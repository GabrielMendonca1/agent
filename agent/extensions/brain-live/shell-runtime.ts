/** Shell do usuário/agente: execução nativa do Pi com ambiente filtrado. */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BashToolOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as childEnvModule from "../../core/child-env.mjs";

/** Env dos comandos do usuário/agente: sem preload do Agent nem curadoria de skills (best-effort). */
export function userCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	try {
		return (childEnvModule as unknown as { userCommandEnv(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv }).userCommandEnv(env);
	} catch {
		return env;
	}
}

function shellOptionsFromSettings(cwd: string): BashToolOptions {
	const read = (path: string): Record<string, unknown> => {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	};
	// Mesma precedência do Pi: projeto sobrescreve global.
	const merged = { ...read(join(getAgentDir(), "settings.json")), ...read(join(cwd, ".pi", "settings.json")) };
	const options: BashToolOptions = { spawnHook: (context) => ({ ...context, env: userCommandEnv(context.env) }) };
	if (typeof merged.shellCommandPrefix === "string") options.commandPrefix = merged.shellCommandPrefix;
	if (typeof merged.shellPath === "string") {
		const raw = merged.shellPath;
		options.shellPath = raw === "~" ? homedir() : raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw;
	}
	return options;
}

/** Settings são relidas por execução; o cwd vem da sessão, não da TUI. */
export default function shellRuntime(pi: ExtensionAPI) {
	// `!cmd` do usuário: mesma execução local do Pi, só com o env filtrado.
	pi.on("user_bash", (_event, ctx) => {
		try {
			const local = createLocalBashOperations(shellOptionsFromSettings(ctx?.cwd ?? process.cwd()));
			return { operations: { exec: (command, cwd, options) => local.exec(command, cwd, { ...options, env: userCommandEnv(options.env ?? process.env) }) } };
		} catch {
			return undefined;
		}
	});

	// Preserva a definição nativa; aplica o filtro de env pelo spawnHook.
	const native = createBashToolDefinition(process.cwd(), shellOptionsFromSettings(process.cwd()));
	const execute = async (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: never, ctx: ExtensionContext) => {
		const cwd = ctx?.cwd ?? process.cwd();
		return createBashToolDefinition(cwd, shellOptionsFromSettings(cwd)).execute(toolCallId, params, signal, onUpdate, ctx);
	};
	pi.registerTool({ ...native, execute } as never);
}
