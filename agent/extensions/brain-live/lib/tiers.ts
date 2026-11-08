/**
 * Tiers de modelo — fonte canônica: ~/Sistema/Pi/models.json (Vault).
 *
 *   fast · standard · deep · visual · image
 *
 * Consumidores: subagent (frontmatter `model: tier:deep`), /models (TUI).
 * O tier "default" (modelo dos chats novos) não vive aqui: é o
 * defaultModel do settings.json, que o Pi já atualiza a cada troca de modelo.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sistemaDir } from "./paths";

export const TIER_NAMES = ["fast", "standard", "deep", "visual", "image"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Papéis nativos do Mark. A ordem é a exibida em /models. */
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

export interface TiersFile {
	tiers: Record<TierName, Tier>;
	/**
	 * Modelos autorizados por papel nativo. A ordem é significativa: a primeira
	 * opção é a preferência usada quando a chamada não escolhe `model`.
	 * Opcional para manter compatibilidade com configs e agentes de projeto antigos.
	 */
	roleModels?: Record<string, RoleModelChoice[]>;
}

export interface ResolvedRoleModel extends RoleModelChoice {
	preference: boolean;
}

export const MODELS_FILE = join(sistemaDir(), "Pi", "models.json");

export function loadTiers(): TiersFile {
	const raw = readFileSync(MODELS_FILE, "utf-8");
	const parsed = JSON.parse(raw) as Partial<TiersFile>;
	if (!parsed.tiers) throw new Error(`${MODELS_FILE}: campo "tiers" ausente`);
	for (const name of TIER_NAMES) {
		const t = parsed.tiers[name];
		if (!t || typeof t.model !== "string" || !t.model.includes("/")) {
			throw new Error(`${MODELS_FILE}: tier "${name}" precisa de "model" no formato provider/modelId`);
		}
	}
	if (parsed.roleModels !== undefined) {
		if (!parsed.roleModels || typeof parsed.roleModels !== "object" || Array.isArray(parsed.roleModels)) {
			throw new Error(`${MODELS_FILE}: campo "roleModels" precisa ser um objeto`);
		}
		for (const [role, choices] of Object.entries(parsed.roleModels)) {
			if (!role.trim() || !Array.isArray(choices) || choices.length === 0) {
				throw new Error(`${MODELS_FILE}: roleModels."${role}" precisa ter ao menos uma opção`);
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

export function getRoleModelChoices(role: string): RoleModelChoice[] | undefined {
	if (!existsSync(MODELS_FILE)) return undefined;
	return loadTiers().roleModels?.[role];
}

/**
 * Allowlist por papel para exibição. Arquivo ausente = nada configurado;
 * arquivo existente e inválido propaga o erro (não vira ausência silenciosa).
 */
export function loadRoleModels(): Record<string, RoleModelChoice[]> {
	if (!existsSync(MODELS_FILE)) return {};
	return loadTiers().roleModels ?? {};
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
	const data = loadTiers();
	const choices = data.roleModels?.[role];
	if (addWithThinking && !choices?.some((choice) => choice.model === model)) {
		if (!model.includes("/")) throw new Error(`modelo "${model}" precisa do formato provider/modelId`);
		const next = [{ model, thinking: addWithThinking }, ...(choices ?? [])];
		data.roleModels = { ...(data.roleModels ?? {}), [role]: next };
		saveTiers(data);
		return next;
	}
	if (!choices) throw new Error(`papel "${role}" não tem modelos autorizados em ${MODELS_FILE}`);
	const index = choices.findIndex((choice) => choice.model === model);
	if (index < 0) {
		throw new Error(`modelo "${model}" não está autorizado para "${role}" (autorizados: ${choices.map((c) => c.model).join(", ")})`);
	}
	if (index === 0) return choices;
	const next = [choices[index], ...choices.filter((_, i) => i !== index)];
	data.roleModels![role] = next;
	saveTiers(data);
	return next;
}

/** Resolve a preferência ou valida uma escolha explícita sem consultar quota/disponibilidade. */
export function resolveRoleModel(role: string, requestedModel?: string): ResolvedRoleModel | undefined {
	const choices = getRoleModelChoices(role);
	if (!choices) {
		if (requestedModel !== undefined) throw new Error(`Agent "${role}" has no configured model choices; explicit model override is not allowed.`);
		return undefined;
	}
	const choice = requestedModel !== undefined ? choices.find((item) => item.model === requestedModel) : choices[0];
	if (!choice) {
		const allowed = choices.map((item, index) => `${item.model} (thinking ${item.thinking}${index === 0 ? ", preferred" : ""})`).join(", ");
		throw new Error(`Model "${requestedModel}" is not allowed for agent "${role}". Allowed: ${allowed}.`);
	}
	return { ...choice, preference: choice === choices[0] };
}

export function formatRoleModelChoices(role: string): string | undefined {
	const choices = getRoleModelChoices(role);
	if (!choices) return undefined;
	return choices
		.map((choice, index) => `${choice.model} (thinking ${choice.thinking}${index === 0 ? ", preferred" : ""})`)
		.join(" OR ");
}

export function saveTiers(data: TiersFile): void {
	// Troca atômica: uma leitura concorrente nunca vê o arquivo pela metade.
	const temp = `${MODELS_FILE}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	renameSync(temp, MODELS_FILE);
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
	return { model: tier.model, thinking: tier.thinking, tier: name };
}
