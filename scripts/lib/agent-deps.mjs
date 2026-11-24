#!/usr/bin/env node
// Dependências externas das skills/papéis do Agent: status, instalação pela fonte oficial e passos
// que só o humano pode fazer. Só builtins: roda no bundle instalado, sem checkout.
//
//   agent deps            status (somente leitura)
//   agent deps --install  instala o que falta (macOS); nas outras plataformas imprime instruções
//
// No install/update (`--install-artifact`), `postInstallDeps` pergunta uma vez num TTY; fora de TTY
// só imprime a linha com `agent deps --install`. AGENT_INSTALL_DEPS=1 instala sem perguntar, =0 pula.
// Nenhuma falha daqui altera o resultado da instalação do Agent.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CUA_INSTALLER = "https://cua.ai/driver/install.sh";

/**
 * Manifesto único. `install.darwin` lista os passos automáticos (fonte oficial); `manual` são os
 * passos que exigem o humano e nunca rodam daqui; `instructions` vale para as outras plataformas.
 */
export const DEPENDENCIES = [
	{
		name: "agent-browser",
		bin: "agent-browser",
		minVersion: "0.43.0",
		usedBy: "skill computer-use (web)",
		source: "https://agent-browser.dev/installation",
		install: {
			darwin: [
				{ kind: "brew", args: ["install", "agent-browser"] },
				// Baixa o Chrome que o CLI controla; sem humano no meio.
				{ kind: "self", args: ["install"] },
			],
		},
		instructions: {
			linux: "npm install -g agent-browser && agent-browser install --with-deps",
			win32: "npm install -g agent-browser && agent-browser install",
		},
		manual: [],
	},
	{
		name: "cua-driver",
		bin: "cua-driver",
		minVersion: "0.36.0",
		usedBy: "skill computer-use (janelas nativas macOS)",
		source: "https://github.com/trycua/cua/tree/main/libs/cua-driver",
		install: {
			// --no-connect: não registra MCP no Claude Code/Codex/Cursor (a skill usa o CLI) e pula o
			// guia de permissões; --no-test: o self-test depende das permissões, que são passo humano.
			darwin: [{ kind: "script", url: CUA_INSTALLER, args: ["--no-connect", "--no-test"] }],
		},
		instructions: {
			linux: `/bin/bash -c "$(curl -fsSL ${CUA_INSTALLER})"`,
			win32: "irm https://cua.ai/driver/install.ps1 | iex",
		},
		manual: ["cua-driver permissions grant   # conceda Acessibilidade e Gravação de Tela ao CuaDriver"],
	},
	{
		name: "agy",
		bin: "agy",
		minVersion: "1.5.16",
		usedBy: "papel gemini (Antigravity CLI)",
		source: "https://antigravity.google",
		install: { darwin: [{ kind: "brew", args: ["install", "--cask", "antigravity-cli"] }] },
		instructions: {
			linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
			win32: "irm https://antigravity.google/cli/install.ps1 | iex",
		},
		manual: ["agy   # uma vez, se ainda não fez o login Google (OAuth)"],
	},
];

function isExecutable(path) {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathDirs(env) {
	return (env.PATH ?? "").split(delimiter).filter(Boolean);
}

function findIn(dirs, bin, platform) {
	const names = platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
	for (const dir of dirs) for (const name of names) {
		const candidate = join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

export function findBrew({ env = process.env, brewCandidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] } = {}) {
	return findIn(pathDirs(env), "brew", "darwin") ?? brewCandidates.find(isExecutable) ?? null;
}

function parseVersion(text) {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
	return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

function context(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? homedir();
	const brew = platform === "darwin" ? findBrew({ env, brewCandidates: options.brewCandidates }) : null;
	return { env, platform, home, brew };
}

/** Status de uma dependência: `ok`, `outdated`, `unknown` (sem versão legível) ou `missing`. */
function inspect(dep, ctx) {
	let path = findIn(pathDirs(ctx.env), dep.bin, ctx.platform);
	let onPath = Boolean(path);
	if (!path) {
		// Instaladores oficiais usam ~/.local/bin (cua-driver) e o prefixo do Homebrew, que nem sempre
		// está no PATH de quem chama (app, CI).
		const extra = [join(ctx.home, ".local", "bin"), ...(ctx.brew ? [dirname(ctx.brew)] : [])];
		path = findIn(extra, dep.bin, ctx.platform);
	}
	if (!path) return { dep, state: "missing" };
	const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15000, env: ctx.env });
	const version = parseVersion(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
	const state = !version ? "unknown" : compareVersions(version, parseVersion(dep.minVersion)) < 0 ? "outdated" : "ok";
	const result = { dep, state, path, onPath, version: version?.join(".") };
	if (dep.name === "cua-driver" && ctx.platform === "darwin") result.permissions = cuaPermissions(path, ctx);
	return result;
}

/** `cua-driver permissions status` é somente leitura; `missing` lista grants não concedidos. */
function cuaPermissions(path, ctx) {
	const run = spawnSync(path, ["permissions", "status"], { encoding: "utf8", timeout: 15000, env: ctx.env });
	if (run.error || run.status !== 0) return { known: false, missing: [] };
	const missing = [];
	for (const line of (run.stdout ?? "").split(/\r?\n/)) {
		const match = /^(Accessibility|Screen Recording):\s*(.*)$/.exec(line.trim());
		if (match && (/not granted|denied|❌/i.test(match[2]) || !/granted/i.test(match[2]))) missing.push(match[1]);
	}
	return { known: true, missing };
}

export function dependencyStatus(options = {}) {
	const ctx = context(options);
	return { ctx, results: DEPENDENCIES.map((dep) => inspect(dep, ctx)) };
}

function describeStep(step, dep) {
	if (step.kind === "brew") return `brew ${step.args.join(" ")}`;
	if (step.kind === "self") return `${dep.bin} ${step.args.join(" ")}`;
	return `/bin/bash -c "$(curl -fsSL ${step.url})" -- ${step.args.join(" ")}`;
}

function installHint(dep, ctx) {
	if (ctx.platform === "darwin") {
		const steps = dep.install.darwin;
		if (steps.some((s) => s.kind === "brew") && !ctx.brew) return `instale o Homebrew (https://brew.sh) e rode: agent deps --install`;
		return steps.map((s) => describeStep(s, dep)).join(" && ");
	}
	return dep.instructions[ctx.platform] ?? `veja ${dep.source}`;
}

const label = { ok: "ok", outdated: "desatualizado", unknown: "versão ilegível", missing: "ausente" };

export function formatStatus({ ctx, results }) {
	const lines = [];
	for (const r of results) {
		const head = `${r.dep.name.padEnd(14)} ${label[r.state].padEnd(16)}`;
		const where = r.path ? `${r.version ?? "?"} (mín. ${r.dep.minVersion}) ${r.path}${r.onPath ? "" : ` — fora do PATH: adicione ${dirname(r.path)} ao PATH`}` : `mín. ${r.dep.minVersion}`;
		lines.push(`${head} ${where}  · ${r.dep.usedBy}`);
		if (r.state === "missing") lines.push(`  instalar: ${installHint(r.dep, ctx)}`);
		if (r.state === "outdated") lines.push(`  atualize pela fonte em que foi instalado (${r.dep.source})`);
		if (r.permissions?.known && r.permissions.missing.length) lines.push(`  permissões pendentes (${r.permissions.missing.join(", ")}): cua-driver permissions grant`);
		if (r.permissions && !r.permissions.known) lines.push("  permissões: status indisponível (daemon parado?); se preciso: cua-driver permissions grant");
	}
	if (ctx.platform === "darwin" && !ctx.brew && results.some((r) => r.state === "missing" && r.dep.install.darwin.some((s) => s.kind === "brew"))) {
		lines.push("Homebrew não encontrado: instale em https://brew.sh para que `agent deps --install` instale agent-browser e agy.");
	}
	return lines.join("\n");
}

function runStep(step, dep, ctx, binPath) {
	const stdio = ["inherit", "inherit", "inherit"];
	if (step.kind === "brew") return spawnSync(ctx.brew, step.args, { stdio, env: ctx.env });
	if (step.kind === "self") return spawnSync(binPath, step.args, { stdio, env: ctx.env });
	// Mesma forma do README oficial: o script vem do curl e roda com o stdin do terminal.
	return spawnSync("/bin/bash", ["-c", 'script=$(curl -fsSL "$1") || exit 1; shift; exec /bin/bash -c "$script" agent-deps "$@"', "agent-deps", step.url, ...step.args], { stdio, env: ctx.env });
}

/**
 * Instala as dependências ausentes. Devolve `{ installed, failed, skipped }` por nome; nunca lança.
 * Fora do macOS só imprime as instruções.
 */
export function installMissing(options = {}) {
	const log = options.log ?? ((line) => console.log(line));
	const { ctx, results } = dependencyStatus(options);
	const missing = results.filter((r) => r.state === "missing");
	const outcome = { installed: [], failed: [], skipped: [] };
	if (!missing.length) {
		log("Agent deps: nada a instalar.");
		return { ...outcome, ctx, results };
	}
	if (ctx.platform !== "darwin") {
		log(`Agent deps: instalação automática só no macOS. Instale manualmente:`);
		for (const r of missing) log(`  ${r.dep.name}: ${installHint(r.dep, ctx)}`);
		outcome.skipped.push(...missing.map((r) => r.dep.name));
		return { ...outcome, ctx, results };
	}
	for (const r of missing) {
		const dep = r.dep;
		const steps = dep.install.darwin;
		if (steps.some((s) => s.kind === "brew") && !ctx.brew) {
			log(`Agent deps: ${dep.name} precisa do Homebrew (https://brew.sh); pulado.`);
			outcome.skipped.push(dep.name);
			continue;
		}
		let ok = true;
		for (const step of steps) {
			const binPath = step.kind === "self" ? inspect(dep, context(options)).path : null;
			if (step.kind === "self" && !binPath) { ok = false; log(`Agent deps: ${dep.bin} não apareceu depois da instalação.`); break; }
			log(`Agent deps: ${dep.name}: ${describeStep(step, dep)}`);
			let run;
			try { run = runStep(step, dep, ctx, binPath); } catch (error) { run = { error }; }
			if (run.error || run.status !== 0) {
				ok = false;
				log(`Agent deps: ${dep.name} falhou (${run.error?.message ?? `código ${run.status}`}). Tente de novo com: agent deps --install`);
				break;
			}
		}
		if (ok && inspect(dep, context(options)).state === "missing") {
			ok = false;
			log(`Agent deps: o instalador de ${dep.name} terminou, mas ${dep.bin} não foi encontrado.`);
		}
		(ok ? outcome.installed : outcome.failed).push(dep.name);
	}
	const after = dependencyStatus(options);
	log(formatStatus(after));
	printManualSteps(after.results, log);
	return { ...outcome, ctx: after.ctx, results: after.results };
}

function printManualSteps(results, log) {
	const steps = results.filter((r) => r.state !== "missing").flatMap((r) => {
		if (r.dep.name === "cua-driver" && r.permissions?.known && !r.permissions.missing.length) return [];
		return r.dep.manual;
	});
	if (!steps.length) return;
	log("Passos manuais (só você pode fazer):");
	for (const step of steps) log(`  ${step}`);
}

async function confirm(question) {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^(s|sim|y|yes)?$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

/**
 * Hook do install/update. Nunca lança nem muda exit code: qualquer erro vira uma linha de log.
 */
export async function postInstallDeps(options = {}) {
	const env = options.env ?? process.env;
	const log = options.log ?? ((line) => console.log(line));
	try {
		const mode = env.AGENT_INSTALL_DEPS;
		if (mode === "0") return;
		const status = dependencyStatus(options);
		const missing = status.results.filter((r) => r.state === "missing").map((r) => r.dep.name);
		if (!missing.length) return;
		const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI);
		if (mode === "1") {
			installMissing(options);
			return;
		}
		if (!interactive || status.ctx.platform !== "darwin") {
			log(`Agent: dependências externas ausentes (${missing.join(", ")}); veja/instale com: agent deps --install`);
			return;
		}
		log("Agent: dependências externas ausentes:");
		log(formatStatus({ ctx: status.ctx, results: status.results.filter((r) => r.state === "missing") }));
		if (await confirm("Instalar agora pela fonte oficial? [S/n] ")) installMissing(options);
		else log("Agent: pulado; instale depois com: agent deps --install");
	} catch (error) {
		log(`Agent: verificação de dependências externas falhou (${error.message}); rode: agent deps`);
	}
}

export function main(args = process.argv.slice(2)) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log("Uso: agent deps [--install]\n  sem flags: status das dependências externas\n  --install: instala as ausentes pela fonte oficial (macOS)");
		return 0;
	}
	const unknown = args.filter((a) => a !== "--install");
	if (unknown.length) {
		console.error(`agent deps: argumento desconhecido: ${unknown.join(" ")}`);
		return 2;
	}
	if (args.includes("--install")) {
		const outcome = installMissing();
		return outcome.failed.length ? 1 : 0;
	}
	const status = dependencyStatus();
	console.log(formatStatus(status));
	printManualSteps(status.results, (line) => console.log(line));
	if (status.results.some((r) => r.state === "missing")) console.log("Instale o que falta com: agent deps --install");
	return 0;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exitCode = main();
}
