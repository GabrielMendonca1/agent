const STOCK_RENDER_INTERVAL_MS = 16;
const INTERACTIVE_RENDER_INTERVAL_MS = 1000 / 120;
const INTERACTION_HOLD_MS = 160;
const INSTALL_KEY = Symbol.for("garime.tui.adaptive-render-rate");
const SCROLL_PATCH_KEY = Symbol.for("garime.tui.stable-follow-end");

type RenderScheduler = {
	MIN_RENDER_INTERVAL_MS: number;
};

type ViewportInput = (data: string) => unknown;

type AdaptiveTui = {
	handleViewportInput?: ViewportInput;
	[INSTALL_KEY]?: AdaptiveController;
};

type RuntimeScrollView = {
	contentHeight?: number;
	followingEnd?: boolean;
	isFollowingEnd: boolean;
	[SCROLL_PATCH_KEY]?: boolean;
	scrollTop: number;
	updateLayout: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
	viewportHeight: number;
};

type ScrollTui = {
	currentLayout?: { primaryScrollView?: unknown };
	getPrimaryScrollView?: () => unknown;
};

export type AdaptiveRenderRateResult = {
	active: boolean;
	dispose: () => void;
	reason?: "disabled" | "invalid" | "unsupported";
};

export type ScrollNotice = {
	following: boolean;
	linesBelow: number;
	newOutput: boolean;
};

export function configuredTuiHz(value: string | undefined): 60 | 120 | undefined {
	if (value === undefined || value.trim() === "") return 60;
	const parsed = Number(value);
	return parsed === 60 || parsed === 120 ? parsed : undefined;
}

function schedulerFor(tui: AdaptiveTui): RenderScheduler | undefined {
	let constructor = Object.getPrototypeOf(tui)?.constructor;
	while (typeof constructor === "function") {
		const candidate = constructor as unknown as Record<string, unknown>;
		if (
			Object.prototype.hasOwnProperty.call(candidate, "MIN_RENDER_INTERVAL_MS") &&
			typeof candidate.MIN_RENDER_INTERVAL_MS === "number"
		) {
			return candidate as RenderScheduler;
		}
		constructor = Object.getPrototypeOf(constructor) as object | undefined;
	}
	return undefined;
}

class AdaptiveController {
	private references = 0;
	private restoreTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly wrappedInput: ViewportInput;

	constructor(
		private readonly tui: AdaptiveTui,
		private readonly scheduler: RenderScheduler,
		private readonly originalInput: ViewportInput,
		private readonly holdMs: number,
	) {
		this.wrappedInput = (data) => {
			const result = this.originalInput.call(this.tui, data);
			if (typeof result === "object" && result !== null && (result as { consume?: unknown }).consume === true) {
				this.boost();
			}
			return result;
		};
		this.tui.handleViewportInput = this.wrappedInput;
	}

	acquire(): AdaptiveRenderRateResult {
		this.references += 1;
		let released = false;
		return {
			active: true,
			dispose: () => {
				if (released) return;
				released = true;
				this.references -= 1;
				if (this.references === 0) this.dispose();
			},
		};
	}

	private boost(): void {
		if (this.references === 0) return;
		this.scheduler.MIN_RENDER_INTERVAL_MS = INTERACTIVE_RENDER_INTERVAL_MS;
		if (this.restoreTimer) clearTimeout(this.restoreTimer);
		this.restoreTimer = setTimeout(() => {
			this.restoreTimer = undefined;
			if (this.references > 0 && this.scheduler.MIN_RENDER_INTERVAL_MS === INTERACTIVE_RENDER_INTERVAL_MS) {
				this.scheduler.MIN_RENDER_INTERVAL_MS = STOCK_RENDER_INTERVAL_MS;
			}
		}, this.holdMs);
		this.restoreTimer.unref?.();
	}

	private dispose(): void {
		if (this.restoreTimer) clearTimeout(this.restoreTimer);
		this.restoreTimer = undefined;
		if (this.scheduler.MIN_RENDER_INTERVAL_MS === INTERACTIVE_RENDER_INTERVAL_MS) {
			this.scheduler.MIN_RENDER_INTERVAL_MS = STOCK_RENDER_INTERVAL_MS;
		}
		// O wrapper fica ligado à instância até ela morrer. Em /reload, a próxima
		// factory readquire o mesmo controller em vez de empilhar wrappers fechados.
	}
}

export function installAdaptiveRenderRate(
	tuiValue: unknown,
	configuredHz: 60 | 120 | undefined,
	holdMs = INTERACTION_HOLD_MS,
): AdaptiveRenderRateResult {
	if (configuredHz === 60) return { active: false, reason: "disabled", dispose() {} };
	if (configuredHz !== 120) return { active: false, reason: "invalid", dispose() {} };
	if (typeof tuiValue !== "object" || tuiValue === null) {
		return { active: false, reason: "unsupported", dispose() {} };
	}

	const tui = tuiValue as AdaptiveTui;
	const existing = tui[INSTALL_KEY];
	if (existing) return existing.acquire();

	const scheduler = schedulerFor(tui);
	if (
		!scheduler ||
		scheduler.MIN_RENDER_INTERVAL_MS !== STOCK_RENDER_INTERVAL_MS ||
		typeof tui.handleViewportInput !== "function"
	) {
		return { active: false, reason: "unsupported", dispose() {} };
	}

	const controller = new AdaptiveController(tui, scheduler, tui.handleViewportInput, Math.max(1, holdMs));
	tui[INSTALL_KEY] = controller;
	return controller.acquire();
}

function primaryScrollView(tuiValue: unknown): RuntimeScrollView | undefined {
	if (typeof tuiValue !== "object" || tuiValue === null) return undefined;
	const tui = tuiValue as ScrollTui;
	let value = tui.currentLayout?.primaryScrollView;
	if (value === undefined && typeof tui.getPrimaryScrollView === "function") {
		value = tui.getPrimaryScrollView.call(tui);
	}
	if (typeof value !== "object" || value === null) return undefined;
	const scroll = value as Partial<RuntimeScrollView>;
	if (
		typeof scroll.isFollowingEnd !== "boolean" ||
		typeof scroll.scrollTop !== "number" ||
		typeof scroll.viewportHeight !== "number" ||
		typeof scroll.updateLayout !== "function"
	) {
		return undefined;
	}
	return scroll as RuntimeScrollView;
}

export class ScrollFollowMonitor {
	private outputVersion = 0;
	private pausedAtOutputVersion = 0;
	private wasFollowing = true;
	private currentScroll: RuntimeScrollView | undefined;

	noteOutput(): void {
		if (this.currentScroll && !this.currentScroll.isFollowingEnd && this.wasFollowing) {
			this.wasFollowing = false;
			this.pausedAtOutputVersion = this.outputVersion;
		}
		this.outputVersion += 1;
	}

	observe(tui: unknown): ScrollNotice | undefined {
		const scroll = primaryScrollView(tui);
		if (!scroll) return undefined;
		this.currentScroll = scroll;
		this.patch(scroll);

		const following = scroll.isFollowingEnd;
		if (following) {
			this.wasFollowing = true;
			this.pausedAtOutputVersion = this.outputVersion;
		} else if (this.wasFollowing) {
			this.wasFollowing = false;
			this.pausedAtOutputVersion = this.outputVersion;
		}
		const contentHeight = typeof scroll.contentHeight === "number" ? scroll.contentHeight : 0;
		const maxScrollTop = Math.max(0, contentHeight - scroll.viewportHeight);
		return {
			following,
			linesBelow: Math.max(0, maxScrollTop - scroll.scrollTop),
			newOutput: !following && this.outputVersion > this.pausedAtOutputVersion,
		};
	}

	dispose(): void {
		this.currentScroll = undefined;
	}

	private patch(scroll: RuntimeScrollView): void {
		if (scroll[SCROLL_PATCH_KEY] || typeof scroll.followingEnd !== "boolean") return;
		const original = scroll.updateLayout;
		scroll.updateLayout = function (contentHeight, viewportHeight, requestRender) {
			const wasFollowing = scroll.isFollowingEnd;
			original.call(scroll, contentHeight, viewportHeight, requestRender);
			// Layout/dock changes may make a paused offset equal the new end. Only explicit
			// user navigation may resume follow-end; equality during layout must not.
			if (!wasFollowing && scroll.isFollowingEnd) scroll.followingEnd = false;
		};
		scroll[SCROLL_PATCH_KEY] = true;
	}
}
