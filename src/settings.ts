import { App, debounce, PluginSettingTab, Setting } from "obsidian";
import type MiddleClickAutoscrollPlugin from "./main";

export interface AutoscrollSettings {
	/** Upper bound for scroll speed, in pixels per second. */
	maxSpeed: number;
	/** Multiplier applied to the distance → speed curve. */
	sensitivity: number;
	/** Radius (px) around the start point in which no scrolling happens. */
	deadZone: number;
	/** Draw the circular indicator at the start point. */
	showIndicator: boolean;
	/** Allow autoscroll in Live Preview. */
	enableLivePreview: boolean;
	/** Allow autoscroll in Source mode. */
	enableSourceMode: boolean;
	/** Allow autoscroll in Reading view. */
	enableReadingView: boolean;
	/** Middle-clicking a link keeps Obsidian's behaviour (open in new tab) instead of autoscrolling. */
	passThroughLinks: boolean;
}

export const DEFAULT_SETTINGS: AutoscrollSettings = {
	maxSpeed: 3000,
	sensitivity: 1,
	deadZone: 12,
	showIndicator: true,
	enableLivePreview: true,
	enableSourceMode: true,
	enableReadingView: true,
	passThroughLinks: true,
};

const LIMITS = {
	maxSpeed: { min: 200, max: 10000, step: 100 },
	sensitivity: { min: 0.1, max: 5, step: 0.1 },
	deadZone: { min: 0, max: 60, step: 1 },
} as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Merge stored data with defaults and keep every number inside its slider range. */
export function sanitizeSettings(raw: unknown): AutoscrollSettings {
	const data = (raw && typeof raw === "object" ? raw : {}) as Partial<AutoscrollSettings>;
	const merged: AutoscrollSettings = { ...DEFAULT_SETTINGS, ...data };
	// Before 1.1.0 the Live Preview toggle also covered Source mode; keep that choice on upgrade.
	if (data.enableSourceMode === undefined && typeof data.enableLivePreview === "boolean") {
		merged.enableSourceMode = data.enableLivePreview;
	}
	merged.maxSpeed = clamp(merged.maxSpeed, LIMITS.maxSpeed.min, LIMITS.maxSpeed.max, DEFAULT_SETTINGS.maxSpeed);
	merged.sensitivity = clamp(merged.sensitivity, LIMITS.sensitivity.min, LIMITS.sensitivity.max, DEFAULT_SETTINGS.sensitivity);
	merged.deadZone = clamp(merged.deadZone, LIMITS.deadZone.min, LIMITS.deadZone.max, DEFAULT_SETTINGS.deadZone);
	for (const key of ["showIndicator", "enableLivePreview", "enableSourceMode", "enableReadingView", "passThroughLinks"] as const) {
		if (typeof merged[key] !== "boolean") merged[key] = DEFAULT_SETTINGS[key];
	}
	return merged;
}

export class AutoscrollSettingTab extends PluginSettingTab {
	/** Sliders fire on every tick while dragging; write data.json once the value settles. */
	private readonly saveSoon = debounce(() => void this.plugin.saveSettings(), 400, true);

	constructor(app: App, private readonly plugin: MiddleClickAutoscrollPlugin) {
		super(app, plugin);
	}

	hide(): void {
		// Flush a pending slider save when the settings window closes.
		this.saveSoon.run();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Maximum speed")
			.setDesc("Fastest scroll speed, in pixels per second.")
			.addSlider((slider) =>
				slider
					.setLimits(LIMITS.maxSpeed.min, LIMITS.maxSpeed.max, LIMITS.maxSpeed.step)
					.setValue(this.plugin.settings.maxSpeed)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.maxSpeed = value;
						this.saveSoon();
					})
			);

		new Setting(containerEl)
			.setName("Sensitivity")
			.setDesc("How quickly speed grows as the pointer moves away from the start point. Higher is faster.")
			.addSlider((slider) =>
				slider
					.setLimits(LIMITS.sensitivity.min, LIMITS.sensitivity.max, LIMITS.sensitivity.step)
					.setValue(this.plugin.settings.sensitivity)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.sensitivity = value;
						this.saveSoon();
					})
			);

		new Setting(containerEl)
			.setName("Dead zone")
			.setDesc("Distance in pixels around the start point where no scrolling happens.")
			.addSlider((slider) =>
				slider
					.setLimits(LIMITS.deadZone.min, LIMITS.deadZone.max, LIMITS.deadZone.step)
					.setValue(this.plugin.settings.deadZone)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.deadZone = value;
						this.saveSoon();
					})
			);

		new Setting(containerEl)
			.setName("Show indicator")
			.setDesc("Draw the circular autoscroll indicator where you middle-clicked.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showIndicator).onChange(async (value) => {
					this.plugin.settings.showIndicator = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Views").setHeading();

		new Setting(containerEl)
			.setName("Live Preview")
			.setDesc("Enable autoscroll in Live Preview.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableLivePreview).onChange(async (value) => {
					this.plugin.settings.enableLivePreview = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Source mode")
			.setDesc("Enable autoscroll in Source mode.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableSourceMode).onChange(async (value) => {
					this.plugin.settings.enableSourceMode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reading view")
			.setDesc("Enable autoscroll in Reading view.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableReadingView).onChange(async (value) => {
					this.plugin.settings.enableReadingView = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Middle-click on links opens them")
			.setDesc("Like browsers, middle-clicking a link keeps Obsidian's normal behaviour instead of starting autoscroll.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.passThroughLinks).onChange(async (value) => {
					this.plugin.settings.passThroughLinks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Reset to defaults").onClick(async () => {
				this.plugin.settings = { ...DEFAULT_SETTINGS };
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
