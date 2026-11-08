#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExtensionEntry, extensionFiles, syncMarkExtensions } from "./lib/extensions.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "mark-extensions-test-"));
const quiet = { log: () => {}, warn: () => {} };
const readSettings = (dir) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
try {
	test("repo ships the Megamind extension and it travels in the bundle", () => {
		const files = extensionFiles(repo);
		assert.ok(files.includes("extensions/megamind/index.ts"));
		assert.ok(files.includes("extensions/megamind/package.json"));
		const pkg = JSON.parse(readFileSync(join(repo, "extensions", "megamind", "package.json"), "utf8"));
		assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
	});

	const source = join(root, "bundle");
	mkdirSync(join(source, "extensions", "megamind", "sub"), { recursive: true });
	writeFileSync(join(source, "extensions", "megamind", "index.ts"), "export default {}\n");
	writeFileSync(join(source, "extensions", "megamind", "sub", "profile.ts"), "export const x = 1\n");
	writeFileSync(join(source, "extensions", "megamind", ".DS_Store"), "");
	const store = join(root, "store");
	const agentDir = join(root, "agent");
	mkdirSync(store); mkdirSync(agentDir);
	const target = resolve(store, "extensions", "megamind");
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ theme: "dark", extensions: ["/Users/x/ARCA/arca/extensions/arca-megamind", "/Users/x/ARCA/arca/extensions/accounts.ts"] }, null, 2)}\n`,
	);

	test("copies the extension, registers it and drops the ARCA entry, keeping the others", () => {
		const result = syncMarkExtensions({ sourceRoot: source, store, agentDir, ...quiet });
		assert.equal(result.installed, true);
		assert.deepEqual(result.removed, ["/Users/x/ARCA/arca/extensions/arca-megamind"]);
		assert.ok(existsSync(join(target, "index.ts")));
		assert.ok(existsSync(join(target, "sub", "profile.ts")));
		assert.ok(!existsSync(join(target, ".DS_Store")));
		const settings = readSettings(agentDir);
		assert.equal(settings.theme, "dark");
		assert.deepEqual(settings.extensions, ["/Users/x/ARCA/arca/extensions/accounts.ts", target]);
	});

	test("second run is idempotent", () => {
		const result = syncMarkExtensions({ sourceRoot: source, store, agentDir, ...quiet });
		assert.equal(result.settingsUpdated, false);
		assert.deepEqual(readSettings(agentDir).extensions, ["/Users/x/ARCA/arca/extensions/accounts.ts", target]);
	});

	test("register:false (Mark II) refreshes an existing copy without touching settings", () => {
		writeFileSync(join(source, "extensions", "megamind", "index.ts"), "export default { v: 2 }\n");
		const before = readFileSync(join(agentDir, "settings.json"), "utf8");
		const result = syncMarkExtensions({ sourceRoot: source, store, agentDir, register: false, ...quiet });
		assert.equal(result.installed, true);
		assert.equal(result.settingsUpdated, false);
		assert.match(readFileSync(join(target, "index.ts"), "utf8"), /v: 2/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
		const fresh = join(root, "fresh-store");
		mkdirSync(fresh);
		assert.equal(syncMarkExtensions({ sourceRoot: source, store: fresh, agentDir, register: false, ...quiet }).installed, false);
		assert.ok(!existsSync(join(fresh, "extensions")));
	});

	test("removed files disappear from the store copy", () => {
		rmSync(join(source, "extensions", "megamind", "sub"), { recursive: true });
		syncMarkExtensions({ sourceRoot: source, store, agentDir, ...quiet });
		assert.ok(!existsSync(join(target, "sub")));
		assert.ok(existsSync(join(target, "index.ts")));
	});

	test("a megamind copy from another store is dropped too", () => {
		const other = "/tmp/other-store/extensions/megamind";
		const settings = readSettings(agentDir);
		settings.extensions = [other, ...settings.extensions];
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
		assert.deepEqual(syncMarkExtensions({ sourceRoot: source, store, agentDir, ...quiet }).removed, [other]);
		assert.deepEqual(readSettings(agentDir).extensions, ["/Users/x/ARCA/arca/extensions/accounts.ts", target]);
	});

	test('"-megamind" in the settings turns it off; nothing is copied or rewritten', () => {
		const off = join(root, "off");
		const offStore = join(root, "off-store");
		mkdirSync(off); mkdirSync(offStore);
		const entries = ["-megamind", "/Users/x/ARCA/arca/extensions/arca-megamind"];
		writeFileSync(join(off, "settings.json"), `${JSON.stringify({ extensions: entries }, null, 2)}\n`);
		const result = syncMarkExtensions({ sourceRoot: source, store: offStore, agentDir: off, ...quiet });
		assert.equal(result.disabled, true);
		assert.ok(!existsSync(join(offStore, "extensions")));
		assert.deepEqual(readSettings(off).extensions, entries);
	});

	test("invalid settings.json is left untouched", () => {
		const file = join(root, "bad.json");
		writeFileSync(file, "{ nope");
		assert.deepEqual(ensureExtensionEntry(file, "/x", () => {}), { settingsUpdated: false, removed: [] });
		assert.equal(readFileSync(file, "utf8"), "{ nope");
	});

	test("missing settings.json is created", () => {
		const file = join(root, "new", "settings.json");
		assert.equal(ensureExtensionEntry(file, "/x", () => {}).settingsUpdated, true);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { extensions: ["/x"] });
	});
	console.log(`${checks} checks passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
