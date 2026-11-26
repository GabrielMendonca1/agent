import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
}

// Pi accepts a few multi-letter short switches. Other single-dash words such as
// -bad are invalid slug candidates; the long switches always start with --.
const PI_SHORT_OPTIONS = /^-(?:[A-Za-z]|nbt|nt|xt|ne|ns|np|nc|na)$/;

// Keep the slug grammar in sync with subagent/workspace.ts (the launcher is plain Node).
// Pi options whose parser unconditionally takes the next token, even if it
// looks like a flag. Options like --mode and --print reject a --worktree value.
const PI_REQUIRED_VALUES = new Set([
	"--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt",
	"--name", "-n", "--session", "--session-id", "--fork", "--session-dir", "--models",
	"--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e",
	"--skill", "--prompt-template", "--theme",
]);

export function extractWorktreeOption(args) {
	let slug;
	const forwarded = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			forwarded.push(...args.slice(i));
			break;
		}
		if (arg !== "--worktree" && !arg.startsWith("--worktree=")) {
			forwarded.push(arg);
			if (PI_REQUIRED_VALUES.has(arg) && i + 1 < args.length) forwarded.push(args[++i]);
			continue;
		}
		if (slug !== undefined) throw new Error("Specify --worktree only once.");
		const next = args[i + 1];
		const nextIsOption = next?.startsWith("--") || PI_SHORT_OPTIONS.test(next ?? "");
		slug = arg !== "--worktree" ? arg.slice("--worktree=".length)
			: next !== undefined && !nextIsOption ? args[++i] : `wt-${Date.now().toString(36)}`;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slug) || slug.includes("..") || slug.endsWith(".")) {
			throw new Error(`Invalid worktree slug: ${JSON.stringify(slug)}.`);
		}
	}
	return { slug, args: forwarded };
}

function present(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
}

function links(root) {
	let raw;
	try { raw = readFileSync(join(root, ".pi", "checks.json"), "utf8"); }
	catch (error) { if (error.code !== "ENOENT") throw error; else return []; }
	const entries = JSON.parse(raw)?.link;
	return (Array.isArray(entries) ? entries : []).map((entry) => {
		if (typeof entry !== "string" || isAbsolute(entry)) throw new Error(`Invalid worktree link: ${entry}`);
		const path = relative(root, resolve(root, entry));
		if (!path || path === ".." || path.startsWith(`..${sep}`)) throw new Error(`Invalid worktree link: ${entry}`);
		return path;
	});
}

function replicateLinks(root, worktree, paths) {
	for (const path of paths) {
		const source = join(root, path);
		let sourceStat;
		try { sourceStat = statSync(source); }
		catch (error) { if (error.code !== "ENOENT") throw error; else continue; }
		const segments = path.split(sep);
		const leaf = segments.pop();
		let parent = worktree;
		for (const segment of segments) {
			parent = join(parent, segment);
			const existing = present(parent);
			if (!existing) mkdirSync(parent);
			else if (!existing.isDirectory()) throw new Error(`Invalid worktree link parent: ${parent}`);
		}
		const target = join(parent, leaf);
		if (!present(target)) symlinkSync(source, target, sourceStat.isDirectory() ? "junction" : "file");
	}
}

export function prepareSessionWorktree(slug, { cwd = process.cwd(), env = process.env, dryRun = false } = {}) {
	const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
	let sourceBranch;
	try { sourceBranch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD"); }
	catch { throw new Error("Cannot open a session worktree from a detached HEAD."); }
	const base = git(root, "rev-parse", "--verify", "HEAD");
	const source = { root, branch: sourceBranch };
	const branch = `agent/session-${slug}`;
	git(root, "check-ref-format", `refs/heads/${branch}`);
	if (branch === sourceBranch) throw new Error(`Already on ${branch}; use a different slug for a nested worktree.`);
	const parent = resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".agent"), "agent", "worktrees");
	if (!dryRun) mkdirSync(parent, { recursive: true });
	const worktree = join(present(parent) ? realpathSync(parent) : parent, `session-${slug}`);
	const worktreeCwd = join(worktree, relative(root, realpathSync(cwd)));
	const listing = git(root, "worktree", "list", "--porcelain", "-z").split("\0\0");
	const registered = listing.map((record) => record.split("\0"))
		.find(([path]) => path.startsWith("worktree ") && resolve(path.slice("worktree ".length)) === worktree);
	const existing = present(worktree);
	const linkPaths = links(root);
	if (registered || existing) {
		if (!registered?.includes(`branch refs/heads/${branch}`) || !existing?.isDirectory()) {
			throw new Error(`Cannot reuse ${worktree}: expected a registered checkout of ${branch}.`);
		}
		const metadata = join(git(worktree, "rev-parse", "--absolute-git-dir"), "agent-session-source.json");
		const recorded = present(metadata) && JSON.parse(readFileSync(metadata, "utf8"));
		if (recorded?.root !== root || recorded?.branch !== sourceBranch) {
			throw new Error(`Cannot reuse ${worktree}: the recorded source does not match ${root} (${sourceBranch}).`);
		}
	} else if (!dryRun) {
		git(root, "worktree", "add", "-b", branch, "--", worktree, base);
	}
	if (existing || !dryRun) {
		try {
			if (!dryRun) replicateLinks(root, worktree, linkPaths);
			const actual = realpathSync(worktreeCwd);
			if ((actual !== worktree && !actual.startsWith(worktree + sep)) || !statSync(actual).isDirectory()) {
				throw new Error(`Not a directory inside the session worktree: ${worktreeCwd}`);
			}
			if (!existing) {
				const metadata = join(git(worktree, "rev-parse", "--absolute-git-dir"), "agent-session-source.json");
				writeFileSync(metadata, JSON.stringify(source) + "\n", { mode: 0o600, flag: "wx" });
			}
		} catch (error) {
			if (!existing) {
				try {
					git(root, "worktree", "remove", "--force", "--", worktree);
					git(root, "update-ref", "-d", `refs/heads/${branch}`, base);
				} catch (cleanup) { throw new Error(`${error.message}\nWorktree cleanup failed: ${cleanup.message}`); }
			}
			throw error;
		}
	}
	return { cwd: worktreeCwd, env: {
		AGENT_WORKTREE_SESSION: worktree,
		AGENT_WORKTREE_SOURCE: root,
		AGENT_WORKTREE_BRANCH: sourceBranch,
		AGENT_WORKTREE_NAME: branch,
	} };
}
