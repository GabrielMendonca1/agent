/**
 * `skim` tool: ask a cheap model one question about a large file, command output or web page.
 * Commands run through the session's own `bash` tool (ctx.executeTool), so the same hooks,
 * sandbox and permission checks apply. The cheap model's usage is returned on the tool
 * result, which Pi adds to the session cost. Configuration: see core.ts.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWeb, wrap } from "../web/core.ts";
import { skim, type SkimSource } from "./core.ts";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

const textOf = (result: any) => (result?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");

async function fileSource(path: string, cwd: string): Promise<SkimSource> {
	const clean = path.replace(/^@/, "");
	const full = clean === "~" ? homedir() : clean.startsWith("~/") ? join(homedir(), clean.slice(2)) : isAbsolute(clean) ? clean : resolve(cwd, clean);
	const info = await stat(full);
	if (!info.isFile()) throw new Error(`skim: not a file: ${full}`);
	if (info.size > MAX_FILE_BYTES) throw new Error(`skim: file too large (${info.size} bytes > ${MAX_FILE_BYTES}); use rg`);
	const text = await readFile(full, "utf8");
	if (text.slice(0, 8192).includes("\u0000")) throw new Error(`skim: binary file: ${full}`);
	return { label: full, text, numbered: true };
}

async function commandSource(command: string, ctx: any, signal?: AbortSignal): Promise<SkimSource> {
	if (typeof ctx?.executeTool !== "function") throw new Error("skim: command needs the session bash tool, unavailable here");
	const outcome = await ctx.executeTool("bash", { command }, { signal });
	const structured = outcome?.result?.structuredContent;
	if (structured && typeof structured.output === "string") {
		return { label: `$ ${command} (exit ${structured.exit_code})`, text: structured.output, numbered: true };
	}
	if (outcome?.isError) throw new Error(`skim: bash failed: ${textOf(outcome.result).slice(0, 2000)}`);
	return { label: `$ ${command}`, text: textOf(outcome?.result), numbered: true };
}

export async function urlSource(web: ReturnType<typeof createWeb>, url: string, signal?: AbortSignal): Promise<SkimSource> {
	const page = await web.fetchText({ url }, signal);
	if (page.text === "PDF not supported") throw new Error("skim: PDF not supported");
	return { label: page.url, text: page.text, numbered: false };
}

/** Web answers stay inside the untrusted marker, like web_fetch pages. */
export function skimResult(result: { text: string; model: string; usage?: any }, source: SkimSource) {
	const text = source.numbered ? result.text : wrap(source.label, result.text);
	return { content: [{ type: "text" as const, text }], details: { model: result.model, source: source.label, chars: source.text.length }, ...(result.usage ? { usage: result.usage } : {}) };
}

export function createSkimExtension(makeWeb: () => ReturnType<typeof createWeb> = () => createWeb()) {
	return function (pi: ExtensionAPI) {
		let web = makeWeb();
		pi.on("session_start", () => { web = makeWeb(); });
		pi.registerTool({
			name: "skim", label: "Skim",
			description: "Ask a cheap model one question about a large file (path), bash command output (command) or web page (url); give exactly one. Returns a short answer with quotes and line numbers or URL, or says it is not in the source.",
			promptGuidelines: ["Use skim to understand large outputs, logs, diffs or pages when you do not need exact text; use read/rg for text you will edit or quote."],
			parameters: Type.Object({
				question: Type.String({ minLength: 1 }),
				path: Type.Optional(Type.String()),
				command: Type.Optional(Type.String()),
				url: Type.Optional(Type.String()),
			}),
			async execute(_id, params, signal, _onUpdate, ctx: any) {
				const given = (["path", "command", "url"] as const).filter((k) => typeof params[k] === "string" && params[k]!.trim());
				if (given.length !== 1) throw new Error("skim: give exactly one of path, command, url");
				const source = params.path ? await fileSource(params.path, ctx?.cwd ?? process.cwd())
					: params.command ? await commandSource(params.command, ctx, signal)
					: await urlSource(web, params.url!, signal);
				if (!ctx?.modelRegistry) throw new Error("skim: no model registry in this context");
				const result = await skim({ registry: ctx.modelRegistry, question: params.question, source, signal });
				return skimResult(result, source) as any;
			},
		});
	};
}

export default createSkimExtension();
