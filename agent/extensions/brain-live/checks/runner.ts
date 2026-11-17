import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Runner de verificação por projeto.
 *
 * O problema que ele resolve não é "rodar teste" — é responder, em segundos e
 * sem depender da disciplina de quem mexeu, se uma mudança QUEBROU algo que
 * funcionava. Por isso as duas peças centrais são o manifesto (o contrato do que
 * precisa continuar de pé) e a baseline (o estado do commit base), que separa
 * "eu quebrei" de "já estava vermelho". Sem baseline, todo agente herda a culpa
 * do anterior, o vermelho vira paisagem e a suíte morre.
 *
 * Node puro e sintaxe apagável: roda dentro da extension, no CLI e como hook do
 * omni, sem build.
 */

export interface Check {
  name: string;
  cmd: string;
  tags?: string[];
  timeoutMs?: number;
}
export interface Manifest {
  root: string;
  checks: Check[];
  defaultTimeoutMs: number;
  parallel: number;
  /** Caminhos do checkout real espelhados no worktree da baseline (node_modules, .venv...). */
  link: string[];
}
export interface CheckResult {
  name: string;
  ok: boolean;
  code: number | null;
  ms: number;
  tail: string;
  timedOut?: boolean;
}
export interface Comparison {
  newFailures: string[];
  fixed: string[];
  stillFailing: string[];
}

const CACHE_DIR = process.env.PI_CHECKS_CACHE_DIR ?? join(homedir(), ".claude", "tmp", "pi-checks");
const TAIL_LINES = 40;

export const MANIFEST_PATH = join(".pi", "checks.json");

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: run.status === 0, out: (run.stdout ?? "").trim() || (run.stderr ?? "").trim() };
}

/** O manifesto define a raiz do projeto: sobe até achá-lo, sem adivinhar por marcador de VCS. */
export function findManifest(from: string): Manifest | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, MANIFEST_PATH);
    if (existsSync(candidate)) return parseManifest(dir, readFileSync(candidate, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseManifest(root: string, raw: string): Manifest {
  let data: any;
  try { data = JSON.parse(raw); } catch (error) {
    throw new Error(`${join(root, MANIFEST_PATH)}: JSON inválido (${error instanceof Error ? error.message : String(error)})`);
  }
  const checks = Array.isArray(data?.checks) ? data.checks : [];
  if (!checks.length) throw new Error(`${join(root, MANIFEST_PATH)}: nenhum check declarado`);
  const seen = new Set<string>();
  for (const check of checks) {
    if (typeof check?.name !== "string" || !check.name.trim()) throw new Error("cada check precisa de um name");
    if (typeof check?.cmd !== "string" || !check.cmd.trim()) throw new Error(`check "${check.name}": cmd ausente`);
    if (seen.has(check.name)) throw new Error(`check "${check.name}" duplicado — o nome é o que torna a falha atribuível`);
    seen.add(check.name);
  }
  return {
    root,
    checks,
    defaultTimeoutMs: Number(data.defaultTimeoutMs) > 0 ? Number(data.defaultTimeoutMs) : 300_000,
    parallel: Number(data.parallel) > 0 ? Number(data.parallel) : 4,
    link: Array.isArray(data.link) ? data.link : [],
  };
}

function tail(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

function runOne(check: Check, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
  signal?.throwIfAborted();
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const windows = process.platform === "win32";
    const child = spawn(check.cmd, [], { cwd, shell: true, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let stopping: Promise<void> | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      // Windows não tem grupo POSIX: taskkill /T derruba a árvore inteira.
      if (windows) { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); return; }
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };
    const stop = () => {
      if (stopping) return;
      killGroup("SIGTERM");
      // Mesmo se o shell fechar antes, netos que ignoram TERM recebem KILL.
      stopping = new Promise((done) => setTimeout(() => { killGroup("SIGKILL"); done(); }, 5000));
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref?.();
    const capture = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let settled = false;
    const finish = async (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopping;
      signal?.removeEventListener("abort", abort);
      resolvePromise({
        name: check.name,
        ok: !timedOut && !signal?.aborted && !error && code === 0,
        code,
        ms: Date.now() - started,
        tail: error ? `falhou ao iniciar: ${error.message}` : timedOut ? `${tail(output)}\n[timeout após ${timeoutMs}ms]` : tail(output),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    child.on("error", (error) => { void finish(null, error); });
    child.on("close", (code) => { void finish(code); });
    if (signal?.aborted) abort();
  });
}

export interface RunOptions {
  cwd?: string;
  tags?: string[];
  names?: string[];
  onStart?: (check: Check) => void;
  onResult?: (result: CheckResult) => void;
  signal?: AbortSignal;
}

export function selectChecks(manifest: Manifest, filter?: { tags?: string[]; names?: string[] }): Check[] {
  const { tags, names } = filter ?? {};
  return manifest.checks.filter((check) => {
    if (names?.length) return names.includes(check.name);
    if (tags?.length) return tags.some((tag) => (check.tags ?? []).includes(tag));
    return true;
  });
}

export async function runChecks(
  manifest: Manifest,
  options?: RunOptions,
): Promise<CheckResult[]> {
  const cwd = options?.cwd ?? manifest.root;
  const queue = selectChecks(manifest, options);
  const results: CheckResult[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (options?.signal?.aborted) return;
      const index = next++;
      if (index >= queue.length) return;
      const check = queue[index];
      options?.onStart?.(check);
      const result = await runOne(check, cwd, check.timeoutMs ?? manifest.defaultTimeoutMs, options?.signal);
      results.push(result);
      options?.onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(manifest.parallel, queue.length) }, worker));
  options?.signal?.throwIfAborted();
  return queue.map((check) => results.find((result) => result.name === check.name)!).filter(Boolean);
}

/** Branch de trabalho compara contra o ponto em que saiu do tronco; no tronco, contra o próprio HEAD. */
export function baseSha(root: string, trunk = "main"): string | null {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch === trunk) return head.out;
  const mergeBase = git(root, ["merge-base", "HEAD", trunk]);
  return mergeBase.ok ? mergeBase.out : head.out;
}

function cacheFile(root: string, sha: string): string {
  const slug = root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join(CACHE_DIR, slug, `${sha}.json`);
}

type CachedResult = CheckResult & { fp: string };
interface BaselineCache {
  version: 2;
  sha: string;
  at: string;
  results: Record<string, CachedResult>;
}

function fingerprint(check: Check, manifest: Manifest): string {
  return createHash("sha1").update(JSON.stringify([check.cmd, check.timeoutMs ?? manifest.defaultTimeoutMs])).digest("hex");
}

function readCache(root: string, sha: string): BaselineCache | null {
  try {
    const data = JSON.parse(readFileSync(cacheFile(root, sha), "utf8"));
    return data.version === 2 && data.sha === sha && data.results && !Array.isArray(data.results) ? data : null;
  } catch { return null; }
}

export function readBaselineCache(root: string, sha: string): CheckResult[] | null {
  const cache = readCache(root, sha);
  return cache ? Object.values(cache.results) : null;
}

function pruneCache(): void {
  try {
    const cutoff = Date.now() - 14 * 86400_000;
    for (const slug of readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (!slug.isDirectory() || slug.isSymbolicLink()) continue;
      const dir = join(CACHE_DIR, slug.name);
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^(?:[a-f0-9]+|ultima-rodada)\.json$/.test(entry.name)) continue;
          const file = join(dir, entry.name);
          try { if (statSync(file).mtimeMs < cutoff) rmSync(file); } catch {}
        }
        if (!readdirSync(dir).length) rmdirSync(dir);
      } catch {}
    }
  } catch {}
}

function writeBaselineCache(root: string, cache: BaselineCache): void {
  try {
    const file = cacheFile(root, cache.sha);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch {
    // Cache é otimização: perdê-lo custa tempo, nunca correção.
  }
  pruneCache();
}

export interface BaselineOptions extends RunOptions {
  sha?: string;
  refresh?: boolean;
  onPhase?: (phase: string) => void;
}

/** Cache por check: seleções parciais nunca substituem a baseline inteira. */
export async function baseline(
  manifest: Manifest,
  options?: BaselineOptions,
): Promise<{ sha: string; results: CheckResult[]; cached: boolean }> {
  options?.signal?.throwIfAborted();
  const sha = options?.sha ?? baseSha(manifest.root);
  if (!sha) throw new Error(`${manifest.root} não é um repositório git — baseline precisa de um commit base`);
  const selection = selectChecks(manifest, options);
  const cache = readCache(manifest.root, sha);
  const valid = (check: Check) => !options?.refresh && cache?.results[check.name]?.fp === fingerprint(check, manifest);
  const missing = selection.filter((check) => !valid(check));
  const selected = new Map<string, CheckResult>();
  for (const check of selection) {
    if (valid(check)) {
      const { fp, ...result } = cache!.results[check.name];
      selected.set(check.name, result);
      options?.onResult?.(result);
    }
  }
  if (!missing.length) return { sha, results: selection.map((c) => selected.get(c.name)!), cached: true };
  options?.onPhase?.("preparando worktree…");
  options?.signal?.throwIfAborted();
  const path = mkdtempSync(join(tmpdir(), "pi-checks-base-"));
  const worktree = join(path, "wt");
  try {
    const add = git(manifest.root, ["worktree", "add", "--detach", worktree, sha]);
    if (!add.ok) throw new Error(`worktree da baseline falhou em ${sha}: ${add.out}`);
    options?.signal?.throwIfAborted();
    for (const entry of manifest.link) {
      const source = join(manifest.root, entry);
      if (existsSync(source)) { try { symlinkSync(source, join(worktree, entry)); } catch {} }
    }
    const results = await runChecks(manifest, { ...options, cwd: worktree, names: missing.map((c) => c.name) });
    // Relê antes de mesclar para preservar entradas escritas durante esta rodada.
    const merged = Object.assign(Object.create(null), readCache(manifest.root, sha)?.results);
    for (const result of results) {
      const check = missing.find((c) => c.name === result.name)!;
      merged[result.name] = { ...result, fp: fingerprint(check, manifest) };
      selected.set(result.name, result);
    }
    writeBaselineCache(manifest.root, { version: 2, sha, at: new Date().toISOString(), results: merged });
    return { sha, results: selection.map((c) => selected.get(c.name)!), cached: false };
  } finally {
    git(manifest.root, ["worktree", "remove", "--force", worktree]);
    git(manifest.root, ["worktree", "prune"]);
    rmSync(path, { recursive: true, force: true });
  }
}

/** Usado pelas duas superfícies e pelo teste sem dependências do Pi. */
export function resultOk(details: { ok?: boolean; results?: CheckResult[] }): boolean {
  return details.ok ?? (details.results ?? []).every((r) => r.ok);
}

export async function gate(manifest: Manifest, options?: RunOptions & { baselineOptions?: BaselineOptions }) {
  const results = await runChecks(manifest, options);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (!failed.length) {
    return { results, ok: true, baseSha: baseSha(manifest.root), baselineSkipped: true,
      verdict: "OK: tudo verde (baseline dispensada)" };
  }
  try {
    const base = await baseline(manifest, { ...options?.baselineOptions, names: failed, signal: options?.signal });
    const comparison = compare(base.results, results);
    return { results, comparison, baseSha: base.sha, baselineCached: base.cached, ok: comparison.newFailures.length === 0,
      verdict: comparison.newFailures.length
        ? `BLOQUEIA: ${comparison.newFailures.length} check(s) que passavam em ${base.sha.slice(0, 8)} quebraram`
        : `OK: nada que funcionava em ${base.sha.slice(0, 8)} quebrou` };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { results, ok: false,
      verdict: `baseline indisponível (${error instanceof Error ? error.message : String(error)}); exigindo suíte inteira verde` };
  }
}

/**
 * Grava o relatório da última rodada, com a saída capturada de cada check.
 *
 * Sem isto, uma falha que não se reproduz não deixa rastro: o console mostra o
 * nome do que quebrou, o operador rola a tela, e a evidência se perde. Guardamos
 * só o ÚLTIMO relatório — histórico aqui viraria lixo que ninguém lê e ninguém
 * apaga. Devolve o caminho, ou null se não deu para escrever (nunca lança: um
 * relatório ausente não pode derrubar o portão).
 */
export function writeLastRun(
  root: string,
  payload: { baseSha: string; baselineCached: boolean; results: CheckResult[]; comparison: Comparison },
): string | null {
  try {
    const slug = root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    const file = join(CACHE_DIR, slug, "ultima-rodada.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          root,
          baseSha: payload.baseSha,
          baselineCached: payload.baselineCached,
          // O ambiente entra no relatório porque ele MUDA embaixo do portão: a
          // release ativa do pi trocou de 0.84.2 para 0.84.3 no meio de um dia de
          // trabalho, e dois checks leem o compositor dessa release.
          ambiente: environmentSnapshot(),
          comparison: payload.comparison,
          results: payload.results,
        },
        null,
        2,
      ),
    );
    return file;
  } catch {
    return null;
  }
}

/** O que pode ter mudado por fora e explicar um vermelho que não se reproduz. */
function environmentSnapshot(): Record<string, string> {
  const snap: Record<string, string> = { node: process.version, plataforma: process.platform };
  try {
    const release = join(homedir(), ".local", "share", "agent", "current");
    snap.releaseAtiva = realpathSync(release).split("/").pop() ?? "?";
  } catch {
    snap.releaseAtiva = "ausente";
  }
  for (const chave of ["PI_SESSION_ID", "OMNI_CHECKS", "OMNI_PI_BIN"]) {
    if (process.env[chave]) snap[chave] = process.env[chave] as string;
  }
  return snap;
}

/** O veredito que importa: o que ESTA mudança quebrou, não o que já estava quebrado. */
export function compare(base: CheckResult[], now: CheckResult[]): Comparison {
  const before = new Map(base.map((result) => [result.name, result.ok]));
  const newFailures: string[] = [];
  const fixed: string[] = [];
  const stillFailing: string[] = [];
  for (const result of now) {
    const wasOk = before.get(result.name);
    if (!result.ok && wasOk !== false) newFailures.push(result.name);
    else if (!result.ok) stillFailing.push(result.name);
    else if (wasOk === false) fixed.push(result.name);
  }
  return { newFailures, fixed, stillFailing };
}

export function formatResults(results: CheckResult[], comparison?: Comparison): string {
  const mark = (result: CheckResult) => {
    if (result.ok) return comparison?.fixed.includes(result.name) ? "✓+" : "✓";
    return comparison?.newFailures.includes(result.name) ? "✗NOVO" : "✗";
  };
  const lines = results.map((result) => `${mark(result).padEnd(6)} ${result.name.padEnd(22)} ${(result.ms / 1000).toFixed(1)}s`);
  if (comparison?.newFailures.length) {
    lines.push("", `quebrou agora: ${comparison.newFailures.join(", ")}`);
    for (const name of comparison.newFailures) {
      const result = results.find((r) => r.name === name);
      if (result) lines.push("", `--- ${name} ---`, result.tail);
    }
  }
  if (comparison?.stillFailing.length) lines.push("", `já estava vermelho: ${comparison.stillFailing.join(", ")}`);
  return lines.join("\n");
}
