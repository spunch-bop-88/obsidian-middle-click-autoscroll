import { Plugin } from "obsidian";
import {
	AutoscrollSession,
	buildScrollChain,
	detectView,
	isElement,
	swallowClickSequence,
} from "./autoscroll";
import { AutoscrollSettings, AutoscrollSettingTab, sanitizeSettings } from "./settings";

/** Middle-clicking these keeps Obsidian's own behaviour (e.g. open link in new tab). */
const LINK_SELECTOR = "a[href], .internal-link, .external-link, .tag";
/** Rendered links in Live Preview. In Source mode the same classes mark raw markdown text. */
const LIVE_PREVIEW_LINK_SELECTOR = ".is-live-preview :is(.cm-hmd-internal-link, .cm-link, .cm-url, .cm-hashtag)";

/** Form controls, and Canvas, where middle-drag pans the board. */
const IGNORE_SELECTOR = "input, textarea, select, button, .canvas-wrapper, .canvas-node";

export default class MiddleClickAutoscrollPlugin extends Plugin {
	settings!: AutoscrollSettings;
	private session: AutoscrollSession | null = null;
	private readonly attachedWindows = new WeakSet<Window>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AutoscrollSettingTab(this.app, this));

		this.attachWindow(window);
		this.app.workspace.onLayoutReady(() => {
			// Popout windows restored from the last session.
			this.app.workspace.iterateAllLeaves((leaf) => {
				const win = leaf.view.containerEl.ownerDocument.defaultView;
				if (win) this.attachWindow(win);
			});
		});
		this.registerEvent(this.app.workspace.on("window-open", (_workspaceWin, win) => this.attachWindow(win)));
		this.registerEvent(
			this.app.workspace.on("window-close", (_workspaceWin, win) => {
				if (this.session?.win === win) this.stopAutoscroll();
			})
		);
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.stopAutoscroll()));
	}

	onunload(): void {
		this.stopAutoscroll();
	}

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private attachWindow(win: Window): void {
		if (this.attachedWindows.has(win)) return;
		this.attachedWindows.add(win);
		// Capture phase on window runs before CodeMirror and Obsidian's own handlers.
		this.registerDomEvent(win, "mousedown", this.onMouseDown, { capture: true });
	}

	private stopAutoscroll(): void {
		// Clear the reference first: stop() calls back into onStop.
		const session = this.session;
		this.session = null;
		session?.stop();
	}

	private onMouseDown = (evt: MouseEvent): void => {
		// While autoscrolling, any mouse button ends it and the click is consumed.
		const target = evt.target;
		if (!isElement(target)) return;
		const win = target.ownerDocument.defaultView ?? window;

		if (this.session) {
			evt.preventDefault();
			evt.stopPropagation();
			this.stopAutoscroll();
			swallowClickSequence(win, evt.button);
			return;
		}

		if (evt.button !== 1) return;
		if (target.closest(IGNORE_SELECTOR)) return;

		const ctx = detectView(target);
		if (!ctx) return;
		const enabled = {
			livePreview: this.settings.enableLivePreview,
			source: this.settings.enableSourceMode,
			reading: this.settings.enableReadingView,
		}[ctx.mode];
		if (!enabled) return;
		if (this.settings.passThroughLinks && target.closest(`${LINK_SELECTOR}, ${LIVE_PREVIEW_LINK_SELECTOR}`)) return;

		// Inside an enabled note: block the default middle-click (paste on Linux, etc.),
		// even when the note is too short to scroll.
		evt.preventDefault();
		evt.stopPropagation();
		swallowClickSequence(win, 1);

		const chain = buildScrollChain(target, ctx);
		if (chain.length === 0) return;

		const session = new AutoscrollSession(
			chain,
			evt.clientX,
			evt.clientY,
			() => this.settings,
			() => {
				if (this.session === session) this.session = null;
			}
		);
		this.session = session;
		session.start();
	};
}
