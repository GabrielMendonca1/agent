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
			return (JSON.parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
		} catch {
			return {};
		}
	};
	const global = read(join(getAgentDir(), "settings.json"));
	// Configuração de shell do projeto pode executar código; só em projetos confiáveis.
	const merged = process.env.AGENT_TRUST_PROJECT_SHELL === "1"
		? { ...global, ...read(join(cwd, ".pi", "settings.json")) }
		: global;
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
	pi.on("user_bash", (event, ctx) => {
		const { commandPrefix, shellPath } = shellOptionsFromSettings(ctx?.cwd ?? process.cwd());
		const local = createLocalBashOperations({ shellPath });
		// O Pi já prefixou o texto passado a exec com settings mesclados. Use o evento original.
		const command = commandPrefix ? `${commandPrefix}\n${event.command}` : event.command;
		return { operations: { exec: (_command, cwd, options) => local.exec(command, cwd, { ...options, env: userCommandEnv(options.env ?? process.env) }) } };
	});

	// Preserva a definição nativa; aplica settings e o filtro de env por execução.
	const native = createBashToolDefinition(process.cwd());
	const execute = async (toolCallId: string, params: never, signal: AbortSignal | undefined, onUpdate: never, ctx: ExtensionContext) => {
		const cwd = ctx?.cwd ?? process.cwd();
		return createBashToolDefinition(cwd, shellOptionsFromSettings(cwd)).execute(toolCallId, params, signal, onUpdate, ctx);
	};
	pi.registerTool({ ...native, execute } as never);
}
