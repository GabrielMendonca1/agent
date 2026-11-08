#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pinInternalPackages, verifyInstalledInternalPackages } from "./lib/internal-packages.mjs";

const exec = promisify(execFile);
// Validate the actual npm package/entrypoint, not just npm_execpath (which may be pnpm).
function findNpmCli() {
	const candidates = [
		process.env.npm_execpath,
		...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)]
			.map((dir) => join(dir, "node_modules", "npm", "bin", "npm-cli.js")),
	];
	for (const candidate of candidates.filter(Boolean)) {
		try {
			const entry = realpathSync(candidate);
			const packageDir = dirname(dirname(entry));
			const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
			if (pkg.name === "npm" && pkg.bin?.npm === "bin/npm-cli.js"
				&& entry === realpathSync(resolve(packageDir, pkg.bin.npm))) {
				readFileSync(entry); // Require an existing, readable JS entrypoint.
				return entry;
			}
		} catch { /* Missing or non-npm candidate: try the next local installation. */ }
	}
	throw new Error("Cannot locate a verified npm JS entrypoint; run via npm or put its installation on PATH. No shell fallback.");
}
const npmCli = process.platform === "win32" ? findNpmCli() : null;
const root = mkdtempSync(join(tmpdir(), "internal-packages João Silva-"));
const scope = "@earendil-works/";
const cli = `${scope}pi-coding-agent`;
const core = `${scope}pi-agent-core`;
const ai = `${scope}pi-ai`;
const telemetry = `${scope}pi-telemetry`;
const env = { ...process.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "npmrc"), npm_config_globalconfig: join(root, "global-npmrc"), ORCA_BACKGROUND_LAUNCH: "1" };
const npm = async (args, cwd = root) => (await exec(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, { cwd, env, shell: false, windowsHide: true })).stdout;
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
const registry = new Map();
let origin;
const server = createServer((req, res) => {
	const path = decodeURIComponent(req.url.slice(1));
	if (path.startsWith("tar/")) {
		const payload = registry.get(path);
		if (payload) { res.end(payload); return; }
	} else if (registry.has(path)) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(registry.get(path))); return;
	}
	res.statusCode = 404; res.end("not found");
});
try {
	mkdirSync(env.HOME); mkdirSync(env.PI_CODING_AGENT_DIR);
	writeFileSync(env.npm_config_userconfig, ""); writeFileSync(env.npm_config_globalconfig, "");
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	env.npm_config_registry = origin;
	env.npm_config_audit = "false";
	env.npm_config_fund = "false";
	async function pack(dir, pkg) {
		mkdirSync(dir, { recursive: true }); json(join(dir, "package.json"), pkg);
		writeFileSync(join(dir, "index.js"), "// local overlay marker\n");
		const result = JSON.parse(await npm(["pack", "--ignore-scripts", "--json"], dir));
		return join(dir, result[0].filename);
	}
	// Registry advances core/ai while the selected source release remains 1.0.4.
	for (const version of ["1.0.4", "1.1.0"]) {
		for (const [name, dependencies] of [[telemetry, {}], [ai, { [telemetry]: "^1.0.4" }], [core, { [ai]: `^${version}` }]]) {
			const pkg = { name, version, dependencies };
			const tarball = await pack(join(root, `${name.split("/")[1]}-${version}`), pkg);
			const key = `tar/${name.split("/")[1]}-${version}.tgz`;
			registry.set(key, readFileSync(tarball));
			const metadata = registry.get(name) ?? { name, "dist-tags": { latest: "1.1.0" }, versions: {} };
			metadata.versions[version] = { ...pkg, dist: { tarball: `${origin}/${key}` } };
			registry.set(name, metadata);
		}
	}
	const source = join(root, "source"); mkdirSync(source);
	json(join(source, "package.json"), { private: true, workspaces: ["packages/*"] });
	const specs = [["coding-agent", cli, { [core]: "^1.0.4", [ai]: "^1.0.4" }], ["agent", core, { [ai]: "^1.0.4" }], ["ai", ai, { [telemetry]: "^1.0.4" }], ["telemetry", telemetry, {}]];
	for (const [dir, name, dependencies] of specs) await pack(join(source, "packages", dir), { name, version: "1.0.4", dependencies });
	const cliDir = join(source, "packages", "coding-agent");
	const original = JSON.parse(readFileSync(join(cliDir, "package.json")));
	const oldTar = await pack(join(root, "old"), original);
	const bad = join(root, "bad");
	await npm(["install", "--global", "--prefix", bad, "--ignore-scripts", oldTar]);
	const badTree = JSON.parse(await npm(["ls", "--global", "--prefix", bad, "--all", "--json"]));
	assert.equal(badTree.dependencies[cli].dependencies[core].version, "1.1.0");
	const badGlobalRoot = process.platform === "win32" ? join(bad, "node_modules") : join(bad, "lib", "node_modules");
	const badAi = join(badGlobalRoot, cli, "node_modules", ai);
	writeFileSync(join(badAi, "package.json"), readFileSync(join(source, "packages", "ai", "package.json")));
	await assert.rejects(npm(["ls", "--global", "--prefix", bad, "--all", "--json"]), /ELSPROBLEMS|invalid/);
	console.log("RED control: core 1.1.0 + overlay ai 1.0.4 makes real npm ls fail");
	const versions = pinInternalPackages(source, cli);
	const patched = JSON.parse(readFileSync(join(cliDir, "package.json")));
	assert.equal(patched.dependencies[telemetry], "1.0.4", "indirect workspace must be pinned at root");
	const packedResult = JSON.parse(await npm(["pack", "--workspace", "packages/coding-agent", "--ignore-scripts", "--json"], source));
	const tarball = join(source, packedResult[0].filename);
	const good = join(root, "good");
	await npm(["install", "--global", "--prefix", good, "--ignore-scripts", tarball]);
	// Emulate the existing release overlay: replace ai's metadata/payload with patched source.
	const globalRoot = process.platform === "win32" ? join(good, "node_modules") : join(good, "lib", "node_modules");
	const installedAi = join(globalRoot, cli, "node_modules", ai);
	writeFileSync(join(installedAi, "package.json"), readFileSync(join(source, "packages", "ai", "package.json")));
	writeFileSync(join(installedAi, "index.js"), "// local overlay marker\n");
	const output = await npm(["ls", "--global", "--prefix", good, "--all", "--json"]);
	const run = (command, args) => {
		assert.equal(command, "npm"); assert.deepEqual(args, ["ls", "--global", "--prefix", good, "--all", "--json"]);
		return output;
	};
	verifyInstalledInternalPackages(good, cli, versions, run);
	assert.match(readFileSync(join(installedAi, "index.js"), "utf8"), /local overlay marker/);
	assert.throws(() => verifyInstalledInternalPackages(bad, cli, versions, () => JSON.stringify(badTree)), /Mixed internal/);
	assert.throws(() => verifyInstalledInternalPackages(good, cli, versions, () => '{}'), /missing/);
	// Workspace versions need not match the CLI's version.
	json(join(source, "packages", "telemetry", "package.json"), { name: telemetry, version: "0.9.2" });
	assert.equal(pinInternalPackages(source, cli)[telemetry], "0.9.2");
	console.log("GREEN: real npm pack/install against newer loopback registry; exact closure, overlays and global-tree gate");
} finally {
	await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
