import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import claudeCards from "./claude-cards";
import click from "./click";
import editor from "./editor";
import loader from "./loader";
import logo from "./logo";
import pasteImage from "./paste-image";
import spinner from "./spinner";
import thinking from "./thinking";
import toolDisplay from "./tool-display";

export {
	accentOverride,
	claudeStyleEnabled,
	CC_AGENT_DARK,
	CC_AGENT_LIGHT,
} from "./claude-style";
export { layoutFor, readCount } from "./claude-layout";
// `headerLines` também existe em logo.ts (cabeçalho da sessão): o card entra
// com nome próprio para os dois conviverem no barril.
export {
	callArgs,
	describeResult,
	headerLines as cardHeaderLines,
	resultLines as cardResultLines,
	toolLabel,
} from "./claude-cards";
export { prefixAgentBullet, prefixUserChevron, transformProse } from "./claude-prose";
export { transformThinking, transformThinkingClaude } from "./thinking";
export { AgentEditor, type SkillPickerSources } from "./editor";
export {
	AUTOMATIC_MARK,
	buildCatalog,
	commandFor,
	COMMON_SKILLS,
	movePicker,
	nextCategoryView,
	openPicker,
	pickerQuery,
	renderPicker,
	shortDescription,
	visibleEntries,
	withQuery,
} from "./skill-picker";
export { modeStatus, subagentMascots } from "./status-line";
export { headerLines } from "./logo";
export { alvoDe, fmtDuracao, fmtTokens, montarLinha, textoDireita } from "./loader";

export default function agentTui(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
	click(pi);
	claudeCards(pi);
	editor(pi);
	loader(pi);
	logo(pi);
	pasteImage(pi);
	spinner(pi);
	thinking(pi);
	toolDisplay(pi);
}
