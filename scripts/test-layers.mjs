#!/usr/bin/env node
/**
 * Testes da seleção de camadas.
 *
 * O que estes testes protegem: uma instalação de sócio nunca pode ganhar uma camada
 * opcional por acidente, e uma instalação que já escolheu uma camada nunca pode perdê-la
 * por rodar o updater sem flags. Ambos os erros são silenciosos em produção — só aparecem
 * como um runtime diferente do esperado — então são checados aqui, em milissegundos.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	layersFilePath,
	markersForPatches,
	optionalLayersFromRecord,
	parseLayerNames,
	readStoreLayers,
	seedLayersFromActive,
	selectLayers,
	writeStoreLayers,
} from "./lib/layers.mjs";

const feito = [];
function teste(nome, fn) {
	fn();
	feito.push(nome);
}

const raiz = mkdtempSync(join(tmpdir(), "layers-test-"));
const novoStore = () => mkdtempSync(join(raiz, "store-"));

const patches = [
	{ name: "pi-black" },
	{ name: "garime-frame" },
	{ name: "example-layer", optional: true },
];
const nomes = (resultado) => resultado.selected.map((patch) => patch.name);

teste("sem flags e sem arquivo, só base", () => {
	const resultado = selectLayers(patches, {});
	assert.deepEqual(nomes(resultado), ["pi-black", "garime-frame"]);
	assert.deepEqual(resultado.optional, []);
	assert.deepEqual(resultado.available, ["example-layer"]);
});

teste("o arquivo do store decide quando não há flags", () => {
	const resultado = selectLayers(patches, { stored: ["example-layer"] });
	assert.deepEqual(nomes(resultado), ["pi-black", "garime-frame", "example-layer"]);
	assert.deepEqual(resultado.optional, ["example-layer"]);
});

teste("--with adiciona e mantém a ordem do manifesto", () => {
	const resultado = selectLayers(patches, { with: ["example-layer"] });
	assert.deepEqual(nomes(resultado), ["pi-black", "garime-frame", "example-layer"]);
});

teste("--without remove o que o store tinha registrado", () => {
	const resultado = selectLayers(patches, { stored: ["example-layer"], without: ["example-layer"] });
	assert.deepEqual(nomes(resultado), ["pi-black", "garime-frame"]);
	assert.deepEqual(resultado.optional, []);
});

teste("nome desconhecido é erro, não silêncio", () => {
	assert.throws(() => selectLayers(patches, { with: ["nao-existe"] }), /Camada desconhecida/);
	assert.throws(() => selectLayers(patches, { without: ["nao-existe"] }), /Camada desconhecida/);
});

teste("--with de patch base é erro; --without de patch base também", () => {
	assert.throws(() => selectLayers(patches, { with: ["pi-black"] }), /não é opcional/);
	assert.throws(() => selectLayers(patches, { without: ["pi-black"] }), /é base e não pode ser removida/);
});

teste("camada registrada que sumiu do manifesto vira aviso, não quebra", () => {
	const resultado = selectLayers(patches, { stored: ["camada-extinta"] });
	assert.deepEqual(nomes(resultado), ["pi-black", "garime-frame"]);
	assert.equal(resultado.warnings.length, 1);
});

teste("markers são filtrados pelos patches realmente aplicados", () => {
	const markers = [
		{ name: "black", patch: "pi-black", marker: "sdk-cli" },
		{ name: "cw", patch: "example-layer", marker: "rollover" },
		{ name: "incondicional", marker: "pi" },
	];
	assert.deepEqual(
		markersForPatches(markers, ["pi-black", "garime-frame"]).map((marker) => marker.name),
		["black", "incondicional"],
	);
	assert.deepEqual(
		markersForPatches(markers, ["pi-black", "example-layer"]).map((marker) => marker.name),
		["black", "cw", "incondicional"],
	);
});

teste("--with/--without aceitam vírgula e repetição", () => {
	assert.deepEqual(parseLayerNames(["a,b", "c", " d , "]), ["a", "b", "c", "d"]);
	assert.deepEqual(parseLayerNames(undefined), []);
});

teste("layers.json é escrito e relido", () => {
	const store = novoStore();
	assert.equal(readStoreLayers(store), undefined);
	writeStoreLayers(store, ["example-layer"]);
	assert.deepEqual(readStoreLayers(store), ["example-layer"]);
	writeStoreLayers(store, []);
	assert.deepEqual(readStoreLayers(store), []);
	assert.ok(existsSync(layersFilePath(store)));
});

teste("layers.json corrompido cai no default em vez de travar o updater", () => {
	const store = novoStore();
	writeFileSync(layersFilePath(store), "isto não é json");
	assert.equal(readStoreLayers(store), undefined);
	assert.deepEqual(nomes(selectLayers(patches, { stored: readStoreLayers(store) })), ["pi-black", "garime-frame"]);
});

const escreverActive = (store, record) =>
	writeFileSync(join(store, "active.json"), `${JSON.stringify(record, null, 2)}\n`);

teste("store sem layers.json herda a seleção de active.json:optionalLayers", () => {
	const store = novoStore();
	escreverActive(store, { optionalLayers: ["example-layer"], patches: { "pi-black": "x" } });
	const semeado = seedLayersFromActive(store, patches);
	assert.deepEqual(semeado.optional, ["example-layer"]);
	assert.match(semeado.source, /optionalLayers/);
	assert.deepEqual(nomes(selectLayers(patches, { stored: semeado.optional })), [
		"pi-black",
		"garime-frame",
		"example-layer",
	]);
});

teste("release anterior a optionalLayers é lida pelos patches que registrou", () => {
	const store = novoStore();
	escreverActive(store, { patches: { "pi-black": "a", "garime-frame": "b", "example-layer": "c" } });
	const semeado = seedLayersFromActive(store, patches);
	assert.deepEqual(semeado.optional, ["example-layer"]);
	assert.match(semeado.source, /patches/);
});

teste("nada a semear: sem active.json, release só-base, ou layers.json já presente", () => {
	const vazio = novoStore();
	assert.equal(seedLayersFromActive(vazio, patches), undefined);

	const soBase = novoStore();
	escreverActive(soBase, { optionalLayers: [], patches: { "pi-black": "a", "garime-frame": "b" } });
	assert.equal(seedLayersFromActive(soBase, patches), undefined);

	// Um `--without` já gravado é escolha explícita: a migração não pode desfazê-la.
	const decidido = novoStore();
	escreverActive(decidido, { optionalLayers: ["example-layer"] });
	writeStoreLayers(decidido, []);
	assert.equal(seedLayersFromActive(decidido, patches), undefined);

	const corrompido = novoStore();
	writeFileSync(join(corrompido, "active.json"), "isto não é json");
	assert.equal(seedLayersFromActive(corrompido, patches), undefined);
});

teste("camada registrada que não é mais opcional não é semeada", () => {
	const store = novoStore();
	escreverActive(store, { optionalLayers: ["camada-extinta", "pi-black"] });
	assert.equal(seedLayersFromActive(store, patches), undefined);
});

teste("rollback deriva as camadas opcionais da metadata da release de destino", () => {
	assert.deepEqual(optionalLayersFromRecord({ optionalLayers: ["example-layer"] }, patches), ["example-layer"]);
	assert.deepEqual(optionalLayersFromRecord({ patches: { "pi-black": "a" } }, patches), []);
	assert.deepEqual(optionalLayersFromRecord({ patches: { "pi-black": "a", "example-layer": "c" } }, patches), [
		"example-layer",
	]);
	assert.deepEqual(optionalLayersFromRecord(undefined, patches), []);
});

teste("o manifesto real declara a base clássica e nenhuma camada opcional (context-windows foi removida)", () => {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = JSON.parse(readFileSync(join(repoRoot, "overlay", "manifest.json"), "utf8"));
	assert.equal(manifest.name, "mark-pi");
	assert.equal(manifest.mark, "II");
	assert.deepEqual(
		selectLayers(manifest.patches, {}).selected.map((patch) => patch.name),
		["pi-black", "garime-frame", "pi-account-env", "transcript-feedback", "stream-markdown", "mark-skill-curation", "codemode-typed-results", "codemode-background", "tool-load-append", "cc-hidden-tool-names"],
	);
	assert.deepEqual(selectLayers(manifest.patches, {}).available, []);
	for (const marker of manifest.compatibility.bundleMarkers) {
		assert.ok(marker.patch, `marker "${marker.name}" não declara o patch a que pertence`);
		assert.ok(
			manifest.patches.some((patch) => patch.name === marker.patch),
			`marker "${marker.name}" aponta para um patch inexistente`,
		);
	}
});

console.log(feito.map((nome) => `  ok ${nome}`).join("\n"));
console.log(`layers: ${feito.length} testes OK`);
rmSync(raiz, { recursive: true, force: true });
