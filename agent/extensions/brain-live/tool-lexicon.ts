import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

/**
 * Reescreve as descrições das ferramentas com o texto de tools.md no perfil Agent.
 *   ## nome_da_tool     → descrição da ferramenta
 *   ### param           → descrição do parâmetro (aceita caminho: args.steps)
 * Ferramenta ausente do arquivo mantém a descrição original.
 */
export const PI_TOOLS_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".agent"), "tools.md");

export interface ToolEntry {
  description: string;
  params: Map<string, string>;
}

export function parseLexicon(text: string): Map<string, ToolEntry> {
  const tools = new Map<string, ToolEntry>();
  let tool: ToolEntry | undefined;
  let param: string | undefined;
  let buffer: string[] = [];

  const commit = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!tool || !body) return;
    if (param) tool.params.set(param, body);
    else tool.description = body;
  };

  for (const line of text.split("\n")) {
    const heading = /^(##|###)\s+(\S+)\s*$/.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    commit();
    if (heading[1] === "##") {
      param = undefined;
      tool = { description: "", params: new Map() };
      tools.set(heading[2], tool);
    } else {
      param = heading[2];
    }
  }
  commit();
  return tools;
}

function schemaOf(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  const schema = tool.parameters ?? tool.input_schema;
  return schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
}

function propertyAt(schema: Record<string, unknown> | undefined, path: string): Record<string, unknown> | undefined {
  const steps = path.split(".");
  let node = schema;
  for (const [index, step] of steps.entries()) {
    const properties = node?.properties as Record<string, unknown> | undefined;
    const next = properties?.[step] as Record<string, unknown> | undefined;
    if (!next) return undefined;
    // A descrição de um array mora no próprio nó; só desce para items para seguir o caminho.
    const last = index === steps.length - 1;
    node = !last && next.items && typeof next.items === "object" ? (next.items as Record<string, unknown>) : next;
  }
  return node === schema ? undefined : node;
}

export function applyLexicon(tools: unknown, lexicon: Map<string, ToolEntry>): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((raw) => {
    const tool = raw as Record<string, unknown>;
    const entry = lexicon.get(String(tool.name));
    if (!entry) return raw;

    const next: Record<string, unknown> = { ...tool };
    if (entry.description) next.description = entry.description;
    if (entry.params.size === 0) return next;

    const schema = structuredClone(schemaOf(tool));
    for (const [path, description] of entry.params) {
      const property = propertyAt(schema, path);
      if (property) property.description = description;
    }
    if (schema) next[tool.input_schema ? "input_schema" : "parameters"] = schema;
    return next;
  });
}

export default function toolLexicon(pi: ExtensionAPI) {
  let cache: { at: number; lexicon: Map<string, ToolEntry> } | undefined;

  const lexicon = (): Map<string, ToolEntry> => {
    if (!existsSync(PI_TOOLS_PATH)) return new Map();
    const at = statSync(PI_TOOLS_PATH).mtimeMs;
    if (!cache || cache.at !== at) cache = { at, lexicon: parseLexicon(readFileSync(PI_TOOLS_PATH, "utf8")) };
    return cache.lexicon;
  };

  pi.on("before_provider_request", (event: { payload: Record<string, unknown> }) => {
    const entries = lexicon();
    if (entries.size === 0 || !Array.isArray(event.payload?.tools)) return;
    return { ...event.payload, tools: applyLexicon(event.payload.tools, entries) };
  });
}
