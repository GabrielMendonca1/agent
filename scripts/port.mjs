#!/usr/bin/env node
/**
 * Port dos patches do overlay para uma release nova do Pi.
 *
 * O trabalho manual que isto substitui era sempre o mesmo e sempre frágil: clonar o Pi de novo,
 * criar um worktree na tag, aplicar patch por patch com `git apply --3way`, resolver conflito,
 * commitar, e no fim regravar cada `overlay/*.patch` com um `git diff` — lembrando de recalcular
 * o sha256 e o `overlayBase` no manifesto. Errar a ordem, esquecer um sha ou exportar o diff
 * errado produz um overlay que só falha lá na frente, no gate de vinte minutos.
 *
 * Aqui a série é explícita: um commit por patch, na ordem do manifesto, sobre a tag oficial.
 * `export` deriva os patches dessa série, então o que está no disco é sempre o que a série diz.
 *
 * Este script nunca toca no store: ele só mexe no cache de clones e no worktree de port.
 *
 *   node scripts/port.mjs start --ref v0.87.1 [--with <camada>] [--src <clone>] [--worktree <dir>]
 *   node scripts/port.mjs continue
 *   node scripts/port.mjs export
 *   node scripts/port.mjs status
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseLayerNames, selectLayers } from "./lib/layers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "overlay", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const defaultCache = process.env.ARCA_PI_CACHE
	? resolve(process.env.ARCA_PI_CACHE)
	: join(homedir(), ".cache", "arca-pi");
const stateFile = "arca-pi-port.json";

function fail(message) {
	throw new Error(message);
}

function git(args, { cwd, allowFailure = false, quiet = false } = {}) {
	if (!quiet) console.log(`+ git ${args.join(" ")}`);
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0 && !allowFailure) {
		fail(`git ${args.join(" ")} failed (${result.status}):\n${result.stderr ?? ""}`);
	}
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitOut(args, options) {
	return git(args, { ...options, quiet: true }).stdout.trim();
}

/**
 * Saída crua do git, sem decodificar. Um patch é gravado byte a byte e travado por SHA-256:
 * decodificar para string e reencodar passaria qualquer byte inválido por U+FFFD e produziria um
 * patch diferente do diff que o git gerou.
 */
function gitBytes(args, { cwd } = {}) {
	const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		fail(`git ${args.join(" ")} failed (${result.status}):\n${result.stderr?.toString("utf8") ?? ""}`);
	}
	return result.stdout;
}

function parseArgs(argv) {
	const command = argv[0];
	if (!command || command.startsWith("-")) {
		fail("Usage: port.mjs <start|continue|export|status> [--ref vX.Y.Z] [--with <layer>] [--without <layer>] [--src <clone>] [--worktree <dir>]");
	}
	const parsed = { command, ref: undefined, with: [], without: [], src: undefined, worktree: undefined };
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--ref") parsed.ref = argv[++index] ?? fail("--ref requires a value");
		else if (arg === "--with") parsed.with.push(argv[++index] ?? fail("--with requires a layer name"));
		else if (arg === "--without") parsed.without.push(argv[++index] ?? fail("--without requires a layer name"));
		else if (arg === "--src") parsed.src = resolve(argv[++index] ?? fail("--src requires a path"));
		else if (arg === "--worktree") parsed.worktree = resolve(argv[++index] ?? fail("--worktree requires a path"));
		else fail(`Unknown port option: ${arg}`);
	}
	parsed.with = parseLayerNames(parsed.with);
	parsed.without = parseLayerNames(parsed.without);
	return parsed;
}

function overlayPatches() {
	return (manifest.patches ?? []).map((patch) => ({ ...patch, file: join(repoRoot, patch.path) }));
}

/**
 * Um clone oficial em cache, com as tags atualizadas. Clonar de novo a cada port é o caminho
 * mais lento possível para descobrir que a tag existe; o cache mantém o custo no primeiro uso.
 *
 * O clone é completo de propósito. `git apply --3way` precisa dos blobs de pré-imagem citados
 * pelas linhas `index` do patch — que são da versão anterior do Pi. Num clone parcial
 * (`--filter=blob:none`) eles faltam, o 3-way desiste com "repository lacks the necessary blob"
 * e cai em aplicação direta: exatamente o merge que o port precisa, perdido para economizar disco.
 */
function ensureFullClone(clone) {
	if (gitOut(["-C", clone, "config", "--get", "remote.origin.promisor"], { allowFailure: true }) !== "true") return;
	console.log(`${clone} é um clone parcial; buscando os blobs para que o merge 3-way funcione`);
	git(["-C", clone, "config", "--unset", "remote.origin.partialclonefilter"], { allowFailure: true });
	git(["-C", clone, "config", "--unset", "remote.origin.promisor"], { allowFailure: true });
	git(["-C", clone, "fetch", "--refetch", "--force", "--tags", "origin"]);
}

function ensureClone(src) {
	if (src) {
		if (!existsSync(join(src, ".git")) && !existsSync(join(src, "HEAD"))) fail(`--src is not a git repository: ${src}`);
		ensureFullClone(src);
		git(["-C", src, "fetch", "--force", "--tags", "origin"]);
		return src;
	}
	const clone = join(defaultCache, "pi");
	if (!existsSync(clone)) {
		mkdirSync(defaultCache, { recursive: true });
		git(["clone", "--no-checkout", manifest.officialRepository, clone]);
	}
	// O Git for Windows instala `core.autocrlf=true` por padrão. Um worktree em CRLF não aceita os
	// patches e exportaria diffs com fim de linha trocado — bytes diferentes sob o mesmo SHA-256.
	git(["-C", clone, "config", "core.autocrlf", "false"], { quiet: true });
	git(["-C", clone, "config", "core.eol", "lf"], { quiet: true });
	ensureFullClone(clone);
	const remote = gitOut(["-C", clone, "remote", "get-url", "origin"]);
	if (remote !== manifest.officialRepository) {
		fail(`Cache clone ${clone} points at ${remote}, expected ${manifest.officialRepository}`);
	}
	git(["-C", clone, "fetch", "--force", "--tags", "origin"]);
	return clone;
}

/** O estado mora no git dir do worktree: fora da árvore de trabalho, logo fora de qualquer commit. */
function statePath(worktree) {
	return join(gitOut(["-C", worktree, "rev-parse", "--absolute-git-dir"]), stateFile);
}

function readState(worktree) {
	const file = statePath(worktree);
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeState(worktree, state) {
	writeFileSync(statePath(worktree), `${JSON.stringify(state, null, 2)}\n`);
}

/** Onde está o port em andamento: o que foi pedido, o cwd, ou o worktree de port mais recente. */
function locateWorktree(options) {
	const candidates = [];
	if (options.worktree) candidates.push(options.worktree);
	candidates.push(process.cwd());
	for (const candidate of candidates) {
		try {
			if (readState(candidate)) return gitOut(["-C", candidate, "rev-parse", "--show-toplevel"]);
		} catch {
			// Não é worktree, ou não tem estado: segue procurando.
		}
	}
	const clone = join(defaultCache, "pi");
	if (existsSync(clone)) {
		const listed = gitOut(["-C", clone, "worktree", "list", "--porcelain"])
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length));
		const found = listed.filter((path) => {
			try {
				return Boolean(readState(path));
			} catch {
				return false;
			}
		});
		if (found.length === 1) return found[0];
		if (found.length > 1) fail(`Several port worktrees are in progress; pass --worktree <dir>:\n  ${found.join("\n  ")}`);
	}
	return fail("No port in progress. Run `port.mjs start --ref vX.Y.Z` first, or pass --worktree <dir>.");
}

function unmergedFiles(worktree) {
	return gitOut(["-C", worktree, "diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
}

function dirtyFiles(worktree) {
	return gitOut(["-C", worktree, "status", "--porcelain"]).split("\n").filter(Boolean);
}

function conflictReport(state, patch, conflicted, stderr) {
	const lines = [
		`Patch "${patch.name}" não aplicou limpo em ${state.worktree} (tag ${state.ref}).`,
		conflicted.length > 0
			? `Arquivos em conflito (${conflicted.length}):\n${conflicted.map((file) => `  - ${file}`).join("\n")}`
			: `git apply não conseguiu nem o merge 3-way:\n${stderr.trim()}`,
		"",
		"Resolva no worktree, depois:",
		`  cd ${state.worktree}`,
		"  # edite os arquivos, remova os marcadores de conflito",
		"  git add <arquivos>",
		`  node ${join(repoRoot, "scripts", "port.mjs")} continue`,
	];
	return lines.join("\n");
}

function applySeries(worktree, state) {
	const patches = overlayPatches();
	while (state.pending.length > 0) {
		const name = state.pending[0];
		const patch = patches.find((candidate) => candidate.name === name) ?? fail(`Unknown patch in state: ${name}`);
		const applied = git(["-C", worktree, "apply", "--3way", "--whitespace=nowarn", patch.file], { allowFailure: true });
		if (applied.status !== 0) {
			state.conflict = name;
			writeState(worktree, state);
			fail(conflictReport(state, patch, unmergedFiles(worktree), applied.stderr));
		}
		commitPatch(worktree, state, patch.name);
	}
	console.log(`Série completa em ${worktree}. Agora: node ${join(repoRoot, "scripts", "port.mjs")} export`);
}

function commitPatch(worktree, state, name) {
	git(["-C", worktree, "add", "-A"]);
	if (dirtyFiles(worktree).length === 0) fail(`Patch "${name}" produziu uma árvore idêntica; nada para commitar`);
	git(["-C", worktree, "commit", "--no-verify", "-m", name]);
	const commit = gitOut(["-C", worktree, "rev-parse", "HEAD"]);
	state.applied.push({ name, commit });
	state.pending = state.pending.filter((pending) => pending !== name);
	state.conflict = null;
	writeState(worktree, state);
	console.log(`Commit de "${name}": ${commit.slice(0, 10)}`);
}

function start(options) {
	const ref = options.ref ?? fail("start requires --ref vX.Y.Z");
	const version = ref.replace(/^v/, "");
	const clone = ensureClone(options.src);
	const worktree = options.worktree ?? join(defaultCache, `port-${version}`);
	if (existsSync(worktree)) {
		fail(
			`${worktree} já existe. Rode \`port.mjs status\`/\`continue\` para retomá-lo, ou remova-o com ` +
				`\`git -C ${clone} worktree remove --force ${worktree}\` para recomeçar.`,
		);
	}
	const selection = selectLayers(overlayPatches(), { with: options.with, without: options.without });
	git(["-C", clone, "worktree", "add", "--detach", worktree, ref]);
	const baseCommit = gitOut(["-C", worktree, "rev-parse", "HEAD"]);
	const state = {
		ref,
		version,
		clone,
		worktree,
		baseCommit,
		startedAt: new Date().toISOString(),
		patches: selection.selected.map((patch) => patch.name),
		applied: [],
		pending: selection.selected.map((patch) => patch.name),
		conflict: null,
	};
	writeState(worktree, state);
	console.log(`Port de ${ref} (${baseCommit.slice(0, 10)}) em ${worktree}: ${state.patches.join(", ")}`);
	applySeries(worktree, state);
}

function proceed(options) {
	const worktree = locateWorktree(options);
	const state = readState(worktree) ?? fail(`No port state in ${worktree}`);
	if (state.conflict) {
		const unmerged = unmergedFiles(worktree);
		if (unmerged.length > 0) {
			fail(
				`Ainda há conflitos não resolvidos em ${worktree}:\n${unmerged.map((file) => `  - ${file}`).join("\n")}\n` +
					`Resolva, \`git add\` e rode este comando de novo.`,
			);
		}
		commitPatch(worktree, state, state.conflict);
	}
	applySeries(worktree, state);
}

/**
 * Regrava cada patch da série a partir do diff do seu commit contra o pai, e fecha o manifesto:
 * sha256 novo por patch e `overlayBase` na tag de onde a série saiu. Patch fora da série não é
 * tocado — portar só o que quebrou é o caso comum.
 */
function exportSeries(options) {
	const worktree = locateWorktree(options);
	const state = readState(worktree) ?? fail(`No port state in ${worktree}`);
	if (state.pending.length > 0) {
		fail(`Port incompleto: faltam ${state.pending.join(", ")}. Rode \`port.mjs continue\` antes de exportar.`);
	}
	const patches = overlayPatches();
	const changed = [];
	for (const entry of state.applied) {
		const patch = patches.find((candidate) => candidate.name === entry.name) ?? fail(`Unknown patch: ${entry.name}`);
		// O diff exportado não pode depender do `~/.gitconfig` de quem exporta: `diff.noprefix`,
		// `diff.mnemonicPrefix`, `color.ui`, um driver externo ou detecção de rename mudam os bytes do
		// patch — e, com eles, o sha256 do manifesto — sem que nada no port tenha mudado.
		// `--full-index`: a abreviação padrão do hash depende do tamanho do clone, então o mesmo
		// commit exportado em duas máquinas produziria bytes (e sha256) diferentes sem mudar nada.
		// `--no-renames`: os patches versionados não carregam rename nenhum, e `git apply` de um bloco
		// `rename from/to` não sobrevive a um upstream que mexeu no arquivo.
		const diff = gitBytes([
			"-c",
			"diff.noprefix=false",
			"-c",
			"diff.mnemonicPrefix=false",
			"-c",
			"color.ui=never",
			"-C",
			worktree,
			"diff",
			"--no-ext-diff",
			"--no-color",
			"--no-renames",
			"--full-index",
			`${entry.commit}^`,
			entry.commit,
		]);
		if (diff.length === 0) fail(`Commit ${entry.commit.slice(0, 10)} ("${entry.name}") tem diff vazio`);
		const body = diff.at(-1) === 0x0a ? diff : Buffer.concat([diff, Buffer.from("\n")]);
		const previous = existsSync(patch.file) ? readFileSync(patch.file) : Buffer.alloc(0);
		writeFileSync(patch.file, body);
		const sha256 = createHash("sha256").update(body).digest("hex");
		const declared = manifest.patches.find((candidate) => candidate.name === entry.name);
		declared.sha256 = sha256;
		changed.push({ name: entry.name, path: patch.path, sha256, unchanged: previous.equals(body) });
	}
	manifest.overlayBase = state.baseCommit;
	manifest.overlayRef = state.ref;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const entry of changed) {
		console.log(`${entry.unchanged ? "igual " : "novo  "} ${entry.path} sha256 ${entry.sha256}`);
	}
	console.log(`overlayBase = ${state.baseCommit} (${state.ref})`);
	console.log(
		`Agora rode o gate: node ${join(repoRoot, "scripts", "agent-update.mjs")} --check --hydrate --ref ${state.ref} --vendor-model-data`,
	);
}

function status(options) {
	const worktree = locateWorktree(options);
	const state = readState(worktree) ?? fail(`No port state in ${worktree}`);
	console.log(`worktree: ${state.worktree}`);
	console.log(`clone:    ${state.clone}`);
	console.log(`ref:      ${state.ref} (${state.baseCommit.slice(0, 10)})`);
	console.log(`série:    ${state.patches.join(", ")}`);
	for (const entry of state.applied) console.log(`  ok       ${entry.name} ${entry.commit.slice(0, 10)}`);
	for (const name of state.pending) console.log(`  pendente ${name}${state.conflict === name ? " (em conflito)" : ""}`);
	if (state.conflict) {
		const unmerged = unmergedFiles(worktree);
		console.log(
			unmerged.length > 0
				? `conflitos:\n${unmerged.map((file) => `  - ${file}`).join("\n")}`
				: "conflito resolvido; rode `port.mjs continue`",
		);
	} else if (state.pending.length === 0) {
		console.log("série completa; rode `port.mjs export`");
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.command === "start") return start(options);
	if (options.command === "continue") return proceed(options);
	if (options.command === "export") return exportSeries(options);
	if (options.command === "status") return status(options);
	fail(`Unknown command: ${options.command}. Use start, continue, export or status.`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
