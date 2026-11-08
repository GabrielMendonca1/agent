import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { readSessionMode } from "../lib/session-mode.mjs";
import { clearSnapshotCache, detectRoot, snapshot } from "./collect.mjs";
import {
  LIMITS,
  homeRelative,
  projectSlug,
  renderFooter,
  renderOverview,
  renderWidget,
  snapshotFingerprint,
} from "./render.mjs";
import {
  appendRecord,
  ensureDir,
  readTail,
  serialize,
  shouldPersist,
  sidecarPaths,
  stateBaseDir,
  writeMetadata,
  writeOverview,
} from "./store.mjs";

const KEY = "project-operator";
const REFRESH_MS = 30000;

/** Coloriza a linha do footer com tokens do tema ("po slug · pi3 · :porta"). */
function styleFooter(line: string | undefined, ctx: ExtensionContext): string | undefined {
  if (!line || !ctx.hasUI) return line;
  const theme = ctx.ui.theme;
  const body = line.startsWith("po ") ? line.slice(3) : line;
  const parts = body.split(" · ");
  const sep = theme.fg("dim", " · ");
  const styled = parts
    .map((p, i) => (i === 0 ? theme.fg("text", p) : theme.fg("muted", p)))
    .join(sep);
  return `${theme.fg("dim", "po")} ${styled}`;
}

interface OperatorState {
  gen: number;
  root: string;
  slug: string;
  paths: ReturnType<typeof sidecarPaths>;
  inert: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  disposed: boolean;
  refreshing: boolean;
  inflight: Promise<any> | null;
  widgetOn: boolean;
  last: any;
  lastFingerprint: string | null;
  lastPersistAt: number | null;
}

let state: OperatorState | null = null;
let generation = 0;

function sessionLabel(ctx: ExtensionContext): string {
  return `pi:${ctx.mode}:${process.pid}`;
}

async function persist(current: OperatorState, snap: any, ctx: ExtensionContext): Promise<void> {
  await serialize(current.paths.dir, async () => {
    await ensureDir(current.paths.dir, current.paths.baseDir);
    const tail = await readTail(current.paths);
    await writeOverview(current.paths, renderOverview(snap, tail, { renderedBy: sessionLabel(ctx) }));
    await writeMetadata(current.paths, {
      root: snap.root,
      slug: snap.slug,
      updatedAt: new Date(snap.at).toISOString(),
      updatedBy: sessionLabel(ctx),
      schema: 1,
    });
  });
}

async function refresh(
  ctx: ExtensionContext,
  options: { force?: boolean; write?: boolean; forceWrite?: boolean } = {},
): Promise<any> {
  const current = state;
  if (!current || current.disposed || current.inert) return null;
  if (current.refreshing) {
    if (options.forceWrite !== true) return current.last;
    try {
      await current.inflight;
    } catch {}
    if (state !== current || current.disposed) return null;
    return refresh(ctx, options);
  }
  current.refreshing = true;
  const run = runRefresh(ctx, current, options);
  current.inflight = run;
  try {
    return await run;
  } finally {
    current.refreshing = false;
    current.inflight = null;
  }
}

async function runRefresh(
  ctx: ExtensionContext,
  current: OperatorState,
  options: { force?: boolean; write?: boolean; forceWrite?: boolean },
): Promise<any> {
  const gen = current.gen;
  try {
    const snap = await snapshot(current.root, {
      force: options.force === true,
      currentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    });
    if (!state || state !== current || state.disposed || state.gen !== gen) return null;
    current.last = snap;
    if (options.write !== false) {
      const fingerprint = snapshotFingerprint(snap);
      const gated = shouldPersist({
        fingerprint,
        lastFingerprint: current.lastFingerprint,
        at: snap.at,
        lastPersistAt: current.lastPersistAt,
        force: options.forceWrite === true,
      });
      if (gated) {
        await persist(current, snap, ctx);
        current.lastFingerprint = fingerprint;
        current.lastPersistAt = snap.at;
      }
    }
    if (!state || state !== current || state.disposed || state.gen !== gen) return null;
    if (ctx.hasUI) {
      ctx.ui.setStatus(KEY, styleFooter(renderFooter(snap), ctx));
      if (current.widgetOn) ctx.ui.setWidget(KEY, renderWidget(snap), { placement: "aboveEditor" });
    }
    return snap;
  } catch {
    if (state === current && !current.disposed && ctx.hasUI) ctx.ui.setStatus(KEY, styleFooter("po ?", ctx));
    return null;
  }
}

function teardown(ctx: ExtensionContext): void {
  const current = state;
  if (!current) return;
  current.disposed = true;
  if (current.timer) clearInterval(current.timer);
  current.timer = undefined;
  if (ctx.hasUI) {
    ctx.ui.setStatus(KEY, undefined);
    ctx.ui.setWidget(KEY, undefined);
  }
  state = null;
}

function summarize(snap: any): Record<string, unknown> {
  const payload = {
    root: homeRelative(snap.root),
    slug: snap.slug,
    at: new Date(snap.at).toISOString(),
    git: snap.git?.unavailable
      ? { unavailable: true }
      : {
          branch: snap.git?.branch ?? null,
          head: snap.git?.head ?? null,
          dirty: snap.git?.dirty ?? null,
          upstream: snap.git?.upstream ?? null,
          stashes: snap.git?.stashes ?? 0,
        },
    processes: snap.processes?.unavailable
      ? { unavailable: true }
      : {
          claude: snap.processes?.claude ?? null,
          pi: snap.processes?.pi ?? null,
          runtimes: (snap.processes?.runtimes ?? []).map((proc: any) => ({
            pid: proc.pid,
            ppid: proc.ppid,
            label: proc.label,
            cwd: proc.rel,
            ports: proc.ports,
          })),
        },
    transcripts: {
      claude: (snap.sessions?.claude ?? []).map((entry: any) => ({
        name: entry.name,
        ageMs: entry.ageMs,
        sizeKb: entry.sizeKb,
        active: entry.active,
      })),
      pi: (snap.sessions?.pi ?? []).map((entry: any) => ({
        name: entry.name,
        ageMs: entry.ageMs,
        sizeKb: entry.sizeKb,
        active: entry.active,
      })),
    },
    warnings: snap.warnings ?? [],
  };
  return payload;
}

function toolText(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= LIMITS.toolBytes) return text;
  return `${text.slice(0, LIMITS.toolBytes)}\n… truncated`;
}

export function renderProjectOverviewResult(result: any, expanded: boolean, theme: any): string {
  const raw = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  if (expanded) return theme.fg("toolOutput", raw);
  const details = result.details ?? {};
  if (details.inert || details.unavailable || details.error) return theme.fg("warning", raw.split("\n")[0]);
  if (details.kind === "intervention" || details.text) {
    return theme.fg("success", `✓ registrado: ${String(details.text ?? raw).split("\n")[0]}`);
  }
  const branch = details.git?.branch ?? "sem git";
  const dirty = details.git?.dirty ? " · dirty" : "";
  const runtimes = details.processes?.runtimes?.length ?? 0;
  const warnings = details.warnings?.length ?? 0;
  return theme.fg("toolOutput", `${details.slug ?? "projeto"} · ${branch}${dirty} · ${runtimes} runtime(s)${warnings ? ` · ${warnings} aviso(s)` : ""}`);
}

type DoctorTool = Pick<ReturnType<ExtensionAPI["getAllTools"]>[number], "name" | "exposure" | "sourceInfo">;
type DoctorCommand = Pick<ReturnType<ExtensionAPI["getCommands"]>[number], "name" | "source" | "sourceInfo">;
const MARK_EXTENSIONS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Registry público, não descoberta de disco: um nome nativo pode ser um override. */
export function buildMarkDoctorReport(input: {
  tools: DoctorTool[];
  activeTools: string[];
  commands: DoctorCommand[];
  settings: { cacheWarming?: unknown };
  mode: "simple" | "complex" | null;
  markExtensionsRoot?: string;
}): string {
  const clean = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ") : "não observado";
  const root = (input.markExtensionsRoot ?? MARK_EXTENSIONS_ROOT).replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const origin = (source: DoctorTool["sourceInfo"] | undefined) => {
    const path = clean(source?.path);
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("builtin:")) return `Pi nativo · ${path}`;
    if (normalized.startsWith(root)) return `Mark · ${normalized.slice(root.length)}`;
    return `extensão/integração · ${path}`;
  };
  const declared = new Set(input.activeTools);
  const tools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  const commands = [...input.commands].sort((a, b) => a.name.localeCompare(b.name));
  const skills = commands.filter(command => command.source === "skill");
  // Nunca serializar settings: pode conter endpoints, comandos e dados privados.
  const warming = ["off", "streaming", "idle"].includes(String(input.settings.cacheWarming))
    ? String(input.settings.cacheWarming) : "streaming (padrão do Pi 1.4)";
  const lines = [
    "MARK · DIAGNÓSTICO DA SESSÃO",
    `Modo Mark: ${input.mode ?? "não observado"}`,
    `Ferramentas registradas: ${tools.length}; declaradas: ${tools.filter(tool => declared.has(tool.name)).length}`,
    "Origem observada no registry; nome da ferramenta não determina sua origem.",
    "",
    "FERRAMENTAS",
  ];
  for (const tool of tools) {
    const exposure = ["direct", "model-only", "codemode", "deferred", "hidden"].includes(tool.exposure) ? tool.exposure : "não observada";
    lines.push(`${clean(tool.name)} · ${declared.has(tool.name) ? "declarada" : "não declarada"} · exposição: ${exposure}`);
    lines.push(`  ${origin(tool.sourceInfo)}`);
    if (tool.name === "subagent" && input.mode === "simple") lines.push("  Modo simple bloqueia subagent na chamada, mesmo declarado.");
  }
  lines.push("", "Declarada ≠ permitida: hooks ainda podem bloquear chamadas.",
    "codemode/deferred podem ser alcançáveis sem declaração; hidden é inacessível.",
    "",
    "COMANDOS DE EXTENSÕES E PROMPTS (não inclui os comandos embutidos do Pi)");
  for (const command of commands.filter(command => command.source !== "skill")) {
    lines.push(`/${clean(command.name)} · ${origin(command.sourceInfo)}`);
  }
  lines.push("", `SKILLS COM COMANDO OBSERVADO: ${skills.length}`);
  for (const skill of skills) lines.push(`/${clean(skill.name)} · ${clean(skill.sourceInfo?.path)}`);
  lines.push("Skills sem comando não são enumeradas por esta API.", "", "CONFIGURAÇÃO E LIMITES",
    `Cache nativo: ${warming} (configuração, não prova de refresh).`,
    "Hooks sem tool/comando: carregamento não observado por este relatório.",
    "Cache-keeper, compactação, aprendizado e observador podem consumir modelo; atividade e cobranças não observadas.",
    "Integração registrada não prova conexão, autenticação ou saúde.",
    "Consulte /cache, /cost e /session quando disponíveis para uso/cache.",
    "pi overlay-status: instalação e checkout. pi config: recursos configurados.",
    "Este diagnóstico não faz inferência, probes ou escrita; não lê auth nem arquivos de conversas.");
  return lines.join("\n");
}

export default function projectOperator(pi: ExtensionAPI) {
  // Independente do snapshot de projeto: funciona até em diretório inert.
  pi.registerCommand("mark-doctor", {
    description: "origem e exposição das ferramentas da sessão, sem inferência ou probes",
    handler: async (_args, ctx) => {
      let mode: "simple" | "complex" | null = null;
      try { mode = readSessionMode(ctx); } catch { /* modo inválido não autoriza nada */ }
      const report = buildMarkDoctorReport({
        tools: pi.getAllTools(), activeTools: pi.getActiveTools(), commands: pi.getCommands(),
        settings: { cacheWarming: pi.getSettings().cacheWarming }, mode,
      });
      if (ctx.hasUI) {
        // Viewer nativo com scroll/cópia; o texto devolvido nunca é salvo nem enviado.
        await ctx.ui.editor("Diagnóstico Mark · alterações descartadas ao fechar", report);
      } else if (ctx.mode === "json") {
        // stderr preserva o protocolo JSONL oficial em stdout.
        console.error(JSON.stringify({ type: "mark_doctor", report }));
      } else {
        console.error(report);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    teardown(ctx);
    clearSnapshotCache();
    generation += 1;
    const detected = await detectRoot(ctx.cwd);
    if (detected.inert) {
      state = null;
      if (ctx.hasUI) ctx.ui.setStatus(KEY, undefined);
      return;
    }
    const snapSlug = projectSlug(detected.root);
    const paths = sidecarPaths(snapSlug, stateBaseDir());
    state = {
      gen: generation,
      root: detected.root,
      slug: snapSlug,
      paths,
      inert: false,
      timer: undefined,
      disposed: false,
      refreshing: false,
      inflight: null,
      widgetOn: false,
      last: null,
      lastFingerprint: null,
      lastPersistAt: null,
    };
    await refresh(ctx, { force: true, forceWrite: true });
    if (state && !state.disposed && ctx.hasUI) {
      const timer = setInterval(() => {
        void refresh(ctx, { force: true });
      }, REFRESH_MS);
      timer.unref?.();
      state.timer = timer;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    teardown(ctx);
  });

  pi.registerCommand("overview", {
    description: "painel operacional do projeto (snapshot passivo, somente leitura)",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["show", "refresh", "hide", "path", "record"];
      return actions
        .filter((action) => action.startsWith(prefix.trim()))
        .map((action) => ({ value: action, label: action }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const current = state;
      if (!current) {
        ctx.ui.notify("project-operator inativo neste diretorio (modo inert)", "info");
        return;
      }
      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      const action = (space === -1 ? trimmed : trimmed.slice(0, space)) || "show";
      const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

      if (action === "hide") {
        current.widgetOn = false;
        if (ctx.hasUI) ctx.ui.setWidget(KEY, undefined);
        return;
      }
      if (action === "path") {
        ctx.ui.notify(homeRelative(current.paths.dir), "info");
        return;
      }
      if (action === "record") {
        let text = rest;
        if (!text && ctx.hasUI) text = (await ctx.ui.input("registrar intervencao", "o que foi feito")) ?? "";
        if (!text.trim()) {
          ctx.ui.notify("nada registrado", "info");
          return;
        }
        const record = await serialize(current.paths.dir, () =>
          appendRecord(current.paths, { kind: "intervention", session: sessionLabel(ctx), text }),
        );
        await refresh(ctx, { force: true, forceWrite: true });
        ctx.ui.notify(`registrado: ${record.text}`, "info");
        return;
      }
      const snap = await refresh(ctx, { force: action === "refresh", forceWrite: action === "refresh" });
      if (action === "refresh") {
        ctx.ui.notify("overview atualizado", "info");
        return;
      }
      current.widgetOn = true;
      if (ctx.hasUI && snap) ctx.ui.setWidget(KEY, renderWidget(snap), { placement: "aboveEditor" });
    },
  });

  pi.registerTool({
    name: "project_overview",
    exposure: "deferred",
    label: "Project Overview",
    description:
      "Passive read-only operational panel for the current project: git state, Claude/Pi sessions and runtimes whose cwd is this project, recent transcript metadata, and the log of recorded interventions.",
    promptSnippet:
      "Read-only operational snapshot of the current project (git, running Claude/Pi sessions, runtimes) plus a log of recorded interventions",
    promptGuidelines: [
      "project_overview is Pi's own operational panel. It observes; it does not govern or control Claude Code sessions and it never starts, stops or kills anything.",
      "Call project_overview {action:'snapshot'} when the user asks about repository state, other running sessions, dev servers, or what is happening in this project. Do not call it every turn.",
      "The snapshot is passive and may be slightly stale; live state is the authority and the sidecar file is only the last snapshot.",
      "Only perform a real intervention when the user explicitly asks for it or a concrete incident requires it, and do it with your normal tools. Afterwards call project_overview {action:'record', text:'...'} with a one-line factual summary.",
    ],
    parameters: Type.Object({
      action: StringEnum(["snapshot", "record"] as const),
      text: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const current = state;
      if (!current) {
        return {
          content: [{ type: "text" as const, text: "project-operator inativo neste diretorio (modo inert)" }],
          details: { inert: true },
        };
      }
      if (params.action === "record") {
        const text = String(params.text ?? "");
        if (!text.trim()) {
          return {
            content: [{ type: "text" as const, text: "record requer text" }],
            details: { error: "missing text" },
          };
        }
        const record = await serialize(current.paths.dir, () =>
          appendRecord(current.paths, { kind: "intervention", session: sessionLabel(ctx), text }),
        );
        await refresh(ctx, { force: true, forceWrite: true });
        return {
          content: [{ type: "text" as const, text: `registrado em ${homeRelative(current.paths.journal)}: ${record.text}` }],
          details: record,
        };
      }
      const snap = (await refresh(ctx, { force: true, forceWrite: true })) ?? current.last;
      if (!snap) {
        return {
          content: [{ type: "text" as const, text: "snapshot indisponivel" }],
          details: { unavailable: true },
        };
      }
      const payload = summarize(snap);
      return { content: [{ type: "text" as const, text: toolText(payload) }], details: payload };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`project_overview ${args.action}`)), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return new Text(renderProjectOverviewResult(result, expanded, theme), 0, 0);
    },

  });
}
