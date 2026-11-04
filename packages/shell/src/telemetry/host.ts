// =============================================================================
// TelemetryHost — the chunk-free telemetry facade the shell boots.
//
// Created synchronously at Shell mount with the probe-served config
// (posthogPublishableKey / posthogHost → ShellConfig). With no key, every
// path here is a structural no-op and the posthog chunk is NEVER fetched
// (OSS cost ~0). With a key, the chunk import is kicked off IMMEDIATELY
// (init still deferred to the first frame, like home-ui's scheduleStart) and
// captures made before the chunk lands wait in the SdkQueue, mirrored to
// sessionStorage at enqueue — the teardown-survival design: an OAuth redirect
// or tab close before the chunk loads drains on the tab's next page load with
// original timestamps and uuid dedupe.
//
// Reporters: one per app, minted here via the SDK's createReporter and closed
// over the app id — no mutable "current app" state, nothing re-inits on app
// switch; a late event from a backgrounded app stamps its true emitter.
// =============================================================================

import { createReporter, type Reporter, type SendOptions } from 'rocketride/analytics';
import { isEmbeddedDevShell } from '../util/devGate';
import { setTelemetryConfig, telemetryConfig, type TelemetryConfig } from './config';
import { getConsentState, watchConsentStorage } from './consentState';
import { classifyTraffic, isTestHost } from './traffic';
import { privacySignalOn } from 'rocketride/analytics';
import { newJourneyKey } from './bridge';
import { SdkQueue } from './sdkQueue';
import type { SdkLike } from './mode';
import type * as Transport from './transport';

/** The lazily loaded transport chunk; null until its import resolves (or forever, keyless). */
let transport: typeof Transport | null = null;
/** null = not attempted yet, false = disabled (no key / privacy signal / chunk or init failed). */
let enabled: boolean | null = null;
/** True while an app page is active (TelemetryProvider); false on shell-owned screens. */
let pageActive = false;
/** The load's traffic class (visible, hidden, zero_viewport, prerender); replay needs a visible load. */
let trafficClass = 'visible';
/** True only when the shell knows the surface is signed out (set from the identity it resolves). */
let knownSignedOut = false;
/** The app-registerable before-send veto for experiment-bearing events; allows everything by default. */
let attributionGate: (event: unknown) => boolean = () => true;
/**
 * The embedding host's telemetry setting (VS Code), mirrored over the bus.
 * Consulted ONLY when consentSource is 'host' — never OR'd with the stored
 * record. null = not yet received: captures stay gated off until it arrives.
 */
let hostTelemetryEnabled: boolean | null = null;
/** The bound reporters, one per app id, handed to apps and never re-pointed. */
const reporters = new Map<string, Reporter>();
/** The SDK starts by then at the latest, even when no frame comes (a throttled or occluded window). */
const START_FALLBACK_MS = 500;

/** Build the queue (a factory so the test reset can re-read the hold's storage like a fresh page load). */
function newQueue(): SdkQueue {
	return new SdkQueue({
		// An embedded dev preview shares the HOST tab's sessionStorage: its
		// captures must stay in memory and never touch the host's hold (the
		// retired channel made the same exception, for the same reason).
		...(isEmbeddedDevShell() ? { storage: null } : {}),
		init: () => {
			if (!transport) {
				// The chunk is not in yet: the hold covers a teardown; the start retries when it lands.
				throw new Error('transport pending');
			}
			transport.initPostHog();
		},
		target: () => {
			if (!transport) {
				throw new Error('transport pending');
			}
			return transport.active();
		},
		register: (props) => {
			transport?.registerOnInstances(props);
		},
		onFailure: () => {
			enabled = false;
		},
	});
}

/** The one queue: captures and super properties until the SDK starts, held across teardown. */
let queue = newQueue();

/**
 * Boot the telemetry host, once, at Shell mount. Keyless (OSS, telemetry off)
 * this is a cheap no-op; with a key the transport chunk import starts NOW and
 * the SDK init is scheduled for after the first frame.
 *
 * @param config - The probe-served config (key '' = off).
 */
export function initTelemetryHost(config: TelemetryConfig): void {
	setTelemetryConfig(config);
	if (enabled !== null) {
		return;
	}
	if (!config.key || typeof window === 'undefined') {
		enabled = false;
		return;
	}
	if (privacySignalOn()) {
		enabled = false;
		return;
	}
	if (config.consentSource === 'host') {
		// VS Code: the cookieless marketing instance and replay are hard-off by
		// design, and no VS Code surface reports product events yet — so the
		// transport stays structurally off. The host-setting bridge
		// (setHostTelemetryEnabled) is wired for the day a VS Code profile
		// (events-only instance, gated by the editor's telemetry setting) gets
		// its first consumer.
		enabled = false;
		return;
	}
	enabled = true;
	try {
		trafficClass = classifyTraffic({
			prerendering: (document as Document & { prerendering?: boolean }).prerendering,
			visibilityState: document.visibilityState,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
		});
	} catch { /* keep 'visible' */ }
	// The page load's super properties, registered before anything captures:
	// the traffic class, the journey key joining the cookieless and consented
	// halves of a consenting visit, and the test-host marker. (These moved
	// here from home-ui's init — they are transport facts, not app facts.)
	queue.register({ rr_traffic: trafficClass, rr_journey: pageJourneyKey() });
	try {
		if (isTestHost(window.location.hostname)) {
			queue.register({ rr_test: true });
		}
	} catch { /* never throws */ }
	installActivationTag();
	watchConsentStorage();
	// Eager chunk fetch, deferred init: shrink the hold's window without paying init before first paint.
	void import('./transport')
		.then((module) => {
			transport = module;
			module.bindTransport({
				queue,
				isPage: () => {
					return pageActive;
				},
				privacySignal: () => {
					return privacySignalOn();
				},
				signedOut: () => {
					return knownSignedOut;
				},
				visibleLoad: () => {
					return trafficClass === 'visible';
				},
				ensureInit: () => {
					return enabled === true;
				},
				allowAttribution: (event) => {
					return attributionGate(event);
				},
			});
			scheduleStart();
			module.startWebVitals();
		})
		.catch(() => {
			// The chunk failed to load (offline, blocked): captures stay in the
			// hold for the tab's next page load; nothing else happens this load.
		});
	// The page leaving before the frame: start now if the chunk is in (the hold covers it otherwise).
	window.addEventListener('pagehide', () => {
		startSdk(true);
	});
}

/** This page load's rr_journey key (crypto UUID where available). */
function pageJourneyKey(): string {
	let uuid: (() => string) | undefined;
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		uuid = () => {
			return crypto.randomUUID();
		};
	}
	return newJourneyKey(Math.random, uuid);
}

/**
 * A prerendered or background load the visitor later activates keeps its load
 * classification (rr_traffic) and gains rr_traffic_activated, so a dashboard
 * excluding prerender loads does not drop the real visit that followed.
 * (home-ui's installActivationTag, moved with the super properties.)
 */
function installActivationTag(): void {
	if (trafficClass === 'visible') {
		return;
	}
	let done = false;
	const activate = (): void => {
		if (done) return;
		done = true;
		queue.register({ rr_traffic_activated: true });
	};
	document.addEventListener('prerenderingchange', activate, { once: true, passive: true });
	document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') activate(); }, { passive: true });
}

/** Start the SDK after the next frame (home-ui's scheduleStart, verbatim semantics). */
function scheduleStart(): void {
	if (document.visibilityState === 'visible' && typeof window.requestAnimationFrame === 'function') {
		window.requestAnimationFrame(() => {
			window.setTimeout(() => {
				startSdk();
			}, 0);
		});
	} else {
		window.setTimeout(() => {
			startSdk();
		}, 0);
	}
	window.setTimeout(() => {
		startSdk();
	}, START_FALLBACK_MS);
}

/**
 * Start posthog-js and replay the queue (inherited hold first), once — and
 * only once the transport chunk is in; before that the queue keeps holding.
 *
 * @param unloading - The page is going away: the replay goes out by sendBeacon.
 */
function startSdk(unloading = false): void {
	if (!enabled || !transport) {
		return;
	}
	queue.start(unloading);
}

/**
 * The bound reporter for one app: minted on first ask, stable from then on.
 * Keyless or disabled, the sink simply never delivers — the reporter shape is
 * the same, so apps need no branches.
 *
 * @param appId - The emitting app's id (the descriptor's).
 * @returns The app's `report(event, props?, options?)`.
 */
export function getReporter(appId: string): Reporter {
	let reporter = reporters.get(appId);
	if (!reporter) {
		reporter = createReporter(appId, (event, props, options) => {
			if (enabled === false) {
				return;
			}
			// Host-governed consent (VS Code): the editor's telemetry setting is
			// the one switch, and until it arrives nothing is captured.
			if (telemetryConfig()?.consentSource === 'host' && hostTelemetryEnabled !== true) {
				return;
			}
			queue.capture(event, props ?? {}, toCaptureOptions(options));
		});
		reporters.set(appId, reporter);
	}
	return reporter;
}

/** The shell's own reporter (shell screens: the waitlist page, auth facts). */
export function shellReporter(): Reporter {
	return getReporter('shell');
}

/** Map the SDK's SendOptions onto posthog-js capture options (same field names by design). */
function toCaptureOptions(options?: SendOptions): { transport?: 'sendBeacon'; timestamp?: Date; uuid?: string } | undefined {
	if (!options) {
		return undefined;
	}
	return { ...(options.transport ? { transport: options.transport } : {}), ...(options.timestamp ? { timestamp: options.timestamp } : {}), ...(options.uuid ? { uuid: options.uuid } : {}) };
}

/**
 * Register super properties on every instance (queued before the start).
 *
 * @param props - The properties to add to every later event.
 */
export function registerSuperProperties(props: Record<string, unknown>): void {
	if (enabled === false) {
		return;
	}
	queue.register(props);
}

/**
 * Whether an app page is active: shell-owned screens (waitlist, loading) are
 * not pages, so no $pageleave and no web vitals are attributed to them.
 * The TelemetryProvider flips this with the app lifecycle.
 */
export function setPageActive(active: boolean): void {
	pageActive = active;
}

/**
 * The shell's signed-in state, forwarded to the transport's identity: rich
 * capture (replay, autocapture) runs only on a known signed-out surface, and
 * identities switch with it. Wired to the shell's auth lifecycle (C6).
 *
 * @param isAuthed - Whether an identity exists now.
 * @param userId - The signed-in user's opaque id, or null.
 */
export function setTelemetryIdentity(isAuthed: boolean, userId: string | null): void {
	knownSignedOut = !isAuthed;
	const identity = transport?.transportIdentity();
	if (!identity) {
		return;
	}
	identity.setAuthed(isAuthed);
	identity.setIdentity(userId);
}

/** Off only, no init, no capture: the moment a sign-in is known, before paint. */
export function markTelemetrySignedIn(): void {
	knownSignedOut = false;
	transport?.transportIdentity().markSignedIn();
}

/**
 * A sign-out on this tab: the queue's hold is dropped (one session's captures
 * never forward under the next account) and the transport resets identity.
 */
export function clearTelemetryOnSignOut(): void {
	queue.clearHold();
	transport?.transportIdentity().shellSignedOut();
}

/**
 * Register the before-send veto for experiment-bearing events (assignment_id):
 * the home app's roulette gate. One registrant; the default allows everything.
 */
export function setAttributionGate(gate: (event: unknown) => boolean): void {
	attributionGate = gate;
}

/**
 * The embedding host's telemetry setting (VS Code), pushed by the extension
 * host over the bus. Meaningful only when consentSource is 'host'.
 */
export function setHostTelemetryEnabled(enabledByHost: boolean): void {
	hostTelemetryEnabled = enabledByHost;
}

/** @returns Whether telemetry is live this page load (key served, no privacy signal, init not failed). */
export function telemetryEnabled(): boolean {
	return enabled === true && telemetryConfig() !== null;
}

/**
 * Whether the consent prompt is due: telemetry is live and the visitor has no
 * valid stored decision. The banner asks this at mount.
 */
export function consentPromptNeeded(): boolean {
	return telemetryEnabled() && getConsentState() === 'undecided';
}

/** Captures consent:shown once per page load, when the banner renders (routed to the transport when it is in). */
export function trackConsentShown(): void {
	transport?.trackConsentShown();
}

/**
 * The explicit-consent experiment gateway: the active consented instance and
 * surface state, or null while capture is unavailable (no consent, SDK not
 * started, or the transport chunk not in yet). home-ui's roulette exposure
 * capture uses it for session-id reads and deterministic-uuid captures that
 * a plain reporter cannot express.
 */
export function getConsentedCapture(): { sdk: SdkLike; signedOut: boolean } | null {
	return transport?.getConsentedCapture() ?? null;
}

/**
 * After a sign-out on this page load, restart the recording once the home app
 * shows a signed-out surface (its transition screen is gone) — only the app
 * knows that moment, so it calls this; everything else about the resume is
 * transport-internal.
 */
export function resumeSignedOutCapture(): void {
	transport?.resumeSignedOutCapture();
}

// ==== test seams (node:test has no posthog and no real page) ================

/**
 * TEST ONLY — a non-consuming view of the queue (inherited hold first, then
 * this load's pending captures), so tests can assert what was reported before
 * any SDK exists.
 */
export function peekQueuedCaptures(): ReturnType<SdkQueue['peekPending']> {
	return queue.peekPending();
}

/**
 * TEST ONLY — reset the host's module state and re-create the queue, which
 * re-reads the hold's storage exactly like a fresh page load of the tab.
 */
export function resetTelemetryHostForTests(): void {
	transport = null;
	enabled = null;
	pageActive = false;
	trafficClass = 'visible';
	knownSignedOut = false;
	attributionGate = () => true;
	hostTelemetryEnabled = null;
	reporters.clear();
	queue = newQueue();
}
