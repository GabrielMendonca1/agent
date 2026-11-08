/**
 * Perfil "Mark headless": settings.json mínimo para `pi -p --mode json`.
 * Deriva do settings completo e mantém Juice, subagent e skills de engenharia.
 * O perfil é só outro settings.json no agent dir; não muda o overlay/updater.
 *
 * Carrega:   Juice (política simple/complex, ledger/orçamento) e `subagent`; skills de engenharia.
 * Não carrega: tui, editor/logo/hints, peers, megamind, whimsical, accounts,
 *             as demais extensões brain-live (ask-user, btw, cache-keeper, checks, ...),
 *             prompts/temas/pacotes.
 * O Juice em si (preload `runtime.mjs` + preferences.json em MARK_JUICE_HOME) vem do launcher/env,
 * não do settings; `brain-live/juice.ts` é a extensão que aplica o modo no prompt.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Entradas de `extensions[]` mantidas (casa por sufixo do caminho, sem `.ts`). */
export const HEADLESS_EXTENSIONS = Object.freeze(["brain-live/juice", "brain-live/subagent"]);
/** Skills de engenharia mantidas (nome da pasta dentro de cada raiz de skills). */
export const HEADLESS_SKILLS = Object.freeze(["debug", "tdd", "review", "pr", "handoff"]);
/** Chaves de settings que só fazem sentido com TUI ou com recursos que o perfil não carrega. */
const DROPPED_KEYS = ["theme", "themes", "tuiMode", "prompts", "packages", "hideThinkingBlock", "terminal", "editorPaddingX"];

const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.ts$/, "");

export function headlessSettings(full, { exists = existsSync } = {}) {
	const out = { ...full };
	for (const key of DROPPED_KEYS) delete out[key];
	// Uma entrada por extensão: a última que não foi excluída por um `-<caminho>` do settings completo.
	// (o settings do Mark II lista a cópia legada do overlay, a exclui com `-…/index.ts` e acrescenta a da release;
	// manter as duas carrega a mesma tool duas vezes e o Pi recusa: "Tool subagent conflicts".)
	const entries = (full.extensions ?? []).filter((e) => typeof e === "string");
	const excluded = entries.filter((e) => e.startsWith("-")).map((e) => norm(e.slice(1)).replace(/\/index$/, ""));
	out.extensions = [];
	for (const name of HEADLESS_EXTENSIONS) {
		const suffix = `/mark/extensions/${name}`;
		const hits = entries.filter((e) => !/^[-!+]/.test(e) && norm(e).endsWith(suffix) && !excluded.includes(norm(e)));
		if (hits.length) out.extensions.push(hits[hits.length - 1]);
	}
	const skills = [];
	for (const root of full.skills ?? []) {
		if (typeof root !== "string" || /^[-!+]/.test(root)) continue;
		for (const name of HEADLESS_SKILLS) {
			const dir = join(root, name);
			if (!skills.includes(dir) && exists(join(dir, "SKILL.md"))) skills.push(dir);
		}
	}
	out.skills = skills;
	out.quietStartup = true;
	return out;
}
