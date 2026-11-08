#!/usr/bin/env node
/**
 * Testes de `overlay-status`, do aviso de checkout à frente, do `overlay-gc` e da camada removida.
 *
 * Tudo roda em stores temporários com fixtures sintéticas e num repositório git temporário; nada
 * toca ~/.local/share/agent nem a rede.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { overlayGc, planOverlayGc } from "./agent-update.mjs";
import { maybeStaleNotice, staleAhead, STALE_CACHE_FILE } from "./lib/overlay-stale.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const updater = join(here, "agent-update.mjs");
const raiz = realpathSync(mkdtempSync(join(tmpdir(), "overlay-status-gc-")));
const feito = [];
function teste(nome, fn) {
	fn();
	feito.push(nome);
}

const git = (cwd, ...args) =>
	spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const commit = (repo, nome) => {
	writeFileSync(join(repo, nome), nome);
	git(repo, "add", ".");
	assert.equal(git(repo, "commit", "-m", nome).status, 0);
	return git(repo, "rev-parse", "HEAD").stdout.trim();
};
const novoRepo = () => {
	const repo = mkdtempSync(join(raiz, "repo-"));
	assert.equal(git(repo, "init", "-q").status, 0);
	return { repo, first: commit(repo, "a") };
};
const roda = (args, env = {}) =>
	spawnSync(process.execPath, [updater, ...args], { encoding: "utf8", env: { ...process.env, AGENT_STORE: "", ...env } });

const dia = (n) => new Date(Date.UTC(2026, 9, 1 + n));
function dir(path, dias) {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "f.txt"), "x".repeat(100));
	if (dias !== undefined) utimesSync(path, dia(dias), dia(dias));
	return path;
}
const bk = (i) => `2026-10-0${i + 1}T00-00-00-000Z-agent-disable`;
const launcherBk = "2026-09-14T18-01-10-527Z";
const enableAntigo = "2026-09-01T00-00-00-001Z-agent-enable";
const link = (alvo, caminho) => symlinkSync(alvo, caminho, process.platform === "win32" ? "junction" : undefined);

/** Store sintético: current/previous, órfãs, artefatos Agent, recibos, backups, candidates. */
function novoStore(extra = {}) {
	const store = mkdtempSync(join(raiz, "store-"));
	const rel = (nome, dias) => dir(join(store, "releases", nome), dias);
	const cur = rel("cur", 10);
	const prev = rel("prev", 9);
	rel("orf-novo", 8);
	rel("orf-velho", 1);
	rel("orf-velho2", 2);
	rel("preparada", 3);
	link(cur, join(store, "current"));
	link(prev, join(store, "previous"));
	mkdirSync(join(store, "prepared"), { recursive: true });
	writeFileSync(join(store, "prepared", "preparada.json"), JSON.stringify({ currentAtPrepare: cur }));
	writeFileSync(join(store, "prepared", "sumiu.json"), "{}");
	const artefato = (id, piRoot, dias) => {
		const d = dir(join(store, "runtime", "releases", id), dias);
		writeFileSync(join(d, "manifest.json"), JSON.stringify({ artifactId: id, piRoot }));
		utimesSync(d, dia(dias), dia(dias));
	};
	artefato("ativo", join(cur, "pkg"), 1);
	artefato("rollback", join(prev, "pkg"), 2);
	artefato("sobra-nova", join(cur, "pkg"), 7);
	artefato("sobra-velha", join(cur, "pkg"), 3);
	artefato("sobra-velha2", join(cur, "pkg"), 4);
	writeFileSync(join(store, "runtime", "config.json"), JSON.stringify({ enabled: true, artifactId: "ativo", piRoot: join(cur, "pkg"), juiceHome: "/segredo" }));
	dir(join(store, "runtime", "build-cache", "release"));
	dir(join(store, "runtime", "resource-snapshots"));
	dir(join(store, "runtime", "resources-backup"));
	for (let i = 0; i < 7; i++) dir(join(store, "backups", bk(i)), i);
	// Protegidos: launcher original (com restore.txt), enable mais antigo, e um diretório que não é do updater.
	for (const nome of [launcherBk, enableAntigo]) {
		dir(join(store, "backups", nome), -30);
		writeFileSync(join(store, "backups", nome, "restore.txt"), "mv x y\n");
	}
	dir(join(store, "backups", "local-audited-x573ukc0"), -40);
	dir(join(store, "candidates", "port"));
	writeFileSync(
		join(store, "active.json"),
		JSON.stringify({ officialVersion: "1.1.0", officialRef: "v1.1.0", officialCommit: "a".repeat(40), patches: { x: "1" }, optionalLayers: [], releaseDir: cur, agent: { artifactId: "ativo" }, updaterGeneration: 4, ...extra }),
	);
	return { store, cur, prev };
}
const existe = (store, ...partes) => existsSync(join(store, ...partes));

// --- status ---------------------------------------------------------------------------------
teste("status sem sourceRepo: 'source unknown', Agent ligado, sem segredos", () => {
	const { store } = novoStore();
	const out = roda(["--status", "--store", store]);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /Pi: 1\.1\.0/);
	assert.match(out.stdout, /Current:\s+cur/);
	assert.match(out.stdout, /Previous: prev/);
	assert.match(out.stdout, /Agent: on \(artifact ativo\)/);
	assert.match(out.stdout, /source unknown/);
	assert.match(out.stdout, /overlay-gc --dry-run/);
	assert.doesNotMatch(out.stdout, /segredo/);
});

teste("status com sourceRepo conta commits à frente num repo git temporário", () => {
	const { repo, first } = novoRepo();
	commit(repo, "b");
	commit(repo, "c");
	const { store } = novoStore({ sourceRepo: repo, sourceCommit: first });
	const out = roda(["--status", "--store", store]);
	assert.match(out.stdout, /2 commits ahead of the install/);
	const { store: igual } = novoStore({ sourceRepo: repo, sourceCommit: git(repo, "rev-parse", "HEAD").stdout.trim() });
	assert.match(roda(["--status", "--store", igual]).stdout, /install is up to date/);
});

teste("status é somente leitura", () => {
	const { store } = novoStore();
	const antes = roda(["--gc", "--dry-run", "--store", store]).stdout;
	roda(["--status", "--store", store]);
	assert.equal(roda(["--gc", "--dry-run", "--store", store]).stdout, antes);
	assert.ok(!existe(store, ".update.lock"));
	assert.ok(!existe(store, STALE_CACHE_FILE));
});

// --- aviso de startup -------------------------------------------------------------------------
const tty = (escrito) => ({ isTTY: true, write: (texto) => escrito.push(texto) });

teste("aviso de startup: uma linha, cache de 1h, env desliga, modos programáticos e não-TTY ficam em silêncio", () => {
	const { repo, first } = novoRepo();
	commit(repo, "b");
	const { store } = novoStore({ sourceRepo: repo, sourceCommit: first });
	const chama = (opcoes = {}) => {
		const escrito = [];
		const impresso = maybeStaleNotice({ store, env: {}, args: [], stderr: tty(escrito), stdin: { isTTY: true }, ...opcoes });
		return { impresso, escrito };
	};
	const primeiro = chama();
	assert.equal(primeiro.impresso, true);
	assert.deepEqual(primeiro.escrito, [`↑ agent: checkout 1 commit ahead of the install · node ${join(repo, "scripts", "agent-update.mjs")}\n`]);
	const cache = JSON.parse(readFileSync(join(store, STALE_CACHE_FILE), "utf8"));
	assert.equal(cache.ahead, 1);
	// Dentro de 1h o cache vale, mesmo que o repo mude.
	commit(repo, "c");
	assert.equal(staleAhead(store), 1);
	// Cache vencido: recalcula.
	assert.equal(staleAhead(store, { now: Date.now() + 2 * 3600 * 1000 }), 2);
	assert.equal(chama({ env: { AGENT_STALE_NOTICE: "0" } }).impresso, false);
	assert.equal(chama({ args: ["-p", "oi"] }).impresso, false);
	assert.equal(chama({ args: ["--mode", "json"] }).impresso, false);
	assert.equal(chama({ args: ["--mode=json"] }).impresso, false);
	assert.equal(chama({ stderr: { isTTY: false, write: () => assert.fail("escreveu sem TTY") } }).impresso, false);
});

teste("aviso: instalação antiga sem sourceRepo, repo ausente e store vazio são silêncio", () => {
	const { store } = novoStore();
	assert.equal(staleAhead(store), undefined);
	const { store: semRepo } = novoStore({ sourceRepo: join(raiz, "nao-existe"), sourceCommit: "a".repeat(40) });
	assert.equal(staleAhead(semRepo), undefined);
	assert.equal(staleAhead(join(raiz, "vazio")), undefined);
});

teste("o aviso não escreve nada em stdout/stderr fora de TTY", () => {
	const { repo, first } = novoRepo();
	commit(repo, "b");
	const { store } = novoStore({ sourceRepo: repo, sourceCommit: first });
	const out = spawnSync(process.execPath, ["-e", `
		import(${JSON.stringify(join(here, "lib", "overlay-stale.mjs"))}).then((m) => {
			process.stdout.write(String(m.maybeStaleNotice({ store: ${JSON.stringify(store)}, args: [] })));
		});`], { encoding: "utf8", env: { ...process.env } });
	assert.equal(out.stdout, "false");
	assert.equal(out.stderr, "");
});

// --- gc ---------------------------------------------------------------------------------------
teste("gc --dry-run lista caminho, tamanho e total e não apaga nada", () => {
	const { store } = novoStore();
	const out = roda(["--gc", "--dry-run", "--store", store]);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /would delete {2}\S+orf-velho /);
	assert.match(out.stdout, /Would reclaim \S+ in \d+ item\(s\)/);
	assert.match(out.stdout, /report only {2}\S+candidates/);
	for (const alvo of [["releases", "orf-velho"], ["releases", "orf-velho2"], ["runtime", "build-cache"], ["backups", bk(0)], ["prepared", "sumiu.json"], ["runtime", "releases", "sobra-velha"]]) {
		assert.ok(existe(store, ...alvo), `dry-run apagou ${alvo.join("/")}`);
	}
	assert.ok(!existe(store, ".update.lock"));
});

teste("gc real respeita current/previous/preparada/Agent ativo+rollback/keep=1 e só reporta candidates", () => {
	const { store } = novoStore();
	const out = roda(["--gc", "--store", store]);
	assert.equal(out.status, 0, out.stderr);
	// Releases: current, previous e preparada (ainda promovível) ficam; das 3 órfãs fica a mais nova.
	for (const nome of ["cur", "prev", "preparada", "orf-novo"]) assert.ok(existe(store, "releases", nome), nome);
	for (const nome of ["orf-velho", "orf-velho2"]) assert.ok(!existe(store, "releases", nome), nome);
	// Artefatos: ativo e alvo de rollback ficam, mais 1 sobra (a mais nova).
	for (const id of ["ativo", "rollback", "sobra-nova"]) assert.ok(existe(store, "runtime", "releases", id), id);
	for (const id of ["sobra-velha", "sobra-velha2"]) assert.ok(!existe(store, "runtime", "releases", id), id);
	// Recibos: o da release preparada fica; o de release inexistente sai.
	assert.ok(existe(store, "prepared", "preparada.json"));
	assert.ok(!existe(store, "prepared", "sumiu.json"));
	// Backups: 5 mais recentes (b2..b6).
	for (const i of [2, 3, 4, 5, 6]) assert.ok(existe(store, "backups", bk(i)), bk(i));
	for (const i of [0, 1]) assert.ok(!existe(store, "backups", bk(i)), bk(i));
	// Protegidos: launcher original, enable mais antigo e o que o updater não criou.
	for (const nome of [launcherBk, enableAntigo, "local-audited-x573ukc0"]) assert.ok(existe(store, "backups", nome), nome);
	assert.ok(existe(store, "backups", launcherBk, "restore.txt"));
	// build-cache só sai sem sessão Pi viva na máquina que executa o check.
	const cacheReport = out.stdout.split("\n").some((line) => line.includes("report only") && line.includes(join(store, "runtime", "build-cache")));
	assert.equal(existe(store, "runtime", "build-cache"), cacheReport);
	for (const alvo of [["runtime", "resource-snapshots"], ["runtime", "resources-backup"], ["candidates", "port"], ["active.json"], ["runtime", "config.json"]]) {
		assert.ok(existe(store, ...alvo), alvo.join("/"));
	}
	assert.match(out.stdout, /report only {2}\S+candidates/);
	assert.ok(!existe(store, ".update.lock"), "o lock devia ter sido liberado");
});

teste("gc: recibo cujo current mudou desde o prepare não protege a release; --keep 0 e --keep 2", () => {
	const { store, prev } = novoStore();
	writeFileSync(join(store, "prepared", "preparada.json"), JSON.stringify({ currentAtPrepare: prev }));
	assert.equal(roda(["--gc", "--keep", "0", "--store", store]).status, 0);
	for (const nome of ["preparada", "orf-novo", "orf-velho", "orf-velho2"]) assert.ok(!existe(store, "releases", nome), nome);
	assert.ok(!existe(store, "prepared", "preparada.json"));
	for (const nome of ["cur", "prev"]) assert.ok(existe(store, "releases", nome), nome);
	for (const id of ["ativo", "rollback"]) assert.ok(existe(store, "runtime", "releases", id), id);
	for (const id of ["sobra-nova", "sobra-velha", "sobra-velha2"]) assert.ok(!existe(store, "runtime", "releases", id), id);
	const { store: dois } = novoStore();
	roda(["--gc", "--keep", "2", "--store", dois]);
	assert.ok(existe(dois, "releases", "orf-novo") && existe(dois, "releases", "orf-velho2") && !existe(dois, "releases", "orf-velho"));
});

teste("gc preserves the recorded rollback artifact even when a newer artifact has the same Pi root", () => {
	const { store, prev } = novoStore();
	const piRoot = join(prev, "pkg");
	const old = join(store, "runtime", "releases", "recorded-old");
	dir(old, 0);
	writeFileSync(join(old, "manifest.json"), JSON.stringify({ artifactId: "recorded-old", piRoot }));
	utimesSync(old, dia(0), dia(0));
	writeFileSync(join(store, "runtime", "pi-artifacts.json"), JSON.stringify({ [piRoot]: "recorded-old" }));
	const plan = planOverlayGc(store, 0, { getProcesses: () => [] });
	assert.ok(!plan.some((item) => item.path === old && item.action === "delete"));
	rmSync(join(store, "runtime", "pi-artifacts.json"));
	assert.ok(planOverlayGc(store, 0, { getProcesses: () => [] }).some((item) => item.path === old && item.action === "delete"));
});

teste("gc: processo fake protege artefato, sua release Pi e build-cache com PID", () => {
	const { store } = novoStore();
	const artifact = join(store, "runtime", "releases", "sobra-velha");
	const release = join(store, "releases", "orf-velho");
	writeFileSync(join(artifact, "manifest.json"), JSON.stringify({ piRoot: join(release, "pkg") }));
	const getProcesses = () => [{ pid: 424242, command: `node --extension ${artifact}/agent/extension.mjs` }];
	const plan = planOverlayGc(store, 0, { getProcesses });
	for (const path of [artifact, release, join(store, "runtime", "build-cache")]) {
		const item = plan.find((item) => item.path === path);
		assert.equal(item?.action, "report", `fake process: gc apagaria ${path}`);
		assert.equal(item.note, "in use by running process 424242");
	}
	const log = console.log;
	try {
		console.log = () => {};
		overlayGc({ store, keep: 0, getProcesses });
	} finally { console.log = log; }
	assert.ok(existsSync(artifact));
	assert.ok(existsSync(release));
	assert.ok(existe(store, "runtime", "build-cache"));
	assert.ok(!existe(store, "runtime", "releases", "sobra-velha2"));
});

teste("gc: snapshot injetado cobre cache direto, launcher, release e inspeção indisponível", () => {
	const { store } = novoStore();
	const cache = join(store, "runtime", "build-cache");
	const release = join(store, "releases", "orf-velho");
	for (const command of [`${cache}/release/juice --state /tmp/state`, `node agent-launch.mjs --store ${store}`, `node ${release}/pkg/dist/cli.js`]) {
		const plan = planOverlayGc(store, 0, { getProcesses: () => [{ pid: 123, command }] });
		assert.equal(plan.find((item) => item.path === cache)?.note, "in use by running process 123");
		assert.ok(!plan.some((item) => item.path === cache && item.action === "delete"));
		if (command.includes(release)) assert.equal(plan.find((item) => item.path === release)?.action, "report");
	}
	const empty = planOverlayGc(store, 0, { getProcesses: () => [] });
	assert.equal(empty.find((item) => item.path === cache)?.action, "delete");
	const unknown = planOverlayGc(store, 0, { getProcesses: () => undefined });
	assert.ok(!unknown.some((item) => ["release", "agent artifact", "agent build-cache"].includes(item.kind) && item.action === "delete"));
});

teste("gc preserva releases em argumentos e ambiente de processos vivos, inclusive via symlink", () => {
	if (process.platform === "win32") return; // Windows conserva releases se não puder inspecionar processos.
	const { store } = novoStore();
	const atalho = join(raiz, "store com espaços");
	link(store, atalho);
	const ready = join(raiz, "process-ready");
	const child = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`, join(store, "releases", "orf-velho", "extensions", "old.mjs")], {
		stdio: "ignore",
		env: { ...process.env, NODE_OPTIONS: "", AGENT_JUICE_BIN: join(atalho, "runtime", "releases", "sobra-velha", "bin", "juice") },
	});
	try {
		const deadline = Date.now() + 5000;
		while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		assert.ok(existsSync(ready), "processo de fixture não iniciou");
		for (const flags of [["--dry-run"], []]) {
			const out = roda(["--gc", "--keep", "0", "--store", atalho, ...flags]);
			assert.equal(out.status, 0, out.stderr);
			for (const path of [join(atalho, "releases", "orf-velho"), join(atalho, "runtime", "releases", "sobra-velha")]) {
				assert.ok(existsSync(path), `gc apagou release em uso: ${path}`);
				assert.ok(out.stdout.split("\n").some((line) => line.includes(path) && line.includes(`in use by running process ${child.pid}`)), out.stdout);
			}
		}
		assert.ok(!existe(store, "releases", "orf-velho2"), "prefixo parecido não deve proteger outra release");
		assert.ok(!existe(store, "runtime", "releases", "sobra-velha2"));
	} finally {
		child.kill();
	}
});

teste("gc conserva releases e reporta em uso se a inspeção de processos falhar", () => {
	const { store } = novoStore();
	const out = roda(["--gc", "--keep", "0", "--store", store], { PATH: "" });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /process inspection unavailable: cannot prove unused/);
	for (const name of ["orf-velho", "orf-velho2"]) assert.ok(existe(store, "releases", name));
	for (const name of ["sobra-velha", "sobra-velha2"]) assert.ok(existe(store, "runtime", "releases", name));
	assert.ok(existe(store, "runtime", "build-cache"), "sem inspeção de processos o build-cache também fica: o broker do Juice pode estar usando");
});

teste("gc sem config do Agent só reporta artefatos, não apaga", () => {
	const { store } = novoStore();
	rmSync(join(store, "runtime", "config.json"));
	assert.equal(roda(["--gc", "--store", store]).status, 0);
	for (const id of ["ativo", "rollback", "sobra-nova", "sobra-velha", "sobra-velha2"]) assert.ok(existe(store, "runtime", "releases", id), id);
});

teste("gc: opções inválidas são recusadas", () => {
	const { store } = novoStore();
	assert.notEqual(roda(["--gc", "--keep", "x", "--store", store]).status, 0);
	assert.notEqual(roda(["--dry-run", "--store", store]).status, 0);
	assert.notEqual(roda(["--status", "--gc", "--store", store]).status, 0);
});

teste("gc --dry-run: launcher original, enable mais antigo e diretório estranho são só reportados", () => {
	const { store } = novoStore();
	const out = roda(["--gc", "--dry-run", "--store", store]).stdout;
	for (const nome of [launcherBk, enableAntigo, "local-audited-x573ukc0"]) {
		assert.doesNotMatch(out, new RegExp(`would delete {2}\\S*${nome}`), nome);
		assert.match(out, new RegExp(`report only {2}\\S*${nome}`), nome);
	}
	// O segundo enable (não o mais antigo) entra na retenção normal.
	dir(join(store, "backups", "2026-09-20T00-00-00-000Z-agent-enable"), -20);
	const depois = roda(["--gc", "--dry-run", "--store", store]).stdout;
	assert.match(depois, /would delete {2}\S*2026-09-20T00-00-00-000Z-agent-enable/);
	assert.match(depois, new RegExp(`report only {2}\\S*${enableAntigo}`));
});

teste("gc real com o store sob symlink apaga normalmente (guarda de caminho resolvida)", () => {
	const { store } = novoStore();
	const atalho = join(raiz, `atalho-${Date.now()}`);
	link(store, atalho);
	const out = roda(["--gc", "--store", atalho]);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(!existe(store, "releases", "orf-velho"));
	assert.ok(!existe(store, "backups", bk(0)));
	assert.ok(existe(store, "backups", launcherBk));
});

// --- origem na release / rollback -----------------------------------------------------------
teste("rollback grava a origem da release de destino, ou nenhuma se ela não tem", () => {
	const montar = (origemAntiga) => {
		const store = mkdtempSync(join(raiz, "rb-"));
		const meta = (v, extra = {}) => ({ officialRef: `v${v}`, officialCommit: "x", officialVersion: v, patches: {}, optionalLayers: [], ...extra });
		for (const [nome, m] of [["a", meta("1", origemAntiga)], ["b", meta("2", { sourceRepo: "/r/novo", sourceCommit: "bbbbbbb" })]]) {
			mkdirSync(join(store, "releases", nome), { recursive: true });
			writeFileSync(join(store, "releases", nome, "agent-release.json"), JSON.stringify(m));
		}
		link(join(store, "releases", "b"), join(store, "current"));
		link(join(store, "releases", "a"), join(store, "previous"));
		writeFileSync(join(store, "active.json"), JSON.stringify({ releaseDir: join(store, "releases", "b"), sourceRepo: "/r/novo", sourceCommit: "bbbbbbb", updaterGeneration: 4 }));
		return store;
	};
	const com = montar({ sourceRepo: "/r/antigo", sourceCommit: "aaaaaaa" });
	assert.equal(roda(["--rollback", "--force", "--store", com]).status, 0);
	const ativo = JSON.parse(readFileSync(join(com, "active.json"), "utf8"));
	assert.equal(ativo.sourceRepo, "/r/antigo");
	assert.equal(ativo.sourceCommit, "aaaaaaa");
	const sem = montar({});
	assert.equal(roda(["--rollback", "--force", "--store", sem]).status, 0);
	const semAtivo = JSON.parse(readFileSync(join(sem, "active.json"), "utf8"));
	assert.ok(!("sourceRepo" in semAtivo) && !("sourceCommit" in semAtivo));
});

// --- git: cache de falha e branch divergente ------------------------------------------------
teste("falha do git é cacheada (ahead: null) e não reconsulta dentro do TTL", () => {
	const { repo } = novoRepo();
	const { store } = novoStore({ sourceRepo: repo, sourceCommit: "b".repeat(40) });
	assert.equal(staleAhead(store), undefined);
	const cache = JSON.parse(readFileSync(join(store, STALE_CACHE_FILE), "utf8"));
	assert.equal(cache.ahead, null);
	// Dentro do TTL o cache responde sem git: mesmo com o commit passando a existir, segue silêncio.
	assert.equal(staleAhead(store, { now: cache.checkedAt + 1000 }), undefined);
	assert.equal(JSON.parse(readFileSync(join(store, STALE_CACHE_FILE), "utf8")).checkedAt, cache.checkedAt);
	// Vencido o TTL, reconsulta e regrava.
	staleAhead(store, { now: cache.checkedAt + 2 * 3600 * 1000 });
	assert.equal(JSON.parse(readFileSync(join(store, STALE_CACHE_FILE), "utf8")).checkedAt, cache.checkedAt + 2 * 3600 * 1000);
});

teste("commit de outro branch (não ancestral de HEAD): sem aviso, status mostra 'diverged'", () => {
	const { repo, first } = novoRepo();
	const base = git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
	assert.equal(git(repo, "checkout", "-q", "-b", "outro").status, 0);
	const outro = commit(repo, "x");
	assert.equal(git(repo, "checkout", "-q", base).status, 0);
	commit(repo, "y");
	commit(repo, "z");
	const { store } = novoStore({ sourceRepo: repo, sourceCommit: outro });
	assert.equal(staleAhead(store), undefined);
	assert.match(roda(["--status", "--store", store]).stdout, /diverged/);
	// Ancestral continua contando.
	const { store: ok } = novoStore({ sourceRepo: repo, sourceCommit: first });
	assert.equal(staleAhead(ok), 2);
});

// --- camada removida --------------------------------------------------------------------------
teste("--with context-windows é erro com a mensagem da camada removida", () => {
	const { store } = novoStore();
	const out = roda(["--with", "context-windows", "--store", store]);
	assert.notEqual(out.status, 0);
	assert.match(out.stderr, /layer context-windows was removed in 2026-10\. It was never ported past Pi 0\.87\. Run without it, or check out an older agent to keep it\./);
	assert.notEqual(roda(["--check", "--with", "a,context-windows", "--store", store]).status, 0);
});

teste("layers.json com context-windows: aviso e ignora (não chega a erro de camada desconhecida)", () => {
	const { store } = novoStore();
	writeFileSync(join(store, "layers.json"), JSON.stringify({ optional: ["context-windows"] }));
	// --simulate-conflict para antes de qualquer build; o aviso da seleção sai antes dele.
	const out = roda(["--simulate-conflict", "--store", store]);
	assert.match(out.stderr, /layer context-windows was removed in 2026-10/);
	assert.match(out.stderr, /Ignoring it/);
	assert.doesNotMatch(out.stderr, /Camada desconhecida|não existe mais como opcional/);
	assert.match(out.stderr, /Simulated overlay conflict/);
});

teste("orphanReleaseRetention do update caiu para 1", () => {
	assert.match(readFileSync(updater, "utf8"), /const orphanReleaseRetention = 1;/);
});

rmSync(raiz, { recursive: true, force: true });
for (const nome of feito) console.log(`ok - ${nome}`);
console.log(`${feito.length} testes passaram`);
