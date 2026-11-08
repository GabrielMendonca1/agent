/**
 * Agent Spinner
 *
 * Troca o spinner de "working" pela logo Pi da Garime em miniatura
 * (meios-blocos, 4x2 caracteres) se montando bloco a bloco e pulsando. Sem bold/brilho — só tons do tema (text/muted/dim), funciona
 * em 911-day e 911-night. A mensagem de status aparece ao lado da logo.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// Grade nativa 4x4 da logo
const GRID = ["###.", "#.#.", "##.#", "#..#"];

type Cell = { r: number; c: number };

function filledCells(): Cell[] {
	const cells: Cell[] = [];
	for (let r = 0; r < 4; r++)
		for (let c = 0; c < 4; c++) if (GRID[r][c] === "#") cells.push({ r, c });
	// ordem de montagem: varredura diagonal
	cells.sort((a, b) => a.r + a.c - (b.r + b.c) || a.r - b.r);
	return cells;
}

const CELLS = filledCells();
const INDEX: number[][] = GRID.map((row, r) =>
	row.split("").map((_, c) => CELLS.findIndex((cell) => cell.r === r && cell.c === c)),
);

type ColorFn = ((s: string) => string) | null;

/**
 * Renderiza um frame em meios-blocos (4 chars x 2 linhas). Cada caractere
 * cobre duas células (topo/baixo); a cor vem da célula mais recente visível.
 */
function frame(colorOf: (index: number) => ColorFn): string {
	const lines: string[] = [];
	for (let rp = 0; rp < 4; rp += 2) {
		let line = "";
		for (let c = 0; c < 4; c++) {
			const ti = INDEX[rp][c];
			const bi = INDEX[rp + 1][c];
			const topFn = ti >= 0 ? colorOf(ti) : null;
			const botFn = bi >= 0 ? colorOf(bi) : null;
			const ch = topFn && botFn ? "█" : topFn ? "▀" : botFn ? "▄" : " ";
			const fn = topFn && botFn ? (ti > bi ? topFn : botFn) : (topFn ?? botFn);
			line += fn ? fn(ch) : " ";
		}
		lines.push(line);
	}
	return lines.join("\n");
}

function buildFrames(theme: Theme): string[] {
	const solid = (s: string) => theme.fg("text", s);
	const soft = (s: string) => theme.fg("muted", s);
	const ghost = (s: string) => theme.fg("dim", s);

	const frames: string[] = [];

	// 1) montagem: blocos surgem um a um (chegam suaves e assentam sólidos)
	for (let k = 1; k <= CELLS.length; k++) {
		frames.push(
			frame((i) => {
				if (i >= k) return null;
				if (i === k - 1) return soft; // recém-chegado
				return solid;
			}),
		);
	}

	// 2) pulso suave: respira e volta
	frames.push(frame(() => solid));
	frames.push(frame(() => solid));
	frames.push(frame(() => soft));
	frames.push(frame(() => ghost));
	frames.push(frame(() => soft));
	frames.push(frame(() => solid));

	return frames;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({
			frames: buildFrames(ctx.ui.theme),
			intervalMs: 100,
		});
	});
}
