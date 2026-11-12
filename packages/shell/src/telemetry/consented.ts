// =============================================================================
// The consent wiring: our consent record, the opted-in ("consented") PostHog
// instance and what follows a decision. analytics.ts owns the page load (init,
// the cookieless instance, the capture mode, page views, identity) and binds
// itself here as the host (bindConsentHost); this file creates, arms, revives
// and tears down the consented instance as the visitor decides, bridges a
// mid-visit opt-in onto it, and exposes the consent API the banner and the
// footer link use. Every path fails silently: telemetry never breaks the site.
// =============================================================================

import posthog, { type CaptureOptions, type PostHogConfig } from 'posthog-js';
import { EV } from './events';
import { SCROLL_ROOT, telemetryHost, telemetryKey } from './config';
import { CONSENT_VERSION, parseConsent, type ConsentOrigin, type ConsentState } from './consent';
import { consentStore as consent, isWithdrawing } from './consentState';
import { quietly, type CaptureMode, type SdkLike } from './mode';
import { maskReplayAttribute, reduceRecordedRequest, reduceStoredProps, sanitizeEvent, type CaptureLike } from './sanitize';
import { installStorageGuard, persistenceProto, scrubStoredProps } from './storageGuard';
import { WEB_VITALS_CONFIG, enableWebVitals, webVitalsLoaded } from './vitals';
import { onIdleAfterLoad } from './settle';
import { ACCEPTED_CAPTURE_CONFIG, ACCEPTED_EXTENSION_CONFIG, SIGNED_IN_CAPTURE_OFF, loadAcceptedExtensions, signedOutCaptureConfig } from './extensions';
import { REPLAY_INIT_CONFIG, homeBlockApplies, inIdle, loadRecorder, replayGate, replayGateReasonFor, startReplay, type ReplayGateReason } from './replay';
import { richEventGate } from './surface';
import { BridgeLog, CONTINUED_KEY, normalizeContinued, planBridge } from './bridge';
import { probe } from './probe';
import type { SendOptions } from 'rocketride/analytics';

/** What this file needs from the page load (analytics.ts). */
export type ConsentHost = {
	/** The capture mode once the SDK started; null before. */
	mode(): CaptureMode | null;
	/**
	 * Recheck consent and traffic before sending an event with experiment identifiers.
	 * @param event Candidate event name.
	 * @returns Whether the experiment event may be captured now.
	 */
	allowAttribution(event: unknown): boolean;
	/** True once posthog-js is initialised. */
	sdkStarted(): boolean;
	/** True on a shell screen (initShellScreen): not a page, so no instance sends a page leave or web vitals. */
	isShellScreen(): boolean;
	/** True while a browser privacy signal (Do Not Track, Global Privacy Control) is on: nothing is captured. */
	privacySignal(): boolean;
	/** True only on a known signed-out surface (unknown counts as signed in). */
	signedOut(): boolean;
	/** True when the load is classed visible (replay records visible loads only). */
	visibleLoad(): boolean;
	/** Initialise the analytics if needed; false when they are off (no key, a privacy signal, a failed init). */
	ensureInit(): boolean;
	/** Register super properties on every instance. */
	register(props: Record<string, unknown>): void;
	/** Capture on the active instance, with capture options. */
	send(event: string, props: Record<string, unknown>, options?: SendOptions): void;
	/** A new per-page-load journey key. */
	freshJourneyKey(): string;
	/** Identify the consented instance by the signed-in user's opaque id, when there is one. */
	identify(): void;
};

let host: ConsentHost | null = null;

/**
 * Called once, by analytics.ts, before anything here runs.
 *
 * @param h - What this file needs from the page load.
 */
export function bindConsentHost(h: ConsentHost): void {
	host = h;
}

const signedOut = (): boolean => {
	return !!host && host.signedOut();
};

// ── State of this page load ────────────────────────────────────────────────
// (The consent record itself lives in consentState.ts, chunk-free; this file
// follows it.)
/** Set once consent:shown went out (once per page load). */
let hasSentConsentShown = false;
/** The replay gate of this device once the consented instance exists. */
let replayGateReason: string | null = null;
/** Set by a sign-out on this page load: the recording restarts once a signed-out surface is on screen. */
let isReplayResumePending = false;
/** This page load's page views and section views as sent, in memory only, for the bridge at a mid-visit accept. */
const bridgeLog = new BridgeLog();
/** Set once this page load hasBridged to the consented instance (one bridge per page load). */
let hasBridged = false;
/** Set once the cookieless instance reported this page load's web vitals (posthog-js flushes 5 s after the first metric). */
let hasCookielessVitals = false;
/** The consented instance of this page load, kept across a withdrawal so a later acceptance can revive it. */
let consentedSdk: SdkLike | null = null;
/** True once posthog-js's storage writes are reduced (guardStorage); without it no opted-in instance is created. */
let isStorageGuarded = false;

/** Sanitised, then rr_continued_visit kept only on the session that continues a cookieless visit (bridge.ts). */
function consentedNext<T extends CaptureLike | null>(event: T): T {
	if (event?.properties?.assignment_id && (!getConsentedCapture() || !host?.allowAttribution(event.event))) return null as T;
	return normalizeContinued(sanitizeEvent(event));
}

/**
 * Provide the explicit-consent experiment gateway without exposing the cookieless SDK.
 * @returns The active consented SDK and surface state, or null when capture is unavailable.
 */
export function getConsentedCapture(): { sdk: SdkLike; signedOut: boolean } | null {
	try {
		if (parseConsent(JSON.stringify(consent.record()), Date.now())?.choice !== 'accepted') return null;
		if (!host?.sdkStarted()) return null;
		const mode = host.mode();
		if (!mode?.isConsented()) return null;
		return { sdk: mode.active(), signedOut: signedOut() };
	} catch {
		return null;
	}
}

/** The consented instance's before_send: rich events only from a signed-out surface, everything sanitised. */
const consentedBeforeSend = richEventGate(signedOut, consentedNext);

/**
 * Whether the consented instance may measure web vitals in this page load: not on a shell screen, which is not a
 * page, and not when the cookieless instance already reported them, or an opt-in after that flush would report the
 * same load twice, once per identity.
 *
 * @returns True when the extension is loaded, this is a page, and the cookieless instance has not reported this
 * load's vitals.
 */
export function consentedVitals(): boolean {
	if (onShellScreen()) {
		return false;
	}
	return webVitalsLoaded() && !hasCookielessVitals;
}

/**
 * Whether this page load is a shell screen (initShellScreen) rather than a page.
 *
 * @returns True on a shell screen; false on a page, or before analytics.ts bound the host.
 */
function onShellScreen(): boolean {
	if (!host) {
		return false;
	}
	return host.isShellScreen();
}

/**
 * Reduce every write posthog-js makes to its storage from here on (storageGuard.ts), on the persistence class
 * the cookieless instance already uses, before any opted-in instance exists.
 *
 * @param cookieless The started cookieless instance.
 * @returns Whether the guard is installed; without it no opted-in instance is ever created.
 */
export function guardStorage(cookieless: unknown): boolean {
	isStorageGuarded = installStorageGuard(persistenceProto((cookieless as { persistence?: unknown }).persistence), reduceStoredProps);
	if (!isStorageGuarded) {
		probe('storage guard', 'not installed: no opted-in instance');
	}
	return isStorageGuarded;
}

/**
 * The cookieless instance's before_send calls this for every event it sends: page views and section views
 * are kept for a later bridge (until it ran), and its web vitals report is noted (see consentedVitals).
 *
 * @param event - The event as the cookieless instance sends it (sanitised), or null when it is dropped.
 */
export function noteCookielessEvent(event: CaptureLike | null): void {
	if (!hasBridged) {
		bridgeLog.record(event);
	}
	if (event?.event === '$web_vitals') {
		hasCookielessVitals = true;
	}
}

/**
 * Super properties for every consented event (the mode registers them again after a sign-out reset).
 *
 * @returns `rr_replay_gate` (whether this device skips replay, and why) once the instance is armed; otherwise none.
 */
export function consentedProperties(): Record<string, unknown> {
	if (replayGateReason) {
		return { rr_replay_gate: replayGateReason };
	}
	return {};
}

/** The web-vitals setting for the consented instance: on only when it may measure this load (consentedVitals). */
function consentedPerformance(): PostHogConfig['capture_performance'] {
	if (consentedVitals()) {
		return WEB_VITALS_CONFIG.capture_performance;
	}
	return false;
}

/**
 * The consented instance's captures at its init. On a known signed-out surface, the accepted ones (the extension
 * captures follow once their chunks are in); otherwise none, except that the rage-click detectors, which posthog-js
 * builds once at init, get their real config: signed in, autocapture and heatmaps are off and the before_send gate
 * drops $rageclick, so nothing is captured from them.
 *
 * @returns The capture part of the init config.
 */
function initialCaptureConfig(): Partial<PostHogConfig> {
	if (signedOut()) {
		return ACCEPTED_CAPTURE_CONFIG;
	}
	return { ...SIGNED_IN_CAPTURE_OFF, rageclick: ACCEPTED_CAPTURE_CONFIG.rageclick };
}

/**
 * Everything a torn-down instance must get back: the counterpart of INERT_CONFIG in mode.ts, which switched
 * each of these off.
 *
 * @returns The config that revives the consented instance.
 */
function reviveConfig(): Partial<PostHogConfig> {
	let captures: Partial<PostHogConfig> = SIGNED_IN_CAPTURE_OFF;
	if (signedOut()) {
		captures = signedOutCaptureConfig();
	}
	return {
		disable_persistence: false,
		// A shell screen is not a page: no $pageleave without a $pageview.
		capture_pageleave: !onShellScreen(),
		...captures,
		capture_performance: consentedPerformance(),
		disable_session_recording: true,
		before_send: consentedBeforeSend,
	};
}

/**
 * The consented instance: persistent identity, created once per page load when the visitor accepts. The
 * cookieless instance stays as it is (posthog-js cannot turn a cookieless_mode 'always' instance into one
 * that records). Replay, heatmaps, autocapture and the extensions are switched on separately, signed out only.
 * CaptureMode calls this; it revives the instance a withdrawal tore down earlier in this page load.
 *
 * @returns The instance, or null when it must not exist (no storage guard) or could not be created.
 */
export function createConsented(): SdkLike | null {
	// Fail closed: without the storage guard the opted-in instance would store raw addresses and referrers and
	// send them in its /flags requests, so the visitor stays on the cookieless instance instead.
	if (!isStorageGuarded) {
		return null;
	}
	if (consentedSdk) {
		// posthog.init with the same name returns the instance a withdrawal tore down (opted out, persistence
		// off, before_send dropping everything): bring it back explicitly, then arm it like a new one.
		const sdk = consentedSdk;
		quietly(() => {
			sdk.opt_in_capturing?.();
		});
		quietly(() => {
			sdk.set_config?.(reviveConfig());
		});
		armConsented(sdk);
		return sdk;
	}
	const instance = posthog.init(telemetryKey(), {
		api_host: telemetryHost(),
		ui_host: 'https://us.posthog.com',
		api_transport: 'fetch',
		persistence: 'localStorage+cookie',
		// The cookie stays on this host: posthog-js would otherwise set it on .rocketride.ai, and every
		// rocketride.ai subdomain (the identity provider among them) would receive it.
		cross_subdomain_cookie: false,
		capture_pageview: false,
		// A shell screen is not a page: no $pageleave without a $pageview.
		capture_pageleave: !onShellScreen(),
		__extensionClasses: { toolbar: undefined },
		debug: false,
		...REPLAY_INIT_CONFIG,
		session_recording: {
			...REPLAY_INIT_CONFIG.session_recording,
			// Network requests and the page addresses posthog-js writes into the recording: utm_* only, no headers,
			// bodies or server timings (sanitize.ts).
			maskCapturedNetworkRequestFn: reduceRecordedRequest,
			// Element attributes in full snapshots and mutations: every address utm_* only.
			maskAttributeFn: maskReplayAttribute,
		},
		// Not (yet) on a known signed-out surface: no rich capture (initialCaptureConfig).
		...initialCaptureConfig(),
		capture_dead_clicks: false,
		capture_exceptions: false,
		// Web vitals from the start when the extension is already loaded; the idle hook covers the other order.
		capture_performance: consentedPerformance(),
		enable_recording_console_log: false,
		// Extensions come from our own bundle (code-split chunks), never from the proxy's /static.
		disable_external_dependency_loading: true,
		scroll_root_selector: SCROLL_ROOT,
		before_send: consentedBeforeSend,
	}, 'consented');
	// posthog.init is typed to return the instance, but returns nothing where it cannot initialise
	if (!instance) {
		return null;
	}
	// Whatever the persistence loaded from storage before this page load's guard (an older build) is reduced too.
	scrubStoredProps(instance.persistence, reduceStoredProps);
	scrubStoredProps(instance.sessionPersistence, reduceStoredProps);
	consentedSdk = instance;
	armConsented(instance);
	return instance;
}

/**
 * Set rr_replay_gate to what is known now, on the instance and for consentedProperties.
 *
 * @param sdk - The consented instance.
 * @param reason - The current reason (replayGateReasonFor).
 * @param always - Register even when unchanged (arming: a revived instance gets it again); else a no-op then.
 */
function noteReplayGate(sdk: SdkLike, reason: ReplayGateReason, always = false): void {
	if (!always && replayGateReason === reason) {
		return;
	}
	replayGateReason = reason;
	try { sdk.register({ rr_replay_gate: reason }); } catch { /* never throws */ }
}

/** True while `sdk` is the active consented instance (a withdrawal or a later instance ends it). */
function stillActive(sdk: SdkLike): boolean {
	const mode = host?.mode();
	return !!mode && mode.isConsented() && mode.active() === sdk;
}

/** Extensions and the recorder on idle, each only while this instance is still the active consented one. */
function armConsented(sdk: SdkLike): void {
	// Whether this device skips replay, on every accepted event, so the excluded share is measurable
	// (also registered again by the mode after a sign-out reset: consentedProperties). A page where the recording
	// could not keep to the home content records nothing (no_home_block); the deferred check updates the value.
	const gate = replayGate();
	noteReplayGate(sdk, replayGateReasonFor(gate, homeBlockApplies(document)), true);
	// Dead clicks and exceptions once their chunks are in; set_config restarts both captures.
	onIdleAfterLoad(() => {
		void loadAcceptedExtensions().then((ok) => {
			if (!ok || !stillActive(sdk)) {
				return;
			}
			// Dead clicks and exceptions only on a signed-out surface; a later sign-out switches them on (mode.setSignedIn).
			if (signedOut()) {
				try { sdk.set_config?.(ACCEPTED_EXTENSION_CONFIG); } catch { /* never throws */ }
			}
		});
		// Replay: the recorder chunk, then a recording only while signed out and only for a visible load.
		// A gated device does not even download the recorder.
		if (gate) {
			probe('replay', `skipped ${gate}`);
			return;
		}
		startReplayWhenIdle(sdk, 'started');
	});
}

/**
 * Every condition a recording needs, checked together each time one may start: `sdk` is still the active
 * consented instance, the surface is a known signed-out one, the load is visible, and the device is not gated.
 *
 * @param sdk - The consented instance the recording would belong to.
 * @returns True when the recording may start now.
 */
function replayAllowed(sdk: SdkLike): boolean {
	return stillActive(sdk) && signedOut() && Boolean(host?.visibleLoad()) && replayGate() === null;
}

/**
 * Load the recorder, then start the recording in its own idle period (rrweb takes the full snapshot inside the
 * start), re-checking every condition (replayAllowed) when it runs. Where the recording could not keep to the home
 * content (homeBlockApplies), the recorder is not even downloaded; startReplay checks again when it starts.
 *
 * @param sdk - The consented instance.
 * @param label - The probe outcome when it starts: 'started' for a first recording, 'resumed' after a sign-out.
 */
function startReplayWhenIdle(sdk: SdkLike, label: 'started' | 'resumed'): void {
	// The deferred check: the home root may have mounted (or gone) since arming, so the gate value follows it.
	const hasHomeBlock = homeBlockApplies(document);
	noteReplayGate(sdk, replayGateReasonFor(replayGate(), hasHomeBlock));
	if (!hasHomeBlock) {
		probe('replay', 'skipped no_home_block');
		return;
	}
	void loadRecorder().then((ok) => {
		if (!ok) {
			return;
		}
		inIdle(() => {
			if (!replayAllowed(sdk)) {
				return;
			}
			let outcome = `not ${label}`;
			if (startReplay(sdk, document)) {
				outcome = label;
			}
			probe('replay', outcome);
		});
	});
}

/** A sign-out on this page load: the recording restarts once a signed-out surface is on screen (resumeSignedOutCapture). */
export function markReplayResumePending(): void {
	isReplayResumePending = true;
}

/**
 * After a sign-out on this page load, restart the recording once HomeApp shows a
 * signed-out surface (the transition screen is gone). The first load's recording
 * starts from armConsented instead.
 */
export function resumeSignedOutCapture(): void {
	const mode = host?.mode();
	if (!isReplayResumePending || !mode || !mode.isConsented()) {
		return;
	}
	const sdk = mode.active();
	if (!replayAllowed(sdk)) {
		return;
	}
	isReplayResumePending = false;
	onIdleAfterLoad(() => {
		startReplayWhenIdle(sdk, 'resumed');
	});
}

/** The capture mode follows every consent change, in this tab or another; a decision made here is reported. */
function onConsentChange(state: ConsentState, origin: ConsentOrigin = 'local'): void {
	quietly(() => {
		followConsent(state, origin);
	});
}

/**
 * onConsentChange's work: the capture mode follows the new state, a withdrawal starts a new journey key, an
 * acceptance continues the journey on the consented instance, and the tab that decided reports consent:decision.
 *
 * @param state - The new consent state.
 * @param origin - 'local' for a decision in this tab, 'external' for another tab's.
 */
function followConsent(state: ConsentState, origin: ConsentOrigin): void {
	if (!host) {
		return;
	}
	const mode = host.mode();
	const wasConsented = !!mode?.isConsented();
	mode?.apply(state);
	const isConsentedNow = !!mode?.isConsented();
	// A withdrawal (this tab or another) continues under a new journey key: nothing the cookieless instance sends
	// from here on, the withdrawal itself included, joins this load's consented (possibly identified) events.
	if (wasConsented && !isConsentedNow) {
		host.register({ rr_journey: host.freshJourneyKey() });
	}
	if (mode && state === 'accepted' && isConsentedNow) {
		followAcceptance(mode, wasConsented);
	}
	// A signed-in visitor who accepts: identified by the opaque id from here on.
	if (state === 'accepted') {
		host.identify();
	}
	// The tab that decided reports the decision; a tab that followed it through storage does not.
	if (origin === 'external' || state === 'undecided') {
		return;
	}
	let choice: ConsentState | 'withdrawn' = state;
	if (isWithdrawing()) {
		choice = 'withdrawn';
	}
	host.send(EV.CONSENT_DECISION, { choice, version: CONSENT_VERSION });
}

/**
 * An acceptance the capture mode now follows: accepted mid-visit (this tab or another), the journey continues on
 * the consented instance, once; and a visitor who accepts after the web-vitals extension loaded is measured by the
 * consented instance from here on.
 *
 * @param mode - The capture mode, now on the consented instance.
 * @param wasConsented - Whether the consented instance was active before this change.
 */
function followAcceptance(mode: CaptureMode, wasConsented: boolean): void {
	const isMidVisitAccept = Boolean(host && host.sdkStarted()) && !wasConsented && !hasBridged;
	if (isMidVisitAccept) {
		continueOnConsented(mode.active());
	}
	if (consentedVitals()) {
		enableWebVitals(mode.active());
	}
}

/**
 * The bridge: the cookieless half of this page load gets consent:handoff (funnels leave that session
 * out), the consented session is marked rr_continued_visit (session counts leave it out), and the page views
 * and section views already sent are re-sent on the consented instance, in order, marked rr_bridged, so the
 * consented session holds the whole journey from landing. Once per page load.
 */
function continueOnConsented(sdk: SdkLike): void {
	hasBridged = true;
	const steps = planBridge(bridgeLog.take());
	quietly(() => {
		// The transport's own event: stamped 'shell' now that the consent machinery is shell-owned.
		posthog.capture(EV.CONSENT_HANDOFF, { bridged_events: steps.length, app: 'shell' });
	});
	quietly(() => {
		const sessionId = sdk.get_session_id?.();
		if (typeof sessionId === 'string' && sessionId) {
			sdk.register_for_session?.({ [CONTINUED_KEY]: sessionId });
		}
	});
	const now = Date.now();
	for (const step of steps) {
		let options: CaptureOptions | undefined;
		if (step.offsetMs !== null) {
			options = { timestamp: new Date(now + step.offsetMs) };
		}
		quietly(() => {
			sdk.capture(step.event, step.properties, options);
		});
	}
}

/**
 * Follow the consent record: this tab's decisions, and another tab's (relayed
 * by consentState's storage watcher). Called once by the transport when it
 * arms; the read/decide API itself lives in consentState.ts, chunk-free.
 */
export function watchConsent(): void {
	consent.subscribe(onConsentChange);
}

/** Captures consent:shown once per page load, when the banner renders. */
export function trackConsentShown(): void {
	const h = host;
	if (!h || !h.ensureInit() || hasSentConsentShown) {
		return;
	}
	hasSentConsentShown = true;
	quietly(() => {
		h.send(EV.CONSENT_SHOWN, {});
	});
}
