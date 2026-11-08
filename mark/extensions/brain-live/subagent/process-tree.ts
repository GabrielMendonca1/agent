/**
 * Árvore de processos do sistema, só para o caminho de cancelamento.
 *
 * Por que existe: o `pi` filho roda `bash` em grupo de processo próprio
 * (detached). Um SIGKILL no `pi` deixa `bash → pnpm → tsc` vivos e órfãos no
 * `launchd`, cada um podendo segurar gigabytes. Quem cancela o filho precisa
 * matar o que ele lançou, e isso exige a foto da árvore antes de ele morrer.
 */

import { execFileSync } from "node:child_process";

export interface ProcessPair {
	pid: number;
	ppid: number;
}

/** Lê `ps -axo pid=,ppid=`; linhas inválidas são ignoradas. */
export function parseProcessPairs(psOutput: string): ProcessPair[] {
	const pairs: ProcessPair[] = [];
	for (const line of psOutput.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		const pid = Number.parseInt(parts[0], 10);
		const ppid = Number.parseInt(parts[1], 10);
		if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
		pairs.push({ pid, ppid });
	}
	return pairs;
}

/** Todos os descendentes de `root` (filhos, netos…), sem o próprio `root`. */
export function descendantsOf(root: number, pairs: ProcessPair[]): number[] {
	const children = new Map<number, number[]>();
	for (const { pid, ppid } of pairs) {
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	const found: number[] = [];
	const stack = [root];
	const seen = new Set<number>([root]);
	while (stack.length > 0) {
		const current = stack.pop() as number;
		for (const child of children.get(current) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			found.push(child);
			stack.push(child);
		}
	}
	return found;
}

/** Foto atual dos descendentes de `pid`. Windows e falhas de `ps` devolvem lista vazia. */
export function listDescendants(pid: number): number[] {
	if (process.platform === "win32") return [];
	try {
		const out = execFileSync("ps", ["-axo", "pid=,ppid="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return descendantsOf(pid, parseProcessPairs(out));
	} catch {
		return [];
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: existe, mas não é nosso. Para a trava, conta como vivo.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Manda `signal` a cada pid; processos já mortos são ignorados. */
export function signalProcesses(pids: Iterable<number>, signal: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch {
			/* já morreu ou não é nosso */
		}
	}
}
