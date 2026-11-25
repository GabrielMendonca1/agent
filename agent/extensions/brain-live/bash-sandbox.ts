import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);

// Caminhos canônicos: o sandbox precisa cobrir também destinos de links simbólicos.
function secretPaths(home: string) {
	return {
		dirs: { SSH: canonical(join(home, ".ssh")), AWS: canonical(join(home, ".aws")), GNUPG: canonical(join(home, ".gnupg")) },
		files: {
			AGENT_AUTH: canonical(join(home, ".agent", "auth.json")),
			PI_AUTH: canonical(join(home, ".pi", "agent", "auth.json")),
			PROFILE_AUTH: canonical(join(getAgentDir(), "auth.json")),
		},
	};
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function sandboxArgs(mode: "seatbelt" | "bwrap", cwd: string, home: string, profile: string): string[] {
	const projectPi = canonical(join(cwd, ".pi"));
	const { dirs, files } = secretPaths(home);
	if (mode === "seatbelt") {
		// Espelha as raízes graváveis do perfil; fora delas o CWD já é só leitura e o guarda vira o próprio cache liberado.
		const roots = ["/private/tmp", "/private/var/folders", "/dev", ...["Library/Caches", ".npm/_cacache", ".npm/_logs", ".cache"].map((path) => join(home, path))];
		const guard = roots.some((root) => within(cwd, root)) ? cwd : join(cwd, "node_modules", ".cache");
		const params = { CWD: cwd, CWD_GUARD: guard, HOME: home, PROJECT_PI: projectPi, ...dirs, ...files };
		return ["/usr/bin/sandbox-exec", "-f", profile, ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`])];
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
	for (const path of new Set(Object.values(dirs))) if (existsSync(path)) mounts.push("--tmpfs", path);
	for (const path of new Set(Object.values(files))) if (existsSync(path)) mounts.push("--ro-bind", "/dev/null", path);
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
