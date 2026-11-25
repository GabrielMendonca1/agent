import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolve o ancestral existente mais profundo: um arquivo ainda ausente sob um link simbólico cai no destino real.
function canonical(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync(absolute);
	const parent = dirname(absolute);
	return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
}

// Credenciais que o bash do filho não lê nem altera: chaves do usuário e tokens de cada raiz de perfil.
function secretPaths(home: string) {
	const roots = [...new Set([join(home, ".agent"), join(home, ".pi", "agent"), getAgentDir()].map((root) => resolve(root)))];
	return {
		dirs: [
			...[".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube"].map((path) => join(home, path)),
			...roots.flatMap((root) => ["accounts.rotations", "secrets"].map((path) => join(root, path))),
		],
		files: [
			...[".netrc", ".git-credentials"].map((path) => join(home, path)),
			...roots.flatMap((root) => ["auth.json", "accounts.json", "accounts-mirror.json", "models.json", "superagent/api-token"].map((path) => join(root, path))),
		],
	};
}

// Seatbelt compara o caminho resolvido; o literal original fica junto caso um link mude depois do cálculo.
const withCanonical = (paths: string[]) => [...new Set(paths.flatMap((path) => [resolve(path), canonical(path)]))];
const sbplString = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;

function seatbeltSecrets(home: string): string {
	const { dirs, files } = secretPaths(home);
	const filters = [
		...withCanonical(dirs).map((path) => `    (subpath ${sbplString(path)})`),
		...withCanonical(files).map((path) => `    (literal ${sbplString(path)})`),
	].join("\n");
	return `\n; Gerado por bash-sandbox.ts: chaves e tokens que o bash não lê nem altera.\n(deny file-read* file-write*\n${filters})\n`;
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function sandboxArgs(mode: "seatbelt" | "bwrap", cwd: string, home: string, profile: string): string[] {
	const projectPi = canonical(join(cwd, ".pi"));
	if (mode === "seatbelt") {
		// Espelha as raízes graváveis do perfil; fora delas o CWD já é só leitura e o guarda vira o próprio cache liberado.
		const roots = ["/private/tmp", "/private/var/folders", "/dev", ...["Library/Caches", ".npm/_cacache", ".npm/_logs", ".cache"].map((path) => join(home, path))];
		const guard = roots.some((root) => within(cwd, root)) ? cwd : join(cwd, "node_modules", ".cache");
		const params = { CWD: cwd, CWD_GUARD: guard, HOME: home, PROJECT_PI: projectPi };
		// A lista de segredos não cabe em parâmetros fixos: o perfil vai inline com as regras anexadas no fim.
		const policy = readFileSync(profile, "utf8") + seatbeltSecrets(home);
		return ["/usr/bin/sandbox-exec", "-p", policy, ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`])];
	}
	const mounts = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev"];
	const writable = ["/tmp", canonical(join(home, ".cache"))].filter((path) => !within(path, projectPi));
	for (const path of writable) mounts.push("--bind", path, path);
	// Um checkout dentro de /tmp ou do cache não deve herdar escrita do mount pai.
	for (const path of new Set([cwd, projectPi])) {
		if (existsSync(path) && writable.some((root) => within(path, root))) mounts.push("--ro-bind", path, path);
	}
	// Mesma exceção do Seatbelt: cache de ferramentas em node_modules continua gravável.
	const toolCache = canonical(join(cwd, "node_modules", ".cache"));
	if (existsSync(toolCache) && within(toolCache, cwd) && !within(toolCache, projectPi)) mounts.push("--bind", toolCache, toolCache);
	// Montagens caem no destino real; basta o caminho canônico de cada segredo existente.
	const { dirs, files } = secretPaths(home);
	for (const path of new Set(dirs.map(canonical))) if (existsSync(path)) mounts.push("--tmpfs", path);
	for (const path of new Set(files.map(canonical))) if (existsSync(path)) mounts.push("--ro-bind", "/dev/null", path);
	return mounts;
}

export default function (pi: ExtensionAPI) {
	const mode = process.env.AGENT_BASH_SANDBOX;
	const cwd = process.env.AGENT_SANDBOX_CWD;
	if (!cwd || (mode !== "seatbelt" && mode !== "bwrap")) return;
	const home = canonical(homedir());
	const project = canonical(cwd);
	const profile = join(dirname(fileURLToPath(import.meta.url)), "sandbox", "readonly.sb");
	if (mode === "bwrap") mkdirSync(join(home, ".cache"), { recursive: true });
	pi.registerTool({
		...createBashTool(cwd, {
			// O hook do Pi aceita texto; o backend decodifica para argv, sem interpolação shell.
			spawnHook: (context) => ({
				...context,
				command: JSON.stringify([...sandboxArgs(mode, project, home, profile), "/bin/bash", "-c", context.command]),
			}),
			operations: {
				exec: (command, workdir, { onData, signal, timeout, env }) => new Promise((resolve, reject) => {
					if (signal?.aborted) { reject(new Error("aborted")); return; }
					const [executable, ...args] = JSON.parse(command) as string[];
					const child = spawn(executable, args, { cwd: workdir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
					let timedOut = false;
					const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* já terminou */ } } };
					const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
					const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", kill); };
					child.stdout.on("data", onData);
					child.stderr.on("data", onData);
					signal?.addEventListener("abort", kill, { once: true });
					if (signal?.aborted) kill();
					child.on("error", (error) => { cleanup(); reject(error); });
					child.on("close", (exitCode) => {
						cleanup();
						if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						else resolve({ exitCode: exitCode ?? 1 });
					});
				}),
			},
		}),
		label: "bash",
	});
}
