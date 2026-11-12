// =============================================================================
// Web vitals (LCP, CLS, INP, FCP) as real-user data for every visitor, in every
// consent state, so production can prove "no slowdown" split by consent_state.
// The web-vitals extension is a code-split chunk of our own bundle
// (posthog-js/dist/web-vitals-with-attribution; its version is the exact
// posthog-js pin in package.json), imported once the page has settled
// (settle.ts); the SDK never fetches it from the proxy's /static (external
// dependency loading is off). Network timing stays off: no resource or request
// data leaves the page. Unit-tested under node:test (test/unit/vitals.test.ts).
// =============================================================================

/** The posthog-js performance config that turns web vitals on and keeps network timing off. */
export type WebVitalsConfig = {
	capture_performance: { web_vitals: true; network_timing: false; web_vitals_allowed_metrics: Array<'LCP' | 'CLS' | 'INP' | 'FCP'>; web_vitals_attribution: true };
};

/** The four metrics, with attribution (which element was the LCP, which target the INP), and no network timing. */
export const WEB_VITALS_CONFIG: WebVitalsConfig = {
	capture_performance: { web_vitals: true, network_timing: false, web_vitals_allowed_metrics: ['LCP', 'CLS', 'INP', 'FCP'], web_vitals_attribution: true },
};

/** The slice of a PostHog instance this module touches: set_config and the typed web-vitals autocapture. */
export type VitalsCapable = {
	set_config(config: WebVitalsConfig): void;
	webVitalsAutocapture?: { startIfEnabled(): void };
};

/**
 * Switch web vitals on for an instance that is already running. set_config alone does not
 * (re)start the web-vitals autocapture in posthog-js 1.433.5 (it restarts replay, heatmaps,
 * autocapture, dead clicks and exceptions, not this one), so the typed autocapture is started
 * explicitly once the extension's callbacks exist. Never throws.
 *
 * @param instance - The running instance.
 * @returns True when the autocapture was started; false when the instance has none or set_config threw.
 */
export function enableWebVitals(instance: VitalsCapable): boolean {
	try {
		instance.set_config(WEB_VITALS_CONFIG);
		const auto = instance.webVitalsAutocapture;
		if (!auto) {
			return false;
		}
		auto.startIfEnabled();
		return true;
	} catch {
		return false;
	}
}

/** What the vitals start reads and does: the live page state and the SDK, injected (tests pass fakes). */
export type VitalsStartDeps = {
	/** Whether posthog-js started (the queue drained). */
	sdkStarted(): boolean;
	/** Whether an app page is active NOW (false on shell screens: waitlist, loading). */
	isPage(): boolean;
	/** Switch web vitals on for the active instance (enableWebVitals); true when the autocapture started. */
	enable(): boolean;
	/** Report the outcome (the harness probe). */
	report(detail: string): void;
};

/**
 * Starts web vitals once per page load, and only on an app page: a shell screen (waitlist, loading) is not a
 * page, so nothing is measured there. The start is attempted when the extension has loaded and again whenever an
 * app page becomes active, so a load that settles on a shell screen still measures the app page that follows.
 */
export class VitalsStart {
	private readonly deps: VitalsStartDeps;
	private isLoaded = false;
	private isStarted = false;

	/** @param deps - The live page state, the SDK and the report. */
	constructor(deps: VitalsStartDeps) {
		this.deps = deps;
	}

	/** The extension chunk loaded: start now if the page allows it. */
	extensionLoaded(): void {
		this.isLoaded = true;
		this.tryStart();
	}

	/** An app page became active: start now if the extension is in and nothing started yet. */
	pageActivated(): void {
		this.tryStart();
	}

	/** Start once every condition holds: extension in, SDK started, an app page active now. */
	private tryStart(): void {
		if (!this.isLoaded || this.isStarted || !this.deps.sdkStarted() || !this.deps.isPage()) {
			return;
		}
		this.isStarted = true;
		let detail = 'no web-vitals autocapture';
		if (this.deps.enable()) {
			detail = 'started';
		}
		this.deps.report(detail);
	}
}

let loading: Promise<boolean> | null = null;

/**
 * Load the extension once.
 *
 * @returns A promise of true once the chunk loaded; of false (and nothing else happens) when it cannot load.
 */
export function loadWebVitalsExtension(): Promise<boolean> {
	if (!loading) {
		// The SDK's default flavour carries attribution (which element was the LCP, which target the INP), so the
		// with-attribution build is the one it looks for; it also lets the gate prove the LCP element is never the banner.
		loading = import('posthog-js/dist/web-vitals-with-attribution')
			.then(() => {
				return true;
			})
			.catch(() => {
				return false;
			});
	}
	return loading;
}

/**
 * Whether the web-vitals extension registered its callbacks (posthog-js checks the same global).
 *
 * @returns True once the with-attribution flavour is registered.
 */
export function webVitalsLoaded(): boolean {
	const ext = (globalThis as { __PosthogExtensions__?: { postHogWebVitalsCallbacksByFlavor?: Record<string, unknown> } }).__PosthogExtensions__;
	return Boolean(ext?.postHogWebVitalsCallbacksByFlavor?.['web-vitals-with-attribution']);
}
