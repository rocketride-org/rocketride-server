// =============================================================================
// Session replay for accepted visitors only, while signed out and only for a
// load the visitor could see (rr_traffic visible). The recorder is a code-split
// chunk of our own bundle (posthog-js/dist/posthog-recorder, the script the
// project's remote config names; its version is locked by the exact
// posthog-js pin in package.json, not only by the lockfile), imported on idle
// after load; the SDK never fetches it from the proxy's /static. A recording
// keeps to the home remote's own content: everything outside its root (the
// shell's surfaces, whatever their styling) is blocked, and replay does not
// start where the browser cannot apply that block. Inputs are always masked,
// elements marked data-rr-private are blocked, canvases and cross-origin
// frames are never recorded, console logs and network bodies stay off; public
// marketing copy stays visible (no personal data while signed out). The
// recording stops on sign-in and on withdrawal. Network headers and bodies are
// never recorded, whatever the project's settings say, and every address a
// recording holds (page addresses, network requests, element attributes) keeps
// only its utm_* parameters (sanitize.ts; the hooks are attached where the
// instance is created, consented.ts, so this module stays import-free for its
// unit tests).
// =============================================================================

/**
 * The attribute the home remote renders on its own root element (HomeApp); the shell renders its surfaces outside it.
 * A copy of surface.ts's (this module has no imports, so node:test can load it); a unit test fails if they differ.
 */
export const HOME_ROOT_ATTRIBUTE = 'data-rr-home-root';

const HOME_ROOT = `[${HOME_ROOT_ATTRIBUTE}]`;

/**
 * Every element of the page body that is not the home root, not inside it and not one of its ancestors: the shell's
 * surfaces (the ALT+D debug panel with the event payloads of a signed-in session, which survive an in-place sign-out,
 * the API-key sign-in form, the app error screen and any surface the shell adds later), found by where they sit, not
 * by how they look. The ancestors stay unblocked because rrweb drops the whole subtree of a blocked element.
 */
export const OUTSIDE_HOME_SELECTOR = `body *:not(${HOME_ROOT}):not(${HOME_ROOT} *):not(:has(${HOME_ROOT}))`;

/** Part of the consented instance's init config: the recorder stays off until startReplay(). */
export const REPLAY_INIT_CONFIG = {
	disable_session_recording: true,
	session_recording: {
		maskAllInputs: true,
		maskTextSelector: '[data-rr-private]',
		// Blocked (rrweb records a sized placeholder and drops their mutations): everything outside the home root
		// (OUTSIDE_HOME_SELECTOR); frames; the landing terminal's input-free typing loop, which fed the recorder a
		// stream of mutations and programmatic scrolls; and every data-rr-private element, because the text mask
		// covers text nodes only and a title, aria-label or data attribute inside one would be recorded verbatim
		// (the placeholder keeps its class and size only).
		blockSelector: `iframe, [data-rr-replay-block], [data-rr-private], ${OUTSIDE_HOME_SELECTOR}`,
		recordCrossOriginIframes: false,
		captureCanvas: { recordCanvas: false },
		// One recorded pointer position per 200 ms instead of rrweb's 50 ms: the coarsest that still reads in the
		// player (the cursor moves in visible steps but the path stays legible; 500 ms loses hover states). Scroll
		// and input sampling are not exposed by posthog-js and keep rrweb's defaults.
		sampling: { mousemove: 200 },
		// Pinned off on the client, which overrides the project's remote setting (posthog-js: "client can always
		// disable despite remote options"); the network hook strips them as well, so neither layer alone decides.
		recordHeaders: false,
		recordBody: false,
	},
};

/** The slice of a PostHog instance startReplay touches; a posthog-js instance satisfies it as is. */
export type ReplayCapable = {
	startSessionRecording?(): void;
	sessionRecordingStarted?(): boolean;
};

let loading: Promise<boolean> | null = null;

/**
 * Load the recorder chunk once.
 *
 * @returns A promise of true once it loaded; of false when it cannot load (then nothing is recorded).
 */
export function loadRecorder(): Promise<boolean> {
	if (!loading) {
		loading = import('posthog-js/dist/posthog-recorder')
			.then(() => {
				return true;
			})
			.catch(() => {
				return false;
			});
	}
	return loading;
}

/** The slice of a document homeBlockApplies reads; the browser's document satisfies it as is. */
export type BlockTarget = {
	documentElement: { matches(selector: string): boolean };
	querySelector(selector: string): unknown;
};

/**
 * Whether a recording can block everything outside the home root here. rrweb tests the block selector with
 * element.matches and treats a selector the browser cannot parse as matching nothing, so a browser without :has()
 * or a complex selector in :not() would record the shell's surfaces in full. With no home root on the page there is
 * no home content to record. Never throws.
 *
 * @param doc - The document the recording would cover.
 * @returns True when the browser parses the block selector and the home root is on the page.
 */
export function homeBlockApplies(doc: BlockTarget): boolean {
	try {
		doc.documentElement.matches(REPLAY_INIT_CONFIG.session_recording.blockSelector);
		return doc.querySelector(HOME_ROOT) !== null;
	} catch {
		return false;
	}
}

/**
 * Start the recording on an instance whose recorder chunk is in; never throws. Fails closed: nothing starts where
 * the recording could not keep to the home content (homeBlockApplies).
 * startSessionRecording() is itself set_config({ disable_session_recording: false }),
 * so no separate set_config (each one restarts every capture extension).
 *
 * @param instance - The consented instance.
 * @param doc - The document the recording would cover.
 * @returns Whether the recording runs (true when the instance cannot say); false when it could not or must not start.
 */
export function startReplay(instance: ReplayCapable, doc: BlockTarget): boolean {
	if (!instance.startSessionRecording || !homeBlockApplies(doc)) {
		return false;
	}
	try {
		instance.startSessionRecording();
		if (instance.sessionRecordingStarted) {
			return instance.sessionRecordingStarted();
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Run `fn` in a fresh idle period (bounded): rrweb takes the first full snapshot
 * synchronously inside the start, one uninterruptible task that cannot be
 * chunked, so it gets its own idle callback instead of riding on the task that
 * resolved the recorder import.
 *
 * @param fn - The work to run.
 * @param timeoutMs - The longest wait for an idle period.
 */
export function inIdle(fn: () => void, timeoutMs = 3000): void {
	const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
	if (typeof w.requestIdleCallback === 'function') {
		w.requestIdleCallback(() => {
			fn();
		}, { timeout: timeoutMs });
	} else {
		window.setTimeout(fn, 0);
	}
}

/** Why session replay is skipped on this device, or null when it runs. */
export type ReplayGate = 'save_data' | 'slow_network' | 'low_memory' | null;

/** Why a consented instance records nothing: a device gate, or a page where the block cannot apply. */
export type ReplayGateReason = Exclude<ReplayGate, null> | 'no_home_block' | 'none';

/**
 * Device memory (GB, as Chromium reports it: rounded down to a power of two) at
 * or below which replay is skipped. Set from measurements on throttled phone
 * profiles: the recorder's per-interaction work fits the budget on a
 * mid-tier phone and not on a low-end one.
 */
export const LOW_MEMORY_GB = 4;

type DeviceSignals = { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };

/**
 * No replay where it would cost the visitor most. Save-Data and a 2G/3G
 * effective connection (the recorder chunk and the snapshot uploads are data
 * the visitor asked not to spend), and low device memory (the CPU class on
 * which the recorder's serialisation of a page swap shows up as a long task).
 * Chromium exposes these signals; Safari and Firefox expose none, so they keep
 * replay. Heatmaps and click capture are not affected.
 *
 * @param signals - The device signals (the browser's navigator by default; tests pass their own).
 * @returns The reason replay is skipped, or null when it runs.
 */
export function replayGate(signals?: DeviceSignals): ReplayGate {
	let nav = signals;
	if (!nav) {
		if (typeof navigator === 'undefined') {
			return null;
		}
		nav = navigator as DeviceSignals;
	}
	try {
		if (nav.connection?.saveData === true) {
			return 'save_data';
		}
		const et = nav.connection?.effectiveType;
		if (et === 'slow-2g' || et === '2g' || et === '3g') {
			return 'slow_network';
		}
		if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= LOW_MEMORY_GB) {
			return 'low_memory';
		}
	} catch { /* unreadable signals: replay runs */ }
	return null;
}
