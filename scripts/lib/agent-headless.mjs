/** Minimal headless resources: project policy and subagents, without interactive UI. */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Entradas de `extensions[]` mantidas (casa por sufixo do caminho, sem `.ts`). */
export const HEADLESS_EXTENSIONS = Object.freeze(["brain-live/project-prompt", "brain-live/subagent"]);
/** Skills de engenharia mantidas (nome da pasta dentro de cada raiz de skills). */
export const HEADLESS_SKILLS = Object.freeze(["debug", "tdd", "review", "pr", "handoff"]);
/** Chaves de settings que só fazem sentido com TUI ou com recursos que o perfil não carrega. */
const DROPPED_KEYS = ["theme", "themes", "tuiMode", "prompts", "packages", "hideThinkingBlock", "terminal", "editorPaddingX"];

const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.ts$/, "");

export function headlessSettings(full, { exists = existsSync } = {}) {
	const out = { ...full };
	for (const key of DROPPED_KEYS) delete out[key];
	// Uma entrada por extensão: a última que não foi excluída por um `-<caminho>` do settings completo.
	// (o settings do Agent lista a cópia legada do overlay, a exclui com `-…/index.ts` e acrescenta a da release;
	// manter as duas carrega a mesma tool duas vezes e o Pi recusa: "Tool subagent conflicts".)
	const entries = (full.extensions ?? []).filter((e) => typeof e === "string");
	const excluded = entries.filter((e) => e.startsWith("-")).map((e) => norm(e.slice(1)).replace(/\/index$/, ""));
	out.extensions = [];
	for (const name of HEADLESS_EXTENSIONS) {
		const suffix = `/agent/extensions/${name}`;
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
