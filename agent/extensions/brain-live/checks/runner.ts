import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, linkSync, readlinkSync, realpathSync, readdirSync, renameSync, statSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** Git só de leitura: GIT_OPTIONAL_LOCKS=0 impede o `status` de regravar o índice (vale dentro do sandbox). */
function gitRead(cwd: string, args: string[]): { ok: boolean; out: Buffer } {
  const run = spawnSync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 256 * 1024 * 1024 });
  return { ok: run.status === 0, out: run.stdout ?? Buffer.alloc(0) };
}

/** tmp no mesmo diretório + rename: leitor concorrente vê o arquivo antigo ou o novo, nunca meio escrito. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, { flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; }
}

/** Lock por repositório no git-common-dir, compartilhado por todos os worktrees do mesmo repo. */
export function repoLockPath(root: string): string | null {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return null;
  return join(isAbsolute(common.out) ? common.out : resolve(root, common.out), "pi-checks.lock");
}

const LOCK_STALE_MS = Number(process.env.PI_CHECKS_LOCK_STALE_MS) > 0 ? Number(process.env.PI_CHECKS_LOCK_STALE_MS) : 10 * 60_000;

/**
 * Serializa operações curtas de `git worktree add/remove/prune` e a mescla do cache.
 * O_EXCL cria o lock; dono morto (mesmo host) ou lock mais velho que LOCK_STALE_MS é
 * tomado: renomeia para um nome único antes de apagar, então só um concorrente vence.
 */
export async function withRepoLock<T>(root: string, fn: () => T | Promise<T>, options?: { signal?: AbortSignal; onWait?: () => void }): Promise<T> {
  const file = repoLockPath(root);
  if (!file) return fn();
  const token = `${process.pid}:${randomUUID()}`;
  let waited = false;
  for (;;) {
    options?.signal?.throwIfAborted();
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token }), { flag: "wx" });
      break;
    } catch (error: any) {
      // Sem como criar o lock (git dir só leitura, etc.): segue sem ele, como antes do lock existir.
      if (error?.code !== "EEXIST") return fn();
    }
    let owner: { pid?: number; host?: string; at?: number; token?: string } = {};
    let age = 0;
    try {
      owner = JSON.parse(readFileSync(file, "utf8"));
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      // Lock sumiu ou está sendo escrito agora: tenta de novo.
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
    }
    const dead = owner.host === hostname() && typeof owner.pid === "number" && !pidAlive(owner.pid);
    if (dead || age > LOCK_STALE_MS) {
      const grave = `${file}.stale.${process.pid}.${randomUUID()}`;
      try { renameSync(file, grave); } catch { continue; }
      // Entre a leitura e o rename outro concorrente pode ter tomado o lock: devolve o que não era o morto.
      let taken: { token?: string } = {};
      try { taken = JSON.parse(readFileSync(grave, "utf8")); } catch {}
      if (taken.token !== owner.token) { try { linkSync(grave, file); } catch {} }
      rmSync(grave, { force: true });
      continue;
    }
    if (!waited) { waited = true; options?.onWait?.(); }
    await sleep(50 + Math.random() * 100);
  }
  try {
    return await fn();
  } finally {
    try { if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file); } catch {}
  }
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
    throw new Error(`${join(root, MANIFEST_PATH)}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const checks = Array.isArray(data?.checks) ? data.checks : [];
  if (!checks.length) throw new Error(`${join(root, MANIFEST_PATH)}: no checks declared`);
  const seen = new Set<string>();
  for (const check of checks) {
    if (typeof check?.name !== "string" || !check.name.trim()) throw new Error("every check needs a name");
    if (typeof check?.cmd !== "string" || !check.cmd.trim()) throw new Error(`check "${check.name}": cmd ausente`);
    if (seen.has(check.name)) throw new Error(`duplicate check "${check.name}": the name is what makes a failure attributable`);
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
        tail: error ? `failed to start: ${error.message}` : timedOut ? `${tail(output)}\n[timeout after ${timeoutMs}ms]` : tail(output),
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
          if (!entry.isFile() || !/^(?:[a-f0-9]+|ultima-rodada)\.json(?:\.\d+\.[0-9a-f-]+\.tmp)?$/.test(entry.name)) continue;
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
    writeFileAtomic(cacheFile(root, cache.sha), JSON.stringify(cache, null, 2));
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
  if (!sha) throw new Error(`${manifest.root} is not a git repository; the baseline needs a base commit`);
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
  const locked = <T>(fn: () => T) => withRepoLock(manifest.root, fn, {
    signal: options?.signal, onWait: () => options?.onPhase?.("waiting for the repository worktree lock…") });
  try {
    await locked(() => {
      const add = git(manifest.root, ["worktree", "add", "--detach", worktree, sha]);
      if (!add.ok) throw new Error(`baseline worktree failed at ${sha}: ${add.out}`);
    });
    options?.signal?.throwIfAborted();
    for (const entry of manifest.link) {
      const source = join(manifest.root, entry);
      if (existsSync(source)) { try { symlinkSync(source, join(worktree, entry)); } catch {} }
    }
    const results = await runChecks(manifest, { ...options, cwd: worktree, names: missing.map((c) => c.name) });
    // Relê sob o lock antes de mesclar para preservar entradas escritas durante esta rodada.
    await locked(() => {
      const merged = Object.assign(Object.create(null), readCache(manifest.root, sha)?.results);
      for (const result of results) {
        const check = missing.find((c) => c.name === result.name)!;
        merged[result.name] = { ...result, fp: fingerprint(check, manifest) };
        selected.set(result.name, result);
      }
      writeBaselineCache(manifest.root, { version: 2, sha, at: new Date().toISOString(), results: merged });
    });
    return { sha, results: selection.map((c) => selected.get(c.name)!), cached: false };
  } finally {
    // Limpeza não pode ser cancelada pelo mesmo sinal que abortou a rodada.
    await withRepoLock(manifest.root, () => {
      git(manifest.root, ["worktree", "remove", "--force", worktree]);
      git(manifest.root, ["worktree", "prune"]);
    });
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
      verdict: "OK: all green (baseline skipped)" };
  }
  try {
    const base = await baseline(manifest, { ...options?.baselineOptions, names: failed, signal: options?.signal });
    const comparison = compare(base.results, results);
    return { results, comparison, baseSha: base.sha, baselineCached: base.cached, ok: comparison.newFailures.length === 0,
      verdict: comparison.newFailures.length
        ? `BLOCKS: ${comparison.newFailures.length} check(s) that passed at ${base.sha.slice(0, 8)} broke`
        : `OK: nothing that worked at ${base.sha.slice(0, 8)} broke` };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { results, ok: false,
      verdict: `baseline unavailable (${error instanceof Error ? error.message : String(error)}); requiring the whole suite green` };
  }
}

export type TreeStatePart = "head" | "status" | "diff" | "untracked";
/** HEAD + impressão digital do working tree: o que um resultado de checks descreve. */
export interface TreeState {
  head: string | null;
  fingerprint: string;
  parts: Record<Exclude<TreeStatePart, "head">, string>;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/**
 * Só lê: `git status --porcelain=v1 -z --untracked-files=all`, `git diff HEAD --binary`
 * e o conteúdo dos não rastreados (que o diff não vê). Roda dentro do sandbox só leitura.
 */
const UNTRACKED_HASH_LIMIT = 8 * 1024 * 1024;

export function treeState(root: string): TreeState | null {
  const top = gitRead(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const dir = top.out.toString("utf8").trim();
  const head = gitRead(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  const status = gitRead(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return null;
  const diff = head.ok ? gitRead(dir, ["diff", "HEAD", "--binary"]) : { ok: true, out: Buffer.alloc(0) };
  if (!diff.ok) return null;
  const untracked = createHash("sha256");
  for (const entry of status.out.toString("utf8").split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    const name = entry.slice(3);
    const file = join(dir, name);
    let content: string;
    try {
      const stat = lstatSync(file);
      // Large untracked files are fingerprinted by size and mtime instead of being read whole.
      content = stat.isSymbolicLink() ? `link:${readlinkSync(file)}`
        : !stat.isFile() ? `kind:${stat.mode}`
        : stat.size > UNTRACKED_HASH_LIMIT ? `stat:${stat.size}:${stat.mtimeMs}`
        : sha256(readFileSync(file));
    } catch (error: any) { content = `unreadable:${error?.code ?? "?"}`; }
    untracked.update(`${name}\0${content}\0`);
  }
  const parts = { status: sha256(status.out), diff: sha256(diff.out), untracked: untracked.digest("hex") };
  const headSha = head.ok ? head.out.toString("utf8").trim() : null;
  return { head: headSha, parts, fingerprint: sha256(JSON.stringify([headSha, parts.status, parts.diff, parts.untracked])) };
}

export interface LastRunRecord {
  version: 1;
  at: string;
  root: string;
  action: "gate" | "run";
  selection: { tags?: string[]; names?: string[] };
  /** Estado do working tree ao fim da rodada. */
  tree: TreeState;
  /** A própria rodada mudou o working tree (saída não ignorada, por exemplo). */
  treeChangedDuringRun?: boolean;
  ok: boolean;
  verdict: string;
  total: number;
  green: number;
  baseSha?: string | null;
  baselineCached?: boolean;
  comparison?: Comparison;
  results: CheckResult[];
  ambiente: Record<string, string>;
}

function lastRunFile(root: string): string {
  const slug = root.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join(CACHE_DIR, slug, "ultima-rodada.json");
}

/**
 * Grava o relatório da última rodada, com a saída de cada check, HEAD e a impressão
 * digital do working tree. Só o ÚLTIMO relatório: histórico aqui viraria lixo. É o que
 * `checks last` devolve a um revisor que não pode executar checks. Nunca lança: um
 * relatório ausente não pode derrubar o portão.
 */
export function writeLastRun(
  root: string,
  payload: {
    action: "gate" | "run"; selection: { tags?: string[]; names?: string[] }; before?: TreeState | null;
    ok: boolean; verdict: string; results: CheckResult[];
    baseSha?: string | null; baselineCached?: boolean; comparison?: Comparison;
  },
): string | null {
  try {
    const tree = treeState(root);
    if (!tree) return null;
    const file = lastRunFile(root);
    const record: LastRunRecord = {
      version: 1,
      at: new Date().toISOString(),
      root,
      action: payload.action,
      selection: payload.selection,
      tree,
      ...(payload.before && payload.before.fingerprint !== tree.fingerprint ? { treeChangedDuringRun: true } : {}),
      ok: payload.ok,
      verdict: payload.verdict,
      total: payload.results.length,
      green: payload.results.filter((r) => r.ok).length,
      baseSha: payload.baseSha,
      baselineCached: payload.baselineCached,
      comparison: payload.comparison,
      results: payload.results,
      // O ambiente entra no relatório porque ele MUDA embaixo do portão: a
      // release ativa do pi trocou de 0.84.2 para 0.84.3 no meio de um dia de
      // trabalho, e dois checks leem o compositor dessa release.
      ambiente: environmentSnapshot(),
    };
    writeFileAtomic(file, JSON.stringify(record, null, 2));
    return file;
  } catch {
    return null;
  }
}

export function readLastRun(root: string): LastRunRecord | null {
  try {
    const data = JSON.parse(readFileSync(lastRunFile(root), "utf8"));
    return data?.version === 1 && data.tree && Array.isArray(data.results) ? data : null;
  } catch { return null; }
}

export type LastRunStatus =
  | { status: "missing"; root: string }
  | { status: "fresh"; record: LastRunRecord }
  | { status: "stale"; record: LastRunRecord; diverged: TreeStatePart[] | ["unknown"] };

/** Não confia no registro: recalcula HEAD + impressão digital e diz qual parte divergiu. */
export function lastRun(root: string): LastRunStatus {
  const record = readLastRun(root);
  if (!record) return { status: "missing", root };
  const now = treeState(root);
  if (!now) return { status: "stale", record, diverged: ["unknown"] };
  const diverged: TreeStatePart[] = [];
  if (now.head !== record.tree.head) diverged.push("head");
  for (const part of ["status", "diff", "untracked"] as const) if (now.parts[part] !== record.tree.parts[part]) diverged.push(part);
  return diverged.length ? { status: "stale", record, diverged } : { status: "fresh", record };
}

/** Uma linha para o resultado do job: `gate: N/M green, new failures: [...] (fresh)`. */
export function lastRunLine(state: LastRunStatus): string {
  if (state.status === "missing") return "gate: not run";
  const r = state.record;
  const failures = r.comparison?.newFailures ?? r.results.filter((x) => !x.ok).map((x) => x.name);
  const freshness = state.status === "fresh" ? "fresh" : `stale: ${state.diverged.join(", ")} changed since`;
  const filter = r.selection.names?.length ? ` only=${r.selection.names.join(",")}` : r.selection.tags?.length ? ` tags=${r.selection.tags.join(",")}` : "";
  return `${r.action}${filter}: ${r.green}/${r.total} green, ${r.action === "gate" ? "new failures" : "failures"}: [${failures.join(", ")}] (${freshness}; ${r.tree.head?.slice(0, 8) ?? "no HEAD"} at ${r.at})`;
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
    return comparison?.newFailures.includes(result.name) ? "✗NEW" : "✗";
  };
  const lines = results.map((result) => `${mark(result).padEnd(6)} ${result.name.padEnd(22)} ${(result.ms / 1000).toFixed(1)}s`);
  if (comparison?.newFailures.length) {
    lines.push("", `broke now: ${comparison.newFailures.join(", ")}`);
    for (const name of comparison.newFailures) {
      const result = results.find((r) => r.name === name);
      if (result) lines.push("", `--- ${name} ---`, result.tail);
    }
  }
  if (comparison?.stillFailing.length) lines.push("", `already red: ${comparison.stillFailing.join(", ")}`);
  return lines.join("\n");
}
