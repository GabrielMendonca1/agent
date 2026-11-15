import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sistemaDir } from "./lib/paths";

const BASE_MARKER = "{{PI_BASE_SYSTEM_PROMPT}}";
// Consome a quebra após {{/PI_TOOL}}: bloco de tool inativa não deixa linha em branco.
const TOOL_BLOCK_RE = /{{#PI_TOOL\s+([A-Za-z0-9_.-]+)}}\r?\n?([\s\S]*?){{\/PI_TOOL}}(\r?\n)?/g;
const KNOWN_GUIDELINES = new Set([
  "Use read to examine files instead of cat or sed.",
  "You can inspect PI_* environment variables for current model and session details.",
  "Use edit for precise changes (edits[].oldText must match exactly)",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  "Use write only for new files or complete rewrites.",
  "project_overview is Pi's own operational panel. It observes; it does not govern or control Claude Code sessions and it never starts, stops or kills anything.",
  "Call project_overview {action:'snapshot'} when the user asks about repository state, other running sessions, dev servers, or what is happening in this project. Do not call it every turn.",
  "The snapshot is passive and may be slightly stale; live state is the authority and the sidecar file is only the last snapshot.",
  "Only perform a real intervention when the user explicitly asks for it or a concrete incident requires it, and do it with your normal tools. Afterwards call project_overview {action:'record', text:'...'} with a one-line factual summary.",
]);
export const PI_VAULT_DIR = join(sistemaDir(), "Pi");

export interface VaultValidation {
  skills: number;
  errors: string[];
}

function markdownCount(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export function validatePiVault(root = PI_VAULT_DIR): VaultValidation {
  const errors: string[] = [];
  // Sem o Vault (máquina de sócio, sem ~/Sistema/Pi): nada a validar e nada a reclamar.
  if (!existsSync(root)) return { skills: 0, errors: [] };
  const skillsDir = join(root, "skills");
  let skills = 0;
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      // Why: dot-dirs (.agent) are state, not skills; symlinked skills are real skills.
      if (entry.name.startsWith(".")) continue;
      const dir = join(skillsDir, entry.name);
      if (entry.isSymbolicLink() && !existsSync(dir)) {
        errors.push(`link de skill quebrado: ${entry.name}`);
        continue;
      }
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && statSync(dir).isDirectory())) continue;
      const skill = join(dir, "SKILL.md");
      if (!existsSync(skill)) errors.push(`skill sem SKILL.md: ${entry.name}`);
      else skills += 1;
    }
  } catch {
    errors.push(`diretório ausente: ${skillsDir}`);
  }

  const systemPrompt = join(root, "system-prompt.md");
  if (!existsSync(systemPrompt)) errors.push(`arquivo ausente: ${systemPrompt}`);
  return { skills, errors };
}

export interface PromptDynamics {
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  cwd?: string;
  /** Seções nomeadas de extensões (ex.: `agent_workflow`); o template não as conhece. */
  sections?: Record<string, string>;
}

function match(base: string, pattern: RegExp): string {
  return pattern.exec(base)?.[1]?.trim() ?? "";
}

/** Conteúdo interno de um bloco XML dinâmico; o wrapper fica editável no Vault. */
function innerXml(base: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return match(base, new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`));
}

function dynamicValues(base: string, dynamics: PromptDynamics) {
  const tools = new Set(dynamics.selectedTools ?? []);
  const declared = new Set<string>();
  const conditional = (template: string) => template.replace(TOOL_BLOCK_RE, (_all, name: string, body: string, newline?: string) => {
    declared.add(name);
    return tools.has(name) ? `${body.trim()}${newline ?? ""}` : "";
  });
  const extraTools = [...tools]
    .filter((name) => !declared.has(name) && dynamics.toolSnippets?.[name])
    .map((name) => `- ${name}: ${dynamics.toolSnippets![name]}`)
    .join("\n");
  const extraGuidelines = (dynamics.promptGuidelines ?? [])
    .filter((guideline) => !KNOWN_GUIDELINES.has(guideline.trim()))
    .map((guideline) => `- ${guideline.trim()}`)
    .join("\n");
  const extraSections = Object.entries(dynamics.sections ?? {})
    .filter(([, content]) => typeof content === "string" && content.trim())
    .map(([name, content]) => `<${name}>\n${content.trim()}\n</${name}>`)
    .join("\n\n");
  return { conditional, extraTools, extraGuidelines, extraSections };
}

export function renderSystemPrompt(base: string, root = PI_VAULT_DIR, dynamics: PromptDynamics = {}): string {
  try {
    let template = readFileSync(join(root, "system-prompt.md"), "utf8").trim();
    if (!template) return base;
    if (template.includes(BASE_MARKER)) return template.replace(BASE_MARKER, base);

    const values = dynamicValues(base, dynamics);
    template = values.conditional(template);
    const replacements: Record<string, string> = {
      PI_EXTRA_TOOLS: values.extraTools,
      PI_EXTRA_GUIDELINES: values.extraGuidelines,
      PI_EXTRA_SECTIONS: values.extraSections,
      // Marcadores legados preservam compatibilidade; os *_ENTRIES/*_CONTENT
      // deixam até os wrappers e títulos sob controle literal do Vault.
      PI_SKILLS: match(base, /(<available_skills>[\s\S]*?<\/available_skills>)/),
      PI_SKILL_ENTRIES: innerXml(base, "available_skills"),
      PI_PROJECT_CONTEXT: match(base, /(<project_context>[\s\S]*?<\/project_context>)/),
      PI_PROJECT_CONTEXT_CONTENT: innerXml(base, "project_context"),
      PI_CWD: dynamics.cwd ?? match(base, /Current working directory:\s*([^\n]+)/),
      PI_README_PATH: match(base, /- Main documentation:\s*([^\n]+)/),
      PI_DOCS_PATH: match(base, /- Additional docs:\s*([^\n]+)/),
      PI_EXAMPLES_PATH: match(base, /- Examples:\s*([^\n]+?)\s*\(extensions, custom tools, SDK\)/),
    };
    // Seções de extensões vão no marcador; sem marcador, no fim — nunca somem.
    if (values.extraSections && !template.includes("{{PI_EXTRA_SECTIONS}}")) template += "\n\n{{PI_EXTRA_SECTIONS}}";
    for (const [name, value] of Object.entries(replacements)) {
      template = template.replaceAll(`{{${name}}}`, value);
    }
    return template.replace(/\n{4,}/g, "\n\n\n").trim();
  } catch {
    return base;
  }
}

export const PI_DUMP_PATH = join(PI_VAULT_DIR, "last-prompt.md");

/**
 * O prompt descreve TODAS as tools registradas, não só as ativas: assim ele não
 * muda quando tools sob demanda são ativadas, e o cache do
 * prefixo sobrevive. A troca em si chega ao modelo pelo schema (o Pi manda
 * tool_addition/tool_removal no meio da conversa) e pela nota de modo.
 */
export function stableDynamics(pi: Pick<ExtensionAPI, "getAllTools">, options: PromptDynamics, memo: Record<string, string> = {}): PromptDynamics {
  let all: ReturnType<ExtensionAPI["getAllTools"]> = [];
  // Só o que pode ser declarado ao modelo: deferred/codemode chegam por tool_search/codemode
  // e não entram na lista (a exposição é fixa na sessão, então o prompt continua estável).
  try { all = pi.getAllTools().filter((tool) => !["hidden", "deferred", "codemode"].includes(tool.exposure)); } catch { return options; }
  if (!all.length) return options;
  for (const [name, snippet] of Object.entries(options.toolSnippets ?? {})) memo[name] ??= snippet;
  const toolSnippets: Record<string, string> = {};
  for (const tool of all) {
    const snippet = memo[tool.name] ?? tool.description?.split("\n")[0]?.trim();
    if (snippet) toolSnippets[tool.name] = memo[tool.name] = snippet;
  }
  const guidelines = [...all.flatMap((tool) => tool.promptGuidelines ?? []), ...(options.promptGuidelines ?? [])];
  return {
    ...options,
    selectedTools: all.map((tool) => tool.name),
    toolSnippets,
    promptGuidelines: [...new Set(guidelines.map((g) => g.trim()).filter(Boolean))],
  };
}

export default function vaultRuntime(pi: ExtensionAPI) {
  if (process.env.AGENT_VAULT !== "1") return;
  let validation = validatePiVault();
  let captured: { base: string; options: PromptDynamics } | null = null;

  // Skills are discovered through ~/.pi/agent/skills, which points at Sistema/Pi/skills.
  // Do not return the same directory from resources_discover: reloads would register it twice.
  const snippets: Record<string, string> = {};
  pi.on("before_agent_start", (event) => {
    captured = { base: event.systemPrompt, options: stableDynamics(pi, event.systemPromptOptions ?? {}, snippets) };
    return {
      systemPrompt: renderSystemPrompt(event.systemPrompt, PI_VAULT_DIR, captured.options),
    };
  });

  pi.registerCommand("prompt-dump", {
    description: `Escreve o system prompt renderizado em ${PI_DUMP_PATH} para auditoria`,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!captured) {
        ctx.ui.notify("Nenhum prompt capturado ainda — rode um turno primeiro.", "error");
        return;
      }
      const rendered = renderSystemPrompt(captured.base, PI_VAULT_DIR, captured.options);
      try {
        writeFileSync(PI_DUMP_PATH, rendered);
        ctx.ui.notify(`System prompt (${rendered.length} caracteres) → ${PI_DUMP_PATH}`, "info");
      } catch (error) {
        ctx.ui.notify(`Falha ao escrever ${PI_DUMP_PATH}: ${error}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!existsSync(PI_VAULT_DIR)) return; // sem Vault o rodapé não ganha indicador nenhum
    const status = validation.errors.length > 0
      ? `vault/Pi ${validation.skills} · ${validation.errors.length} erro(s)`
      : `vault/Pi ${validation.skills}`;
    ctx.ui.setStatus("vault-runtime", status);
  });

  pi.registerCommand("vault-sync", {
    description: "Valida Sistema/Pi e recarrega system prompt e skills",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      validation = validatePiVault();
      if (validation.errors.length > 0) {
        ctx.ui.notify(validation.errors.join("\n"), "error");
        return;
      }
      ctx.ui.notify(`Sistema/Pi válido: ${validation.skills} skills`, "info");
      await ctx.reload();
    },
  });
}
