import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isChild } from "../../../core/client.mjs";
import { baseline, baseSha, gate, lastRun, lastRunLine, resultOk, selectChecks, treeState, writeLastRun, type CheckResult, type Manifest, findManifest, formatResults, runChecks } from "./runner.ts";

/**
 * O portão de verificação como ferramenta de primeira classe.
 *
 * Worktree isola escrita; ele não protege comportamento. O que faltava era um
 * veredito rápido e atribuível sobre o que a mudança QUEBROU — disponível para
 * o agente durante o trabalho, para o hook do omni no fim de cada step e para o
 * portão de merge. Os três chamam a mesma coisa: `gate`.
 */

export type ChecksMode = "main" | "writer-child" | "readonly-child";

/**
 * Filho só leitura (papel sem edit/write): o runner do subagent marca AGENT_CHECKS_READONLY=1.
 * O sandbox do bash também conta, por segurança. Ali checks não executa nada: o comando vem
 * de .pi/checks.json, controlado pelo projeto, e rodaria fora do sandbox.
 */
export function checksMode(env: NodeJS.ProcessEnv = process.env): ChecksMode {
  if (env.AGENT_CHECKS_READONLY === "1" || env.AGENT_BASH_SANDBOX === "seatbelt" || env.AGENT_BASH_SANDBOX === "bwrap") return "readonly-child";
  return isChild() ? "writer-child" : "main";
}

const READONLY_ACTIONS = ["list", "last"] as const;
const FULL_ACTIONS = ["gate", "run", "baseline", "list", "last"] as const;
const cwdParam = Type.Optional(Type.String({ description: "Project or worktree directory. Default: the session cwd." }));
const ChecksParams = Type.Object({
  action: Type.Optional(StringEnum(FULL_ACTIONS)),
  tags: Type.Optional(Type.String({ description: 'Comma-separated manifest tags (e.g. "fast").' })),
  only: Type.Optional(Type.String({ description: "Comma-separated check names." })),
  cwd: cwdParam,
});
const ReadonlyChecksParams = Type.Object({
  action: Type.Optional(StringEnum(READONLY_ACTIONS)),
  cwd: cwdParam,
});

function split(value?: string): string[] | undefined {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function summary(results: CheckResult[]): string {
  const red = results.filter((result) => !result.ok).length;
  return `${results.length - red}/${results.length} green`;
}

/** Subagente escritor: sem tags/only, roda só "fast" (o gate completo fica com o integrate). */
export function childDefaultTags(manifest: Manifest, mode: ChecksMode, tags?: string[], names?: string[]): string[] | undefined {
  if (mode !== "writer-child" || tags?.length || names?.length) return tags;
  return manifest.checks.some((check) => check.tags?.includes("fast")) ? ["fast"] : undefined;
}

export function readonlyRefusal(action: string): string {
  return `checks ${action} is not available in a read-only subagent: it would execute project-controlled commands from .pi/checks.json outside the bash sandbox. Use checks last to read the last recorded run (validated against HEAD and the working tree), or checks list.`;
}

export function lastRunText(cwd: string): { text: string; details: Record<string, unknown> } {
  const manifest = findManifest(cwd);
  if (!manifest) throw new Error(`no .pi/checks.json found from ${cwd}`);
  const state = lastRun(manifest.root);
  if (state.status === "missing") {
    return { text: `missing: no recorded checks gate/run for ${manifest.root}.`, details: { name: "checks", action: "last", status: "missing", root: manifest.root } };
  }
  const r = state.record;
  const base = { name: "checks", action: "last", status: state.status, root: manifest.root, head: r.tree.head, at: r.at, ok: r.ok, total: r.total, green: r.green,
    newFailures: r.comparison?.newFailures, ...(state.status === "stale" ? { diverged: state.diverged } : {}) };
  if (state.status === "stale") {
    return {
      text: `stale: ${state.diverged.join(", ")} changed since the recorded run; it does not describe the current tree.\nrecorded: ${lastRunLine(state)}`,
      details: base,
    };
  }
  const note = r.treeChangedDuringRun ? "\nnote: the run itself changed the working tree; the fingerprint is the state after the run." : "";
  return {
    text: `fresh: ${lastRunLine(state)}\n${r.verdict}${note}\n${formatResults(r.results, r.comparison)}`,
    details: { ...base, results: r.results },
  };
}

export function renderChecksResult(result: any, expanded: boolean, isPartial: boolean, theme: any): string {
  const raw = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  if (expanded) return theme.fg("toolOutput", raw);
  if (isPartial) return theme.fg("muted", raw.split("\n")[0] || "rodando…");

  const details = result.details ?? {};
  if (details.action === "list") return theme.fg("success", `✓ ${details.total ?? 0} checks declarados`);
  if (details.action === "last") {
    const mark = details.status !== "fresh" ? theme.fg("warning", "?") : resultOk(details) ? theme.fg("success", "✓") : theme.fg("error", "✗");
    return `${mark} ${theme.fg("toolOutput", raw.split("\n")[0] || String(details.status))}`;
  }
  const results = Array.isArray(details.results) ? details.results as CheckResult[] : [];
  const status = !resultOk(details) ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const verdict = raw.split("\n")[0] || (results.length ? summary(results) : "concluído");
  return `${status} ${theme.fg("toolOutput", verdict)}`;
}

export default function checksExtension(pi: ExtensionAPI) {
  const mode = checksMode();
  const readonly = mode === "readonly-child";
  pi.registerTool({
    name: "checks",
    label: "Checks",
    description: readonly
      ? [
        "Project verification gate declared in .pi/checks.json. Read-only here: this subagent cannot execute checks.",
        "",
        "last (default): the last recorded gate/run for this checkout, with HEAD and a working-tree fingerprint. Returns fresh with the results when HEAD, git status, git diff HEAD and untracked contents still match; otherwise stale with the part that diverged — do not cite a stale result as evidence.",
        "list: the declared checks.",
      ].join("\n")
      : [
        "Project verification gate declared in .pi/checks.json.",
        "",
        "gate (default): runs the checks and compares failures with the baseline of the base commit; reports only what THIS change broke.",
        "run: runs without comparing. baseline: shows/computes the base commit state. list: declared checks. last: the last recorded gate/run, fresh or stale against HEAD and the working tree.",
        ...(mode === "writer-child" ? ["", 'In a subagent, gate/run/baseline default to tags "fast" when neither tags nor only is given; the full gate runs at integrate.'] : []),
        "",
        "Run gate after changing code and before saying you are done. Inherited failures are not yours; new failures are.",
      ].join("\n"),
    promptSnippet: readonly
      ? "Read the last recorded checks result for this checkout (fresh or stale)"
      : "Check whether the change broke something that worked (.pi/checks.json)",
    promptGuidelines: readonly
      ? [
        "Use checks last to cite the writer's gate result with its HEAD sha; treat stale as no evidence.",
      ]
      : [
        "Run checks gate before declaring a code task done; pass cwd when working in a different worktree.",
        "Treat newFailures as real blockers: fix or explain them. stillFailing was already red; do not claim you caused it.",
      ],
    parameters: readonly ? ReadonlyChecksParams : ChecksParams,
    // Antes da validação do schema: a recusa explica o porquê em vez de só listar os valores aceitos.
    prepareArguments: (args: any) => {
      const action = args?.action;
      if (readonly && typeof action === "string" && !(READONLY_ACTIONS as readonly string[]).includes(action)) throw new Error(readonlyRefusal(action));
      return args;
    },
    async execute(_toolCallId, params: { action?: string; tags?: string; only?: string; cwd?: string }, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const action = params.action ?? (readonly ? "last" : "gate");
      if (readonly && !(READONLY_ACTIONS as readonly string[]).includes(action)) throw new Error(readonlyRefusal(action));
      if (action === "last") {
        const last = lastRunText(cwd);
        return { content: [{ type: "text", text: last.text }], details: last.details };
      }
      const manifest = findManifest(cwd);
      if (!manifest) throw new Error(`no .pi/checks.json found from ${cwd}; declare the project contract before requiring the gate`);
      const names = split(params.only);
      const explicitTags = split(params.tags);
      const tags = childDefaultTags(manifest, mode, explicitTags, names);
      const defaulted = tags !== explicitTags ? `default tags ${tags!.join(",")} (subagent); pass tags or only for other checks\n` : "";

      if (action === "list") {
        const lines = manifest.checks.map((check) => `${check.name}  [${(check.tags ?? []).join(",") || "no tag"}]  ${check.cmd}`);
        return { content: [{ type: "text", text: `${manifest.root}\n${lines.join("\n")}` }], details: { name: "checks", action, total: manifest.checks.length } };
      }

      const progress = (prefix: string, total: number) => {
        const running = new Set<string>();
        let done = 0;
        let red = 0;
        const emit = (phase?: string) => onUpdate?.({ content: [{ type: "text", text:
          `${prefix}${done}/${total} · ✗${red} · ${phase ?? `running: ${[...running].join(", ") || "—"}`}` }] });
        return {
          onStart: (check: { name: string }) => { running.add(check.name); emit(); },
          onResult: (result: CheckResult) => { running.delete(result.name); done++; if (!result.ok) red++; emit(); },
          onPhase: (phase: string) => emit(phase),
        };
      };
      const baseProgress = () => progress(`baseline ${baseSha(manifest.root)?.slice(0, 8) ?? "?"}: `,
        selectChecks(manifest, { tags, names }).length);
      if (action === "baseline") {
        const base = await baseline(manifest, { tags, names, signal, ...baseProgress() });
        return {
          content: [{ type: "text", text: `${defaulted}baseline ${base.sha.slice(0, 8)}${base.cached ? " (cache)" : ""}\n${formatResults(base.results)}` }],
          details: { name: "checks", action, sha: base.sha, results: base.results, ok: base.results.every((r) => r.ok) },
        };
      }

      const selection = { tags, names };
      const before = treeState(manifest.root);
      const currentProgress = progress("", selectChecks(manifest, { tags, names }).length);
      if (action === "run") {
        const results = await runChecks(manifest, { cwd, tags, names, signal, ...currentProgress });
        const ok = results.every((result) => result.ok);
        writeLastRun(manifest.root, { action: "run", selection, before, ok, verdict: `${ok ? "OK" : "BLOQUEIA"}: ${summary(results)}`, results });
        return {
          content: [{ type: "text", text: `${defaulted}${summary(results)}\n${formatResults(results)}` }],
          details: { name: "checks", action, results, ok },
        };
      }
      const failed: CheckResult[] = [];
      let baselineProgress: ReturnType<typeof progress> | undefined;
      const getBaselineProgress = () => baselineProgress ??= progress(
        `baseline ${baseSha(manifest.root)?.slice(0, 8) ?? "?"}: `, failed.length);
      const verdict = await gate(manifest, {
        cwd, tags, names, signal,
        onStart: currentProgress.onStart,
        onResult: (result) => { if (!result.ok) failed.push(result); currentProgress.onResult(result); },
        baselineOptions: {
          onStart: (check) => getBaselineProgress().onStart(check),
          onResult: (result) => getBaselineProgress().onResult(result),
          onPhase: (phase) => getBaselineProgress().onPhase(phase),
        },
      });
      writeLastRun(manifest.root, { action: "gate", selection, before, ...verdict });
      return {
        content: [{ type: "text", text: `${defaulted}${verdict.verdict}\n${summary(verdict.results)}\n${formatResults(verdict.results, verdict.comparison)}` }],
        details: { name: "checks", action, ...verdict },
      };
    },
    renderCall(args, theme) {
      const action = args.action ?? "gate";
      const filter = args.only ? ` ${args.only}` : args.tags ? ` [${args.tags}]` : "";
      return new Text(theme.fg("toolTitle", theme.bold(`checks ${action}`)) + theme.fg("dim", filter), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return new Text(renderChecksResult(result, expanded, isPartial, theme), 0, 0);
    },
  });

  pi.registerCommand("checks", {
    description: "Portão de verificação do projeto: /checks [gate|run|list|last] [tags]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const [verb = "gate", tags] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "last") {
        try { pi.sendMessage({ customType: "checks", content: lastRunText(ctx.cwd).text, display: true }); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        return;
      }
      const manifest = findManifest(ctx.cwd);
      if (!manifest) { ctx.ui.notify(`nenhum .pi/checks.json a partir de ${ctx.cwd}`, "error"); return; }
      if (verb === "list") {
        pi.sendMessage({ customType: "checks", content: manifest.checks.map((c) => `${c.name}  ${c.cmd}`).join("\n"), display: true });
        return;
      }
      if (readonly) { ctx.ui.notify(readonlyRefusal(verb), "error"); return; }
      ctx.ui.notify(`checks: rodando ${manifest.checks.length} check(s)…`, "info");
      const selection = { tags: split(tags) };
      const before = treeState(manifest.root);
      let text: string;
      if (verb === "gate") {
        const verdict = await gate(manifest, { cwd: ctx.cwd, tags: split(tags) });
        writeLastRun(manifest.root, { action: "gate", selection, before, ...verdict });
        text = `${verdict.verdict}\n${summary(verdict.results)}\n${formatResults(verdict.results, verdict.comparison)}`;
      } else {
        const results = await runChecks(manifest, { cwd: ctx.cwd, tags: split(tags) });
        const ok = results.every((r) => r.ok);
        text = `${ok ? "OK" : "BLOQUEIA"}: ${summary(results)}\n${formatResults(results)}`;
        writeLastRun(manifest.root, { action: "run", selection, before, ok, verdict: text.split("\n")[0], results });
      }
      pi.sendMessage({ customType: "checks", content: text, display: true });
    },
  });
}
