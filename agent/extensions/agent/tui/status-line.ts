/** Native footer status formatting. No widget, footer reference or animation. */
export const MODE_ICON = { complex: "\u{F09D1}", simple: "\u{F0241}" };
/** Unpainted status follows the native terminal foreground across theme swaps. */
export function modeStatus(mode: "simple" | "complex"): string {
 return `${MODE_ICON[mode]} ${mode}`;
}
function rgb(hex: string, text: string): string {
 const value = Number.parseInt(hex.slice(1), 16);
 return `\x1b[38;2;${value >> 16};${(value >> 8) & 0xff};${value & 0xff}m${text}\x1b[39m`;
}

type Mascot = { color: string; left: string; right: string; eyes: string };
const ROUND_L = "\uE0B6", ROUND_R = "\uE0B4"; // semicírculos
const SLOPE_UP = "\uE0BA", SLOPE_DOWN = "\uE0B8"; // ◢ ◣
const SLANT_TOP = "\uE0BC", SLANT_BOTTOM = "\uE0BE"; // ◤ ◥
// Olhos, formas e cores fixos por papel.
const SUBAGENT_MASCOTS: Record<string, Mascot> = {
	worker: { color: "#E8772E", left: ROUND_L, right: ROUND_R, eyes: "″" }, // bola laranja, olhos inclinados
	scout: { color: "#3B82F6", left: SLANT_BOTTOM, right: SLOPE_DOWN, eyes: "‥" }, // cilindro azul inclinado
	planner: { color: "#8B5CF6", left: SLOPE_UP, right: SLANT_TOP, eyes: "″" }, // losango roxo
	reviewer: { color: "#3FB5A5", left: "▐", right: "▌", eyes: "‖" }, // quadrado teal
	visual: { color: "#E84A93", left: SLOPE_UP, right: SLOPE_DOWN, eyes: "‖" }, // triângulo rosa
};
const UNKNOWN_MASCOT: Mascot = { color: "#8A8A8A", left: ROUND_L, right: ROUND_R, eyes: "‥" };
const EYE_WHITE = "#FFFFFF";
const MAX_MASCOTS = 5;

function mascotFace(mascot: Mascot): string {
	const value = Number.parseInt(mascot.color.slice(1), 16);
	const bg = `\x1b[48;2;${value >> 16};${(value >> 8) & 0xff};${value & 0xff}m`;
	return rgb(mascot.color, mascot.left) + bg + rgb(EYE_WHITE, mascot.eyes) + "\x1b[49m" + rgb(mascot.color, mascot.right);
}

/** Static faces from session-owned running jobs, never from rendered status text. */
export function subagentMascots(roles: readonly string[]): string | undefined {
 if (!roles.length) return undefined;
 const faces = roles.slice(0, MAX_MASCOTS).map(name => {
  const role = Object.keys(SUBAGENT_MASCOTS).find(key => name === key || name.startsWith(`${key}-`));
  return mascotFace(role ? SUBAGENT_MASCOTS[role] : UNKNOWN_MASCOT);
 });
 return faces.join(" ") + (roles.length > faces.length ? ` +${roles.length - faces.length}` : "");
}
