#!/usr/bin/env node
/**
 * Launcher gerenciado do Agent. O wrapper do overlay chama este script no caminho normal (nunca
 * nas rotas de manutenção) e ele decide, uma única vez por processo, o que executar:
 *
 *   pi <args>  ->  node <release física>/dist/cli.js <args> com AGENT_RUNTIME_ENABLED/AGENT_PI_ROOT (v3)
 *   opt-out    ->  <store>/current/bin/pi <args>                    sem nenhuma AGENT_JUICE_*
 *
 * Não existe fallback silencioso: configuração inválida, artefato alterado, broker de outra
 * arquitetura ou `piRoot` mutável abortam com diagnóstico e código 70. Um `pi` que anuncia
 * runtime e roda sem ele é pior do que um `pi` que não abre.
 *
 * O filho recebe o ambiente REAL (HOME, agent dir, modelos, thinking, NODE_OPTIONS do usuário
 * preservados), herda stdio e os sinais do terminal; o código de saída é propagado tal e qual.
 *
 *   node scripts/agent-launch.mjs [--store <abs>] [--print-spec] [--] [args do pi...]
 */
import { spawn } from "node:child_process";
import { buildAgentLaunch, defaultStore, DISABLE_ENV, MANAGED_ENV_KEYS } from "./lib/agent-runtime.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"];
const USAGE = `usage: agent-launch [--store <abs>] [--print-spec] [--worktree [slug] | --worktree=<slug>] [--] [pi args...]\n  ${DISABLE_ENV}=1 lança o Pi legado, sem Agent.`;

function parseArgs(argv) {
	const parsed = { store: undefined, printSpec: false, args: [] };
	let index = 0;
	for (; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") {
			// The wrapper inserts a separator after --store, before the user's arguments.
			if (parsed.store !== undefined) index++;
			break;
		}
		if (arg === "--store") {
			parsed.store = argv[++index];
			if (!parsed.store) throw new Error(`--store exige um caminho absoluto\n${USAGE}`);
			continue;
		}
		if (arg.startsWith("--store=")) {
			parsed.store = arg.slice("--store=".length);
			continue;
		}
		if (arg === "--print-spec") {
			parsed.printSpec = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		// Primeiro argumento que não é opção deste launcher pertence ao Pi.
		break;
	}
	parsed.args = argv.slice(index);
	return parsed;
}

let spec;
let launchStore;
let launchArgs = [];
let launchCwd;
try {
	const parsed = parseArgs(process.argv.slice(2));
	launchStore = parsed.store ?? defaultStore();
	// Keep the ordinary launch path independent of worktree setup.
	const argEnd = parsed.args.indexOf("--");
	const options = argEnd < 0 ? parsed.args : parsed.args.slice(0, argEnd);
	let workspace;
	if (options.some((arg) => arg === "--worktree" || arg.startsWith("--worktree="))) {
		workspace = await import("./lib/session-worktree.mjs");
		const { slug, args } = workspace.extractWorktreeOption(parsed.args);
		parsed.slug = slug;
		parsed.args = args;
	}
	launchArgs = parsed.args;
	spec = buildAgentLaunch({
		store: launchStore,
		env: process.env,
		args: parsed.args,
	});
	let sessionEnv = {};
	if (workspace) {
		const session = workspace.prepareSessionWorktree(parsed.slug, { env: spec.env, dryRun: parsed.printSpec });
		launchCwd = session.cwd;
		sessionEnv = session.env;
		Object.assign(spec.env, sessionEnv);
	}
	if (parsed.printSpec) {
		// Diagnóstico não pode despejar tokens/credenciais herdados no ambiente.
		const visible = new Set([...MANAGED_ENV_KEYS, "AGENT_ARTIFACT", "HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SYSTEM_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PATH", "TMPDIR", "PI_ACCOUNTS_MIRROR", "PI_OFFLINE", "ORCA_BACKGROUND_LAUNCH", "AGENT_LEARN", "AGENT_DISPATCHER"]);
		const env = Object.fromEntries(Object.entries(spec.env).filter(([key]) => visible.has(key)));
		process.stdout.write(`${JSON.stringify({ ...spec, ...(launchCwd ? { cwd: launchCwd } : {}), env: { ...env, ...sessionEnv } }, null, 2)}\n`);
		process.exit(0);
	}
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.stderr.write(`O Pi não foi iniciado. Para abrir o Pi sem Agent: ${DISABLE_ENV}=1 agent\n`);
	// 70 (EX_SOFTWARE): falha deste launcher, nunca confundível com um exit do Pi.
	process.exit(70);
}

for (const warning of spec.warnings) process.stderr.write(`Agent: ${warning}\n`);

// Aviso de checkout à frente da instalação: uma linha em stderr, só em sessão interativa, só git
// local com cache de 1h. Só neste launcher (Agent) de propósito: o caminho legado não paga um
// node extra na abertura; quem o usa consulta `agent overlay-status`. Qualquer falha (inclusive o helper ausente num bundle antigo) é silêncio.
try {
	const { maybeStaleNotice } = await import("./lib/overlay-stale.mjs");
	maybeStaleNotice({ store: launchStore, env: process.env, args: launchArgs });
} catch {
	/* o aviso nunca impede o Pi de abrir */
}

const child = spawn(spec.command, spec.args, { stdio: "inherit", env: spec.env, cwd: launchCwd });
const forward = (signal) => () => {
	// O terminal já manda o sinal para o grupo inteiro; reenviar é idempotente e cobre o caso de
	// um `kill` dirigido só a este processo.
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill(signal);
		} catch {
			/* o filho já saiu */
		}
	}
};
const handlers = new Map(FORWARDED_SIGNALS.map((signal) => [signal, forward(signal)]));
for (const [signal, handler] of handlers) {
	try {
		process.on(signal, handler);
	} catch {
		/* sinal inexistente nesta plataforma */
	}
}

child.on("error", (error) => {
	process.stderr.write(`Agent: não deu para executar ${spec.command}: ${error.message}\n`);
	process.exit(70);
});
child.on("exit", (code, signal) => {
	for (const [name, handler] of handlers) process.removeListener(name, handler);
	if (signal) {
		// Morrer do mesmo sinal preserva a semântica para o shell (e o 128+n de um `$?`).
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});
