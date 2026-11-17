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
import { ATTRIBUTED_TAG } from './consent';
import { classifyTraffic, isTestHost } from './traffic';
import { privacySignalOn } from 'rocketride/analytics';
import { newJourneyKey } from './bridge';
import { SdkQueue } from './sdkQueue';
// mode.ts imports posthog-js for types only, so this keeps the SDK chunk lazy.
import { clearSiteStorage } from './mode';
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
/**
 * The last resolved auth state the shell reported, replayed onto the transport's
 * identity when its chunk binds (a report made before the chunk landed would
 * otherwise be lost). null = nothing resolved yet: the bootstrap is still
 * running, so nothing is replayed and the identity stays "unknown" (never a
 * signed-out report, which would reset a stored identified identity).
 */
let lastAuth: { isAuthed: boolean; userId: string | null } | null = null;
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
	// Each disabled branch drops the queue's hold: captures held by an earlier
	// page load of the tab would otherwise sit in sessionStorage with nothing
	// to drain them. (An embedded preview's queue has no storage, so this
	// never touches the host tab's hold.)
	if (!config.key || typeof window === 'undefined') {
		queue.clearHold();
		enabled = false;
		return;
	}
	if (privacySignalOn()) {
		queue.clearHold();
		// A privacy signal also removes whatever PostHog stored on an earlier
		// visit (as home-ui's init did before the port). An embedded preview
		// shares the host tab's storage and leaves it to the host.
		if (!isEmbeddedDevShell()) {
			clearSiteStorage();
		}
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
		queue.clearHold();
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
			onTransportLoaded(module);
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

/**
 * The transport chunk landed: bind it to this page load, replay the auth state
 * resolved before it was in, then schedule the SDK start.
 *
 * @param module - The loaded transport chunk.
 */
function onTransportLoaded(module: typeof Transport): void {
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
	});
	// Replay the auth state resolved before the chunk landed, BEFORE the
	// SDK starts: the init then identifies a signed-in accepted visitor
	// and drops a stored identified identity only on a known sign-out.
	replayAuth();
	scheduleStart();
	module.startWebVitals();
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

/** The `app` stamp's shape (events.contract.json stampedProperties.app.pattern). */
const APP_STAMP_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Stamps no app may use: they belong to the shell itself. */
const RESERVED_APP_STAMPS: ReadonlySet<string> = new Set(['shell']);

/**
 * Whether a stamp is reserved for the shell, in any letter case.
 *
 * @param stamp - A candidate stamp.
 * @returns True when the stamp belongs to the shell.
 */
function isReservedStamp(stamp: string): boolean {
	return RESERVED_APP_STAMPS.has(stamp.toLowerCase());
}

/** The reporter an app whose own id is reserved gets: it never sends. */
const NOOP_REPORTER: Reporter = () => {};

/**
 * Whether an app id is first-party. The SaaS server keeps the `rocketride` and
 * `rocketride.*` namespace to RocketRide's own publisher, so only those
 * descriptors are trusted to choose a telemetry alias. On a self-hosted (OSS)
 * server every local app is published under `rocketride`, so all of them
 * count as first-party there; that server's operator owns every app anyway.
 *
 * @param appId - The descriptor id.
 * @returns True for `rocketride` and `rocketride.*`.
 */
function isFirstPartyApp(appId: string): boolean {
	return appId === 'rocketride' || appId.startsWith('rocketride.');
}

/**
 * The `app` value an app's events are stamped with. The descriptor comes from
 * the app's own bundle, so its `telemetryId` alias is honoured only when all
 * of these hold, and otherwise the descriptor id is used:
 * - the app is first-party (`rocketride` or `rocketride.*`);
 * - the alias is a string matching the contract's stamp pattern;
 * - the alias is not a reserved stamp ('shell');
 * - the alias is not the id of another registered app.
 *
 * @param appId - The descriptor id.
 * @param telemetryId - The descriptor's optional `telemetryId`.
 * @param registeredIds - Ids of every registered app; an alias equal to one of
 *   them (other than appId itself) is rejected.
 * @returns The value to bind the app's reporter to.
 */
export function telemetryAppStamp(appId: string, telemetryId?: unknown, registeredIds?: Iterable<string>): string {
	if (!isFirstPartyApp(appId) || typeof telemetryId !== 'string' || !APP_STAMP_PATTERN.test(telemetryId) || isReservedStamp(telemetryId)) {
		return appId;
	}
	if (telemetryId !== appId && registeredIds) {
		for (const id of registeredIds) {
			if (id === telemetryId) {
				return appId;
			}
		}
	}
	return telemetryId;
}

/**
 * The reporter an app's TelemetryProvider is bound to: the reporter for the
 * stamp telemetryAppStamp picks from the descriptor. Reporters are cached by
 * stamp, so the same app always gets the same reporter. An app whose own id is
 * a reserved stamp (an app published as 'shell') gets a reporter that never
 * sends, so it can never be handed the shell's own reporter.
 *
 * @param appId - The active app's descriptor id.
 * @param descriptor - The app's descriptor (only `telemetryId` is read).
 * @param registeredIds - Ids of every registered app, for the collision check.
 * @returns The app's bound reporter.
 */
export function appReporter(appId: string, descriptor?: { telemetryId?: unknown }, registeredIds?: Iterable<string>): Reporter {
	const stamp = telemetryAppStamp(appId, descriptor?.telemetryId, registeredIds);
	return isReservedStamp(stamp) ? NOOP_REPORTER : getReporter(stamp);
}

/**
 * The bound reporter for one app: minted on first ask, stable from then on.
 * Keyless or disabled, the sink simply never delivers — the reporter shape is
 * the same, so apps need no branches.
 *
 * @param appId - The emitting app's stamp: the descriptor's telemetryId, else
 *   its id (see telemetryAppStamp); 'shell' for the shell's own events.
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
			queue.capture(event, attributionProps(props), toCaptureOptions(options));
		});
		reporters.set(appId, reporter);
	}
	return reporter;
}

/**
 * True only while getConsentedCapture's report is calling the app's reporter,
 * so the sink tags exactly those events with ATTRIBUTED_TAG.
 */
let attributing = false;

/**
 * An app's props as the queue gets them: ATTRIBUTED_TAG removed from what the
 * caller passed (no app can set it by hand) and added back only for an event
 * sent through getConsentedCapture's report.
 *
 * @param props - The props the reporter was called with (already app-stamped).
 * @returns A new props object.
 */
function attributionProps(props?: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...(props ?? {}) };
	delete out[ATTRIBUTED_TAG];
	if (attributing) {
		out[ATTRIBUTED_TAG] = true;
	}
	return out;
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
	const own: Record<string, unknown> = { ...props };
	delete own[ATTRIBUTED_TAG]; // a super property would tag every event: only getConsentedCapture's report tags
	queue.register(own);
}

/**
 * Whether an app page is active: shell-owned screens (waitlist, loading) are
 * not pages, so no $pageleave and no web vitals are attributed to them.
 * The TelemetryProvider flips this with the app lifecycle.
 */
export function setPageActive(active: boolean): void {
	if (active === pageActive) {
		return;
	}
	pageActive = active;
	// Before the start the init reads isPage(); after it the live instances need the new value pushed.
	if (transport && queue.started) {
		transport.syncPageActive(active);
	}
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
	lastAuth = { isAuthed, userId };
	replayAuth();
}

/** Forward the last resolved auth state to the transport's identity, once the chunk is in. */
function replayAuth(): void {
	const identity = transport?.transportIdentity();
	if (!identity || !lastAuth) {
		return;
	}
	identity.setAuthed(lastAuth.isAuthed);
	identity.setIdentity(lastAuth.userId);
}

/** Off only, no init, no capture: the moment a sign-in is known, before paint. */
export function markTelemetrySignedIn(): void {
	knownSignedOut = false;
	// A later bind replays signed in, keeping whatever user id is already known
	// (the identity report that follows the sign-in brings the id).
	lastAuth = { isAuthed: true, userId: lastAuth?.userId ?? null };
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
 * A report bound to one consented session: it sends through the app's own
 * reporter (sanitised, app-stamped, consent-routed) and returns whether it was
 * handed to the transport. It refuses, returning false, once the moment the
 * capture was taken in has passed: consent withdrawn, the SDK gone, or the
 * session rotated. True does not mean delivered: the event can still be queued,
 * or dropped at send time by the consent gate (attributionGate). Events sent
 * through this report are tagged (ATTRIBUTED_TAG) and only they are gated:
 * the same event sent through the plain reporter is not.
 */
export type ConsentedReporter = (event: string, props?: Record<string, unknown>, options?: SendOptions) => boolean;

/**
 * What an app gets from getConsentedCapture: the consented session it was
 * taken in, a report bound to it, and the surface state. Never the SDK: no
 * app can reconfigure the transport or record a screen through this.
 */
export type ConsentedCapture = {
	/** The app's report, bound to this session (ConsentedReporter). */
	report: ConsentedReporter;
	/** The consented instance's session id when this capture was taken. */
	sessionId: string;
	/** Subscribe to session rotation on the consented instance; returns the unsubscribe. */
	onSessionId(callback: (sessionId: string) => void): () => void;
	/** True only on a known signed-out surface. */
	signedOut: boolean;
};

/**
 * The explicit-consent measurement seam, the same for every app: the consented
 * session's id with a report bound to it, or null while there is none (no
 * consent, SDK not started, no session yet, or the transport chunk not in).
 * An app that keys a measurement on the session (one exposure per session, a
 * deterministic uuid from it) takes this, decides, and reports through the
 * bound report, which drops anything the session no longer covers.
 *
 * @param report - The app's bound reporter (useReport, or the one handed to the app).
 * @returns The consented capture, or null.
 */
export function getConsentedCapture(report: Reporter): ConsentedCapture | null {
	const current = transport?.consentedSession() ?? null;
	if (!current) {
		return null;
	}
	const sessionId = current.sessionId;
	return {
		report: (event, props, options) => {
			if (transport?.consentedSession()?.sessionId !== sessionId) {
				return false;
			}
			const outer = attributing;
			attributing = true;
			try {
				report(event, props, options);
			} finally {
				attributing = outer;
			}
			return true;
		},
		sessionId,
		onSessionId: (callback) => {
			return transport?.onConsentedSessionId(callback) ?? (() => { /* chunk gone: nothing to unsubscribe */ });
		},
		signedOut: current.signedOut,
	};
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
	lastAuth = null;
	hostTelemetryEnabled = null;
	reporters.clear();
	queue = newQueue();
}

/**
 * TEST ONLY — bind a fake transport chunk exactly as the keyed path's import
 * does (replay, then the start schedule), without fetching posthog-js. The
 * host counts as enabled, as it is whenever the chunk import runs.
 */
export function loadTransportForTests(module: Pick<typeof Transport, 'bindTransport' | 'transportIdentity' | 'startWebVitals' | 'initPostHog' | 'active' | 'registerOnInstances' | 'syncPageActive'>): void {
	enabled = true;
	onTransportLoaded(module as typeof Transport);
}

/** TEST ONLY — whether the host currently treats the surface as known signed out. */
export function knownSignedOutForTests(): boolean {
	return knownSignedOut;
}
