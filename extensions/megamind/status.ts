/**
 * Ícone do Megamind na barra de status: `◈ megamind`, sem mensagem no
 * transcript. A cor diz o estado da conexão — destaque conectado, aviso
 * enquanto (re)conecta, erro quando caiu. A prioridade do projeto continua em
 * seu próprio item da barra.
 *
 * Com mais de uma empresa (ARCA, Omni) a barra também diz de quem é o Megamind
 * desta sessão: `◈ megamind · Omni`.
 */

export const MEGAMIND_GLYPH = "◈";
export const MEGAMIND_STATUS_KEY = "megamind";

export type MegamindState = "connecting" | "online" | "reconnecting" | "offline";

const TONES: Record<MegamindState, string> = {
	connecting: "warning",
	online: "accent",
	reconnecting: "warning",
	offline: "error",
};

export interface StatusTheme {
	fg(color: string, text: string): string;
}

export function megamindStatus(state: MegamindState, theme: StatusTheme, label?: string): string {
	const base = `${theme.fg(TONES[state], MEGAMIND_GLYPH)} ${theme.fg("dim", "megamind")}`;
	return label ? `${base}${theme.fg("dim", ` · ${label}`)}` : base;
}
