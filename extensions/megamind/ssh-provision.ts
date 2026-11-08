// Provisionamento sem dependência do Pi. I/O injetável para verificação local sem rede.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type SshProvisionResult = { line: string; reason?: string; silent?: boolean };
type Run = (args: string[]) => Promise<string>;
type Options = {
  company: string;
  endpoint: string;
  bearer: string;
  home?: string;
  machine?: string;
  request?: typeof fetch;
  run?: Run;
};

function keygen(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh-keygen", args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15_000 });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error("ssh-keygen falhou")));
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

/** Fingerprint OpenSSH: o comentário da chave não muda sua identidade. */
export function publicKeyFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/u);
  if (parts[0] !== "ssh-ed25519" || !parts[1] || !/^[A-Za-z0-9+/]+={0,2}$/u.test(parts[1])) {
    throw new Error("chave pública ed25519 inválida");
  }
  return `SHA256:${createHash("sha256").update(Buffer.from(parts[1], "base64")).digest("base64").replace(/=+$/u, "")}`;
}

/** Troca somente a região gerenciada; configuração manual permanece byte a byte. */
export function sshConfigBlock(config: string, company: string, host: string, user: string, identity: string): string {
  if (!/^[a-z][a-z0-9_-]*$/u.test(company) || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/u.test(host)
    || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/u.test(user) || /[\r\n\0"]/u.test(identity)) {
    throw new Error("perfil SSH inválido");
  }
  const begin = `# megamind:${company} begin`;
  const end = `# megamind:${company} end`;
  const lines = config.split(/(?<=\n)/u);
  const marker = (line: string) => line.replace(/\r?\n$/u, "");
  const starts = lines.flatMap((line, i) => marker(line) === begin ? [i] : []);
  const ends = lines.flatMap((line, i) => marker(line) === end ? [i] : []);
  if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0] >= ends[0])) {
    throw new Error("bloco SSH gerenciado incompleto ou duplicado");
  }
  const path = identity.replace(/\\/gu, "/").replace(/%/gu, "%%");
  const block = `${begin}\nHost ${company}\n  HostName ${host}\n  User ${user}\n  IdentityFile "${path}"\n  IdentitiesOnly yes\n${end}`;
  if (starts.length) {
    const trailing = lines[ends[0]].endsWith("\n") ? (lines[ends[0]].endsWith("\r\n") ? "\r\n" : "\n") : "";
    return lines.slice(0, starts[0]).join("") + block + trailing + lines.slice(ends[0] + 1).join("");
  }
  // No início para não herdar um Match/Host anterior e para preceder Host *.
  return `${block}\n${config}`;
}

/** Empresas/sessões paralelas não podem sobrescrever o bloco umas das outras. */
async function updateConfig(path: string, company: string, host: string, user: string, identity: string): Promise<void> {
  const lockPath = `${path}.megamind-lock`;
  for (let attempt = 0; ; attempt++) {
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt >= 50) throw error;
      await delay(100);
      continue;
    }
    try {
      const config = await readOptional(path) ?? "";
      const next = sshConfigBlock(config, company, host, user, identity);
      if (next !== config) await writeFile(path, next, { mode: 0o600 });
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
    return;
  }
}

export async function provisionSsh(options: Options): Promise<SshProvisionResult> {
  const { company, endpoint, bearer } = options;
  const home = options.home ?? homedir();
  const run = options.run ?? keygen;
  const request = options.request ?? fetch;
  let stage = "validar configuração";
  try {
    if (!/^[a-z][a-z0-9_-]*$/u.test(company)) throw new Error("empresa inválida");
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.ARCA_ALLOW_INSECURE_LOCALHOST === "1" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
      throw new Error("endpoint inválido");
    }
    const base = endpoint.replace(/\/mcp\/?$/u, "").replace(/\/$/u, "");
    const api = async (route: string, publicKey?: string) => {
      const response = await request(`${base}/devices/${route}`, {
        method: publicKey === undefined ? "GET" : "PUT",
        redirect: "error",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        ...(publicKey === undefined ? {} : { body: JSON.stringify({ public_key: publicKey }) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { failure: { line: `ssh: indisponível (${route}: HTTP ${response.status})`, reason: `HTTP ${response.status}`, silent: response.status === 404 } };
      }
      try { return { value: await response.json() }; }
      catch {
        return { failure: { line: `ssh: indisponível (${route}: HTTP ${response.status}, resposta não JSON)`, reason: "resposta não JSON" } };
      }
    };
    const sshDir = join(home, ".ssh");
    const identity = join(sshDir, `megamind_${company}`);
    stage = "preparar chave (ssh-keygen/OpenSSH necessário no PATH)";
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    if (await readOptional(identity) === undefined) {
      await run(["-t", "ed25519", "-N", "", "-C", `megamind-${company}-${options.machine ?? hostname()}`, "-f", identity]);
    }
    let publicKey = await readOptional(`${identity}.pub`);
    if (publicKey === undefined) {
      publicKey = await run(["-y", "-P", "", "-f", identity]);
      await writeFile(`${identity}.pub`, publicKey.trim() + "\n", { mode: 0o600 });
    }
    const localFingerprint = publicKeyFingerprint(publicKey);
    const cacheDir = join(home, ".cache", "arca-projects");
    const cachePath = join(cacheDir, `ssh-${company}.json`);
    let cached: { publicKeyFingerprint?: string; fingerprint?: string; endpoint?: string } = {};
    try { cached = JSON.parse(await readOptional(cachePath) ?? "{}"); } catch { /* cache inválido: registrar de novo */ }
    let fingerprint = cached?.fingerprint;
    if (cached?.publicKeyFingerprint !== localFingerprint || cached?.endpoint !== base || typeof fingerprint !== "string" || !fingerprint) {
      stage = "registrar chave";
      const registered = await api("ssh-key", publicKey.trim());
      if (registered.failure) return registered.failure;
      if (registered.value?.ok !== true || typeof registered.value.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]+={0,2}$/u.test(registered.value.fingerprint)) {
        throw new Error("resposta de registro inválida");
      }
      fingerprint = registered.value.fingerprint;
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(cachePath, JSON.stringify({ publicKeyFingerprint: localFingerprint, fingerprint, endpoint: base }) + "\n", { mode: 0o600 });
    }
    stage = "consultar perfil";
    const profile = await api("ssh-profile");
    if (profile.failure) return profile.failure;
    const { user, ssh_host: host } = profile.value ?? {};
    if (typeof user !== "string" || !user.trim() || typeof host !== "string" || !host.trim()) {
      return { line: "ssh: indisponível (perfil sem usuário ou host SSH)", reason: "perfil sem usuário ou host SSH", silent: true };
    }
    stage = "escrever ~/.ssh/config";
    const configPath = join(sshDir, "config");
    await updateConfig(configPath, company, host, user, identity);
    return { line: `ssh: Host ${company} → ${user}@${host} (chave registrada: ${fingerprint})` };
  } catch (error) {
    // Não expõe resposta remota, credenciais ou caminhos de enrollment no diagnóstico.
    const reason = `${stage}${missing(error) ? ": executável ou arquivo ausente" : ": falha"}`;
    return { line: `ssh: indisponível (${reason})`, reason };
  }
}
