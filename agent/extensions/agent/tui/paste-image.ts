/**
 * Agent Paste Image (estilo Claude Code)
 *
 * Ao colar texto que contém caminho(s) de imagem, o caminho vira [Image #N]
 * imediatamente no editor. No envio, cada [Image #N] é anexado como imagem
 * de verdade, inclusive na resposta livre do ask_user. Caminhos crus também
 * são detectados no input principal (não em resultados de ferramentas).
 */

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { LADO_MAX, precisaReduzir } from "../lib/image-normalize.ts";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB por imagem

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

// caminhos absolutos ou ~/..., com espaços escapados (\ ), entre aspas, ou
// com espaços sem escape (validados com existsSync antes de anexar)
const PATH_RE =
	/(?:"((?:\/|~\/)[^"\n]+?\.(?:png|jpe?g|gif|webp|bmp))"|'((?:\/|~\/)[^'\n]+?\.(?:png|jpe?g|gif|webp|bmp))'|((?:\/|~\/)[^\n]+?\.(?:png|jpe?g|gif|webp|bmp)))/gi;

const PASTE_RE = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
const PLACEHOLDER_RE = /\[Image #(\d+)\]/g;
const PLACEHOLDER_END_RE = /\[Image #\d+\]$/;
const ANSWER_PREFIX_RE = /^Resposta do usuário(?: \([^)]*\))?: /;
const BACKSPACES = new Set(["\x7f", "\x08"]);

const LOG = `${homedir()}/.pi/agent/garime-debug.log`;
function dbg(msg: string): void {
	// Sync append on every click/paste: opt-in only.
	if (process.env.GARIME_DEBUG !== "1") return;
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [paste-image] ${msg}\n`);
	} catch {}
}

function resolvePath(raw: string): string {
	let p = raw.replace(/\\ /g, " ");
	if (p.startsWith("~/")) p = homedir() + p.slice(1);
	return p;
}

async function loadImage(path: string): Promise<ImageContent | null> {
	try {
		if (!existsSync(path)) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_BYTES) return null;
		const ext = path.split(".").pop()?.toLowerCase() ?? "";
		const mimeType = MIME[ext];
		if (!mimeType) return null;
		const bytes = readFileSync(path);
		// Screenshot Retina tem 3000+ px: a Anthropic recusa >2000 px em requests com
		// várias imagens e cobra ~7k tokens por uma dessas. Entra no transcript já reduzida.
		if (precisaReduzir(bytes)) {
			const r = await resizeImage(bytes, mimeType, { maxWidth: LADO_MAX, maxHeight: LADO_MAX });
			if (r) {
				dbg(`reduzida ${basename(path)}: ${r.originalWidth}x${r.originalHeight} → ${r.width}x${r.height}`);
				return { type: "image", data: r.data, mimeType: r.mimeType };
			}
		}
		return { type: "image", data: bytes.toString("base64"), mimeType };
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	// placeholder number -> caminho resolvido
	const pending = new Map<string, string>();
	let counter = 0;
	const asks = new Map<string, { pending: Map<string, string>; answer?: string }>();
	const subscriptions: (() => void)[] = [];

	function reset() {
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		pending.clear();
		asks.clear();
		tuiRef = null;
	}

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "ask_user" && ctx.mode === "tui") {
			asks.set(event.toolCallId, { pending: new Map() });
		}
	});
	pi.on("agent_end", () => { asks.clear(); });
	pi.on("session_shutdown", reset);

	// captura da TUI p/ achar o editor (apagar placeholder de uma vez)
	let tuiRef: any = null;

	function isEditor(c: unknown): boolean {
		const e = c as Record<string, unknown>;
		return (
			!!e &&
			typeof e.getCursor === "function" &&
			typeof e.getLines === "function" &&
			typeof e.handleInput === "function" &&
			typeof e.getPaddingX === "function"
		);
	}

	function findEditor(root: unknown, depth = 0): any | null {
		if (!root || depth > 12) return null;
		if (isEditor(root)) return root;
		const children = (root as { children?: unknown[] }).children;
		if (Array.isArray(children)) {
			for (const child of children) {
				const hit = findEditor(child, depth + 1);
				if (hit) return hit;
			}
		}
		return null;
	}

	pi.on("session_start", async (_event, ctx) => {
		reset();
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget("garime-paste-image", (tui) => {
			tuiRef = tui;
			return { render: () => [], invalidate() {} };
		});

		// Backspace logo após um [Image #N] apaga o placeholder inteiro
		subscriptions.push(ctx.ui.onTerminalInput((data) => {
			if (!BACKSPACES.has(data) || !tuiRef) return undefined;
			try {
				const ed = findEditor(tuiRef.layoutRoot);
				if (!ed) return undefined;
				const { line, col } = ed.getCursor();
				const before = (ed.getLines()[line] ?? "").slice(0, col);
				const m = PLACEHOLDER_END_RE.exec(before);
				if (!m) return undefined;
				dbg(`backspace atômico: ${m[0]}`);
				for (let i = 0; i < m[0].length; i++) ed.handleInput("\x7f");
				tuiRef.requestRender?.();
				return { consume: true };
			} catch {
				return undefined;
			}
		}));

		// Colou path de imagem -> vira [Image #N] na hora, dentro do próprio paste
		subscriptions.push(ctx.ui.onTerminalInput((data) => {
			// Só uma pergunta pode possuir o editor. Em concorrência, não adivinhar.
			if (asks.size > 1) return undefined;
			const ask = asks.values().next().value;
			if (ask && !isKeyRelease(data) && matchesKey(data, "enter")) {
				ask.answer = ctx.ui.getEditorText().trim();
			}
			if (!data.includes("\x1b[200~")) return undefined;
			let changed = false;
			const out = data.replace(PASTE_RE, (paste, inner: string) => {
				const replaced = inner.replace(PATH_RE, (match, g1, g2, g3) => {
					const path = resolvePath(g1 ?? g2 ?? g3 ?? match);
					if (!existsSync(path)) return match;
					counter++;
					(ask?.pending ?? pending).set(String(counter), path);
					changed = true;
					dbg(`paste -> [Image #${counter}] ${path}`);
					return `[Image #${counter}]`;
				});
				return changed ? `\x1b[200~${replaced}\x1b[201~` : paste;
			});
			return changed ? { data: out } : undefined;
		}));
	});

	async function resolve(textIn: string, pending: Map<string, string>, rawPaths: boolean) {
		const images: ImageContent[] = [];

		// replace() é síncrono: primeiro resolve os caminhos, depois carrega (com resize async)
		const achados: { match: string; path: string; n?: string }[] = [];
		textIn.replace(PLACEHOLDER_RE, (match, n: string) => {
			const path = pending.get(n);
			if (path) achados.push({ match, path, n });
			return match;
		});
		if (rawPaths) textIn.replace(PATH_RE, (match, g1, g2, g3) => {
			achados.push({ match, path: resolvePath(g1 ?? g2 ?? g3 ?? match) });
			return match;
		});
		const carregadas = new Map<string, ImageContent | null>();
		for (const a of achados) if (!carregadas.has(a.path)) carregadas.set(a.path, await loadImage(a.path));

		// 1) placeholders criados no paste
		let text = textIn.replace(PLACEHOLDER_RE, (match, n: string) => {
			const path = pending.get(n);
			const img = path ? carregadas.get(path) : null;
			if (!path) return match;
			pending.delete(n);
			if (!img) return `[image unavailable: ${basename(path)}]`;
			images.push(img);
			return `[image: ${basename(path)}]`;
		});

		// 2) paths crus digitados/enviados sem passar pelo paste
		if (rawPaths) text = text.replace(PATH_RE, (match, g1, g2, g3) => {
			const path = resolvePath(g1 ?? g2 ?? g3 ?? match);
			const img = carregadas.get(path);
			if (!img) return match;
			images.push(img);
			return `[image: ${basename(path)}]`;
		});

		return { text, images };
	}

	pi.on("input", async (event) => {
		if (event.source !== "interactive") return { action: "continue" };
		const { text, images } = await resolve(event.text, pending, true);
		if (!images.length && text === event.text) return { action: "continue" };
		return { action: "transform", text, images: [...(event.images ?? []), ...images] };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "ask_user") return;
		const ask = asks.get(event.toolCallId);
		if (!ask) return;
		asks.delete(event.toolCallId);
		// Esc/abort deixam texto no editor: invalidar os placeholders, sem expor paths
		// crus que o fallback do próximo input poderia anexar de novo.
		const editor = ctx.ui.getEditorText();
		const cleaned = editor.replace(PLACEHOLDER_RE, (match, n: string) =>
			ask.pending.has(n) ? `[image not sent: ${basename(ask.pending.get(n)!)}]` : match);
		if (cleaned !== editor) ctx.ui.setEditorText(cleaned);
		if (event.isError || !ask.answer) return;
		// ask_user may tag the answer with its source: "Resposta do usuário (terminal): …".
		const answer = ask.answer;
		const index = event.content.findIndex(c => c.type === "text" && ANSWER_PREFIX_RE.test(c.text)
			&& c.text.replace(ANSWER_PREFIX_RE, "") === answer);
		const block = event.content[index];
		if (!block || block.type !== "text") return;
		const expected = block.text;
		const { text, images } = await resolve(expected, ask.pending, false);
		if (text === expected && !images.length) return;
		const content = [...event.content];
		content[index] = { type: "text", text };
		return { content: [...content, ...images], structuredContent: event.structuredContent };
	});
}
