import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const mode = process.env.MARK_BASH_SANDBOX;
	const cwd = process.env.MARK_SANDBOX_CWD;
	if (!cwd || (mode !== "seatbelt" && mode !== "bwrap")) return;
	const home = homedir();
	const profile = join(dirname(fileURLToPath(import.meta.url)), "sandbox", "readonly.sb");
	if (mode === "bwrap") {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(join(home, ".cache"), { recursive: true });
	}
	pi.registerTool({
		...createBashTool(cwd, {
			// O hook do Pi aceita texto; o backend decodifica para argv, sem interpolação shell.
			spawnHook: (context) => ({ ...context, command: JSON.stringify(mode === "seatbelt"
				? ["/usr/bin/sandbox-exec", "-f", profile, "-D", `CWD=${cwd}`, "-D", `HOME=${home}`, "/bin/bash", "-c", context.command]
				: ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--bind", "/tmp", "/tmp", "--bind", join(cwd, ".pi"), join(cwd, ".pi"), "--bind", join(home, ".cache"), join(home, ".cache"), "/bin/bash", "-c", context.command]) }),
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
