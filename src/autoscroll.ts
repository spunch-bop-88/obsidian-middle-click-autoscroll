import type { AutoscrollSettings } from "./settings";

export type ViewMode = "editor" | "reading";

export interface ViewContext {
	mode: ViewMode;
	/** Root element of the markdown view the click landed in. */
	root: HTMLElement;
}

const BODY_ACTIVE = "mca-active";
const BODY_UP = "mca-scrolling-up";
const BODY_DOWN = "mca-scrolling-down";

/** Cross-window safe check (popout windows have their own Element constructor). */
export function isElement(target: EventTarget | null): target is HTMLElement {
	return !!target && (target as Node).nodeType === Node.ELEMENT_NODE;
}

/**
 * Work out which kind of markdown view an element belongs to.
 * Reading view is checked first so embeds rendered inside it count as reading view;
 * embeds inside Live Preview resolve to the editor that hosts them.
 */
export function detectView(target: HTMLElement): ViewContext | null {
	const reading = target.closest<HTMLElement>(".markdown-reading-view");
	if (reading) return { mode: "reading", root: reading };
	const source = target.closest<HTMLElement>(".markdown-source-view");
	if (source) return { mode: "editor", root: source };
	// Hover popovers and other stand-alone rendered markdown.
	const preview = target.closest<HTMLElement>(".markdown-preview-view");
	if (preview) return { mode: "reading", root: preview };
	return null;
}

function isScrollableY(el: HTMLElement): boolean {
	if (el.scrollHeight <= el.clientHeight + 1) return false;
	const overflowY = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY ?? "";
	return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/**
 * Collect every vertically scrollable ancestor of `target`, innermost first, stopping at the
 * view's leaf (or popover). Each frame scrolls the innermost one that can still move, so nested
 * containers (embeds, tall code blocks, popovers) scroll first and hand off to the note itself.
 */
export function buildScrollChain(target: HTMLElement, ctx: ViewContext): HTMLElement[] {
	const boundary = ctx.root.closest<HTMLElement>(".workspace-leaf-content, .hover-popover") ?? ctx.root;
	const chain: HTMLElement[] = [];
	let el: HTMLElement | null = target;
	while (el) {
		if (isScrollableY(el)) chain.push(el);
		if (el === boundary) break;
		el = el.parentElement;
	}

	// Make sure the view's main scroller is in the chain even if the click hit something odd.
	const main = ctx.mode === "editor"
		? ctx.root.querySelector<HTMLElement>(".cm-scroller")
		: ctx.root.matches(".markdown-preview-view")
			? ctx.root
			: ctx.root.querySelector<HTMLElement>(".markdown-preview-view");
	if (main && !chain.includes(main) && main.scrollHeight > main.clientHeight + 1) chain.push(main);
	return chain;
}

/**
 * Signed scroll velocity in px/s for a vertical pointer offset.
 * Speed grows with distance outside the dead zone (linear + quadratic term, like browsers),
 * and is capped at the configured maximum.
 */
export function computeVelocity(offset: number, settings: AutoscrollSettings): number {
	const distance = Math.abs(offset) - settings.deadZone;
	if (distance <= 0) return 0;
	const speed = settings.sensitivity * (2 * distance + 0.02 * distance * distance);
	return Math.sign(offset) * Math.min(settings.maxSpeed, speed);
}

/**
 * Swallow the rest of a mouse click (mouseup / click / auxclick / contextmenu) for `button`,
 * so the click that started or ended autoscroll doesn't also open links, paste, place the
 * cursor, or show a context menu.
 */
export function swallowClickSequence(win: Window, button: number): void {
	const types = ["mouseup", "click", "auxclick", "contextmenu"] as const;
	let releaseTimer = 0;

	const handler = (evt: MouseEvent) => {
		if (evt.button !== button) return;
		evt.preventDefault();
		evt.stopPropagation();
		// click/auxclick/contextmenu follow mouseup almost immediately; give them a short grace period.
		if (evt.type === "mouseup" && !releaseTimer) releaseTimer = win.setTimeout(remove, 250);
	};
	const remove = () => {
		for (const type of types) win.removeEventListener(type, handler, true);
		win.removeEventListener("mousedown", remove, true);
		win.clearTimeout(releaseTimer);
		win.clearTimeout(fallbackTimer);
	};

	for (const type of types) win.addEventListener(type, handler, true);
	// A new press means the previous click is over, whatever happened to it.
	win.addEventListener("mousedown", remove, true);
	// Safety net in case mouseup never arrives (e.g. released outside the window).
	const fallbackTimer = win.setTimeout(remove, 10000);
}

/** One active autoscroll: owns its listeners, animation frame, indicator and cursor classes. */
export class AutoscrollSession {
	readonly win: Window;
	private readonly doc: Document;
	private pointerY: number;
	private frame: number | null = null;
	private lastTime: number | null = null;
	private remainder = 0;
	/** -1 up, 1 down, 0 idle. */
	private direction = 0;
	private indicator: HTMLElement | null = null;
	/** True until the button that started the session is released (enables press-drag-release mode). */
	private awaitingRelease = true;
	/** Pointer left the dead zone while the starting button was still held. */
	private movedWhileHeld = false;
	private stopped = false;
	private readonly listeners: Array<[string, EventListener, AddEventListenerOptions]> = [];

	constructor(
		private readonly chain: HTMLElement[],
		private readonly originX: number,
		private readonly originY: number,
		private readonly getSettings: () => AutoscrollSettings,
		private readonly onStop: () => void
	) {
		this.doc = chain[0].ownerDocument;
		this.win = this.doc.defaultView ?? window;
		this.pointerY = originY;
	}

	start(): void {
		this.listen("mousemove", this.onMouseMove, { capture: true, passive: true });
		this.listen("mouseup", this.onMouseUp, { capture: true });
		this.listen("keydown", this.onKeyDown, { capture: true });
		// Mouse wheel ends autoscroll (as in browsers) and still scrolls normally.
		this.listen("wheel", () => this.stop(), { capture: true, passive: true });
		this.listen("blur", () => this.stop(), {});

		this.doc.body.addClass(BODY_ACTIVE);
		if (this.getSettings().showIndicator) this.createIndicator();
		this.scheduleFrame();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
		this.frame = null;
		for (const [type, fn, opts] of this.listeners) this.win.removeEventListener(type, fn, opts);
		this.listeners.length = 0;
		this.indicator?.remove();
		this.indicator = null;
		this.doc.body.removeClasses([BODY_ACTIVE, BODY_UP, BODY_DOWN]);
		this.onStop();
	}

	private listen<K extends keyof WindowEventMap>(
		type: K,
		fn: (evt: WindowEventMap[K]) => void,
		opts: AddEventListenerOptions
	): void {
		this.win.addEventListener(type, fn, opts);
		this.listeners.push([type, fn as EventListener, opts]);
	}

	private createIndicator(): void {
		const el = this.doc.body.createDiv({ cls: "mca-indicator" });
		el.createDiv({ cls: "mca-arrow mca-arrow-up" });
		el.createDiv({ cls: "mca-dot" });
		el.createDiv({ cls: "mca-arrow mca-arrow-down" });
		el.setCssProps({ "--mca-x": `${this.originX}px`, "--mca-y": `${this.originY}px` });
		this.indicator = el;
	}

	private onMouseMove = (evt: MouseEvent): void => {
		this.pointerY = evt.clientY;
		this.scheduleFrame();
		if (this.awaitingRelease) {
			const { deadZone } = this.getSettings();
			if (Math.hypot(evt.clientX - this.originX, evt.clientY - this.originY) > Math.max(deadZone, 6)) {
				this.movedWhileHeld = true;
			}
		}
	};

	private onMouseUp = (evt: MouseEvent): void => {
		if (evt.button !== 1 || !this.awaitingRelease) return;
		this.awaitingRelease = false;
		// Press, drag, release: behaves like holding the button down in Chrome.
		if (this.movedWhileHeld) this.stop();
	};

	private onKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key !== "Escape") return;
		evt.preventDefault();
		evt.stopPropagation();
		this.stop();
	};

	private tick = (now: number): void => {
		this.frame = null;
		if (this.stopped) return;
		if (!this.chain.some((el) => el.isConnected)) {
			this.stop();
			return;
		}

		// Clamp dt so a hidden/throttled window doesn't cause a big jump when it resumes.
		const dt = this.lastTime === null ? 16 : Math.min(now - this.lastTime, 50);
		this.lastTime = now;

		const velocity = computeVelocity(this.pointerY - this.originY, this.getSettings());
		this.setDirection(Math.sign(velocity));

		if (velocity === 0) {
			// Inside the dead zone: pause the loop until the pointer moves again.
			this.remainder = 0;
			this.lastTime = null;
			return;
		}

		// Accumulate sub-pixel movement so slow speeds still scroll smoothly.
		this.remainder += (velocity * dt) / 1000;
		const step = Math.trunc(this.remainder);
		if (step !== 0) {
			this.remainder -= step;
			if (!this.scrollBy(step)) this.remainder = 0;
		}

		this.frame = this.win.requestAnimationFrame(this.tick);
	};

	private scheduleFrame(): void {
		if (this.frame === null && !this.stopped) this.frame = this.win.requestAnimationFrame(this.tick);
	}

	/** Scroll the innermost container in the chain that can still move in this direction. */
	private scrollBy(step: number): boolean {
		for (const el of this.chain) {
			if (!el.isConnected) continue;
			const max = el.scrollHeight - el.clientHeight;
			const before = el.scrollTop;
			if (step < 0 ? before <= 0 : before >= max - 1) continue;
			el.scrollTop = before + step;
			if (el.scrollTop !== before) return true;
		}
		return false;
	}

	private setDirection(direction: number): void {
		if (direction === this.direction) return;
		this.direction = direction;
		const body = this.doc.body;
		body.toggleClass(BODY_UP, direction < 0);
		body.toggleClass(BODY_DOWN, direction > 0);
		this.indicator?.toggleClass("is-up", direction < 0);
		this.indicator?.toggleClass("is-down", direction > 0);
	}
}
