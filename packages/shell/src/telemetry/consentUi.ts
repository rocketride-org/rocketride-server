// =============================================================================
// Consent banner signal - the footer's "Privacy settings" link asks the banner
// to open; the banner subscribes. Pure, tiny, no DOM.
// =============================================================================

type Listener = () => void;
const listeners = new Set<Listener>();
let pending = false;

/**
 * Ask the consent banner to open. The banner is a lazy chunk mounted once the
 * page has settled, so a request that arrives before it exists is kept until
 * the banner mounts and takes it (`takePendingOpen`).
 */
export function openConsentBanner(): void {
	pending = true;
	for (const fn of Array.from(listeners)) {
		try {
			fn();
		} catch {
			/* never throws */
		}
	}
}

/** The banner takes a request that arrived before it mounted; true at most once per request. */
export function takePendingOpen(): boolean {
	const was = pending;
	pending = false;
	return was;
}

/** What the lazy banner host knows when it decides whether to mount the banner. */
export type ConsentHostInputs = {
	/** A telemetry key is served (false: OSS / keyless, nothing to consent to). */
	hasKey: boolean;
	/** The consent source is the stored record (false: VS Code, the editor's setting governs). */
	storedConsent: boolean;
	/** Telemetry is live this page load (key, no privacy signal, init not failed). */
	telemetryLive: boolean;
	/** The browser sends a privacy signal (DNT / GPC). */
	privacySignal: boolean;
	/** The page has settled (the unprompted mount waits for it). */
	settled: boolean;
	/** The visitor explicitly asked ("Privacy settings" / openConsentBanner). */
	requested: boolean;
};

/**
 * Whether the lazy host mounts the consent banner. Keyless or host-governed:
 * never. Live telemetry: once settled or on request (the banner itself decides
 * whether to prompt). Under a privacy signal telemetry is off, yet an explicit
 * request still mounts the banner — it states that the signal is honoured and
 * offers no opt-in — while nothing is ever shown unasked.
 */
export function shouldMountConsentBanner(i: ConsentHostInputs): boolean {
	if (!i.hasKey || !i.storedConsent) {
		return false;
	}
	if (i.telemetryLive) {
		return i.settled || i.requested;
	}
	return i.privacySignal && i.requested;
}

/**
 * Subscribe to "Privacy settings" requests (the banner and its lazy host do).
 *
 * @param fn - Called on every request to open the banner.
 * @returns Unsubscribes `fn`.
 */
export function onOpenConsentBanner(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Whether a request is waiting for the banner; unlike `takePendingOpen`, it leaves the request in place. */
export function hasPendingOpen(): boolean {
	return pending;
}

/**
 * Subscribe the lazy host (ConsentBannerHost) to "Privacy settings" requests.
 * A request made before the host subscribed is still pending, so `onRequest`
 * runs once at once for it. The request stays pending for the banner to take
 * when it mounts. The host must use this, not `onOpenConsentBanner`, or an
 * early request is missed.
 *
 * @param onRequest - Called for a pending request, then on every new request.
 * @returns Unsubscribes `onRequest`.
 */
export function subscribeConsentHost(onRequest: () => void): () => void {
	const off = onOpenConsentBanner(onRequest);
	if (hasPendingOpen()) {
		try {
			onRequest();
		} catch {
			/* never throws */
		}
	}
	return off;
}
