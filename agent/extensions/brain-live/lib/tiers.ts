/**
 * Tiers de modelo — fonte canônica: agent-models.json no perfil Agent.
 *
 *   fast · standard · deep · visual · image
 *
 * Consumidores: subagent (frontmatter `model: tier:deep`), /models (TUI).
 * O tier "default" (modelo dos chats novos) não vive aqui: é o
 * defaultModel do settings.json, que o Pi já atualiza a cada troca de modelo.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const TIER_NAMES = ["fast", "standard", "deep", "visual", "image"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Papéis nativos do Agent. A ordem é a exibida em /models. */
export const ROLE_NAMES = ["scout", "worker", "planner", "reviewer", "visual"] as const;

export interface Tier {
	label: string;
	description: string;
	model: string; // provider/modelId
	thinking?: string;
	/** só no tier image: qualidade e tamanho passados ao image_generation */
	quality?: "low" | "medium" | "high" | "auto";
	size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
}

export interface RoleModelChoice {
	model: string; // provider/modelId
	thinking: string;
}

export const AGY_THINKING = ["low", "medium", "high", "xhigh"] as const;
type AgyThinking = (typeof AGY_THINKING)[number];
const [low, medium, high] = AGY_THINKING;
const regular = [low, medium, high] as const;

// Snapshot de `agy models`. Sem sufixos anunciados, o ID é fixo e só --effort varia.
export const AGY_FAMILIES: ReadonlyArray<{ id: string; label: string; levels?: readonly AgyThinking[] }> = [
	{ id: "gemini-4-neon", label: "Gemini 4 Neon", levels: AGY_THINKING },
	{ id: "gemini-4-carbon", label: "Gemini 4 Carbon", levels: regular },
	{ id: "gemini-4-argon", label: "Gemini 4 Argon", levels: regular },
	{ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", levels: AGY_THINKING },
	{ id: "gemini-pro-orchestrator-neon", label: "Gemini Pro Orchestrator Neon" },
	{ id: "gemini-pro-orchestrator", label: "Gemini Pro Orchestrator" },
	{ id: "gemini-pro-orchestrator-argon", label: "Gemini Pro Orchestrator Argon" },
	{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", levels: regular },
	{ id: "claude-opus-5-5", label: "Claude Opus 5.5", levels: regular },
	{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", levels: regular },
	{ id: "gpt-oss-120b", label: "GPT OSS 120B", levels: [medium] },
];
export const agyFamilyRef = (id: string) => `antigravity/${id}`;
export const DEFAULT_GEMINI_MODEL: Readonly<RoleModelChoice> = { model: agyFamilyRef("gemini-4-neon"), thinking: high };

/** Converte família virtual no par nativo, sem consultar o registry do Pi. */
export function resolveAgyFamily(choice: RoleModelChoice): RoleModelChoice {
	const family = AGY_FAMILIES.find(({ id }) => agyFamilyRef(id) === choice?.model);
	const requested = AGY_THINKING.indexOf(choice?.thinking as AgyThinking);
	if (!family || requested < 0) throw new Error("gemini: escolha uma família Antigravity e thinking low, medium, high ou xhigh");
	const distance = (level: AgyThinking) => Math.abs(AGY_THINKING.indexOf(level) - requested);
	const effort = family.levels?.reduce((best, level) => distance(level) < distance(best) ? level : best) ?? AGY_THINKING[requested];
	return { model: family.levels ? `${family.id}-${effort}` : family.id, thinking: effort };
}

export interface TiersFile {
	tiers: Record<TierName, Tier>;
	/**
	 * Modelos autorizados por papel nativo. A ordem é significativa: a primeira
	 * opção é a preferência usada quando a chamada não escolhe `model`.
	 * Opcional para manter compatibilidade com configs e agentes de projeto antigos.
	 */
	roleModels?: Record<string, RoleModelChoice[]>;
	/** Preferência de CLI, separada das allowlists de inferência do Pi. */
	agyModels?: { gemini?: RoleModelChoice };
}

export interface ResolvedRoleModel extends RoleModelChoice {
	preference: boolean;
}

export const MODELS_FILE = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".agent"), "agent-models.json");

export function loadTiers(): TiersFile {
	if (!existsSync(MODELS_FILE)) return { tiers: {} as Record<TierName, Tier> };
	const raw = readFileSync(MODELS_FILE, "utf-8");
	const parsed = JSON.parse(raw) as Partial<TiersFile>;
	if (!parsed.tiers) throw new Error(`${MODELS_FILE}: campo "tiers" ausente`);
	for (const name of TIER_NAMES) {
		const t = parsed.tiers[name];
		if (!t) continue;
		if (typeof t.model !== "string" || !t.model.includes("/")) {
			throw new Error(`${MODELS_FILE}: tier "${name}" precisa de "model" no formato provider/modelId`);
		}
	}
	if (parsed.roleModels !== undefined) {
		if (!parsed.roleModels || typeof parsed.roleModels !== "object" || Array.isArray(parsed.roleModels)) {
			throw new Error(`${MODELS_FILE}: campo "roleModels" precisa ser um objeto`);
		}
		for (const [role, choices] of Object.entries(parsed.roleModels)) {
			if (!role.trim() || !Array.isArray(choices)) {
				throw new Error(`${MODELS_FILE}: roleModels."${role}" precisa ser uma lista de opções`);
			}
			const seen = new Set<string>();
			for (const choice of choices) {
				if (
					!choice ||
					typeof choice.model !== "string" ||
					!choice.model.includes("/") ||
					typeof choice.thinking !== "string" ||
					!choice.thinking
				) {
					throw new Error(`${MODELS_FILE}: opção inválida em roleModels."${role}" (model + thinking obrigatórios)`);
				}
				if (seen.has(choice.model)) throw new Error(`${MODELS_FILE}: modelo duplicado em roleModels."${role}": ${choice.model}`);
				seen.add(choice.model);
			}
		}
	}
	return parsed as TiersFile;
}

/** Model refs from the Pi catalog, not native IDs for the agy runner. */
export function isGoogleApiModel(ref: string | null | undefined): boolean {
	if (!ref || ref.startsWith("agy/")) return false;
	// Direct providers and publisher/model IDs exposed through aggregators.
	return /^google(?:-ai-studio|-gemini-cli|-antigravity|-vertex)?\//i.test(ref) ||
		/(?:^|[/.:])~?(?:google[/:]|gemini(?:[-/:.]|$))/i.test(ref);
}

function allowedRoleChoices(choices: RoleModelChoice[], isBlocked = isGoogleApiModel): RoleModelChoice[] {
	return choices.filter((choice) => !isBlocked(choice.model));
}

/** undefined = absent; [] = configured but no allowed model. */
export function getRoleModelChoices(role: string, isBlocked = isGoogleApiModel): RoleModelChoice[] | undefined {
	const roles = loadTiers().roleModels;
	return roles && Object.hasOwn(roles, role) ? allowedRoleChoices(roles[role], isBlocked) : undefined;
}

/** Keep empty configured roles visible in /models so they can be reconfigured. */
export function loadRoleModels(data = loadTiers()): Record<string, RoleModelChoice[]> {
	return Object.fromEntries(Object.entries(data.roleModels ?? {}).map(([role, choices]) => [role, allowedRoleChoices(choices)]));
}

/**
 * Promove um modelo a preferência do papel (primeira posição).
 * Relê o arquivo no momento da gravação — nunca grava um snapshot velho — e não
 * remove nem reescreve opções: só reordena as do papel pedido.
 *
 * Sem `addWithThinking`, só aceita modelo já autorizado. Com ele (escolha explícita
 * do usuário em /models), autoriza o modelo novo naquele papel com esse thinking.
 */
export function setRolePreference(role: string, model: string, addWithThinking?: string): RoleModelChoice[] {
	if (isGoogleApiModel(model)) throw new Error("Gemini está disponível pelo papel agy, não pela API do Pi.");
	const data = loadTiers();
	const choices = data.roleModels && Object.hasOwn(data.roleModels, role) ? data.roleModels[role] : undefined;
	if (addWithThinking && !choices?.some((choice) => choice.model === model)) {
		if (!model.includes("/")) throw new Error(`modelo "${model}" precisa do formato provider/modelId`);
		const next = [{ model, thinking: addWithThinking }, ...(choices ?? [])];
		data.roleModels = { ...(data.roleModels ?? {}), [role]: next };
		saveTiers(data);
		return allowedRoleChoices(next);
	}
	const allowed = allowedRoleChoices(choices ?? []);
	if (!choices || !allowed.length) throw new Error(`papel "${role}" não tem modelos autorizados em ${MODELS_FILE}`);
	const index = choices.findIndex((choice) => choice.model === model);
	if (index < 0) {
		throw new Error(`modelo "${model}" não está autorizado para "${role}" (autorizados: ${allowed.map((c) => c.model).join(", ")})`);
	}
	if (index === 0) return allowed;
	const next = [choices[index], ...choices.filter((_, i) => i !== index)];
	data.roleModels![role] = next;
	saveTiers(data);
	return allowedRoleChoices(next);
}

/** Resolve a preferência ou valida uma escolha explícita sem consultar quota/disponibilidade. */
export function resolveRoleModel(role: string, requestedModel?: string, options?: {
	isBlocked?: typeof isGoogleApiModel;
	allowUnconfiguredOverride?: boolean;
}): ResolvedRoleModel | undefined {
	const choices = getRoleModelChoices(role, options?.isBlocked);
	if (!choices) {
		if (requestedModel !== undefined && !options?.allowUnconfiguredOverride) {
			throw new Error(`Agent "${role}" has no configured model choices; explicit model override is not allowed.`);
		}
		return undefined;
	}
	if (!choices.length) throw new Error(`Agent "${role}" has no allowed Pi models. Choose one in /models before dispatching.`);
	const choice = requestedModel !== undefined ? choices.find((item) => item.model === requestedModel) : choices[0];
	if (!choice) {
		const allowed = choices.map((item, index) => `${item.model} (thinking ${item.thinking}${index === 0 ? ", preferred" : ""})`).join(", ");
		throw new Error(`Model "${requestedModel}" is not allowed for agent "${role}". Allowed: ${allowed}.`);
	}
	return { ...choice, preference: choice === choices[0] };
}

export function formatRoleModelChoices(role: string): string | undefined {
	const choices = getRoleModelChoices(role);
	if (!choices?.length) return undefined;
	return choices
		.map((choice, index) => `${choice.model} (thinking ${choice.thinking}${index === 0 ? ", preferred" : ""})`)
		.join(" OR ");
}

export function saveTiers(data: TiersFile): void {
	// Troca atômica: uma leitura concorrente nunca vê o arquivo pela metade.
	mkdirSync(dirname(MODELS_FILE), { recursive: true, mode: 0o700 });
	const temp = `${MODELS_FILE}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	renameSync(temp, MODELS_FILE);
}

export function getGeminiPreference(data = loadTiers()): RoleModelChoice | undefined {
	const choice = data.agyModels?.gemini;
	if (choice !== undefined) resolveAgyFamily(choice);
	return choice;
}

export function setGeminiPreference(choice: RoleModelChoice): void {
	resolveAgyFamily(choice);
	const data = loadTiers();
	data.agyModels = { ...data.agyModels, gemini: choice };
	saveTiers(data);
}

/** Preferência salva > frontmatter nativo (se presente) > padrão do gemini. */
export function resolveGeminiPreference(role: { model?: string; thinking?: string }): RoleModelChoice | undefined {
	const choice = getGeminiPreference();
	if (choice) return resolveAgyFamily(choice);
	if (!role.model && !role.thinking) return resolveAgyFamily(DEFAULT_GEMINI_MODEL);
	return undefined; // Runner mantém a semântica original do frontmatter nativo.
}

export function isTierRef(value: string | undefined): value is `tier:${TierName}` {
	return typeof value === "string" && value.startsWith("tier:");
}

/**
 * Resolve `tier:<nome>` para {model, thinking}. Valores que já são
 * provider/modelId passam intactos (thinking undefined).
 */
export function resolveModelRef(value: string): { model: string; thinking?: string; tier?: TierName } {
	if (!isTierRef(value)) return { model: value };
	const name = value.slice("tier:".length) as TierName;
	if (!TIER_NAMES.includes(name)) {
		throw new Error(`tier desconhecido "${name}" — use ${TIER_NAMES.join(", ")}`);
	}
	const tier = loadTiers().tiers[name];
	if (!tier) throw new Error(`tier "${name}" não configurado em ${MODELS_FILE}`);
	return { model: tier.model, thinking: tier.thinking, tier: name };
}
