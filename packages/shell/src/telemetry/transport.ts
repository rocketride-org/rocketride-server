// =============================================================================
// The lazy transport chunk: everything that VALUE-imports posthog-js.
//
// The TelemetryHost (host.ts) kicks `import('./transport')` off the moment the
// probe delivers a key and starts the SdkQueue only once this module is in —
// a page torn down before then is covered by the queue's sessionStorage hold.
// This module owns the cookieless instance, the capture mode over it and the
// consented instance (consented.ts), and the identity switching; it knows
// nothing about apps, pages or React. Ported from home-ui's analytics.ts
// transport half; the page-tracking half stayed with home-ui.
// =============================================================================

import posthog from 'posthog-js';
import { EV } from './events';
import { SCROLL_ROOT, telemetryHost, telemetryKey } from './config';
import { getConsentState } from './consentState';
import { CaptureMode, clearPostHogStorage, quietly, type SdkLike } from './mode';
import { sanitizeEvent } from './sanitize';
import { Identity } from './identity';
import { enableWebVitals, loadWebVitalsExtension } from './vitals';
import { onIdleAfterLoad } from './settle';
import { SIGNED_IN_CAPTURE_OFF, signedOutCaptureConfig } from './extensions';
import { newJourneyKey } from './bridge';
import { probe } from './probe';
import { bindConsentHost, consentedProperties, createConsented, guardStorage, markReplayResumePending, noteCookielessEvent, watchConsent } from './consented';
import type { ConsentHost } from './consented';
import type { SdkQueue } from './sdkQueue';

export { markReplayResumePending, resumeSignedOutCapture, getConsentedCapture, trackConsentShown } from './consented';

/** What the transport needs from the TelemetryHost (the page-load context the shell knows). */
export type TransportDeps = {
	/** The host's queue: captures and super properties flow through it. */
	queue: SdkQueue;
	/** True when an app page is active (false on shell-owned screens: waitlist, loading). */
	isPage(): boolean;
	/** True while a browser privacy signal (DNT, GPC) is on: nothing is captured. */
	privacySignal(): boolean;
	/** True only on a known signed-out surface (unknown counts as signed in). */
	signedOut(): boolean;
	/** True when the load is classed visible (replay records visible loads only). */
	visibleLoad(): boolean;
	/** Initialise-if-needed, from the host (false = telemetry off). */
	ensureInit(): boolean;
	/**
	 * The app-registerable before-send veto: an event carrying experiment
	 * identifiers (assignment_id) is captured only while this allows it.
	 * Default allows everything; home-ui registers its roulette gate.
	 */
	allowAttribution(event: unknown): boolean;
};

let deps: TransportDeps | null = null;
/** The capture mode once the SDK started (cookieless ↔ consented routing). */
let mode: CaptureMode | null = null;

/** Signed-in state and the opaque user id: rich capture runs only on a known signed-out surface. */
const identity = new Identity({
	mode: () => {
		return mode;
	},
	ensureInit: () => {
		return deps?.ensureInit() ?? false;
	},
	registerAuthed: (isAuthed) => {
		deps?.queue.register({ is_authed: isAuthed });
	},
	markReplayResumePending,
});

/** The identity surface the host forwards sign-in state through. */
export function transportIdentity(): Identity {
	return identity;
}

/**
 * Removes PostHog's own storage on this site: its localStorage and sessionStorage keys and its ph_ cookies, on this
 * host and its parent domain. Never throws.
 */
function clearSiteStorage(): void {
	quietly(() => {
		clearPostHogStorage(document, window.localStorage, window.sessionStorage, window.location.hostname);
	});
}

/**
 * A new rr_journey key for this page load (or after a withdrawal).
 *
 * @returns A random key, from crypto.randomUUID where the browser has it.
 */
export function freshJourneyKey(): string {
	let uuid: (() => string) | undefined;
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		uuid = () => {
			return crypto.randomUUID();
		};
	}
	return newJourneyKey(Math.random, uuid);
}

/**
 * The instance captures go through once the SDK started.
 *
 * @returns The consented instance after an acceptance, else the cookieless one.
 */
export function active(): SdkLike {
	if (mode) {
		return mode.active();
	}
	return posthog;
}

/** Web vitals for every consent state: once the page has settled, the extension chunk, then the capture switched on. */
export function startWebVitals(): void {
	onIdleAfterLoad(() => {
		void loadWebVitalsExtension().then((ok) => {
			if (!ok || !deps?.queue.started) {
				return;
			}
			// Only the active instance measures, so an accepted visitor's vitals are not reported twice.
			let detail = 'no web-vitals autocapture';
			if (enableWebVitals(active())) {
				detail = 'started';
			}
			// the harness reads this to prove the extension path (probe.ts: a no-op in production)
			probe('web vitals', detail);
		});
	});
}

/**
 * Bind this transport to its host context and arm the consent machinery.
 * Called once by the TelemetryHost, right after the chunk loads.
 *
 * @param d - The page-load context (host.ts).
 */
export function bindTransport(d: TransportDeps): void {
	deps = d;
	const consentHost: ConsentHost = {
		mode: () => {
			return mode;
		},
		allowAttribution: (event) => {
			return d.allowAttribution(event);
		},
		sdkStarted: () => {
			return d.queue.started;
		},
		isShellScreen: () => {
			return !d.isPage();
		},
		privacySignal: () => {
			return d.privacySignal();
		},
		signedOut: () => {
			return d.signedOut();
		},
		visibleLoad: () => {
			return d.visibleLoad();
		},
		ensureInit: () => {
			return d.ensureInit();
		},
		register: (props) => {
			d.queue.register(props);
		},
		send: (event, props, options) => {
			d.queue.capture(event, { ...props, app: 'shell' }, options);
		},
		freshJourneyKey,
		identify: () => {
			identity.identifyIfConsented();
		},
	};
	bindConsentHost(consentHost);
	watchConsent();
}

/**
 * posthog-js's init for this page load and the capture mode on top of it (the queue's init; it throws when
 * posthog-js cannot start). Verbatim port of home-ui's initPostHog: the cookieless instance, storage guard,
 * capture mode, stale-storage cleanup and the identity start.
 */
export function initPostHog(): void {
	const d = deps;
	if (!d) {
		throw new Error('transport not bound');
	}
	posthog.init(telemetryKey(), {
		api_host: telemetryHost(),
		ui_host: 'https://us.posthog.com',
		// fetch with keepalive (posthog-js's default, pinned): a batch in flight when the page navigates is still
		// delivered; the queue itself goes out by sendBeacon on pagehide.
		api_transport: 'fetch',
		cookieless_mode: 'always',
		persistence: 'memory',
		respect_dnt: true,
		// Nothing from the PostHog static host, ever: remote config comes as JSON, the web-vitals code from our
		// own chunk. No toolbar: a crafted #__posthog= link would otherwise store _postHogToolbarParams and load
		// the toolbar script for any visitor. No debug: ?__posthog_debug=true would store ph_debug.
		disable_external_dependency_loading: true,
		__extensionClasses: { toolbar: undefined },
		debug: false,
		autocapture: false,
		capture_pageview: false,
		// A shell screen is not a page: no $pageleave without a $pageview.
		capture_pageleave: d.isPage(),
		disable_session_recording: true,
		capture_heatmaps: false,
		// Pinned off: when unset these follow the project's remote config, which could add
		// $dead_click, $exception and $web_vitals events outside the contract and the budget.
		capture_dead_clicks: false,
		capture_exceptions: false,
		capture_performance: false,
		// Scroll depth on $pageleave is measured against the page's own scroller, not the window.
		scroll_root_selector: SCROLL_ROOT,
		// Only utm_* query params leave the browser; referrers are reduced to their origin; click ids are dropped.
		// While the visitor's consented instance is active this instance sends nothing at all: a cookieless
		// 'always' instance cannot be opted out, and its own $pageleave and web vitals would otherwise go out too.
		// The one exception is consent:handoff, sent right after the switch to close the cookieless half.
		// Page views and section views are also kept in memory for a later bridge (accept mid-visit).
		before_send: (event) => {
			if (mode?.isConsented() && event?.event !== EV.CONSENT_HANDOFF) {
				return null;
			}
			const out = sanitizeEvent(event);
			noteCookielessEvent(out);
			return out;
		},
	});
	// Every write posthog-js makes to its storage is reduced from here on, before any opted-in instance exists.
	guardStorage(posthog);
	mode = new CaptureMode({
		cookieless: posthog,
		createConsented,
		clearSdkStorage: clearSiteStorage,
		// The consented instance is created inside the start with the super properties of that moment, before the
		// queue replays: an earlier event without a property registered in between (within the one frame the queue
		// spans) can pick it up there. The cookieless instance gets them only after the replay (sdkQueue.ts).
		superProperties: () => {
			return d.queue.properties();
		},
		later: (fn, ms) => { window.setTimeout(fn, ms); },
		captureConfig: (signedIn) => {
			if (signedIn) {
				return SIGNED_IN_CAPTURE_OFF;
			}
			return signedOutCaptureConfig();
		},
		consentedProperties,
	});
	mode.apply(getConsentState());
	// An acceptance that expired or belongs to an older consent version reads as undecided: whatever the
	// earlier consented instance stored must go now, not only on an explicit withdrawal.
	if (getConsentState() !== 'accepted') {
		clearSiteStorage();
	} else {
		// an accepted visitor keeps the consented instance's ph_ storage, but never a stored toolbar link
		try { window.localStorage.removeItem('_postHogToolbarParams'); } catch { /* never throws */ }
	}
	// An accepted, signed-in visitor is identified; a signed-out load that still holds an identified consented
	// identity starts a fresh one first. This runs inside the init, so before the queue replays: a signed-out
	// load's queued page view must never go out under the stored identified identity.
	identity.sdkStarted();
}

/**
 * An app page became active or inactive after the SDK started: posthog-js reads capture_pageleave per page leave,
 * but only from its config, which init set from the page state of that moment. The host calls this only when the
 * value changes (set_config also re-runs each extension's start-or-stop check; a running replay is left as is). The
 * consented instance is updated only while it is the active one: a torn-down instance stays inert, and the revive
 * (reviveConfig) and a fresh creation both read the live page state.
 *
 * @param active - Whether an app page is active now.
 */
export function syncPageActive(active: boolean): void {
	if (!mode) {
		return;
	}
	const config = { capture_pageleave: active };
	quietly(() => {
		posthog.set_config(config);
	});
	if (mode.isConsented()) {
		const consented = mode.active();
		quietly(() => {
			consented.set_config(config);
		});
	}
}

/** The posthog-js calls the queue registers through once the SDK started (both instances). */
export function registerOnInstances(props: Record<string, unknown>): void {
	try { posthog.register(props); } catch { /* never throws */ }
	if (mode?.isConsented()) {
		try { mode.active().register(props); } catch { /* never throws */ }
	}
}
