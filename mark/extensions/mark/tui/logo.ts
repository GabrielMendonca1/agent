import { juiceEnabled } from "../../../juice/client.mjs";
import { userCompanies as companiesOf } from "../../../juice/companies.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface LogoTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type OpsCompany = "arca" | "omni";

/** Empresas do usuário (critério em juice/companies.mjs, compartilhado com as skills de empresa). */
export function userCompanies(env: NodeJS.ProcessEnv = process.env, home = homedir()): OpsCompany[] {
	return companiesOf(env, home) as OpsCompany[];
}

/** Skills de Ops a anunciar: empresa do usuário E skill existente na sessão. */
export function opsSkills(commands: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
	return userCompanies(env, home)
		.map((id) => `${id}-ops`)
		.filter((name) => commands.has(`skill:${name}`));
}

/** One startup hint, selected from capabilities actually loaded in this session. */
export function headerTips(theme: LogoTheme, opts: { skills: readonly string[]; juice: boolean }): string[] {
 const hint = opts.skills.length
  ? `Use ${opts.skills.map(name => `/skill:${name}`).join(" ou ")} para operar o projeto`
  : opts.juice ? "shift+tab alterna simple / complex" : "/ comandos · /hotkeys atalhos";
 return [theme.fg("muted", hint)];
}

export function headerLines(width: number, theme: LogoTheme, parts: { tips: readonly string[] }): string[] {
 if (width <= 0) return [];
 return [theme.fg("accent", "✳") + " " + theme.bold("Mark"), ...parts.tips.slice(0, 1)]
  .map(line => truncateToWidth(line, width, "…"));
}

export default function (pi: ExtensionAPI) {
 pi.on("session_start", (_event, ctx) => {
  if (ctx.mode !== "tui") return;
  const skills = opsSkills(new Set((pi.getCommands?.() ?? []).map(command => command.name)));
  ctx.ui.setHeader((_tui, theme) => ({
   render: (width: number) => headerLines(width, theme, { tips: headerTips(theme, { skills, juice: juiceEnabled() }) }),
   invalidate() {},
  }));
 });
}
