/**
 * Defasagem entre o checkout git de onde o overlay foi instalado e a instalação em si.
 *
 * O updater grava em `active.json` o `sourceRepo` (raiz do checkout) e o `sourceCommit` (HEAD na
 * hora da ativação). Aqui só se lê git LOCAL — nunca rede — para dizer quantos commits o checkout
 * tem à frente. Nada neste arquivo escreve fora do cache do aviso e nada lança: o aviso de startup
 * é cortesia, e um erro nele vira silêncio.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STALE_NOTICE_ENV = "PI_OVERLAY_STALE_NOTICE";
export const STALE_CACHE_FILE = "stale-notice.json";
export const STALE_CACHE_TTL_MS = 60 * 60 * 1000;
export const STALE_GIT_TIMEOUT_MS = 300;

function git(cwd, args, timeoutMs) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

/**
 * Raiz e HEAD de `dir` quando `dir` é a raiz de um checkout git (tem `.git`, diretório ou arquivo de
 * worktree). Um bundle instalado não tem `.git` e nem chega a invocar o git.
 */
export function checkoutInfo(dir, timeoutMs = 2000) {
	if (!existsSync(join(dir, ".git"))) return undefined;
	const head = git(dir, ["rev-parse", "HEAD"], timeoutMs);
	return head ? { top: dir, head } : undefined;
}

/**
 * Commits em `sourceRepo` entre `sourceCommit` e HEAD. `undefined` quando não dá para saber;
 * `"diverged"` quando `sourceCommit` não é ancestral de HEAD (outro branch: contar commits mentiria).
 */
export function commitsAhead(sourceRepo, sourceCommit, timeoutMs = 2000) {
	if (typeof sourceRepo !== "string" || typeof sourceCommit !== "string" || !existsSync(sourceRepo)) return undefined;
	if (!/^[a-f0-9]{7,64}$/.test(sourceCommit)) return undefined;
	const result = spawnSync("git", ["merge-base", "--is-ancestor", sourceCommit, "HEAD"], {
		cwd: sourceRepo,
		timeout: timeoutMs,
		stdio: "ignore",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.error) return undefined;
	if (result.status === 1) return "diverged";
	if (result.status !== 0) return undefined;
	const count = git(sourceRepo, ["rev-list", "--count", `${sourceCommit}..HEAD`], timeoutMs);
	return count !== undefined && /^\d+$/.test(count) ? Number(count) : undefined;
}

/** O `pi overlay-update` instalado roda o updater do bundle; quem atualiza é o updater do checkout. */
export function staleNoticeText(ahead, sourceRepo) {
	const updater = sourceRepo ? `node ${join(sourceRepo, "scripts", "pi-overlay-update.mjs")}` : "pi overlay-status";
	return `↑ mark-pi: checkout ${ahead} commit${ahead === 1 ? "" : "s"} ahead of the install · ${updater}`;
}

function readCache(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Número de commits à frente para o aviso de startup, com cache de 1h no store. Retorna `undefined`
 * (silêncio) em qualquer dúvida: sem active.json, sem chaves de origem, git ausente/lento, erro.
 */
export function staleAhead(store, { now = Date.now(), timeoutMs = STALE_GIT_TIMEOUT_MS } = {}) {
	try {
		const active = JSON.parse(readFileSync(join(store, "active.json"), "utf8"));
		const { sourceRepo, sourceCommit } = active;
		if (!sourceRepo || !sourceCommit) return undefined;
		const file = join(store, STALE_CACHE_FILE);
		const cache = readCache(file);
		if (
			cache?.sourceRepo === sourceRepo &&
			cache?.sourceCommit === sourceCommit &&
			Number.isFinite(cache?.checkedAt) &&
			now - cache.checkedAt >= 0 &&
			now - cache.checkedAt < STALE_CACHE_TTL_MS &&
			(Number.isInteger(cache?.ahead) || cache?.ahead === null)
		) {
			return cache.ahead ?? undefined;
		}
		const found = commitsAhead(sourceRepo, sourceCommit, timeoutMs);
		// Falha/timeout/divergência também são cacheados (ahead: null, mesmo TTL): sem isso cada abertura
		// pagaria o timeout do git.
		const ahead = Number.isInteger(found) ? found : null;
		try {
			mkdirSync(store, { recursive: true });
			const temporary = `${file}.tmp-${process.pid}`;
			writeFileSync(temporary, `${JSON.stringify({ checkedAt: now, sourceRepo, sourceCommit, ahead })}\n`);
			renameSync(temporary, file);
		} catch {
			/* cache é opcional */
		}
		return ahead ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Uma linha em stderr, só em sessão interativa. `-p`/`--print`/`--mode` são os modos programáticos
 * do Pi (stdout é contrato); fora de TTY também não se escreve nada.
 */
export function maybeStaleNotice({ store, env = process.env, args = [], stderr = process.stderr, stdin = process.stdin } = {}) {
	try {
		if (env[STALE_NOTICE_ENV] === "0") return false;
		if (!stderr.isTTY || !stdin.isTTY) return false;
		if (args.some((arg) => arg === "-p" || arg === "--print" || arg === "--mode" || arg.startsWith("--mode="))) return false;
		const ahead = staleAhead(store);
		if (!ahead || ahead < 1) return false;
		const { sourceRepo } = JSON.parse(readFileSync(join(store, "active.json"), "utf8"));
		stderr.write(`${staleNoticeText(ahead, sourceRepo)}\n`);
		return true;
	} catch {
		return false;
	}
}
