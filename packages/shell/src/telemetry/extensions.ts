// =============================================================================
// Accepted visitors only: dead clicks and exceptions come from code-split
// chunks of our own bundle (posthog-js/dist/dead-clicks-autocapture and
// dist/exception-autocapture; their versions are locked by the exact
// posthog-js pin in package.json, not only by the lockfile), imported on idle
// once the consented instance exists; the SDK never fetches them from the
// proxy's /static. Heatmaps and click autocapture need no extension and are
// part of the consented instance's config.
// =============================================================================

/**
 * Elements no click capture may describe: posthog-js's defaults (kept) and our marker. The shell's own surfaces
 * (its ALT+D debug panel among them) are outside the home root, and the consented instance's before_send drops
 * every click event from outside it, whatever their styling (surface.ts).
 */
const CLICK_IGNORELIST = ['.ph-no-capture', '.ph-no-autocapture', '[data-ph-no-autocapture]', '[data-rr-private]'];

/** The consented instance's extras that need no extension chunk: heatmaps, click capture and rage clicks. */
export const ACCEPTED_CAPTURE_CONFIG = {
	// One heatmap batch per 5 s of activity at most (the SDK default); a batch is a few hundred bytes.
	capture_heatmaps: { flush_interval_milliseconds: 5000 },
	// Clicks only: no form, change, submit or copy events. Inline styles are left out of the element chain: the
	// landing pages style every element inline, so each chain carried kilobytes of CSS that no query reads.
	// (It is bytes, not time: the click's INP cost did not move with it.)
	autocapture: { dom_event_allowlist: ['click' as const], capture_copied_text: false, element_attribute_ignorelist: ['style'], css_selector_ignorelist: CLICK_IGNORELIST },
	// Rage clicks derived from clicks (a top-level option in posthog-js, not an autocapture one). posthog-js
	// builds its rage-click detectors once, at init, from this value: it must never be false at init.
	rageclick: { css_selector_ignorelist: [...CLICK_IGNORELIST, '.ph-no-rageclick'] },
};

/**
 * Not on a signed-out surface: no rich capture at all. Signed-in screens
 * render the account's name and email, which replay, autocapture, dead clicks,
 * heatmaps and exception reports would carry; the switch-off is by surface, not by marking
 * elements (data-rr-private stays as defence in depth).
 */
export const SIGNED_IN_CAPTURE_OFF = { capture_heatmaps: false, autocapture: false, capture_dead_clicks: false, capture_exceptions: false, rageclick: false, disable_session_recording: true };

/** Switched on after the chunks loaded. Console errors stay off: a page's console is not product data. */
export const ACCEPTED_EXTENSION_CONFIG = {
	capture_dead_clicks: { css_selector_ignorelist: [...CLICK_IGNORELIST, '.ph-no-deadclick'] },
	capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true, capture_console_errors: false },
};

let loading: Promise<boolean> | null = null;
let isLoaded = false;

/**
 * Load both chunks once.
 *
 * @returns A promise of true once both loaded; of false when either cannot load (then neither capture is switched on).
 */
export function loadAcceptedExtensions(): Promise<boolean> {
	if (!loading) {
		loading = Promise.all([import('posthog-js/dist/dead-clicks-autocapture'), import('posthog-js/dist/exception-autocapture')])
			.then(() => {
				isLoaded = true;
				return true;
			})
			.catch(() => {
				return false;
			});
	}
	return loading;
}

/**
 * True once both chunks are in (a revived instance can switch the captures on at once).
 *
 * @returns Whether both chunks loaded.
 */
function extensionsLoaded(): boolean {
	return isLoaded;
}

/**
 * The consented instance's captures on a signed-out surface: heatmaps, click capture and rage clicks, and dead
 * clicks and exceptions once their chunks are in.
 *
 * @returns The config to init or set_config the consented instance with.
 */
export function signedOutCaptureConfig(): typeof ACCEPTED_CAPTURE_CONFIG & Partial<typeof ACCEPTED_EXTENSION_CONFIG> {
	if (extensionsLoaded()) {
		return { ...ACCEPTED_CAPTURE_CONFIG, ...ACCEPTED_EXTENSION_CONFIG };
	}
	return { ...ACCEPTED_CAPTURE_CONFIG };
}
