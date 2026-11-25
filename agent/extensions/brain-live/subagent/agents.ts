/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/**
	 * Skill allowlist (frontmatter `skills`): names from the child's catalog. Absent = the full
	 * catalog; `[]` = none. A user/project override without the field inherits the bundled
	 * role of the same name.
	 */
	skills?: string[];
	runner?: "agy";
	model?: string;
	thinking?: string;
	/** Brief fields this role refuses to run without (frontmatter `brief_required`). */
	briefRequired?: string[];
	/** Default "Return format" section when the caller's brief omits it. */
	returnFormat?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	skills?: unknown;
	runner?: unknown;
	model?: unknown;
	thinking?: unknown;
	brief_required?: unknown;
	return_format?: unknown;
};

/**
 * Normalize a frontmatter list value (`tools`, `brief_required`) to names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields
 * nothing rather than throwing: this runs inside agent discovery, where a
 * single bad file must not take down every other agent in the same directory.
 */
function parseNameList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const names = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return names.length > 0 ? names : undefined;
}

/** `skills` keeps the difference between absent (full catalog) and empty (no skills). */
function parseSkillList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (value === null) return [];
	return parseNameList(value) ?? [];
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseNameList(frontmatter.tools),
			...(Object.hasOwn(frontmatter, "skills") ? { skills: parseSkillList(frontmatter.skills) } : {}),
			...(frontmatter.runner === "agy" ? { runner: "agy" as const } : {}),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			briefRequired: parseNameList(frontmatter.brief_required),
			returnFormat: typeof frontmatter.return_format === "string" ? frontmatter.return_format.trim() || undefined : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Bundled roles travel with the runtime; never copy them into the personal profile.
	const bundledDir = fileURLToPath(new URL("../../../agents/", import.meta.url));
	const bundled = loadAgentsFromDir(bundledDir, "bundled");
	// An override without `skills:` keeps the bundled role's allowlist; a new role keeps the full catalog.
	const inheritSkills = (agent: AgentConfig): AgentConfig => {
		if (agent.skills !== undefined) return agent;
		const base = bundled.find((role) => role.name === agent.name);
		return base?.skills !== undefined ? { ...agent, skills: [...base.skills] } : agent;
	};
	const userAgents = scope === "project" ? [] : [
		...bundled,
		...loadAgentsFromDir(userDir, "user").map(inheritSkills),
	];
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project").map(inheritSkills);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
