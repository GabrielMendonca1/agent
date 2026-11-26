/**
 * /models — painel de tiers de modelo (Default · Fast · Standard · Deep · Visual · Image).
 *
 *   Default  → modelo da sessão e dos chats novos (o Pi grava o último usado)
 *   demais   → agent-models.json no perfil Agent: `subagent` usa `model: tier:<nome>`,
 *              `generate_image` usa o tier image.
 *
 * Papéis nativos (scout/worker/planner/reviewer/visual) aparecem sempre, com o
 * modelo/thinking/origem efetivos. Escolher ali lista primeiro os pares autorizados em
 * `roleModels` e depois todo modelo disponível; confirmado, promove o escolhido a
 * preferência daquele papel (autorizando-o, se era novo, com o thinking da preferência
 * atual). O thinking pode ser ajustado no par ativo, sem mudar a sessão nem outro papel.
 * Presets de swarm são independentes e, se ausentes, herdam o papel.
 *
 *   ↑↓ linha · Enter escolhe modelo (digite pra filtrar) · ←→ thinking/quality · s size · Esc fecha
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getAgentPreferences, isChild, runtimeEnabled, setAgentPreferences } from "../../core/client.mjs";
import { AGY_FAMILIES, AGY_THINKING, agyFamilyRef, DEFAULT_GEMINI_MODEL, getGeminiPreference, resolveAgyFamily, setGeminiPreference } from "./lib/tiers.ts";
import { isGoogleApiModel, loadRoleModels, loadSwarmModels, loadTiers, MODELS_FILE, ROLE_NAMES, type RoleModelChoice, setRolePreference, setRoleThinking, setSwarmModel, setSwarmThinking, SWARM_SLOTS, type SwarmSlot, THINKING_LEVELS as THINKING, TIER_NAMES, type Tier, type TierName, type TiersFile, updateTier } from "./lib/tiers.ts";
import { type AgentConfig, discoverAgents } from "./subagent/agents.ts";

const SWARM_INHERIT: Record<SwarmSlot, string> = { writer: "worker", reviewer: "reviewer", board: "papel da task" };
const QUALITY = ["auto", "low", "medium", "high"] as const;
const SIZE = ["auto", "1024x1024", "1024x1536", "1536x1024"] as const;
const step = <T,>(levels: readonly T[], current: T, dir: 1 | -1): T => levels[(levels.indexOf(current) + dir + levels.length) % levels.length];

type ThemeLike = { fg: (c: any, t: string) => string; bold: (t: string) => string };

// ── identidade visual por provider (Unicode puro: funciona em qualquer fonte) ──
const PROVIDERS: Record<string, { glyph: string; color: string; name: string }> = {
	"openai-codex": { glyph: "⬢", color: "success", name: "OpenAI" },
	openai: { glyph: "⬢", color: "success", name: "OpenAI" },
	anthropic: { glyph: "✳", color: "warning", name: "Anthropic" },
	openrouter: { glyph: "◈", color: "muted", name: "OpenRouter" },
};
const OTHER = { glyph: "●", color: "dim", name: "" };

function providerOf(id: string) {
	return PROVIDERS[id.split("/")[0]] ?? OTHER;
}

const THINKING_COLOR: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const USAGE: Record<string, string> = {
	fast: "scout",
	standard: "worker",
	deep: "planner · reviewer",
	visual: "visual",
	image: "generate_image",
};

/** Nome bonito do modelo (registry) — cai no id se não houver. */
function prettyName(ctx: ExtensionCommandContext, id: string): string {
	const [provider, ...rest] = id.split("/");
	const m = ctx.modelRegistry.find(provider, rest.join("/"));
	if (m?.name && m.name !== m.id) return m.name;
	return rest.join("/");
}

function badge(theme: ThemeLike, id: string, name: string, selected: boolean): string {
	const p = providerOf(id);
	const label = selected ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name);
	return `${theme.fg(p.color, p.glyph)} ${label}`;
}

function modelOptions(ctx: ExtensionCommandContext, pilot: boolean, allChat = false): SelectItem[] {
	const available = ctx.modelRegistry.getAvailable();
	const models = !allChat && ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : available;
	const seen = new Set<string>();
	const items: SelectItem[] = [];
	for (const m of models) {
		if ((pilot || allChat) && m.type && m.type !== "chat") continue;
		const id = `${m.provider}/${m.id}`;
		if (isGoogleApiModel(id) || seen.has(id)) continue;
		seen.add(id);
		const p = providerOf(id);
		const bits: string[] = [];
		if (m.input?.includes("image")) bits.push("vision");
		if (m.contextWindow) bits.push(`${Math.round(m.contextWindow / 1000)}K`);
		if (pilot) {
			const input = m.cost?.input;
			const output = m.cost?.output;
			bits.push(typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 && input + output > 0
				? `catálogo US$${input}/${output} por 1M entrada/saída`
				: "preço não informado/assinatura");
		}
		items.push({ value: id, label: `${p.glyph} ${m.name && m.name !== m.id ? m.name : m.id}`, description: `${p.name || m.provider} · ${bits.join(" · ")}` });
	}
	// primeiro os provedores diretos, depois openrouter e o resto
	const rank = (id: string) => (id.startsWith("openai-codex/") ? 0 : id.startsWith("anthropic/") ? 1 : id.startsWith("openrouter/") ? 3 : 2);
	return items.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
}

/** Seletor de modelo com filtro por digitação. */
class ModelPicker extends Container {
	private list: SelectList;
	private listIndex: number;
	private input = new Input();
	constructor(
		title: string,
		description: string,
		private options: SelectItem[],
		current: string,
		private onPick: (value: string) => void,
		private onBack: () => void,
		theme: ThemeLike,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)) + theme.fg("dim", `  ${description}`), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.list = this.build(options, current);
		this.listIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  digite pra filtrar · Enter seleciona · Esc volta"), 0, 0));
		this.input.onSubmit = () => this.list.handleInput("\r");
	}
	private build(items: SelectItem[], preselect?: string): SelectList {
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme(), { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 44 });
		const idx = preselect ? items.findIndex((i) => i.value === preselect) : -1;
		if (idx >= 0) list.setSelectedIndex(idx);
		list.onSelect = (item) => this.onPick(item.value);
		list.onCancel = () => this.onBack();
		return list;
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data.startsWith("\x1b[")) {
			this.list.handleInput(data);
			return;
		}
		if (data.charCodeAt(0) < 32 && data !== "\x7f" && data !== "\b") return;
		this.input.handleInput(data);
		const q = this.input.getValue();
		const filtered = q ? fuzzyFilter(this.options, q, (i) => `${i.value} ${i.label} ${i.description ?? ""}`) : this.options;
		const sel = this.list.getSelectedItem()?.value;
		this.list = this.build(filtered, sel);
		this.children[this.listIndex] = this.list;
		this.invalidate();
	}
}

type Row = (
	| { kind: "session" | "support" | "tier" | "role" | "agy"; id: string }
	| { kind: "swarm"; id: SwarmSlot }
) & {
	label: string;
	description: string;
	model: () => string;
	extra: () => string[]; // colunas à direita (origem · thinking / quality · size)
};

const supportWarningKey = Symbol.for("agent.models.support-warning-shown");
const processFlags = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!runtimeEnabled() || isChild() || processFlags[supportWarningKey]) return;
		try {
			// Só avisa quando o scout de fato herdaria o principal: sem apoio e sem modelo próprio do papel.
			const { supportModel } = getAgentPreferences();
			if ((supportModel && !isGoogleApiModel(supportModel)) || (loadRoleModels().scout?.length ?? 0) > 0) return;
			processFlags[supportWarningKey] = true;
			ctx.ui.notify("Modelo de apoio não configurado: sem uma escolha própria, o scout herda o modelo principal. Configure o apoio em /models.", "warning");
		} catch { /* Aviso de custo não impede a abertura da sessão. */ }
	});
	pi.registerCommand("models", {
		description: "Painel de modelos, papéis e presets do swarm",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/models precisa da TUI", "error");
				return;
			}
			let pilot = false;
			try {
				pilot = runtimeEnabled();
			} catch {
				// A broken opt-in client must not alter the established /models view.
			}
			let data: TiersFile | undefined;
			let roleChoices: Record<string, RoleModelChoice[]> = {};
			let swarmChoices: Partial<Record<SwarmSlot, RoleModelChoice>> = {};
			let configError: string | undefined;
			let swarmError: string | undefined;
			let resourcePrefs: { supportModel: string | null } | undefined;
			let resourceError: string | undefined;
			if (pilot) {
				try {
					resourcePrefs = getAgentPreferences();
				} catch (err) {
					resourceError = err instanceof Error ? err.message : String(err);
				}
			} else {
				try {
					data = loadTiers();
				} catch (err) {
					ctx.ui.notify(`erro lendo ${MODELS_FILE}: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
			}
			// Papéis e swarm valem nos dois modos. Config inválida não esconde Principal/Apoio no piloto.
			try {
				const config = data ?? loadTiers();
				roleChoices = loadRoleModels(config);
				try {
					swarmChoices = loadSwarmModels(config);
				} catch (err) {
					swarmError = err instanceof Error ? err.message : String(err);
				}
			} catch (err) {
				configError = err instanceof Error ? err.message : String(err);
			}
			let gemini: AgentConfig | undefined;
			try {
				gemini = discoverAgents(ctx.cwd, "user").agents.find((agent) => agent.name === "gemini");
			} catch { /* A broken role file must not block the Pi model panel. */ }
			const showAgy = !gemini || gemini.runner === "agy";
			let geminiChoice: RoleModelChoice | undefined;
			let geminiError: string | undefined;
			if (showAgy) {
				try {
					geminiChoice = getGeminiPreference(data);
				} catch (err) {
					geminiError = err instanceof Error ? err.message : String(err);
				}
			}
			const agyOptions = AGY_FAMILIES.map((family) => ({
				value: agyFamilyRef(family.id), label: family.label, description: family.levels?.join(" / ") ?? "ID fixo · thinking via effort",
			}));
			const nativeFamily = AGY_FAMILIES.find(({ id, levels }) =>
				levels ? levels.some((level) => `${id}-${level}` === gemini?.model) : id === gemini?.model,
			);
			const frontmatterThinking = gemini?.thinking ??
				nativeFamily?.levels?.find((level) => `${nativeFamily.id}-${level}` === gemini?.model);
			const agyChoice = () => geminiChoice ?? {
				model: nativeFamily ? agyFamilyRef(nativeFamily.id) : DEFAULT_GEMINI_MODEL.model,
				thinking: AGY_THINKING.find((level) => level === frontmatterThinking) ?? DEFAULT_GEMINI_MODEL.thinking,
			};
			const writeAgyChoice = (choice: RoleModelChoice) => {
				try {
					setGeminiPreference(choice);
					geminiChoice = choice;
					geminiError = undefined;
				} catch (err) {
					ctx.ui.notify(`erro salvando gemini: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			};
			const options = modelOptions(ctx, pilot);
			const currentDefault = () => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
			const normalModel = (model?: string | null) => isGoogleApiModel(model) ? "" : model ?? "";
			const supportUnset = "__agent_support_inherit__";
			const swarmUnset = "";

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const setTier = (name: TierName, edit: (tier: Partial<Tier>) => Partial<Tier>) => {
					if (!data) return;
					try {
						data = updateTier(name, edit);
						roleChoices = loadRoleModels(data);
					} catch (err) {
						ctx.ui.notify(`erro salvando tier: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
				};
				// Papel nativo: a allowlist do models.json decide modelo E thinking (par autorizado).
				// Papel sem allowlist não é escondido: aparece com a origem real (frontmatter/slot).
				const roleIds = [...ROLE_NAMES, ...Object.keys(roleChoices).filter((r) => !ROLE_NAMES.includes(r as any) && !(showAgy && r === "gemini"))];
				const roleRows: Row[] = roleIds.map((role) => ({
					kind: "role",
					id: role,
					label: role,
					description: "papel · par autorizado",
					model: () => roleChoices[role]?.[0]?.model ?? "",
					extra: () => {
						const choice = roleChoices[role]?.[0];
						if (!choice) return [configError ? "config inválida" : pilot ? "frontmatter/slot" : "frontmatter"];
						return ["models.json", choice.thinking];
					},
				}));
				if (showAgy) roleRows.push({
					kind: "agy", id: "gemini", label: "gemini", description: "papel · Antigravity CLI",
					model: () => geminiChoice?.model ?? (!nativeFamily && gemini?.model ? gemini.model : agyChoice().model),
					extra: () => {
						if (geminiError) return ["config inválida"];
						if (!geminiChoice && (gemini?.model || gemini?.thinking)) return ["frontmatter", frontmatterThinking ?? ""];
						const choice = agyChoice();
						const actual = resolveAgyFamily(choice).thinking;
						return [geminiChoice ? "models.json" : "padrão", actual === choice.thinking ? actual : `${choice.thinking} → ${actual}`];
					},
				});
				const swarmRows: Row[] = SWARM_SLOTS.map((slot) => ({
					kind: "swarm",
					id: slot,
					label: `swarm ${slot}`,
					description: "preset do swarm",
					model: () => swarmChoices[slot]?.model ?? "",
					extra: () => [swarmChoices[slot]?.thinking ?? ""],
				}));
				const rows: Row[] = pilot
					? [
							{
								kind: "session",
								id: "default",
								label: "Principal",
								description: "sessão · fallback dos papéis sem allowlist",
								model: () => normalModel(currentDefault()),
								// Thinking do principal é escolha manual (←→ aqui, ou /thinking) e persiste:
								// o modo simple/complex não mexe nele.
								extra: () => ["sessão", ctx.thinkingLevel ?? ""],
							},
							{
								kind: "support",
								id: "support",
								label: "Apoio",
								description: "fallback económico dos papéis sem allowlist",
								model: () => normalModel(resourcePrefs?.supportModel),
								extra: () => ["fallback"],
							},
							...roleRows,
							...swarmRows,
						]
					: [
							{
								kind: "session",
								id: "default",
								label: "Default",
								description: "você · chats novos",
								model: () => normalModel(currentDefault()),
								extra: () => [ctx.thinkingLevel ?? ""],
							},
							...TIER_NAMES.map((name): Row => {
								const t = () => data!.tiers[name] ?? { label: name, description: "Não configurado", model: "" };
								return {
									kind: "tier",
									id: name,
									label: t().label,
									description: `${USAGE[name] ?? ""} · ${t().description}`,
									model: () => name === "image" ? t().model : normalModel(t().model),
									extra: () => (name === "image" ? [t().quality ?? "auto", t().size ?? "auto"] : [t().thinking ?? "medium"]),
								};
							}),
							...roleRows,
							...swarmRows,
						];

				let cursor = 0;
				let picker: ModelPicker | null = null;

				const cycle = (dir: 1 | -1) => {
					const row = rows[cursor];
					if (row.kind === "agy") {
						if (geminiError || (!geminiChoice && gemini?.model && !nativeFamily)) {
							ctx.ui.notify("gemini: escolha uma família com Enter antes de mudar o thinking", "warning");
							return;
						}
						const choice = agyChoice();
						const cur = AGY_THINKING.findIndex((level) => level === choice.thinking);
						writeAgyChoice({ ...choice, thinking: AGY_THINKING[(cur + dir + AGY_THINKING.length) % AGY_THINKING.length] });
						return;
					}
					if (row.kind === "role" || row.kind === "swarm") {
						const choice = row.kind === "role" ? roleChoices[row.id]?.[0] : swarmChoices[row.id];
						if (!choice) {
							ctx.ui.notify(`${row.label}: escolha um modelo com Enter antes de mudar o thinking`, "warning");
							return;
						}
						const next = (thinking: string) => step(THINKING, thinking, dir);
						try {
							if (row.kind === "role") roleChoices = { ...roleChoices, [row.id]: setRoleThinking(row.id, next) };
							else swarmChoices = setSwarmThinking(row.id, next);
						} catch (err) {
							ctx.ui.notify(`erro salvando thinking de ${row.label}: ${err instanceof Error ? err.message : String(err)}`, "error");
						}
						return;
					}
					if (row.kind === "session") {
						const cur = THINKING.indexOf(ctx.thinkingLevel ?? "medium");
						const next = THINKING[(cur + dir + THINKING.length) % THINKING.length];
						pi.setThinkingLevel(next as any);
						return;
					}
					// Tiers não aparecem no piloto.
					if (row.kind !== "tier" || !data) return;
					const name = row.id as TierName;
					setTier(name, (tier) => name === "image"
						? { quality: step(QUALITY, tier.quality ?? QUALITY[0], dir) }
						: { thinking: step(THINKING, tier.thinking ?? THINKING[0], dir) });
				};
				const cycleSize = () => {
					const row = rows[cursor];
					if (row.kind !== "tier" || row.id !== "image" || !data) return;
					setTier("image", (tier) => ({ size: step(SIZE, tier.size ?? SIZE[0], 1) }));
				};
				const openPicker = () => {
					const row = rows[cursor];
					if (row.kind === "agy") {
						picker = new ModelPicker(row.label, row.description, agyOptions, row.model(), (model) => {
							writeAgyChoice({ ...agyChoice(), model });
							picker = null;
						}, () => { picker = null; }, theme);
						return;
					}
					const rowError = row.kind === "swarm" ? configError ?? swarmError : row.kind === "role" ? configError : undefined;
					if (rowError) {
						ctx.ui.notify(`erro lendo ${MODELS_FILE}: ${rowError}`, "error");
						return;
					}
					if (row.kind === "swarm") {
						const choices = [
							{ value: swarmUnset, label: "Herdar padrão", description: `herda ${SWARM_INHERIT[row.id]}` },
							...modelOptions(ctx, pilot, true),
						];
						picker = new ModelPicker(row.label, row.description, choices, row.model(), (model) => {
							try {
								swarmChoices = setSwarmModel(row.id, (current) => model === swarmUnset ? null : { model, thinking: current?.thinking ?? "medium" });
							} catch (err) {
								ctx.ui.notify(`erro salvando ${row.label}: ${err instanceof Error ? err.message : String(err)}`, "error");
							}
							picker = null;
						}, () => { picker = null; }, theme);
						return;
					}
					if (row.kind === "role") {
						const choices = roleChoices[row.id] ?? [];
						// Primeiro os pares autorizados (o thinking vem com o modelo); depois todo
						// modelo disponível — escolher um deles o autoriza neste papel com o
						// thinking da preferência atual (ou medium).
						const newThinking = choices[0]?.thinking ?? "medium";
						const allowedIds = new Set(choices.map((c) => c.model));
						const allowed: SelectItem[] = [
							...choices.map((choice, index) => ({
								value: choice.model,
								label: `${providerOf(choice.model).glyph} ${prettyName(ctx, choice.model)}`,
								description: `thinking ${choice.thinking}${index === 0 ? " · preferência atual" : " · autorizado"}`,
							})),
							...options
								.filter((o) => {
									if (allowedIds.has(o.value)) return false;
									const [provider, ...rest] = o.value.split("/");
									const type = ctx.modelRegistry.find(provider, rest.join("/"))?.type;
									return !type || type === "chat";
								})
								.map((o) => ({ ...o, description: `${o.description ?? ""} · autorizar (thinking ${newThinking})` })),
						];
						picker = new ModelPicker(
							row.id,
							"autorizados neste papel primeiro · demais disponíveis abaixo",
							allowed,
							row.model(),
							(v) => {
								// Enter aqui é a confirmação do usuário: grava só a preferência deste papel.
								try {
									roleChoices = { ...roleChoices, [row.id]: setRolePreference(row.id, v, allowedIds.has(v) ? undefined : (current) => current?.thinking ?? "medium") };
									const chosen = roleChoices[row.id][0];
									ctx.ui.notify(`${row.id}: ${chosen.model} · thinking ${chosen.thinking}`, "info");
								} catch (err) {
									ctx.ui.notify(`erro salvando preferência de ${row.id}: ${err instanceof Error ? err.message : String(err)}`, "error");
								}
								picker = null;
							},
							() => {
								picker = null;
							},
							theme,
						);
						return;
					}
					const pickerOptions = row.kind === "support"
						? [{ value: supportUnset, label: "herdar principal", description: "não configurado" }, ...options]
						: options;
					picker = new ModelPicker(
						row.label,
						row.description,
						pickerOptions,
						row.model(),
						(v) => {
							if (row.kind === "session") {
								const [provider, ...rest] = v.split("/");
								const m = ctx.modelRegistry.find(provider, rest.join("/"));
								if (m) void pi.setModel(m).then((ok) => !ok && ctx.ui.notify(`sem auth para ${v}`, "error"));
							} else if (row.kind === "support") {
								try {
									resourcePrefs = setAgentPreferences({ supportModel: v === supportUnset ? null : v });
								} catch (err) {
									ctx.ui.notify(`erro salvando preferência: ${err instanceof Error ? err.message : String(err)}`, "error");
								}
							} else {
								setTier(row.id as TierName, () => ({ model: v }));
							}
							picker = null;
						},
						() => {
							picker = null;
						},
						theme,
					);
				};

				const renderRows = (width: number): string[] => {
					const out: string[] = [];
					const labelW = 15;
					const descW = Math.min(34, Math.max(0, width - 62));
					for (let i = 0; i < rows.length; i++) {
						const r = rows[i];
						const sel = i === cursor;
						const id = r.model();
						const cur = theme.fg(sel ? "accent" : "dim", sel ? "▸ " : "  ");
						const label = truncateToWidth((sel ? theme.bold(theme.fg("accent", r.label)) : theme.fg("text", r.label)) + " ".repeat(labelW), labelW, "", true);
						const desc = descW ? `  ${theme.fg("dim", truncateToWidth(r.description, descW, "…", true))}` : "";
						const model = !id
							? r.kind === "support"
								? theme.fg("dim", "herdar principal · não configurado")
								: r.kind === "swarm"
									? theme.fg("dim", configError || swarmError ? "config inválida" : `herda ${SWARM_INHERIT[r.id]}`)
									: theme.fg("dim", "—")
							: r.kind === "tier" && r.id === "image"
								? badge(theme, id, "GPT Image", sel) + theme.fg("dim", `  via ${prettyName(ctx, id)}`)
								: badge(theme, id, r.kind === "agy" ? agyOptions.find((o) => o.value === id)?.label ?? id : prettyName(ctx, id), sel);
						const extra = r
							.extra()
							.filter(Boolean)
							.map((e) => theme.fg((THINKING_COLOR[e] as any) ?? "muted", e))
							.join(theme.fg("dim", " · "));
						const left = `${cur}${label}${desc}  ${model}`;
						const fittedExtra = truncateToWidth(extra, width, "");
						const extraW = visibleWidth(fittedExtra);
						const fittedLeft = truncateToWidth(left, Math.max(0, width - extraW - (extraW ? 1 : 0)), "");
						const pad = extraW ? " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - extraW)) : "";
						out.push(fittedLeft + pad + fittedExtra);

						const nextKind = rows[i + 1]?.kind;
						if (nextKind === "swarm" && r.kind !== "swarm") {
							out.push(truncateToWidth(theme.fg("borderMuted", "  ── Swarm"), width, ""));
						} else if (r.kind === "session" || (r.kind !== "role" && nextKind === "role")) {
							out.push(theme.fg("borderMuted", truncateToWidth("  " + "─".repeat(Math.max(0, width - 4)), width, "")));
						}
					}
					return out;
				};

				const header = (width: number) => {
					const description = pilot
						? resourceError ? `preferências indisponíveis · ${resourceError}` : "preferências do perfil"
						: "O agente conversa com você; os subagentes usam o tier de cada um";
					return [truncateToWidth(theme.bold(theme.fg("accent", "Modelos")) + theme.fg("dim", `   ${description}`), width, ""), ""];
				};
				const footer = (width: number) => {
					const row = rows[cursor];
					const isImage = row.kind === "tier" && row.id === "image";
					const hints = ["↑↓ linha", "Enter modelo", isImage ? "←→ quality" : "←→ thinking", ...(isImage ? ["s size"] : []), "Esc fecha"];
					const panelError = configError ?? swarmError;
					const note = panelError
						? `  erro lendo ${MODELS_FILE.replace(process.env.HOME ?? "", "~")}: ${panelError}`
						: pilot
							? "  modelo e thinking são sua escolha e persistem; o modo (Shift+Tab) não os altera"
							: `  ${MODELS_FILE.replace(process.env.HOME ?? "", "~")}`;
					return ["", truncateToWidth(theme.fg("dim", "  " + hints.join("  ·  ")), width, ""), truncateToWidth(theme.fg(panelError ? "error" : "dim", note), width, "")];
				};

				return {
					render(width: number) {
						if (picker) return picker.render(width);
						return [...header(width), ...renderRows(width), ...footer(width)];
					},
					invalidate() {
						picker?.invalidate();
					},
					handleInput(d: string) {
						if (picker) {
							picker.handleInput(d);
						} else if (matchesKey(d, Key.up)) cursor = (cursor - 1 + rows.length) % rows.length;
						else if (matchesKey(d, Key.down)) cursor = (cursor + 1) % rows.length;
						else if (matchesKey(d, Key.enter)) openPicker();
						else if (matchesKey(d, Key.left)) cycle(-1);
						else if (matchesKey(d, Key.right)) cycle(1);
						else if (d === "s") cycleSize();
						else if (matchesKey(d, Key.escape) || d === "q") done(undefined);
						tui.requestRender();
					},
				};
			});
		},
	});
}
