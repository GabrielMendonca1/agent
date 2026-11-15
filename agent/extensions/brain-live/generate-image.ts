/**
 * generate_image — gera/edita imagens com o GPT Image da conta ChatGPT (login Codex).
 *
 * Usa o backend Codex (`chatgpt.com/backend-api/codex/responses`) com a tool
 * nativa `image_generation`; não precisa de OPENAI_API_KEY. O modelo "host" e
 * a qualidade/tamanho vêm do tier `image` em agent-models.json no perfil Agent (/models).
 *
 * Saída: PNG salvo em `output` (ou ~/Pictures/pi-images/<timestamp>.png).
 * Com `reference_images`, o pedido vira edição (as imagens vão como input_image).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadTiers } from "./lib/tiers.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_DIR = join(homedir(), "Pictures", "pi-images");
const SUNBURST_MODEL = "gpt-image-2.5-sunburst";
const FLARE_MODEL = "gpt-image-2.5-flare";
const IMAGE_MODELS = ["auto", SUNBURST_MODEL, FLARE_MODEL] as const;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const Params = Type.Object({
	prompt: Type.String({ description: "What to generate or how to edit the reference images. Be specific: subject, style, composition, text to render." }),
	output: Type.Optional(Type.String({ description: `Absolute .png path to save. Default: ${DEFAULT_DIR}/<timestamp>.png` })),
	reference_images: Type.Optional(
		Type.Array(Type.String(), { description: "Absolute paths of images to edit/use as reference (png/jpg/jpeg/webp/gif; max 20MB each)." }),
	),
	model: Type.Optional(
		StringEnum(IMAGE_MODELS, {
			description:
				"Image model selector. Default auto omits tools[].model because GPT Image 2.5 selection is not yet confirmed by the backend. Explicit 2.5 requests fail unless the server confirms the same model (or its dated snapshot).",
			default: "auto",
		}),
	),
	size: Type.Optional(StringEnum(["auto", "1024x1024", "1024x1536", "1536x1024"] as const)),
	quality: Type.Optional(StringEnum(["low", "medium", "high", "xhigh", "max", "auto"] as const)),
	background: Type.Optional(StringEnum(["auto", "opaque", "transparent"] as const)),
});

function accountIdFromToken(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("token Codex inválido");
	const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, { chatgpt_account_id?: string }>;
	const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	if (!id) throw new Error("token Codex sem chatgpt_account_id");
	return id;
}

function mimeOf(path: string): string {
	const ext = extname(path).toLowerCase();
	return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
}

function timestampName(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

function confirmedModel(requested: string, actual: string): boolean {
	if (actual === requested) return true;
	const suffix = actual.slice(requested.length);
	return actual.startsWith(`${requested}-`) && /^-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(suffix);
}

function imageModelFromResponse(response: any): string | undefined {
	const tool = Array.isArray(response?.tools) ? response.tools.find((candidate: any) => candidate?.type === "image_generation") : undefined;
	return typeof tool?.model === "string" && tool.model.length > 0 ? tool.model : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		exposure: "deferred",
		label: "Generate image",
		description:
			"Generate a new image, or edit/combine reference images, with GPT Image (ChatGPT account). Saves a new PNG without overwriting. The backend has not yet confirmed GPT Image 2.5 selector support; auto keeps current generation working, while explicit 2.5 requests require server confirmation.",
		promptSnippet: "Generate or edit images with GPT Image (saves a PNG)",
		promptGuidelines: [
			"Use generate_image for any request to create or edit a picture; give a concrete prompt and, when editing, pass the source files in reference_images. After it returns, read the PNG to check the result before reporting.",
		],
		parameters: Params,
		async execute(_id, params, signal, onUpdate, ctx) {
			const requestedModel = params.model ?? "auto";
			const explicitModel = requestedModel !== "auto";
			const out = params.output ? resolve(params.output) : join(DEFAULT_DIR, timestampName());
			if (extname(out).toLowerCase() !== ".png") throw new Error(`output precisa terminar em .png: ${out}`);
			if (existsSync(out)) throw new Error(`output já existe; sobrescrita recusada: ${out}`);

			const tier = loadTiers().tiers.image;
			const [provider, ...rest] = tier.model.split("/");
			if (provider !== "openai-codex") {
				throw new Error(`tier image precisa de um modelo openai-codex (atual: ${tier.model}); ajuste em /models`);
			}
			const hostModel = rest.join("/");
			const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (!token) throw new Error("sem login Codex — rode /login openai-codex");
			const accountId = accountIdFromToken(token);

			const refs = (params.reference_images ?? []).map((p) => resolve(p));
			for (const r of refs) {
				if (!existsSync(r)) throw new Error(`referência não encontrada: ${r}`);
				if (!REFERENCE_EXTENSIONS.has(extname(r).toLowerCase())) throw new Error(`formato de referência não permitido: ${r}`);
				const stat = statSync(r);
				if (!stat.isFile()) throw new Error(`referência não é arquivo: ${r}`);
				if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`referência excede 20MB: ${r}`);
			}

			const content: Array<Record<string, string>> = [{ type: "input_text", text: params.prompt }];
			for (const r of refs) {
				content.push({ type: "input_image", image_url: `data:${mimeOf(r)};base64,${readFileSync(r).toString("base64")}` });
			}

			const body = {
				model: hostModel,
				instructions:
					"You are an image generation assistant. Always call the image_generation tool exactly once to fulfil the request, then reply with one short sentence describing what was produced.",
				input: [{ role: "user", content }],
				tools: [
					{
						type: "image_generation",
						...(explicitModel ? { model: requestedModel } : {}),
						size: params.size ?? tier.size ?? "auto",
						quality: params.quality ?? tier.quality ?? "auto",
						background: params.background ?? "auto",
						output_format: "png",
					},
				],
				tool_choice: { type: "image_generation" },
				stream: true,
				store: false,
			};

			const progressText = explicitModel
				? `variante solicitada: ${requestedModel}; aguardando confirmação do backend…`
				: "modelo automático do servidor; suporte ao seletor GPT Image 2.5 ainda não confirmado…";
			onUpdate?.({
				content: [{ type: "text", text: `${refs.length ? "editando" : "gerando"} imagem — ${progressText}` }],
				details: { requestedModel, actualModel: "server/unconfirmed" },
			});

			const res = await fetch(CODEX_URL, {
				method: "POST",
				signal,
				headers: {
					Authorization: `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					originator: "pi",
					"OpenAI-Beta": "responses=experimental",
					accept: "text/event-stream",
					"content-type": "application/json",
					"session-id": crypto.randomUUID(),
				},
				body: JSON.stringify(body),
			});
			if (!res.ok || !res.body) {
				throw new Error(
					`Codex recusou a variante solicitada ${requestedModel} em tools[].model (sem fallback): ${res.status} ${(await res.text()).slice(0, 400)}`,
				);
			}

			let b64: string | undefined;
			let revised: string | undefined;
			let note = "";
			let errorMsg: string | undefined;
			let actualModel: string | undefined;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line.startsWith("data:")) continue;
					let ev: any;
					try {
						ev = JSON.parse(line.slice(5));
					} catch {
						continue;
					}
					const t = ev?.type as string | undefined;
					if (t === "response.created" || t === "response.completed") {
						const reportedModel = imageModelFromResponse(ev.response);
						if (reportedModel) {
							actualModel = reportedModel;
							if (explicitModel && !confirmedModel(requestedModel, reportedModel)) {
								await reader.cancel().catch(() => undefined);
								throw new Error(
									`backend não confirmou ${requestedModel}: response.tools image_generation informou ${reportedModel}; PNG descartado (sem retry/fallback)`,
								);
							}
						}
					}
					if (t === "error" || t === "response.failed") {
						errorMsg = JSON.stringify(ev?.error ?? ev?.response?.error ?? ev).slice(0, 400);
					} else if (t === "response.image_generation_call.generating") {
						onUpdate?.({
							content: [{ type: "text", text: `renderizando — ${progressText}` }],
							details: { requestedModel, actualModel: explicitModel ? actualModel ?? "server/unconfirmed" : "server/unconfirmed" },
						});
					} else if (t === "response.output_item.done") {
						const item = ev.item;
						if (item?.type === "image_generation_call") {
							b64 = item.result ?? b64;
							revised = item.revised_prompt ?? revised;
							if (item.status && item.status !== "completed") errorMsg = `image_generation ${item.status}`;
						} else if (item?.type === "message") {
							note = (item.content ?? []).map((c: any) => c.text ?? "").join("").trim();
						}
					}
				}
			}
			if (errorMsg) {
				throw new Error(`Codex falhou com a variante solicitada ${requestedModel} (sem fallback): ${errorMsg}`);
			}
			if (explicitModel && !actualModel) {
				throw new Error(
					`backend não informou response.tools image_generation.model para confirmar ${requestedModel}; PNG descartado (sem retry/fallback)`,
				);
			}
			if (!b64) {
				throw new Error(`Codex não devolveu PNG para a variante solicitada ${requestedModel} (sem retry/fallback)`);
			}

			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, Buffer.from(b64, "base64"), { flag: "wx" });

			const resolvedActualModel = explicitModel ? actualModel! : "server/unconfirmed";
			const lines = [`saved: ${out}`, `requested image model: ${requestedModel}`, `actual image model: ${resolvedActualModel}`];
			if (revised) lines.push(`revised prompt: ${revised}`);
			if (note) lines.push(note);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					path: out,
					revisedPrompt: revised,
					references: refs,
					size: body.tools[0].size,
					quality: body.tools[0].quality,
					requestedModel,
					actualModel: resolvedActualModel,
				},
			};
		},
		renderCall(args, theme) {
			const refs = args.reference_images?.length ? theme.fg("dim", ` (${args.reference_images.length} ref)`) : "";
			const model = theme.fg("dim", ` [${args.model ?? "auto"}]`);
			return new Text(theme.fg("toolTitle", theme.bold("generate_image ")) + theme.fg("accent", args.prompt.slice(0, 80)) + model + refs, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { path?: string } | undefined;
			return new Text(d?.path ? theme.fg("success", `✓ ${basename(d.path)}`) + theme.fg("dim", `  ${dirname(d.path)}`) : theme.fg("muted", "…"), 0, 0);
		},
	});
}
