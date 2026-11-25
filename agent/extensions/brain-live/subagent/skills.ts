/**
 * Skill set of a Pi child.
 *
 * Pi 1.5.2: `--no-skills` drops discovery (settings, agent dir, project) but keeps every
 * `--skill <path>`, so `--no-skills --skill a --skill b` loads exactly a and b. What reaches the
 * prompt is then filtered by the Agent curation (PI_AUTOMATIC_SKILLS, set by the child's preload
 * from AGENT_CHILD_SKILLS), so the runner passes the advertised names too: debug/tdd carry
 * `disable-model-invocation` and would otherwise stay hidden.
 */
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { companySkillDirs } from "../../../core/companies.mjs";
import { AGENT_SKILLS_DIR } from "../../../core/skill-categories.mjs";
import { automaticSkillNames } from "../../../core/skill-policy.mjs";
import type { AgentConfig } from "./agents.ts";

/** Effective skill set recorded in the launch snapshot; absent = full catalog, no flags. */
export interface ChildSkills {
	/** `--no-skills`: only `paths` load (role allowlist). False = default catalog plus `paths`. */
	only: boolean;
	/** `--skill` values (SKILL.md files), in argv order. */
	paths: string[];
	/** Names the child advertises (AGENT_CHILD_SKILLS / PI_AUTOMATIC_SKILLS). */
	advertised: string[];
}

export type SkillResolution = { ok: true; skills?: ChildSkills } | { ok: false; error: string };

export interface CatalogSkill {
	name: string;
	filePath: string;
}

/**
 * The catalog a child would discover in `cwd` (no extensions), plus the user's company skills and
 * the skills bundled with this runtime, so a role allowlist (worker: debug, tdd) never depends on
 * the profile's `skills` setting. The first source wins on a name collision.
 */
export async function skillCatalog(cwd: string): Promise<CatalogSkill[]> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		additionalSkillPaths: [...companySkillDirs(), AGENT_SKILLS_DIR],
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	return loader.getSkills().skills.map((skill) => ({ name: skill.name, filePath: skill.filePath }));
}

export const runnerSkillHooks = { catalog: skillCatalog };

/** Request-level names: trimmed, deduplicated, empty entries dropped. */
export function requestedSkills(names: unknown): string[] {
	if (!Array.isArray(names)) return [];
	return [...new Set(names.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean))];
}

/**
 * Role allowlist plus the caller's extra names, resolved against the catalog. Unknown names and
 * paths fail; nothing outside the catalog reaches `--skill`.
 */
export async function resolveChildSkills(
	role: Pick<AgentConfig, "name" | "skills" | "runner">,
	extraNames: string[] | undefined,
	cwd: string,
): Promise<SkillResolution> {
	const extras = requestedSkills(extraNames);
	if (role.runner === "agy") {
		return extras.length
			? { ok: false, error: `Agent "${role.name}" runs on agy and does not load Pi skills; omit skills for it.` }
			: { ok: true };
	}
	if (role.skills === undefined && extras.length === 0) return { ok: true };
	const paths = extras.filter((name) => /[\\/]/.test(name) || name.endsWith(".md"));
	if (paths.length) return { ok: false, error: `Skills are catalog names, not paths: ${paths.join(", ")}.` };
	let catalog: CatalogSkill[];
	try {
		catalog = await runnerSkillHooks.catalog(cwd);
	} catch (error) {
		return { ok: false, error: `Could not load the skill catalog: ${error instanceof Error ? error.message : String(error)}` };
	}
	const byName = new Map<string, string>();
	for (const skill of catalog) if (!byName.has(skill.name)) byName.set(skill.name, skill.filePath);
	const available = () => [...byName.keys()].sort().join(", ") || "none";
	const roleUnknown = (role.skills ?? []).filter((name) => !byName.has(name));
	if (roleUnknown.length) return { ok: false, error: `Agent "${role.name}" lists unknown skill(s): ${roleUnknown.join(", ")}. Available skills: ${available()}.` };
	const unknown = extras.filter((name) => !byName.has(name));
	if (unknown.length) return { ok: false, error: `Unknown skill(s) for agent "${role.name}": ${unknown.join(", ")}. Available skills: ${available()}.` };
	if (role.skills !== undefined) {
		const names = [...new Set([...role.skills, ...extras])];
		return { ok: true, skills: { only: true, paths: names.map((name) => byName.get(name)!), advertised: names } };
	}
	return { ok: true, skills: { only: false, paths: extras.map((name) => byName.get(name)!), advertised: [...new Set([...automaticSkillNames(), ...extras])] } };
}

/** argv for the snapshot; nothing for the full catalog. */
export function skillArgs(skills: ChildSkills | undefined): string[] {
	if (!skills) return [];
	return [...(skills.only ? ["--no-skills"] : []), ...skills.paths.flatMap((file) => ["--skill", file])];
}
