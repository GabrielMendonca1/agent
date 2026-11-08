import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { baseline, baseSha, gate, resultOk, selectChecks, type CheckResult, findManifest, formatResults, runChecks } from "./runner.ts";

/**
 * O portão de verificação como ferramenta de primeira classe.
 *
 * Worktree isola escrita; ele não protege comportamento. O que faltava era um
 * veredito rápido e atribuível sobre o que a mudança QUEBROU — disponível para
 * o agente durante o trabalho, para o hook do omni no fim de cada step e para o
 * portão de merge. Os três chamam a mesma coisa: `gate`.
 */

const ActionSchema = StringEnum(["gate", "run", "baseline", "list"] as const);
const ChecksParams = Type.Object({
  action: Type.Optional(ActionSchema),
  tags: Type.Optional(Type.String({ description: 'Filtra por tag do manifesto, separadas por vírgula (ex.: "fast").' })),
  only: Type.Optional(Type.String({ description: "Nomes específicos de check, separados por vírgula." })),
  cwd: Type.Optional(Type.String({ description: "Diretório do projeto ou do worktree a verificar. Default: cwd da sessão." })),
});

function split(value?: string): string[] | undefined {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function summary(results: CheckResult[]): string {
  const red = results.filter((result) => !result.ok).length;
  return `${results.length - red}/${results.length} verdes`;
}

export function renderChecksResult(result: any, expanded: boolean, isPartial: boolean, theme: any): string {
  const raw = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  if (expanded) return theme.fg("toolOutput", raw);
  if (isPartial) return theme.fg("muted", raw.split("\n")[0] || "rodando…");

  const details = result.details ?? {};
  if (details.action === "list") return theme.fg("success", `✓ ${details.total ?? 0} checks declarados`);
  const results = Array.isArray(details.results) ? details.results as CheckResult[] : [];
  const status = !resultOk(details) ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const verdict = raw.split("\n")[0] || (results.length ? summary(results) : "concluído");
  return `${status} ${theme.fg("toolOutput", verdict)}`;
}

export default function checksExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "checks",
    label: "Checks",
    description: [
      "Portão de verificação do projeto, declarado em .pi/checks.json.",
      "",
      'gate (default): roda os checks e compara com a baseline do commit base — devolve só o que ESTA mudança quebrou. É o veredito que vale antes de integrar.',
      "run: roda sem comparar. baseline: mostra/calcula o estado do commit base. list: lista os checks declarados.",
      "",
      "Use gate depois de mexer em código, e antes de dizer que terminou. Falha herdada não é sua; regressão nova é.",
    ].join("\n"),
    promptSnippet: "Verificar se a mudança quebrou algo que funcionava (.pi/checks.json)",
    promptGuidelines: [
      "Rode checks gate antes de declarar uma tarefa de código concluída, e passe cwd quando estiver trabalhando num worktree.",
      "Trate newFailures como bloqueio real: conserte ou explique. stillFailing é vermelho herdado — não invente que você causou.",
    ],
    parameters: ChecksParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const manifest = findManifest(cwd);
      if (!manifest) throw new Error(`nenhum .pi/checks.json a partir de ${cwd} — declare o contrato do projeto antes de exigir o portão`);
      const tags = split(params.tags);
      const names = split(params.only);
      const action = params.action ?? "gate";

      if (action === "list") {
        const lines = manifest.checks.map((check) => `${check.name}  [${(check.tags ?? []).join(",") || "sem tag"}]  ${check.cmd}`);
        return { content: [{ type: "text", text: `${manifest.root}\n${lines.join("\n")}` }], details: { name: "checks", action, total: manifest.checks.length } };
      }

      const progress = (prefix: string, total: number) => {
        const running = new Set<string>();
        let done = 0;
        let red = 0;
        const emit = (phase?: string) => onUpdate?.({ content: [{ type: "text", text:
          `${prefix}${done}/${total} · ✗${red} · ${phase ?? `rodando: ${[...running].join(", ") || "—"}`}` }] });
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
          content: [{ type: "text", text: `baseline ${base.sha.slice(0, 8)}${base.cached ? " (cache)" : ""}\n${formatResults(base.results)}` }],
          details: { name: "checks", action, sha: base.sha, results: base.results, ok: base.results.every((r) => r.ok) },
        };
      }

      const currentProgress = progress("", selectChecks(manifest, { tags, names }).length);
      if (action === "run") {
        const results = await runChecks(manifest, { cwd, tags, names, signal, ...currentProgress });
        return {
          content: [{ type: "text", text: `${summary(results)}\n${formatResults(results)}` }],
          details: { name: "checks", action, results, ok: results.every((result) => result.ok) },
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
      return {
        content: [{ type: "text", text: `${verdict.verdict}\n${summary(verdict.results)}\n${formatResults(verdict.results, verdict.comparison)}` }],
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
    description: "Portão de verificação do projeto: /checks [gate|run|list] [tags]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const [verb = "gate", tags] = args.trim().split(/\s+/);
      const manifest = findManifest(ctx.cwd);
      if (!manifest) { ctx.ui.notify(`nenhum .pi/checks.json a partir de ${ctx.cwd}`, "error"); return; }
      if (verb === "list") {
        pi.sendMessage({ customType: "checks", content: manifest.checks.map((c) => `${c.name}  ${c.cmd}`).join("\n"), display: true });
        return;
      }
      ctx.ui.notify(`checks: rodando ${manifest.checks.length} check(s)…`, "info");
      let text: string;
      if (verb === "gate") {
        const verdict = await gate(manifest, { cwd: ctx.cwd, tags: split(tags) });
        text = `${verdict.verdict}\n${summary(verdict.results)}\n${formatResults(verdict.results, verdict.comparison)}`;
      } else {
        const results = await runChecks(manifest, { cwd: ctx.cwd, tags: split(tags) });
        text = `${results.every((r) => r.ok) ? "OK" : "BLOQUEIA"}: ${summary(results)}\n${formatResults(results)}`;
      }
      pi.sendMessage({ customType: "checks", content: text, display: true });
    },
  });
}
