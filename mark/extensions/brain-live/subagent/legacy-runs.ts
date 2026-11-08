/** Legacy job metadata: read only, for safe orphan cleanup. No replay. */
import * as fs from "node:fs";
import * as path from "node:path";
import { hostname } from "node:os";
import type { SingleResult } from "./runner.ts";
import { ownerMayBeAlive, type ProcessIdentity } from "./process-owner.ts";

/** Retomadas por slot. Depois disso a tarefa falha com motivo, nunca em laço. */
export const MAX_RESUMES = 2;

/** O que precisa sobreviver à morte do pai para um slot ser retomado. */
export interface DurableRunState {
	slot: number;
	agent: string;
	agentSource: SingleResult["agentSource"];
	/** Diretório do slot. */
	dir: string;
	/** Sessão durável do filho (`--session`). */
	sessionDir: string;
	cwd: string;
	model?: string;
	modelLabel?: string;
	thinking?: string;
	tools?: string[];
	promptPath?: string;
	briefPath?: string;
	/** argv completo da retomada: os mesmos flags, sem mensagem. */
	resumeArgs: string[];
	/** pi que lançou este filho. */
	parentPid: number;
	/** pi filho em execução; ausente quando ninguém está rodando. */
	childPid?: number;
	childIdentity?: ProcessIdentity;
	/** Intenção publicada antes de spawn; true sem confirmação nunca autoriza replay. */
	spawnPending?: boolean;
	startedAt: number;
	/** Quantas retomadas este slot já gastou. */
	resumes: number;
	/** Slot concluído: `result.json` tem a palavra final. */
	done?: boolean;
	step?: number;
}

/** Backstop para queda entre spawn e persistência do childPid. O host continua dono do lock. */
export function sessionMayBeOwned(run: DurableRunState): boolean {
	try {
		fs.statSync(`${run.sessionDir}.lock`);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	try {
		const owner = JSON.parse(fs.readFileSync(path.join(run.sessionDir, "owner.json"), "utf8"));
		if (typeof owner.host === "string" && owner.host !== hostname()) return true;
		if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return true;
		return ownerMayBeAlive(owner.pid, owner.pid === run.childPid ? run.childIdentity : undefined);
	} catch {
		// Lock sem dono legível: não remover nem adivinhar que a sessão está livre.
		return true;
	}
}

export function jobRunDir(baseDir: string, sessionId: string, jobId: string): string {
	return path.join(baseDir, sessionId, `${jobId}.d`);
}

/** Remove o diretório de execução do job (o registro guarda o resultado). */
export function removeJobRunDir(baseDir: string, sessionId: string, jobId: string): void {
	try {
		fs.rmSync(jobRunDir(baseDir, sessionId, jobId), { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}
