/**
 * Mark Click-to-Cursor
 *
 * Estilo Claude Code: clicar dentro do editor move o cursor até o ponto
 * clicado. Como a árvore de layout do pi não expõe o editor como box,
 * usamos o CURSOR_MARKER (âncora do cursor de hardware) pra descobrir onde
 * o cursor está na tela e navegamos relativamente com setas sintéticas.
 *
 * Best-effort sobre APIs internas — em caso de erro, o fluxo normal segue.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

const LOG = `${homedir()}/.pi/agent/garime-debug.log`;
function dbg(msg: string): void {
	// Sync append on every click/paste: opt-in only.
	if (process.env.GARIME_DEBUG !== "1") return;
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [click] ${msg}\n`);
	} catch {}
}

// todos os eventos SGR de mouse dentro de um chunk (motion, press, release)
const EVENT_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

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

/** Procura a instância do editor na árvore de componentes. */
export function findEditor(root: unknown, depth = 0): any | null {
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

type Layout = Array<{ text: string; hasCursor?: boolean; cursorPos?: number }>;

function cursorLine(layout: Layout): number {
	const i = layout.findIndex((l) => l.hasCursor);
	return i < 0 ? 0 : i;
}

/** Posição do cursor de hardware na tela (0-based), via CURSOR_MARKER. */
function screenCursor(t: any): { row: number; col: number } | null {
	const height = t.terminal?.rows ?? 24;
	const lines: string[] | undefined = t.currentLayout?.lines;
	if (!lines) return null;
	const top = Math.max(0, lines.length - height);
	for (let r = lines.length - 1; r >= top; r--) {
		const i = lines[r].indexOf(CURSOR_MARKER);
		if (i !== -1) return { row: r - top, col: visibleWidth(lines[r].slice(0, i)) };
	}
	return null;
}

/** Linhas de conteúdo do editor na tela (0-based), mais a coluna onde o texto começa. */
export function editorScreenRows(t: any): { firstRow: number; lastRow: number; contentStart: number } | null {
	const ed = findEditor(t.layoutRoot);
	if (!ed) return null;
	const anchor = screenCursor(t);
	if (!anchor) return null;

	const width = ed.lastWidth ?? 78;
	const layout = ed.layoutText(width) as Layout;
	if (!Array.isArray(layout) || layout.length === 0) return null;

	const V = cursorLine(layout);
	const scroll = ed.scrollOffset ?? 0;
	const firstRow = anchor.row - (V - scroll);
	const visibleCount = Math.min(layout.length - scroll, layout.length);
	const cur = layout[V];
	const beforeCursor = cur.text.slice(0, cur.cursorPos ?? 0);
	return {
		firstRow,
		lastRow: firstRow + visibleCount - 1,
		contentStart: anchor.col - visibleWidth(beforeCursor),
	};
}

/** Tenta mover o cursor do editor até o ponto clicado. true = consumiu. */
function clickToCursor(t: any, clickX: number, clickY: number): boolean {
	const ed = findEditor(t.layoutRoot);
	if (!ed) return false;
	const box = editorScreenRows(t);
	if (!box) return false;

	const width = ed.lastWidth ?? 78;
	let layout = ed.layoutText(width) as Layout;
	if (!Array.isArray(layout) || layout.length === 0) return false;

	const V = cursorLine(layout);
	const scroll = ed.scrollOffset ?? 0;
	const { firstRow, lastRow, contentStart } = box;
	if (clickY < firstRow || clickY > lastRow) {
		dbg(`click y=${clickY} fora do editor (${firstRow}..${lastRow})`);
		return false;
	}

	// --- vertical ---
	const target = Math.max(0, Math.min(clickY - firstRow + scroll, layout.length - 1));
	let v = V;
	for (let i = 0; i < 200 && v !== target; i++) {
		ed.handleInput(v < target ? DOWN : UP);
		const nv = cursorLine(ed.layoutText(width));
		if (nv === v) break;
		v = nv;
	}

	// --- horizontal ---
	layout = ed.layoutText(width);
	v = cursorLine(layout);
	const line = layout[v];
	if (!line) return true;
	const targetCol = Math.max(0, Math.min(clickX - contentStart, line.text.length));
	let col = line.cursorPos ?? 0;
	for (let i = 0; i < 400 && col !== targetCol; i++) {
		const dir = col < targetCol ? RIGHT : LEFT;
		ed.handleInput(dir);
		const lay = ed.layoutText(width) as Layout;
		const nv = cursorLine(lay);
		if (nv !== v) {
			ed.handleInput(dir === RIGHT ? LEFT : RIGHT);
			break;
		}
		const nc = lay[nv].cursorPos ?? 0;
		if (nc === col) break;
		col = nc;
	}
	dbg(`click ok -> linha ${target} col ${targetCol}`);
	return true;
}

const MULTI_CLICK_MS = 500;

/**
 * A seleção da TUI é retangular sobre a tela inteira, então uma seleção de
 * várias linhas dentro do input arrasta junto as bordas da caixa do editor
 * (`│`) e o preenchimento até a margem. Aqui devolvemos só o texto de dentro.
 * Só é aplicado quando a seleção tocou as linhas do editor.
 */
export function stripEditorFrame(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			line
				.replace(/^[ \t]*\u2502[ ]?/, "")
				.replace(/[ ]*\u2502[ \t]*$/, "")
				.replace(/[ \t]+$/, ""),
		)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let patched = false;

	pi.on("session_start", async (_event, ctx) => {
		dbg(`session_start mode=${ctx.mode} patched=${patched}`);
		if (ctx.mode !== "tui" || patched) return;

		// widget invisível só pra capturar a instância da TUI
		ctx.ui.setWidget("garime-click", (tui) => {
			if (!patched) {
				patched = true;
				const t = tui as any;
				if (typeof t.handleViewportInput === "function") {
					const orig = t.handleViewportInput.bind(t);
					dbg("patch installed");

					// Um clique simples no editor move o cursor; arrastar continua sendo
					// seleção do pi (que copia no release). Por isso o press nunca é
					// consumido: ele é repassado pra TUI ancorar a seleção, e só no
					// release, se não houve arrasto, movemos o cursor.
					let pending: { x: number; y: number } | null = null;
					let dragged = false;
					let lastPressAt = 0;
					let lastPressPos = { x: -1, y: -1 };
					let multiClick = false;
					let selectionTouchedEditor = false;

					// limpa as bordas da caixa quando a seleção veio de dentro do input
					const origCopy = t.copySelection;
					if (typeof origCopy === "function") {
						t.copySelection = async (text: string) => {
							// nunca logamos o conteúdo copiado
							dbg(`copy (editor=${selectionTouchedEditor})`);
							return origCopy(selectionTouchedEditor ? stripEditorFrame(text) : text);
						};
					}

					const touchesEditor = (rows: number[]): boolean => {
						try {
							const box = editorScreenRows(t);
							if (!box) return false;
							const top = Math.min(...rows);
							const bottom = Math.max(...rows);
							return bottom >= box.firstRow && top <= box.lastRow;
						} catch {
							return false;
						}
					};

					t.handleViewportInput = (data: string) => {
						let deferredClick: { x: number; y: number } | null = null;
						try {
							if (data.includes("\x1b[<") && !t.hasOverlay?.()) {
								if (process.env.GARIME_CLICK_TRACE) dbg(`raw ${JSON.stringify(data)}`);
								for (const m of data.matchAll(EVENT_RE)) {
									const button = Number(m[1]);
									const x = Number(m[2]) - 1;
									const y = Number(m[3]) - 1;
									const release = m[4] === "m";
									const motion = (button & 32) !== 0;
									const leftButton = (button & 3) === 0 && (button & 64) === 0;
									if (!leftButton) continue;

									if (motion) {
										if (pending && (x !== pending.x || y !== pending.y)) dragged = true;
										// Motion na MESMA célula do press (jitter sub-célula, típico via
										// herdr) não é arraste. O pi-tui trata qualquer motion como drag e
										// descarta o link OSC 8 pressionado; engolimos o evento aqui.
										if (pending && !dragged && m[0] === data) {
											dbg(`motion na mesma célula engolido (${x},${y})`);
											return { consume: true };
										}
										continue;
									}
									if (!release) {
										const now = Date.now();
										multiClick =
											now - lastPressAt <= MULTI_CLICK_MS && lastPressPos.x === x && lastPressPos.y === y;
										lastPressAt = now;
										lastPressPos = { x, y };
										pending = { x, y };
										dragged = false;
										continue;
									}
									// release
									dbg(`release (${x},${y}) pending=${pending ? `${pending.x},${pending.y}` : "-"} dragged=${dragged} multi=${multiClick}`);
									if (pending && !dragged && !multiClick && x === pending.x && y === pending.y) {
										deferredClick = pending;
									}
									selectionTouchedEditor = touchesEditor([pending?.y ?? y, y]);
									pending = null;
									dragged = false;
								}
							}
						} catch (err) {
							dbg(`erro: ${err}`);
						}

						const result = orig(data);
						if (deferredClick) {
							try {
								if (clickToCursor(t, deferredClick.x, deferredClick.y)) t.requestRender?.();
							} catch (err) {
								dbg(`erro no clique: ${err}`);
							}
						}
						return result;
					};
				}
			}
			return { render: () => [], invalidate() {} };
		});
	});
}
