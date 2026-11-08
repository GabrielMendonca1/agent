/**
 * Seleção de camadas do overlay.
 *
 * O overlay tem duas classes de patch. Os de base (sem `optional` no manifesto) são a
 * identidade compartilhada: todo mundo que instala leva exatamente eles. Os opcionais
 * (`"optional": true`) são camadas que uma instalação escolhe carregar — hoje
 * nenhuma está declarada no manifesto (`context-windows` foi removida).
 *
 * A seleção precisa ser estável entre invocações: quem instalou com uma camada extra
 * não pode perdê-la no próximo `pi overlay-update` só porque não repetiu a flag. Por isso
 * ela é persistida em `<store>/layers.json` e as flags `--with`/`--without` operam sobre
 * esse arquivo. Nada aqui escreve no store: o updater só grava depois de uma instalação
 * real bem-sucedida, nunca em `--check`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAYERS_FILE = "layers.json";

/** `--with a,b --with c` → ["a","b","c"]; vazios são descartados. */
export function parseLayerNames(values) {
	return (values ?? [])
		.flatMap((value) => String(value).split(","))
		.map((name) => name.trim())
		.filter(Boolean);
}

export function layersFilePath(store) {
	return join(store, LAYERS_FILE);
}

/** Camadas opcionais registradas no store, ou `undefined` quando o arquivo não existe. */
export function readStoreLayers(store) {
	const file = layersFilePath(store);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed?.optional)) return undefined;
		return parsed.optional.filter((name) => typeof name === "string");
	} catch {
		// Arquivo ilegível é tratado como ausente: o default (só base) é sempre seguro.
		return undefined;
	}
}

export function writeStoreLayers(store, optional) {
	mkdirSync(store, { recursive: true });
	writeFileSync(layersFilePath(store), `${JSON.stringify({ optional: [...optional] }, null, 2)}\n`);
}

export function isOptionalPatch(patch) {
	return patch?.optional === true;
}

/**
 * Camadas opcionais que uma release registrou, lidas da metadata dela (`agent-release.json` ou
 * `active.json`). Releases novas gravam `optionalLayers`; as anteriores a esse campo só têm
 * `patches`, e ali as opcionais são as que o manifesto declara como tal.
 */
export function optionalLayersFromRecord(record, patches) {
	const optionalNames = new Set(patches.filter(isOptionalPatch).map((patch) => patch.name));
	const recorded = Array.isArray(record?.optionalLayers) ? record.optionalLayers : Object.keys(record?.patches ?? {});
	return recorded.filter((name) => typeof name === "string" && optionalNames.has(name));
}

/**
 * Migração: um store instalado antes de `layers.json` existir não registra seleção nenhuma, e um
 * `pi overlay-update` sem flags instalaria só a base — tirando silenciosamente uma camada que
 * aquela instalação tinha. Quando o arquivo falta, a seleção é semeada pelo que a release ativa
 * registrou. Devolve `undefined` quando não há o que semear (arquivo já existe, sem `active.json`,
 * ou release ativa só com base).
 */
export function seedLayersFromActive(store, patches) {
	if (readStoreLayers(store) !== undefined) return undefined;
	let active;
	try {
		active = JSON.parse(readFileSync(join(store, "active.json"), "utf8"));
	} catch {
		return undefined;
	}
	const optional = optionalLayersFromRecord(active, patches);
	if (optional.length === 0) return undefined;
	return { optional, source: Array.isArray(active.optionalLayers) ? "active.json:optionalLayers" : "active.json:patches" };
}

/**
 * Resolve quais patches do manifesto entram nesta instalação.
 *
 * `stored` é o que o store registrou (ou `undefined` quando nunca registrou nada);
 * `with`/`without` são as flags. Sem flags e sem arquivo, só base. A ordem devolvida é
 * sempre a do manifesto, porque é ela que decide a aplicação dos patches.
 */
export function selectLayers(patches, { with: withNames = [], without: withoutNames = [], stored } = {}) {
	const byName = new Map(patches.map((patch) => [patch.name, patch]));
	const optionalNames = patches.filter(isOptionalPatch).map((patch) => patch.name);

	const known = (name, flag) => {
		const patch = byName.get(name);
		if (!patch) {
			throw new Error(
				`Camada desconhecida: ${JSON.stringify(name)} (${flag}). Camadas opcionais declaradas: ` +
					`${optionalNames.length > 0 ? optionalNames.join(", ") : "nenhuma"}.`,
			);
		}
		return patch;
	};

	const warnings = [];
	const selectedOptional = new Set();
	for (const name of stored ?? []) {
		const patch = byName.get(name);
		if (!patch || !isOptionalPatch(patch)) {
			warnings.push(`Camada ${JSON.stringify(name)} registrada no store não existe mais como opcional; ignorada.`);
			continue;
		}
		selectedOptional.add(name);
	}
	for (const name of withNames) {
		const patch = known(name, "--with");
		if (!isOptionalPatch(patch)) {
			throw new Error(
				`A camada ${JSON.stringify(name)} não é opcional: ela é base e já está sempre incluída. ` +
					`--with só aceita patches com "optional": true no manifesto.`,
			);
		}
		selectedOptional.add(name);
	}
	for (const name of withoutNames) {
		const patch = known(name, "--without");
		if (!isOptionalPatch(patch)) {
			throw new Error(
				`A camada ${JSON.stringify(name)} é base e não pode ser removida: ela define a identidade do overlay.`,
			);
		}
		selectedOptional.delete(name);
	}

	const selected = patches.filter((patch) => !isOptionalPatch(patch) || selectedOptional.has(patch.name));
	return {
		selected,
		optional: selected.filter(isOptionalPatch).map((patch) => patch.name),
		base: patches.filter((patch) => !isOptionalPatch(patch)).map((patch) => patch.name),
		available: optionalNames,
		warnings,
	};
}

/**
 * Markers de bundle que valem para um conjunto de patches.
 *
 * Um marker com `patch` só é exigido quando aquele patch foi aplicado — senão uma
 * instalação só-base seria declarada degradada por não conter código que ela nunca pediu.
 * Marker sem `patch` é incondicional (vale para qualquer release).
 */
export function markersForPatches(markers, patchNames) {
	const names = new Set(patchNames ?? []);
	return (markers ?? []).filter((marker) => !marker.patch || names.has(marker.patch));
}
