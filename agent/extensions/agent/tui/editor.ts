import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, Key, type Component, type TUI } from "@earendil-works/pi-tui";

import { loadAllSkillCategories } from "../../../juice/skill-categories.mjs";
import { isAutomaticSkill } from "../../../juice/skill-policy.mjs";

import { paint, paletteFor, type ThemeLike } from "./claude-style";
import {
	buildCatalog,
	commandFor,
	movePicker,
	nextCategoryView,
	openPicker,
	pickerQuery,
	renderPicker,
	visibleEntries,
	withQuery,
	type IsAutomaticSkill,
	type PickerState,
	type SkillCatalog,
	type SkillCommandInfo,
	type CategoryLike,
} from "./skill-picker";
import { configuredTuiHz, installAdaptiveRenderRate, ScrollFollowMonitor } from "./tui-responsiveness";

const PLAN_FOCUS_EVENT = "garime:plan:focus";

interface PlanFocusRequest {
	tui: TUI;
	editor: Component;
	handled: boolean;
}

/** Janela do ESC duplo (mesma do /tree nativo com input vazio). */
const DOUBLE_ESC_MS = 500;

/** De onde o seletor tira comandos, categorias e curadoria. */
export interface SkillPickerSources {
	/** Comandos REAIS da sessão (`pi.getCommands()`). */
	commands: () => readonly SkillCommandInfo[];
	/** Categorias das pastas (`loadSkillCategories()`); chamado só ao ABRIR o seletor. */
	categories: () => readonly CategoryLike[];
	/** Curadoria (agent/juice/skill-policy.mjs); ausente = ninguém é automática. */
	isAutomaticSkill?: IsAutomaticSkill;
}

export class AgentEditor extends CustomEditor {
	private readonly agentKeys: { matches(data: string, action: string): boolean };
	private readonly focusPlan: (request: PlanFocusRequest) => void;
	/** Tema ATIVO do Pi (o `theme` do editor é um `EditorTheme`, sem `appearance`). */
	private readonly appTheme: () => ThemeLike | undefined;
	private lastEscAt = 0;
	private readonly skillSources: SkillPickerSources | undefined;
	private picker: PickerState | undefined;
	private catalog: SkillCatalog | undefined;
	/** Esc fecha o seletor até o texto deixar de ser `/skill` ou `/skill:<filtro>`. */
	private pickerDismissed = false;

	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		focusPlan: (request: PlanFocusRequest) => void = () => {},
		appTheme: () => ThemeLike | undefined = () => undefined,
		skillSources?: SkillPickerSources,
	) {
		super(tui, theme, keybindings);
		this.agentKeys = keybindings;
		this.focusPlan = focusPlan;
		this.appTheme = appTheme;
		this.skillSources = skillSources;
	}

	/** Estado atual do seletor (undefined = fechado). Para testes e para o render. */
	skillPickerState(): PickerState | undefined {
		return this.picker;
	}

	private matches(data: string, action: string): boolean {
		try {
			return this.agentKeys.matches(data, action) === true;
		} catch {
			return false;
		}
	}

	/** O dropdown nativo não divide a tela com o seletor. */
	private dropNativeAutocomplete(): void {
		try {
			(this as unknown as { cancelAutocomplete?: () => void }).cancelAutocomplete?.();
		} catch {
			// best-effort
		}
	}

	/** Catálogo montado UMA vez por abertura (loadSkillCategories só aqui, nunca por tecla/render). */
	private ensureCatalog(): SkillCatalog | undefined {
		if (this.catalog) return this.catalog;
		const sources = this.skillSources;
		if (!sources) return undefined;
		try {
			this.catalog = buildCatalog({
				commands: sources.commands() ?? [],
				categories: sources.categories() ?? [],
				isAutomaticSkill: sources.isAutomaticSkill,
			});
		} catch {
			this.catalog = undefined;
		}
		return this.catalog;
	}

	private closePicker(): void {
		this.picker = undefined;
		this.catalog = undefined;
	}

	/**
	 * Seletor de skills: abre sozinho em `/skill` ou `/skill:<filtro>`
	 * (inclusive vindo do Tab do autocomplete nativo em `/sk`), trata ↑↓/Tab/Enter/Esc
	 * e deixa o resto (digitar, apagar, colar) com o editor nativo.
	 *
	 * Retorna `true` quando a tecla foi consumida pelo seletor.
	 */
	private handleSkillPicker(data: string): boolean {
		const query = pickerQuery(this.getText());
		if (query === undefined) {
			this.pickerDismissed = false;
			if (this.picker) this.closePicker();
			return false;
		}
		if (this.pickerDismissed) return false;
		const catalog = this.ensureCatalog();
		if (!catalog) return false;
		if (!this.picker) this.picker = openPicker(catalog, undefined, query);
		else this.picker = withQuery(this.picker, query);
		this.dropNativeAutocomplete();

		const isAuto = this.skillSources?.isAutomaticSkill;
		const entries = visibleEntries(catalog, this.picker, isAuto);
		const isEsc = matchesKey(data, Key.escape) || this.matches(data, "app.interrupt");
		const isTab = matchesKey(data, Key.tab);
		const isEnter = matchesKey(data, Key.enter);
		const isUp = matchesKey(data, Key.up) || this.matches(data, "tui.editor.cursorUp");
		const isDown = matchesKey(data, Key.down) || this.matches(data, "tui.editor.cursorDown");

		if (isEsc) {
			this.pickerDismissed = true;
			this.closePicker();
			this.invalidate();
			return true;
		}
		if (isTab) {
			this.picker = nextCategoryView(catalog, this.picker);
			this.invalidate();
			return true;
		}
		if (isUp || isDown) {
			this.picker = movePicker(this.picker, isDown ? 1 : -1, entries.length);
			this.invalidate();
			return true;
		}
		if (isEnter) {
			const chosen = entries[Math.max(0, Math.min(this.picker.index, entries.length - 1))];
			if (!chosen) return true;
			// INSERE o comando com espaço e NÃO envia: o texto deixa de casar com
			// `/skill:<filtro>`, então o seletor fecha sozinho na próxima tecla.
			this.setText(commandFor(chosen));
			this.closePicker();
			this.pickerDismissed = false;
			this.dropNativeAutocomplete();
			this.invalidate();
			return true;
		}
		return false;
	}

	/** Linhas do seletor, abaixo da caixa do input. */
	private skillPickerLines(width: number): string[] {
		const state = this.picker;
		const catalog = this.catalog;
		if (!state || !catalog) return [];
		let theme: ThemeLike | undefined;
		try {
			theme = this.appTheme();
		} catch {
			theme = undefined;
		}
		const p = paletteFor(theme);
		return renderPicker(
			catalog,
			state,
			width,
			{
				muted: (text) => paint(text, { fg: p.muted }),
				selected: (text) => paint(text, { fg: p.success, bold: true }),
				automatic: (text) => paint(text, { fg: p.success }),
			},
			this.skillSources?.isAutomaticSkill,
		);
	}

	/**
	 * ESC duplo com texto no input limpa o input (estilo Claude Code).
	 * O Pi nativo só trata ESC duplo com input vazio (/tree); com texto,
	 * ESC não faz nada fora de streaming. O primeiro ESC segue o fluxo
	 * normal (aborta streaming/bash se houver); o segundo, dentro da janela, limpa.
	 */
	handleInput(data: string): void {
		try {
			if (!this.picker && !isKeyRelease(data) && matchesKey(data, Key.tab) && /^\/sk(?:ill)?$/.test(this.getText())) {
				this.setText("/skill:");
				this.pickerDismissed = false;
				this.handleSkillPicker("");
				this.invalidate();
				return;
			}
			if (!isKeyRelease(data) && this.handleSkillPicker(data)) return;
		} catch {
			// best-effort: um seletor quebrado nunca trava o input
		}
		try {
			if (!isKeyRelease(data) && this.agentKeys.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) {
				const now = Date.now();
				const hasText = this.getText().length > 0;
				if (hasText && now - this.lastEscAt < DOUBLE_ESC_MS) {
					this.lastEscAt = 0;
					this.setText("");
					return;
				}
				this.lastEscAt = hasText ? now : 0;
			}
		} catch {
			// best-effort: nunca bloquear o input
		}

		// O plano fica ABAIXO do input (placement público em plan.ts), então é o ↓ que desce
		// para ele; o ↑ continua inteiro para o histórico de prompts do Pi.
		const mayFocusPlan = !isKeyRelease(data)
			&& this.agentKeys.matches(data, "tui.editor.cursorDown")
			&& !this.isShowingAutocomplete();
		// Só com o input vazio: com texto (inclusive histórico já trazido ou prompt
		// multilinha) o ↓ é todo do editor. Sem plano visível, `handled` fica false e
		// a tecla segue para o editor como sempre.
		if (mayFocusPlan && this.getText().length === 0) {
			const request: PlanFocusRequest = { tui: this.tui, editor: this, handled: false };
			this.focusPlan(request);
			if (request.handled) return;
		}
		super.handleInput(data);
		// A digitação/paste acabou de mudar o texto. Abrir/filtrar já neste quadro,
		// não só na próxima tecla (que poderia ser Enter e enviar sem seleção).
		try { this.handleSkillPicker(""); } catch { /* editor nativo segue funcional */ }
	}

	/** Réguas não recebem cliques; texto/autocomplete mantêm coordenadas nativas. */
	handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]) {
		const height = (this as unknown as { renderedVisibleLineCount: number }).renderedVisibleLineCount;
		if (event.y <= 0 || event.y === height + 1) return undefined;
		return super.handleMouse(event);
	}

	beforeRender?: () => void;
	onDispose?: () => void;
	dispose(): void {
		const dispose = this.onDispose; this.onDispose = undefined; dispose?.();
	}

	/** Desenho nativo sem margem extra acima do editor. */
	render(width: number): string[] {
		this.beforeRender?.();
		const lines = super.render(width);
		try { return [...lines, ...this.skillPickerLines(width)]; }
		catch { return lines; }
	}

}

export default function agentEditor(pi: ExtensionAPI) {
	const live = new Map<AgentEditor, ScrollFollowMonitor>();
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new AgentEditor(
			tui,
			theme,
			keybindings,
			(request) => pi.events.emit(PLAN_FOCUS_EVENT, request),
			// Lido a cada render: `ctx.ui.theme` é vivo, então troca de tema (inclusive
			// o lado claro/escuro do par) chega ao seletor sem reinstalar o editor.
			() => ctx.ui.theme as unknown as ThemeLike,
			skillSources(ctx.cwd, pi),
			);
			const hz = configuredTuiHz(process.env.GARIME_TUI_HZ);
			if (hz === undefined) ctx.ui.notify("GARIME_TUI_HZ aceita somente 60 ou 120; mantendo 60 Hz", "warning");
			const rate = installAdaptiveRenderRate(tui, hz ?? 60);
			if (hz === 120 && !rate.active) ctx.ui.notify("120 Hz indisponível nesta versão do Pi; mantendo o scheduler padrão", "warning");
			const monitor = new ScrollFollowMonitor();
			live.set(editor, monitor);
			let lastScroll: string | undefined;
			editor.beforeRender = () => {
				const scroll = monitor.observe(tui);
				const label = scroll && !scroll.following
					? scroll.newOutput ? "↓ nova saída · End" : `↓${scroll.linesBelow > 0 ? ` ${scroll.linesBelow} abaixo` : ""} · End`
					: undefined;
				if (label !== lastScroll) { lastScroll = label; ctx.ui.setStatus("agent-scroll", label); }
			};
			editor.onDispose = () => {
				rate.dispose(); monitor.dispose(); live.delete(editor);
				editor.beforeRender = undefined;
				ctx.ui.setStatus("agent-scroll", undefined);
			};
			return editor;
		});
	});
	const noteOutput = () => { for (const monitor of live.values()) monitor.noteOutput(); };
	pi.on("message_update", noteOutput);
	pi.on("tool_execution_update", noteOutput);
	pi.on("session_shutdown", () => { for (const editor of live.keys()) editor.dispose(); });
}

/** Comandos reais e categorias do artefato, lidos só ao abrir o seletor. */
function skillSources(_cwd: string, pi: ExtensionAPI): SkillPickerSources {
	return {
		commands: () => {
			try { return (pi.getCommands?.() ?? []) as SkillCommandInfo[]; }
			catch { return []; }
		},
		categories: () => loadAllSkillCategories(),
		isAutomaticSkill,
	};
}
