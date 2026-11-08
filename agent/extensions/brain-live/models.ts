/**
 * /models — painel de tiers de modelo (Default · Fast · Standard · Deep · Visual · Image).
 *
 *   Default  → modelo da sessão e dos chats novos (o Pi grava o último usado)
 *   demais   → ~/Sistema/Pi/models.json (Vault): `subagent` usa `model: tier:<nome>`,
 *              `generate_image` usa o tier image.
 *
 * Papéis nativos (scout/worker/planner/reviewer/visual) aparecem sempre, com o
 * modelo/thinking/origem efetivos. Escolher ali lista primeiro os pares autorizados em
 * `roleModels` e depois todo modelo disponível; confirmado, promove o escolhido a
 * preferência daquele papel (autorizando-o, se era novo, com o thinking da preferência
 * atual). Nunca muda a sessão nem outro papel.
 *
 *   ↑↓ linha · Enter escolhe modelo (digite pra filtrar) · ←→ thinking/quality · s size · Esc fecha
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatJuiceStatus, getJuicePreferences, getJuiceSnapshot, juiceEnabled, setJuicePreferences } from "../../juice/client.mjs";
import { loadRoleModels, loadTiers, MODELS_FILE, ROLE_NAMES, type RoleModelChoice, saveTiers, setRolePreference, TIER_NAMES, type Tier, type TierName, type TiersFile } from "./lib/tiers.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const QUALITY = ["auto", "low", "medium", "high"];
const SIZE = ["auto", "1024x1024", "1024x1536", "1536x1024"];

type ThemeLike = { fg: (c: any, t: string) => string; bold: (t: string) => string };

// ── identidade visual por provider (Unicode puro: funciona em qualquer fonte) ──
const PROVIDERS: Record<string, { glyph: string; color: string; name: string }> = {
	"openai-codex": { glyph: "⬢", color: "success", name: "OpenAI" },
	openai: { glyph: "⬢", color: "success", name: "OpenAI" },
	anthropic: { glyph: "✳", color: "warning", name: "Anthropic" },
	google: { glyph: "◆", color: "accent", name: "Google" },
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

function modelOptions(ctx: ExtensionCommandContext, pilot = false): SelectItem[] {
	const available = ctx.modelRegistry.getAvailable();
	const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : available;
	const seen = new Set<string>();
	const items: SelectItem[] = [];
	for (const m of scoped) {
		if (pilot && m.type && m.type !== "chat") continue;
		const id = `${m.provider}/${m.id}`;
		if (seen.has(id)) continue;
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
	const rank = (id: string) => (id.startsWith("openai-codex/") ? 0 : id.startsWith("anthropic/") ? 1 : id.startsWith("google/") ? 2 : id.startsWith("openrouter/") ? 4 : 3);
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

interface Row {
	/** `role` = papel nativo (allowlist do models.json); os outros são sessão/fallback/tier. */
	kind: "session" | "support" | "tier" | "role";
	id: string;
	label: string;
	description: string;
	model: () => string;
	extra: () => string[]; // colunas à direita (origem · thinking / quality · size)
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "Painel de tiers de modelo (default · fast · standard · deep · visual · image)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/models precisa da TUI", "error");
				return;
			}
			let pilot = false;
			try {
				pilot = juiceEnabled();
			} catch {
				// A broken opt-in client must not alter the established /models view.
			}
			let data: TiersFile | undefined;
			let roleChoices: Record<string, RoleModelChoice[]> = {};
			let roleError: string | undefined;
			let juicePrefs: { mode: "simple" | "complex"; supportModel: string | null } | undefined;
			let juiceSnapshot: object | null = null;
			let juiceError: string | undefined;
			if (pilot) {
				try {
					juicePrefs = getJuicePreferences();
					juiceSnapshot = getJuiceSnapshot();
				} catch (err) {
					juiceError = err instanceof Error ? err.message : String(err);
				}
			} else {
				try {
					data = loadTiers();
				} catch (err) {
					ctx.ui.notify(`erro lendo ${MODELS_FILE}: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
			}
			// Allowlist por papel: vale nos dois modos. Config quebrada é dita, não escondida —
			// e no piloto não derruba o painel (slots seguem servindo de fallback).
			try {
				roleChoices = data ? (data.roleModels ?? {}) : loadRoleModels();
			} catch (err) {
				roleError = err instanceof Error ? err.message : String(err);
			}
			const options = modelOptions(ctx, pilot);
			const currentDefault = () => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
			const supportUnset = "__juice_support_inherit__";

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const setTier = (name: TierName, patch: Partial<Tier>) => {
					if (!data) return;
					try {
						const latest = loadTiers();
						latest.tiers[name] = { ...latest.tiers[name], ...patch };
						saveTiers(latest);
						data = latest;
						roleChoices = latest.roleModels ?? {};
					} catch (err) {
						ctx.ui.notify(`erro salvando tier: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
				};
				// Papel nativo: a allowlist do models.json decide modelo E thinking (par autorizado).
				// Papel sem allowlist não é escondido: aparece com a origem real (frontmatter/slot).
				const roleIds = [...ROLE_NAMES, ...Object.keys(roleChoices).filter((r) => !ROLE_NAMES.includes(r as any))];
				const roleRows: Row[] = roleIds.map((role) => ({
					kind: "role",
					id: role,
					label: role,
					description: "papel · par autorizado",
					model: () => roleChoices[role]?.[0]?.model ?? "",
					extra: () => {
						const choice = roleChoices[role]?.[0];
						if (!choice) return [roleError ? "config inválida" : pilot ? "frontmatter/slot" : "frontmatter"];
						return ["models.json", choice.thinking];
					},
				}));
				const rows: Row[] = pilot
					? [
							{
								kind: "session",
								id: "default",
								label: "Principal",
								description: "sessão · fallback dos papéis sem allowlist",
								model: currentDefault,
								// Thinking do principal é escolha manual (←→ aqui, ou /thinking) e persiste:
								// o modo simple/complex não mexe nele.
								extra: () => ["sessão", ctx.thinkingLevel ?? ""],
							},
							{
								kind: "support",
								id: "support",
								label: "Apoio",
								description: "fallback económico dos papéis sem allowlist",
								model: () => juicePrefs?.supportModel ?? "",
								extra: () => ["fallback"],
							},
							...roleRows,
						]
					: [
							{
								kind: "session",
								id: "default",
								label: "Default",
								description: "você · chats novos",
								model: currentDefault,
								extra: () => [ctx.thinkingLevel ?? ""],
							},
							...TIER_NAMES.map((name): Row => {
								const t = () => data!.tiers[name];
								return {
									kind: "tier",
									id: name,
									label: t().label,
									description: `${USAGE[name] ?? ""} · ${t().description}`,
									model: () => t().model,
									extra: () => (name === "image" ? [t().quality ?? "auto", t().size ?? "auto"] : [t().thinking ?? "medium"]),
								};
							}),
							...roleRows,
						];

				let cursor = 0;
				let picker: ModelPicker | null = null;

				const cycle = (dir: 1 | -1) => {
					const row = rows[cursor];
					// Thinking de papel vem do par autorizado: não se move sozinho.
					if (row.kind === "role") return;
					if (row.kind === "session") {
						const cur = THINKING.indexOf(ctx.thinkingLevel ?? "medium");
						const next = THINKING[(cur + dir + THINKING.length) % THINKING.length];
						pi.setThinkingLevel(next as any);
						return;
					}
					// No piloto só existem as linhas Principal/Apoio e os papéis; tiers não entram.
					if (row.kind !== "tier" || !data) return;
					const name = row.id as TierName;
					const list = name === "image" ? QUALITY : THINKING;
					const field = name === "image" ? "quality" : "thinking";
					const cur = list.indexOf((data!.tiers[name] as any)[field] ?? list[0]);
					setTier(name, { [field]: list[(cur + dir + list.length) % list.length] } as Partial<Tier>);
				};
				const cycleSize = () => {
					const row = rows[cursor];
					if (row.kind !== "tier" || row.id !== "image" || !data) return;
					const cur = SIZE.indexOf(data.tiers.image.size ?? "auto");
					setTier("image", { size: SIZE[(cur + 1) % SIZE.length] as Tier["size"] });
				};
				const openPicker = () => {
					const row = rows[cursor];
					if (row.kind === "role") {
						if (roleError) {
							ctx.ui.notify(`erro lendo ${MODELS_FILE}: ${roleError}`, "error");
							return;
						}
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
									roleChoices = { ...roleChoices, [row.id]: setRolePreference(row.id, v, allowedIds.has(v) ? undefined : newThinking) };
									if (data) data.roleModels = { ...(data.roleModels ?? {}), [row.id]: roleChoices[row.id] };
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
									juicePrefs = setJuicePreferences({ supportModel: v === supportUnset ? null : v });
								} catch (err) {
									ctx.ui.notify(`erro salvando preferência juice: ${err instanceof Error ? err.message : String(err)}`, "error");
								}
							} else {
								setTier(row.id as TierName, { model: v });
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
					const labelW = 10;
					const descW = Math.max(18, Math.min(34, width - 62));
					for (let i = 0; i < rows.length; i++) {
						const r = rows[i];
						const sel = i === cursor;
						const id = r.model();
						const cur = theme.fg(sel ? "accent" : "dim", sel ? "▸ " : "  ");
						const label = truncateToWidth((sel ? theme.bold(theme.fg("accent", r.label)) : theme.fg("text", r.label)) + " ".repeat(labelW), labelW, "", true);
						const desc = theme.fg("dim", truncateToWidth(r.description, descW, "…", true));
						const model = !id
							? r.kind === "support"
								? theme.fg("dim", "herdar principal · não configurado")
								: theme.fg("dim", "—")
							: r.kind === "tier" && r.id === "image"
								? badge(theme, id, "GPT Image", sel) + theme.fg("dim", `  via ${prettyName(ctx, id)}`)
								: badge(theme, id, prettyName(ctx, id), sel);
						const extra = r
							.extra()
							.filter(Boolean)
							.map((e) => theme.fg((THINKING_COLOR[e] as any) ?? "muted", e))
							.join(theme.fg("dim", " · "));
						const left = `${cur}${label}  ${desc}  ${model}`;
						if (!pilot) {
							const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(extra) - 2);
							out.push(left + " ".repeat(pad) + extra);
						} else {
							const fittedExtra = truncateToWidth(extra, width, "");
							if (visibleWidth(fittedExtra) >= width) {
								out.push(fittedExtra);
							} else {
								const fittedLeft = truncateToWidth(left, Math.max(0, width - visibleWidth(fittedExtra) - 1), "");
								const pad = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedExtra)));
								out.push(fittedLeft + pad + fittedExtra);
							}
						}
						const divide = r.kind === "session" || (r.kind !== "role" && rows[i + 1]?.kind === "role");
						if (divide) out.push(theme.fg("borderMuted", pilot ? truncateToWidth("  " + "─".repeat(Math.max(0, width - 4)), width, "") : "  " + "─".repeat(Math.max(10, width - 4))));
					}
					return out;
				};

				const header = (width: number) => pilot
					? [
							truncateToWidth(theme.bold(theme.fg("accent", "Modelos")) + theme.fg("dim", `   ${juiceError ? `juice indisponível · ${juiceError}` : formatJuiceStatus(juiceSnapshot, juicePrefs)}`), width, ""),
							"",
						]
					: [
							theme.bold(theme.fg("accent", "Modelos")) + theme.fg("dim", "   Astra conversa com você; os subagentes usam o tier de cada um"),
							"",
						];
				const footer = (width: number) => {
					const row = rows[cursor];
					const isImage = row.kind === "tier" && row.id === "image";
					const isRole = row.kind === "role";
					const hints = isRole
						? ["↑↓ linha", "Enter par autorizado", "Esc fecha"]
						: pilot
							? ["↑↓ linha", "Enter modelo", "←→ thinking", "Esc fecha"]
							: ["↑↓ linha", "Enter modelo", isImage ? "←→ quality" : "←→ thinking", ...(isImage ? ["s size"] : []), "Esc fecha"];
					const note = roleError
						? `  erro lendo ${MODELS_FILE.replace(process.env.HOME ?? "", "~")}: ${roleError}`
						: pilot
							? "  modelo e thinking são sua escolha e persistem; o modo (Shift+Tab) não os altera"
							: `  ${MODELS_FILE.replace(process.env.HOME ?? "", "~")}`;
					return ["", truncateToWidth(theme.fg("dim", "  " + hints.join("  ·  ")), width, ""), truncateToWidth(theme.fg(roleError ? "error" : "dim", note), width, "")];
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
