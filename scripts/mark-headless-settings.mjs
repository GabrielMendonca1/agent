#!/usr/bin/env node
/**
 * Gera o settings do perfil Mark headless a partir do settings completo do Mark.
 *   node scripts/mark-headless-settings.mjs --from ~/.pi/agent/settings.json --out ~/.pi/agent/settings.headless.json
 * Sem --out escreve no stdout. Ativar = o arquivo gerado virar `settings.json` do agent dir do processo
 * (ver deploy/vm/NOTES.md). Não toca no settings de origem.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { headlessSettings } from "./lib/mark-headless.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const from = opt("--from");
if (!from) {
	process.stderr.write("usage: mark-headless-settings --from <settings.json> [--out <file>]\n");
	process.exit(2);
}
const text = `${JSON.stringify(headlessSettings(JSON.parse(readFileSync(from, "utf8"))), null, 2)}\n`;
const out = opt("--out");
if (!out) process.stdout.write(text);
else {
	mkdirSync(dirname(out), { recursive: true });
	const tmp = `${out}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, out);
}
