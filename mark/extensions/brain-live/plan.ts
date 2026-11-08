/**
 * Garime Plan — checklist expansível junto ao editor.
 *
 * O agente substitui o plano inteiro pelo tool `plan`. O estado do plano
 * persiste na sessão; a expansão é apenas visual e reinicia em cada sessão.
 *
 * Posição: na montagem MARK II o widget vai para BAIXO do input
 * (placement público `belowEditor`). Por isso a
 * navegação é vertical coerente com isso: ↓ no input vazio desce para o plano,
 * ↑ (ou esc) no plano volta para o input.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { createTaskTool, TodoParams } from "./todos.ts";

const ENTRY_TYPE = "garime-plan";
const WIDGET_ID = "garime-plan";
const MAX_STEPS = 20;
const MAX_STEP_LENGTH = 120;
export const PLAN_FOCUS_EVENT = "garime:plan:focus";

export interface PlanFocusRequest {
	tui: TUI;
	editor: Component;
	handled: boolean;
}

export type Status = "pending" | "in_progress" | "done" | "skipped";
export interface Step {
	text: string;
	status: Status;
}

const StepSchema = Type.Object({
	text: Type.String({ description: "Short step description (one line)" }),
	status: StringEnum(["pending", "in_progress", "done", "skipped"] as const),
});

const PlanParams = Type.Object({
	...TodoParams.properties,
	action: Type.Optional(StringEnum([
		"steps", "list", "list-all", "get", "create", "update", "append", "delete", "claim", "release",
	] as const, { description: "Defaults to steps when steps is supplied, otherwise list." })),
	steps: Type.Optional(Type.Array(StepSchema, {
		description: `Session checklist, only with action steps. Full replacement (max ${MAX_STEPS}); [] clears it without deleting project tasks. At most one step in_progress.`,
		maxItems: MAX_STEPS,
	})),
});

let steps: Step[] = [];
let expanded = false;

const ICON: Record<Status, string> = {
	pending: "◻",
	in_progress: "◉",
	done: "✓",
	skipped: "–",
};

interface WidgetTheme {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

function cleanSteps(value: unknown): Step[] {
	if (!Array.isArray(value)) return [];
	const valid = new Set<Status>(["pending", "in_progress", "done", "skipped"]);
	return value
		.filter((step): step is Step => {
			if (!step || typeof step !== "object") return false;
			const candidate = step as Partial<Step>;
			return typeof candidate.text === "string" && valid.has(candidate.status as Status);
		})
		.slice(0, MAX_STEPS)
		.map((step) => ({
			text: step.text.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_LENGTH),
			status: step.status,
		}))
		.filter((step) => step.text.length > 0);
}

function planSummary(items: Step[]): string {
	const done = items.filter((step) => step.status === "done" || step.status === "skipped").length;
	return `${done}/${items.length}`;
}

function currentStep(items: Step[]): Step | undefined {
	return items.find((step) => step.status === "in_progress") ?? items.find((step) => step.status === "pending");
}

/** Linhas puras do widget, exportadas para verificar largura e expansão. */
export function renderPlanLines(items: Step[], isExpanded: boolean, width: number, theme: WidgetTheme, focused = false): string[] {
	if (width <= 0 || items.length === 0) return [];
	const disclosure = isExpanded ? "▾" : "▸";
	const hint = focused ? "Enter abre/fecha · ←/→ fecha/abre · ↑/esc volta" : "↓ seleciona · clique abre/fecha";
	let header = `${focused ? theme.fg("accent", "› ") : ""}${disclosure} ${theme.fg("muted", `plano ${planSummary(items)}`)}`;

	if (!isExpanded) {
		const current = currentStep(items);
		if (current) {
			const color = current.status === "in_progress" ? "accent" : "muted";
			const text = current.status === "in_progress" ? theme.bold(current.text) : current.text;
			header += ` · ${theme.fg(color, ICON[current.status])} ${text}`;
		} else {
			header += ` · ${theme.fg("success", "✓ concluído")}`;
		}
	}
	header += ` ${theme.fg("dim", `· ${hint}`)}`;
	const lines = [truncateToWidth(header, width, "…")];
	if (!isExpanded) return lines;

	for (const step of items) {
		const color = step.status === "in_progress" ? "accent" : step.status === "done" ? "success" : "muted";
		const text = step.status === "in_progress" ? theme.bold(step.text) : step.text;
		lines.push(...wrapTextWithAnsi(`  ${theme.fg(color, ICON[step.status])} ${text}`, width));
	}
	return lines;
}

/**
 * handleMouse recebe coordenadas locais e bounds reais do renderer. Só a célula
 * do disclosure é clicável; não há interceptação global nem pedido de foco.
 */
export class PlanWidget implements Component {
	focused = false;
	private returnToEditor?: (data?: string) => void;

	constructor(
		private readonly getSteps: () => Step[],
		private readonly getExpanded: () => boolean,
		private readonly setExpanded: (value: boolean) => void,
		private readonly theme: WidgetTheme,
		private readonly requestRender: () => void = () => {},
	) {}

	setEditorReturn(callback: (data?: string) => void): void {
		this.returnToEditor = callback;
	}

	releaseFocus(): void {
		if (this.focused) this.returnToEditor?.();
	}

	render(width: number): string[] {
		return renderPlanLines(this.getSteps(), this.getExpanded(), width, this.theme, this.focused);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.setExpanded(!this.getExpanded());
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (!this.getExpanded()) this.setExpanded(true);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.getExpanded()) this.setExpanded(false);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.escape)) {
			this.returnToEditor?.();
			return;
		}
		// ↓ não tem para onde ir (o plano é o último bloco antes do rodapé): fica.
		if (matchesKey(data, Key.down)) return;
		// Texto e demais teclas voltam ao editor e são encaminhados para ele,
		// pois o plano não é um modo de edição.
		this.returnToEditor?.(data);
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left" || event.x !== (this.focused ? 2 : 0) || event.y !== 0) return undefined;
		this.setExpanded(!this.getExpanded());
		return { handled: true, render: true } as const;
	}

	invalidate(): void {}
}

let activeWidget: PlanWidget | undefined;

function render(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	activeWidget?.releaseFocus();
	if (steps.length === 0) {
		activeWidget = undefined;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(
		WIDGET_ID,
		(tui, theme) => {
			activeWidget = new PlanWidget(() => steps, () => expanded, (value) => { expanded = value; }, theme, () => tui.requestRender());
			return activeWidget;
		},
		{ placement: "belowEditor" },
	);
}

function restore(ctx: ExtensionContext): void {
	let latest: unknown;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) latest = (entry as { data?: { steps?: unknown } }).data?.steps;
	}
	steps = cleanSteps(latest);
}

export default function (pi: ExtensionAPI) {
	const tasks = createTaskTool();
	pi.events.on(PLAN_FOCUS_EVENT, (request: PlanFocusRequest) => {
		if (!activeWidget || steps.length === 0) return;
		activeWidget.setEditorReturn((data) => {
			request.tui.setFocus(request.editor);
			request.tui.requestRender();
			if (data) request.editor.handleInput?.(data);
		});
		request.tui.setFocus(activeWidget);
		request.tui.requestRender();
		request.handled = true;
	});

	pi.on("session_start", async (_event, ctx) => {
		expanded = false;
		restore(ctx);
		render(ctx);
	});

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Manage persistent project tasks and the visible session checklist. " +
			"Use steps (or action steps) to replace the checklist; [] clears only the widget. " +
			"Task actions: list (default), list-all, get, create, update, append, delete, claim, release. " +
			"Tasks remain in .pi/todos (or PI_TODO_PATH); existing TODO-<hex> ids still work. " +
			"Title is a summary; body is markdown (update replaces, append adds). " +
			"Claim before working; update status to closed when complete. Not for personal Vault tasks.",
		promptSnippet: "Manage persistent project tasks and their visible step checklists",
		parameters: PlanParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = params.action ?? (params.steps !== undefined ? "steps" : "list");
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			if (action !== "steps") {
				if (params.steps !== undefined) return fail("Use a separate action steps call to update the checklist.");
				return tasks.execute(_id, { ...params, action }, _signal, _onUpdate, ctx);
			}
			if (!params.steps) return fail("steps is required for action steps; use [] to clear.");
			if ([params.id, params.title, params.status, params.tags, params.body, params.force].some(value => value !== undefined)) {
				return fail("Task fields require a task action, not action steps.");
			}
			if (params.steps.filter(step => step.status === "in_progress").length > 1) return fail("Keep at most one step in_progress.");
			steps = cleanSteps(params.steps);
			pi.appendEntry(ENTRY_TYPE, { steps });
			render(ctx);
			const text = steps.length === 0 ? "plan cleared" : `plan ${planSummary(steps)}\n${steps.map((step) => `${ICON[step.status]} ${step.text}`).join("\n")}`;
			return { content: [{ type: "text", text }], details: { steps } };
		},
		renderCall(args, theme) {
			const action = args.action ?? (args.steps !== undefined ? "steps" : "list");
			if (action !== "steps") {
				return new Text(theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("accent", action) + (args.id ? ` ${args.id}` : ""), 0, 0);
			}
			const n = args.steps?.length ?? 0;
			const current = args.steps?.find((step: Step) => step.status === "in_progress")?.text;
			const head = theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("accent", n === 0 ? "clear" : `${n} passos`);
			return new Text(current ? `${head}${theme.fg("dim", ` → ${current}`)}` : head, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { steps?: Step[] } | undefined;
			if (result.isError || !details || !("steps" in details)) {
				const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
				return new Text(theme.fg(result.isError ? "error" : "dim", text), 0, 0);
			}
			if (!details?.steps?.length) return new Text(theme.fg("muted", "plano limpo"), 0, 0);
			return new Text(theme.fg("dim", `${planSummary(details.steps)} concluídos`), 0, 0);
		},
	});
}
