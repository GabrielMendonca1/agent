/**
 * Memória livre do host, só para segurar o spawn de um subagent quando a
 * máquina já está no limite. Não há teto de quantidade: o que trava o Mac é o
 * trabalho pesado que o filho lança (tsc, vitest), não o `pi` em si.
 *
 * macOS: `kern.memorystatus_level` é o mesmo número do `memory_pressure` e já
 * desconta o compressor. Linux: MemAvailable/MemTotal. Onde não há leitura,
 * o spawn segue sem esperar.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** Abaixo disto de memória livre no host, o spawn espera o Mac aliviar. */
export const MIN_HOST_FREE_PERCENT = 10;

export function readHostFreePercent(): number | undefined {
	try {
		if (process.platform === "darwin") {
			const out = execFileSync("sysctl", ["-n", "kern.memorystatus_level"], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const value = Number.parseInt(out.trim(), 10);
			return Number.isNaN(value) ? undefined : value;
		}
		if (process.platform === "linux") {
			const info = fs.readFileSync("/proc/meminfo", "utf8");
			const total = /MemTotal:\s+(\d+)/.exec(info);
			const available = /MemAvailable:\s+(\d+)/.exec(info);
			if (!total || !available) return undefined;
			return Math.round((Number(available[1]) / Number(total[1])) * 100);
		}
	} catch {
		/* sem leitura: segue */
	}
	return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		timer.unref?.();
		function done() {
			signal?.removeEventListener("abort", done);
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

export interface HostMemoryWaitOptions {
	signal?: AbortSignal;
	minFreePercent?: number;
	pollMs?: number;
	hostFreePercent?: () => number | undefined;
}

/** Resolve true quando há memória; false se o sinal abortou antes. */
export async function waitForHostMemory(opts: HostMemoryWaitOptions = {}): Promise<boolean> {
	const minFree = opts.minFreePercent ?? MIN_HOST_FREE_PERCENT;
	const pollMs = opts.pollMs ?? 750;
	const hostFree = opts.hostFreePercent ?? readHostFreePercent;
	while (true) {
		if (opts.signal?.aborted) return false;
		const free = hostFree();
		if (free === undefined || free >= minFree) return true;
		await sleep(pollMs, opts.signal);
	}
}
