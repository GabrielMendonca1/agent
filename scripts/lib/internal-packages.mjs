import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Run only after upstream checks/build: packaging metadata, not a source/lockfile change.
// Pin the whole runtime closure at the consumer root, including indirect workspaces.
// This is not a lock for external transitive dependencies.
export function pinInternalPackages(sourceDir, officialPackage) {
	const packages = new Map();
	for (const entry of readdirSync(join(sourceDir, "packages"), { withFileTypes: true })) {
		const file = join(sourceDir, "packages", entry.name, "package.json");
		if (!entry.isDirectory() || !existsSync(file)) continue;
		const pkg = JSON.parse(readFileSync(file, "utf8"));
		packages.set(pkg.name, { pkg, file });
	}
	const root = packages.get(officialPackage);
	if (!root) throw new Error(`Missing workspace ${officialPackage}`);
	const versions = {};
	function visit(name) {
		if (Object.hasOwn(versions, name)) return;
		const { pkg } = packages.get(name);
		if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error(`Invalid workspace version: ${name}`);
		versions[name] = pkg.version;
		for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
			if (packages.has(dependency)) visit(dependency);
		}
	}
	visit(officialPackage);
	for (const name of Object.keys(versions)) {
		const { pkg, file } = packages.get(name);
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
			for (const dependency of Object.keys(pkg[field] ?? {})) {
				if (Object.hasOwn(versions, dependency)) pkg[field][dependency] = versions[dependency];
			}
		}
		if (name === officialPackage) {
			pkg.dependencies = { ...pkg.dependencies, ...versions };
			delete pkg.dependencies[officialPackage];
		}
		writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
	}
	return versions;
}

export function verifyInstalledInternalPackages(installDir, officialPackage, versions, run) {
	// --prefix alone queries a local (potentially empty) tree, NOT the global install.
	const tree = JSON.parse(run("npm", ["ls", "--global", "--prefix", installDir, "--all", "--json"], { capture: true }));
	if (tree.dependencies?.[officialPackage]?.version !== versions[officialPackage]) {
		throw new Error(`Installed tree is missing ${officialPackage}@${versions[officialPackage]}`);
	}
	const seen = new Set();
	function visit(node) {
		for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
			if (Object.hasOwn(versions, name)) {
				if (dependency.version !== versions[name]) throw new Error(`Mixed internal package ${name}: expected ${versions[name]}, found ${dependency.version}`);
				seen.add(name);
			}
			visit(dependency);
		}
	}
	visit(tree);
	for (const name of Object.keys(versions)) {
		if (!seen.has(name)) throw new Error(`Installed tree is missing internal package ${name}`);
	}
}
