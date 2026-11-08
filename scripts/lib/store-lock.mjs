/**
 * Exclusão mútua para o store de releases.
 *
 * O problema real que isto resolve: dois agentes (ou duas abas) rodando o updater
 * ao mesmo tempo constroem releases diferentes e, no fim, cada um aponta `current`
 * para a sua. O último a terminar apaga o trabalho do outro do runtime ativo — sem
 * erro, sem aviso, e a única pista é um symlink que mudou sozinho. Já aconteceu.
 *
 * São duas defesas, e elas cobrem coisas diferentes:
 *
 * 1. LOCK: só um updater mexe no store por vez. Cobre o caso comum.
 * 2. COMPARE-AND-SWAP: mesmo com o lock, `current` pode ter mudado entre o começo
 *    da construção e a ativação — por um rollback manual, por outra ferramenta, ou
 *    por um updater de outra geração que não conhece este lock. Antes de trocar o
 *    ponteiro, conferimos que ele ainda é o que era quando começamos.
 *
 * O lock é um arquivo com o pid dono. Se o dono morreu, o lock é roubado: um
 * updater interrompido no meio não pode deixar a máquina travada para sempre.
 */
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_NAME = ".update.lock";
const RECLAIM_NAME = ".update.lock.reclaim";

function lockPath(store) {
	return join(store, LOCK_NAME);
}

/** Um pid vivo é dono legítimo; um pid morto deixou lixo. */
export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM significa que o processo existe e pertence a outro usuário.
		return error?.code === "EPERM";
	}
}

function readLock(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		// Ausência não é corrupção: depois de ENOENT outro processo pode publicar um lock vivo.
		if (error?.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return null;
		throw error; // Falha de I/O não prova que o dono abandonou o lock.
	}
}

/**
 * Publica `payload` em `file` de forma atômica e exclusiva: o conteúdo completo é escrito num
 * arquivo temporário e então ligado (hard link) ao destino. `link` falha com EEXIST se o destino
 * existe, e o destino nunca é visível vazio ou pela metade. Devolve false se já existia.
 */
function publishExclusive(file, payload) {
	const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	writeFileSync(temp, payload, { flag: "wx" });
	try {
		linkSync(temp, file);
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(temp, { force: true });
	}
}

function busyError(store, file, existing) {
	const since = existing.startedAt ? ` desde ${existing.startedAt}` : "";
	return new Error(
		`O store ${store} está em uso por ${existing.holder ?? "outro processo"} (pid ${existing.pid})${since}.\n` +
			`Dois updaters ao mesmo tempo se sobrescrevem: o último a terminar apaga a release do outro.\n` +
			`Espere ele terminar, ou remova ${file} se tiver certeza de que aquele processo morreu.`,
	);
}

/**
 * Remove um lock que parecia abandonado. Ler-e-depois-apagar não é atômico: entre a leitura e o
 * unlink, outro processo pode ter roubado e recriado o lock, e o unlink apagaria o lock vivo dele.
 * Por isso o roubo é serializado por um guard exclusivo e o estado é relido DENTRO do guard.
 * Dentro do guard ninguém mais apaga o lock, e criar só é possível com ele ausente; logo o
 * unlink só atinge o lock que acabamos de reconferir. O guard é de vida curta (um read + unlink);
 * se encontrarmos um guard alheio, recusamos em vez de adivinhar — não há como reclamar o guard
 * com segurança sem recair no mesmo problema.
 */
function reclaimStale(store, file) {
	const guard = join(store, RECLAIM_NAME);
	const guardPayload = JSON.stringify({ pid: process.pid, holder: "reclaim", startedAt: new Date().toISOString() });
	if (!publishExclusive(guard, guardPayload)) {
		const other = readLock(guard) ?? {};
		throw new Error(
			`Outro processo está recuperando o lock de ${store} (pid ${other.pid ?? "desconhecido"}).\n` +
				`Tente de novo em instantes; se confirmar que o dono do guard morreu, remova somente ${guard}.`,
		);
	}
	try {
		const existing = readLock(file);
		if (existing === undefined) return;
		if (existing && processAlive(existing.pid)) throw busyError(store, file, existing);
		rmSync(file, { force: true });
	} finally {
		rmSync(guard, { force: true });
	}
}

/**
 * Toma o lock do store. Devolve `{ release() }`.
 * Lança com mensagem acionável se outro processo vivo estiver com ele.
 */
export function acquireStoreLock(store, { holder = "agent-update", now = Date.now } = {}) {
	mkdirSync(store, { recursive: true });
	const file = lockPath(store);
	// O nonce identifica ESTA aquisição: pid sozinho não distingue duas aquisições no mesmo processo
	// nem um lock roubado e retomado por um pid reciclado.
	const nonce = randomBytes(16).toString("hex");
	const payload = JSON.stringify({ pid: process.pid, holder, nonce, startedAt: new Date(now()).toISOString() });

	for (let attempt = 0; attempt < 2; attempt++) {
		if (publishExclusive(file, payload)) {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				// Só apaga se ainda for nosso: um lock roubado por outro não é nosso para soltar.
				if (readLock(file)?.nonce === nonce) rmSync(file, { force: true });
			};
			return { release, file };
		}
		const existing = readLock(file);
		if (existing && processAlive(existing.pid)) throw busyError(store, file, existing);
		// Dono morto ou lock ilegível: rouba (serializado) e tenta de novo.
		reclaimStale(store, file);
	}
	throw new Error(`Não consegui tomar o lock de ${store} (disputa persistente em ${file})`);
}

/** Alvo atual do symlink `current`, ou null quando ainda não há release ativa. */
export function readCurrentTarget(store) {
	try {
		return readlinkSync(join(store, "current"));
	} catch {
		return null;
	}
}

/**
 * Compare-and-swap: `current` ainda é o que era quando começamos?
 * Construir uma release leva muitos minutos; nesse intervalo o mundo pode ter mudado.
 */
export function assertCurrentUnchanged(store, expected, { force = false } = {}) {
	const actual = readCurrentTarget(store);
	if (actual === expected) return;
	if (force) {
		console.warn(`Aviso: current mudou durante a construção (${expected ?? "nenhum"} -> ${actual ?? "nenhum"}); --force ignorando.`);
		return;
	}
	throw new Error(
		`A release ativa mudou enquanto esta atualização era construída.\n` +
			`  quando começamos: ${expected ?? "nenhuma"}\n` +
			`  agora:            ${actual ?? "nenhuma"}\n` +
			`Alguém promoveu ou reverteu uma release no meio do caminho. Ativar agora apagaria esse trabalho\n` +
			`do runtime ativo. Rode o updater de novo para construir sobre o estado atual, ou repita com --force\n` +
			`se a intenção for justamente sobrescrever.`,
	);
}
