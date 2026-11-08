/**
 * Skills padrão do Agent.
 *
 * O Agent leva as skills de `skills/` deste repositório (contrato:
 * prometheus/docs/reference/skills-distribution.md). A cada ativação o updater copia essas skills
 * para `<store>/skills` e garante que esse caminho esteja em `skills[]` do `settings.json` do Pi.
 * É a única entrada que o Agent escreve ali; ele nunca mexe em `~/.pi/agent/skills`,
 * `~/.agents/skills` nem `~/.claude/skills`.
 *
 * O Pi carrega os caminhos de `settings.json` antes das pastas descobertas sozinhas e, em colisão
 * de nome, fica com o primeiro. Para a skill do usuário vencer, uma skill padrão com o mesmo nome
 * de uma em `~/.pi/agent/skills` ou `~/.agents/skills` não é copiada, e o updater avisa.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const SKILLS_DIR = "skills";
const ignored = new Set([".DS_Store", "node_modules"]);

/** Nomes das skills (diretórios com SKILL.md) diretamente sob `dir`; segue links. */
export function skillNames(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => !ignored.has(name) && !name.startsWith("."))
		.filter((name) => {
			try {
				return statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md"));
			} catch {
				return false; // link quebrado
			}
		})
		.sort();
}

/** Arquivos (relativos à raiz do repo) que viajam no bundle do overlay. */
export function skillFiles(repoRoot) {
	const files = [];
	const walk = (relative) => {
		for (const entry of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
			if (ignored.has(entry.name)) continue;
			const child = `${relative}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files.push(child);
		}
	};
	for (const name of skillNames(join(repoRoot, SKILLS_DIR))) walk(`${SKILLS_DIR}/${name}`);
	return files.sort();
}

/**
 * Copia as skills padrão para `<store>/skills` e registra o caminho no settings do Pi.
 * Devolve `{ installed, skipped, settingsUpdated }`.
 */
export function syncAgentSkills({
	sourceRoot,
	store,
	agentDir,
	homeDir,
	register = true,
	log = console.log,
	warn = console.warn,
}) {
	const source = join(sourceRoot, SKILLS_DIR);
	const names = skillNames(source);
	const target = join(store, SKILLS_DIR);
	// `register: false` (Agent): só atualiza uma cópia que já existe; o registro é do recibo de recursos.
	if (!register && !existsSync(target)) return { installed: [], skipped: [], settingsUpdated: false };
	// O Prometheus liga as skills padrão em ~/.agents/skills para o Claude/Codex apontando para
	// <store>/skills: esses links são do próprio Agent, não skills do usuário.
	const ownRoot = `${resolve(target)}${sep}`;
	const isOwn = (path) => {
		try {
			return `${realpathSync(path)}${sep}`.startsWith(existsSync(target) ? `${realpathSync(target)}${sep}` : ownRoot);
		} catch {
			return false;
		}
	};
	const userNames = new Set(
		[join(agentDir, "skills"), join(homeDir, ".agents", "skills")].flatMap((dir) =>
			skillNames(dir).filter((name) => !isOwn(join(dir, name))),
		),
	);
	const skipped = names.filter((name) => userNames.has(name));
	const installed = names.filter((name) => !userNames.has(name));
	if (skipped.length) {
		warn(`Skills padrão do Agent não instaladas porque você já tem uma com o mesmo nome: ${skipped.join(", ")}`);
	}

	const temporary = `${target}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(temporary, { recursive: true });
	for (const name of installed) {
		cpSync(join(source, name), join(temporary, name), {
			recursive: true,
			filter: (path) => !ignored.has(path.split(/[\\/]/).pop()),
		});
	}
	rmSync(target, { recursive: true, force: true });
	renameSync(temporary, target);

	const settingsUpdated = register ? ensureSettingsEntry(join(agentDir, "settings.json"), resolve(target), warn) : false;
	log(`Skills padrão do Agent: ${installed.length ? installed.join(", ") : "nenhuma"} (${target})`);
	return { installed, skipped, settingsUpdated };
}

/** Acrescenta `entry` a `skills[]`; não reescreve um settings ilegível. */
export function ensureSettingsEntry(file, entry, warn = console.warn) {
	let settings = {};
	if (existsSync(file)) {
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			warn(`${file} não é JSON válido; acrescente "${entry}" em "skills" à mão`);
			return false;
		}
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
			warn(`${file} não é um objeto JSON; acrescente "${entry}" em "skills" à mão`);
			return false;
		}
	}
	const skills = Array.isArray(settings.skills) ? settings.skills : [];
	if (skills.includes(entry)) return false;
	settings.skills = [...skills, entry];
	mkdirSync(resolve(file, ".."), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(temporary, file);
	return true;
}
