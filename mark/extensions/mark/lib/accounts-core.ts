import { homedir } from "os";
import { join } from "path";
import { codexEmail, MIRRORED_PROVIDERS, pull, push, type Credential } from "./account-mirror.ts";
import { withAccountLocks } from "./auth-lock.ts";
import { readJson, writeJson } from "./json-file.ts";

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

export interface AccountsOptions {
  agentDir?: string;
  mirrorEnabled?: boolean;
  push?: typeof push;
  pull?: typeof pull;
}

export function createAccountsCore(options: AccountsOptions = {}) {
const AGENT_DIR = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const BUCKET_PATH = join(AGENT_DIR, "accounts.json");
const MIRROR_STATE_PATH = join(AGENT_DIR, "accounts-mirror.json");
const MIRROR_ENABLED = options.mirrorEnabled ?? process.env.PI_ACCOUNTS_MIRROR !== "0";
type Auth = Record<string, Credential>;
interface Bucket {
  version: 1;
  active: Record<string, string>;
  accounts: Record<string, Record<string, Credential>>;
}

const ACTIONS = ["list", "save", "use", "sync", "mirror", "rename", "remove"];

function readAuth(): Auth {
  return readJson<Auth>(AUTH_PATH, {});
}

// Snapshot de cada bucket lido: a gravacao so aplica o que ESTA execucao mudou, porque o pi com
// PI_ACCOUNT_<PROVIDER> renova entradas do accounts.json por conta propria (refresh rotaciona:
// regravar a copia velha mataria a conta).
const bucketBase = new WeakMap<Bucket, Bucket>();

function readBucket(): Bucket {
  const bucket = readJson<Bucket>(BUCKET_PATH, { version: 1, active: {}, accounts: {} });
  bucketBase.set(bucket, structuredClone(bucket));
  return bucket;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Relê o bucket e aplica por cima so as entradas e selecoes que `ours` mudou desde a leitura. */
function mergeBucket(ours: Bucket): Bucket {
  const base = bucketBase.get(ours) ?? { version: 1, active: {}, accounts: {} };
  const fresh = readJson<Bucket>(BUCKET_PATH, { version: 1, active: {}, accounts: {} });
  const providers = new Set([...Object.keys(base.active), ...Object.keys(ours.active)]);
  for (const provider of providers) {
    if (same(base.active[provider], ours.active[provider])) continue;
    if (ours.active[provider] === undefined) delete fresh.active[provider];
    else fresh.active[provider] = ours.active[provider];
  }
  for (const provider of new Set([...Object.keys(base.accounts), ...Object.keys(ours.accounts)])) {
    const names = new Set([...Object.keys(base.accounts[provider] ?? {}), ...Object.keys(ours.accounts[provider] ?? {})]);
    for (const name of names) {
      const mine = ours.accounts[provider]?.[name];
      if (same(base.accounts[provider]?.[name], mine)) continue;
      if (mine === undefined) delete fresh.accounts[provider]?.[name];
      else (fresh.accounts[provider] ??= {})[name] = mine;
    }
  }
  return fresh;
}

function writeMerged(bucket: Bucket): void {
  const merged = mergeBucket(bucket);
  writeJson(BUCKET_PATH, merged);
  Object.assign(bucket, merged);
  bucketBase.set(bucket, structuredClone(merged));
}

// Copia o slot atual de cada provider pra conta marcada como ativa (captura refresh renovado).
// Recusa quando o slot claramente e outra identidade (accountId diferente) — isso e /login sem save.
function sync(bucket: Bucket, auth: Auth, exclude: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const [provider, name] of Object.entries(bucket.active)) {
    if (exclude.includes(provider)) continue;
    const slot = auth[provider];
    const stored = bucket.accounts[provider]?.[name];
    if (!slot || !stored) continue;
    if (slot.accountId && stored.accountId && slot.accountId !== stored.accountId) {
      problems.push(`${provider}: slot tem accountId diferente de ${name} — parece /login novo; rode /accounts save ${provider} <nome>`);
      continue;
    }
    bucket.accounts[provider][name] = slot;
  }
  return problems;
}

function fingerprint(cred: Credential): string {
  const bits: string[] = [cred.type ?? "?"];
  const email = codexEmail(cred);
  if (email) bits.push(email);
  else if (cred.accountId) bits.push(`acct=${String(cred.accountId).slice(0, 8)}…`);
  if (typeof cred.refresh === "string") bits.push(`rt=…${cred.refresh.slice(-6)}`);
  if (typeof cred.expires === "number") {
    const ms = cred.expires - Date.now();
    bits.push(ms > 0 ? `expira em ${Math.round(ms / 60000)}min` : "expirado (renova no uso)");
  }
  return bits.join(" · ");
}

function sameCredential(a?: Credential, b?: Credential): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Puxa renovacoes dos CLIs pras contas ativas (mais novo vence). Devolve quais mudaram. */
function pullAll(bucket: Bucket, auth: Auth): string[] {
  const changed: string[] = [];
  if (!MIRROR_ENABLED) return changed;
  for (const provider of MIRRORED_PROVIDERS) {
    const name = bucket.active[provider];
    const cred = name ? bucket.accounts[provider]?.[name] : undefined;
    if (!name || !cred) continue;
    try {
      const pulled = (options.pull ?? pull)(provider, `${provider}/${name}`, cred, MIRROR_STATE_PATH);
      if (pulled) {
        bucket.accounts[provider][name] = pulled;
        auth[provider] = pulled;
        changed.push(`${provider}/${name}`);
      }
    } catch {
      // fonte externa ilegivel: ignora
    }
  }
  return changed;
}

/** Espelha as contas ativas dos providers indicados. Pode atualizar bucket/auth (refresh p/ id_token). */
async function pushAll(bucket: Bucket, auth: Auth, providers: readonly string[]): Promise<{ notes: string[]; errors: string[]; touched: boolean; rotated: Set<string> }> {
  const notes: string[] = [];
  const errors: string[] = [];
  const rotated = new Set<string>();
  let touched = false;
  if (!MIRROR_ENABLED) return { notes, errors, touched, rotated };
  for (const provider of providers) {
    if (!(MIRRORED_PROVIDERS as readonly string[]).includes(provider)) continue;
    const name = bucket.active[provider];
    const cred = name ? bucket.accounts[provider]?.[name] : undefined;
    if (!name || !cred) continue;
    try {
      const r = await (options.push ?? push)(provider, `${provider}/${name}`, cred, MIRROR_STATE_PATH);
      if (!r) continue;
      // A credencial devolvida vale mesmo com erro: o refresh ja rotacionou o token antigo.
      if (!sameCredential(r.cred, cred)) {
        bucket.accounts[provider][name] = r.cred;
        auth[provider] = r.cred;
        touched = true;
        rotated.add(provider);
      }
      if (r.error) errors.push(`${provider}/${name}: ${r.error}`);
      notes.push(`${provider}/${name} → ${r.note}`);
    } catch (e) {
      errors.push(`${provider}/${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { notes, errors, touched, rotated };
}

interface SlotUpdate {
  provider: string;
  /** auth.json[provider] serializado na leitura inicial; se mudou, o pi renovou no meio. */
  before: string;
  cred: Credential;
  rotated: boolean;
}

/**
 * Grava bucket e auth sob lock: relê auth.json e mescla só os slots que mudamos, pra não
 * sobrescrever um refresh que o pi (ou o app) renovou entre a leitura e a gravação.
 * Devolve os providers cujo slot foi deixado como está por conflito.
 */
/** Monta os updates dos providers cujo slot mudou desde `before`. */
function changedSlots(auth: Auth, before: Record<string, string>, rotated: ReadonlySet<string>): SlotUpdate[] {
  const updates: SlotUpdate[] = [];
  for (const [provider, previous] of Object.entries(before)) {
    const cred = auth[provider];
    if (!cred || JSON.stringify(cred) === previous) continue;
    updates.push({ provider, before: previous, cred, rotated: rotated.has(provider) });
  }
  return updates;
}

// Chamado sempre com as travas accounts.json -> auth.json ja tomadas (ver `locked`).
function commit(bucket: Bucket, updates: SlotUpdate[], onConflict?: (provider: string, fresh: Auth) => void): string[] {
  {
    const fresh = readAuth();
    const merged: Auth = { ...fresh };
    const skipped: string[] = [];
    let applied = false;
    for (const update of updates) {
      const conflict = JSON.stringify(fresh[update.provider] ?? null) !== update.before;
      // Rotacionar o refresh token mata o anterior, entao a nossa credencial vence o conflito.
      if (conflict && !update.rotated) {
        skipped.push(update.provider);
        onConflict?.(update.provider, fresh);
        continue;
      }
      merged[update.provider] = update.cred;
      applied = true;
    }
    // Providers que nao tocamos podem ter renovado nesse meio tempo: adota no bucket.
    // Pulados por conflito tambem: o slot vivo vence a copia lida antes (senao o bucket guardaria
    // um refresh token que o pi ja rotacionou).
    sync(bucket, fresh, updates.filter((u) => !skipped.includes(u.provider)).map((u) => u.provider));
    writeMerged(bucket);
    if (applied) writeJson(AUTH_PATH, merged);
    return skipped;
  }
}

/**
 * Todo read-modify-write (inclusive o refresh do espelho Codex, que rotaciona o token) roda com
 * as duas travas, na ordem do pi, e le os arquivos ja dentro delas.
 */
function locked<T>(run: () => T | Promise<T>): Promise<T> {
  return withAccountLocks(AGENT_DIR, run);
}

function render(bucket: Bucket, auth: Auth): string {
  const providers = new Set([...Object.keys(auth), ...Object.keys(bucket.accounts)]);
  if (providers.size === 0) return "Nenhuma credencial em auth.json nem no bucket.";
  const lines: string[] = [];
  for (const provider of [...providers].sort()) {
    const active = bucket.active[provider];
    const names = Object.keys(bucket.accounts[provider] ?? {});
    lines.push(`${provider}`);
    if (names.length === 0) {
      lines.push(`  (slot sem conta no bucket — use /accounts save ${provider} <nome>)  ${auth[provider] ? fingerprint(auth[provider]) : ""}`);
      continue;
    }
    for (const name of names.sort()) {
      const cred = bucket.accounts[provider][name];
      const isActive = name === active;
      const drift = isActive && auth[provider] && !sameCredential(auth[provider], cred) ? " (slot difere — rode /accounts save pra reimportar)" : "";
      lines.push(`  ${isActive ? "●" : "○"} ${name}  ${fingerprint(cred)}${drift}`);
    }
    if (!active && auth[provider]) lines.push(`  ! slot ocupado por credencial fora do bucket — /accounts save ${provider} <nome>`);
    if (active && !auth[provider]) lines.push(`  ! slot vazio (logout?) — /accounts use ${provider} ${active}`);
  }
  return lines.join("\n");
}


  // access token por provider na ultima vez que espelhamos; muda => pi renovou => re-espelhar.
  const lastMirroredAccess = new Map<string, string | undefined>();
  let mirrorErrorShown = false;

  async function agentEnd(provider: string | undefined, notify: Notify) {
    if (!MIRROR_ENABLED) return;
    if (!provider || !(MIRRORED_PROVIDERS as readonly string[]).includes(provider)) return;
    const peek = readAuth()[provider];
    if (!peek?.access || lastMirroredAccess.get(provider) === peek.access) return;
    await locked(() => agentEndLocked(provider, notify));
  }

  async function agentEndLocked(provider: string, notify: Notify) {
    const auth = readAuth();
    const slot = auth[provider];
    if (!slot?.access || lastMirroredAccess.get(provider) === slot.access) return;
    const bucket = readBucket();
    const name = bucket.active[provider];
    const stored = name ? bucket.accounts[provider]?.[name] : undefined;
    if (!name || !stored) return;
    if (slot.accountId && stored.accountId && slot.accountId !== stored.accountId) return; // login fora do bucket: nao toca
    const before = JSON.stringify(slot);
    bucket.accounts[provider][name] = slot;
    const { errors, touched, rotated } = await pushAll(bucket, auth, [provider]);
    commit(bucket, touched ? [{ provider, before, cred: auth[provider], rotated: rotated.has(provider) }] : []);
    lastMirroredAccess.set(provider, auth[provider]?.access);
    if (errors.length && !mirrorErrorShown) {
      mirrorErrorShown = true;
      notify(`Espelho de conta falhou: ${errors.join("; ")}`, "warning");
    }
  }

  function completions(prefix: string) {
      const parts = prefix.split(/\s+/);
      const current = parts.pop() ?? "";
      const base = parts.length ? `${parts.join(" ")} ` : "";
      let source: string[] = [];
      if (parts.length === 0) source = ACTIONS;
      else if (parts.length === 1) {
        const bucket = readBucket();
        source = [...new Set([...Object.keys(readAuth()), ...Object.keys(bucket.accounts)])];
      } else if (parts.length === 2 && parts[0] !== "save") {
        source = Object.keys(readBucket().accounts[parts[1]] ?? {});
      }
      const items = source.filter((v) => v.startsWith(current)).map((v) => ({ value: `${base}${v}`, label: v }));
      return items.length ? items : null;
    }
    async function execute(args: string, notify: Notify) {
      const [action = "list"] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "list" || !ACTIONS.includes(action)) return executeLocked(args, notify);
      try {
        await locked(() => executeLocked(args, notify));
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
    async function executeLocked(args: string, notify: Notify) {
      const [action = "list", provider, name, extra] = args.trim().split(/\s+/).filter(Boolean);
      const bucket = readBucket();
      const auth = readAuth();

      const fail = (msg: string) => notify(msg, "error");
      const syncOrFail = (): boolean => {
        const problems = sync(bucket, auth);
        if (problems.length) fail(problems.join("\n"));
        return problems.length === 0;
      };

      switch (action) {
        case "list": {
          notify(render(bucket, auth), "info");
          return;
        }
        case "sync": {
          if (!syncOrFail()) return;
          const before = Object.fromEntries(MIRRORED_PROVIDERS.map((p) => [p, JSON.stringify(auth[p] ?? null)]));
          const pulled = pullAll(bucket, auth);
          const { notes, errors, rotated } = await pushAll(bucket, auth, MIRRORED_PROVIDERS);
          const skipped = commit(bucket, changedSlots(auth, before, rotated));
          if (skipped.length) errors.push(`slot renovado por outro processo em ${skipped.join(", ")} — rode /accounts sync de novo`);
          for (const p of MIRRORED_PROVIDERS) lastMirroredAccess.set(p, auth[p]?.access);
          const lines = ["Bucket sincronizado com os slots atuais."];
          if (pulled.length) lines.push(`Adotado do CLI (mais novo): ${pulled.join(", ")}`);
          lines.push(...notes.map((n) => `Espelhado: ${n}`));
          if (errors.length) fail(errors.join("\n"));
          notify(lines.join("\n"), "info");
          return;
        }
        case "mirror": {
          const targets = provider ? [provider] : [...MIRRORED_PROVIDERS];
          const before = Object.fromEntries(targets.map((p) => [p, JSON.stringify(auth[p] ?? null)]));
          const { notes, errors, touched, rotated } = await pushAll(bucket, auth, targets);
          if (touched) commit(bucket, changedSlots(auth, before, rotated));
          for (const p of MIRRORED_PROVIDERS) lastMirroredAccess.set(p, auth[p]?.access);
          if (errors.length) fail(errors.join("\n"));
          notify(notes.length ? notes.map((n) => `Espelhado: ${n}`).join("\n") : "Nada a espelhar.", "info");
          return;
        }
        case "save": {
          if (!provider || !name) return fail("Uso: /accounts save <provider> <nome>");
          const slot = auth[provider];
          if (!slot) return fail(`auth.json não tem slot '${provider}'. Faça /login ${provider} primeiro.`);
          bucket.accounts[provider] ??= {};
          bucket.accounts[provider][name] = slot;
          bucket.active[provider] = name;
          writeMerged(bucket);
          notify(`Salvo ${provider}/${name} (ativa).`, "info");
          return;
        }
        case "use": {
          if (!provider || !name) return fail("Uso: /accounts use <provider> <nome>");
          const cred = bucket.accounts[provider]?.[name];
          if (!cred) return fail(`Não existe ${provider}/${name} no bucket.`);
          if (auth[provider] && !bucket.active[provider]) {
            return fail(`O slot '${provider}' tem uma credencial fora do bucket. Salve antes: /accounts save ${provider} <nome>`);
          }
          if (!syncOrFail()) return;
          const previous = bucket.active[provider];
          const before = JSON.stringify(auth[provider] ?? null);
          auth[provider] = bucket.accounts[provider][name];
          bucket.active[provider] = name;
          const { notes, errors } = await pushAll(bucket, auth, [provider]);
          // rotated: false — trocar de conta nunca pode passar por cima de um refresh que o pi acabou de fazer.
          const skipped = commit(bucket, [{ provider, before, cred: auth[provider], rotated: false }], (_p, fresh) => {
            if (previous) bucket.active[provider] = previous;
            else delete bucket.active[provider];
            sync(bucket, fresh);
          });
          lastMirroredAccess.set(provider, auth[provider]?.access);
          if (skipped.length) return fail(`O pi renovou o slot '${provider}' durante a troca; nada foi trocado — rode /accounts use ${provider} ${name} de novo.`);
          if (errors.length) fail(`Trocou no pi, mas o espelho falhou: ${errors.join("; ")}`);
          notify(`${provider} → ${name}. Vale na próxima request.${notes.length ? ` Espelhado em ${notes.map((n) => n.split(" → ")[1]).join(", ")}.` : ""}`, "info");
          return;
        }
        case "rename": {
          if (!provider || !name || !extra) return fail("Uso: /accounts rename <provider> <de> <para>");
          const cred = bucket.accounts[provider]?.[name];
          if (!cred) return fail(`Não existe ${provider}/${name}.`);
          if (bucket.accounts[provider][extra]) return fail(`${provider}/${extra} já existe.`);
          bucket.accounts[provider][extra] = cred;
          delete bucket.accounts[provider][name];
          if (bucket.active[provider] === name) bucket.active[provider] = extra;
          writeMerged(bucket);
          notify(`${provider}/${name} → ${provider}/${extra}`, "info");
          return;
        }
        case "remove": {
          if (!provider || !name) return fail("Uso: /accounts remove <provider> <nome>");
          if (!bucket.accounts[provider]?.[name]) return fail(`Não existe ${provider}/${name}.`);
          if (bucket.active[provider] === name) return fail(`${provider}/${name} está ativa — troque com /accounts use antes de remover.`);
          delete bucket.accounts[provider][name];
          writeMerged(bucket);
          notify(`Removida ${provider}/${name}.`, "info");
          return;
        }
        default:
          return fail(`Ação desconhecida '${action}'. Use: ${ACTIONS.join(", ")}`);
      }
    }
  function list() {
    const bucket = readBucket();
    const auth = readAuth();
    return Object.entries(bucket.accounts).flatMap(([provider, accounts]) =>
      Object.keys(accounts).sort().map(name => ({ provider, name,
        active: bucket.active[provider] === name,
        drift: bucket.active[provider] === name && !sameCredential(auth[provider], accounts[name])
      })));
  }
  return { execute, completions, agentEnd, list };
}
