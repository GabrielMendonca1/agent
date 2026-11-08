import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isProcessAlive } from "./process-tree.ts";

/** PID sozinho não identifica um processo depois de um reboot/reuso. */
export interface ProcessIdentity {
	host: string;
	start: string;
}

/** Leitura curta, sem shell. Indisponibilidade nunca é prova de que o dono morreu. */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		let start: string;
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// comm pode conter espaços e parênteses; starttime é o campo 22.
			const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
			if (!ticks || !/^\d+$/.test(ticks)) return undefined;
			start = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
		} else if (process.platform === "darwin") {
			start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8", timeout: 2000, maxBuffer: 4096,
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			}).trim();
		} else {
			// Plataformas ainda sem identidade nativa permanecem conservadoras por PID.
			return undefined;
		}
		return start ? { host: hostname(), start } : undefined;
	} catch {
		return undefined;
	}
}

/** true também cobre identidade desconhecida: não autoriza replay nem remoção. */
export function ownerMayBeAlive(pid: number | undefined, identity?: ProcessIdentity): boolean {
	if (identity && (identity.host !== hostname() || typeof identity.start !== "string" || !identity.start)) return true;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
	if (!isProcessAlive(pid)) return false;
	if (!identity) return true; // registros legados: não adivinhar a identidade
	const current = readProcessIdentity(pid);
	return !current || current.start === identity.start;
}
