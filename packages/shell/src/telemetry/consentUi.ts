// =============================================================================
// Consent UI rules - the footer's "Privacy settings" link asks the banner to
// open (the banner subscribes), and the Settings Privacy section's two
// decisions: when it shows and what its toggle may do. Withdrawal must stay as
// reachable as consent, whatever switched capture off. Pure, tiny, no DOM.
// =============================================================================

import type { ConsentState } from './consent';

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

/**
 * What the Settings Privacy toggle does when pressed. A privacy signal blocks
 * only the opt-in: a visitor who accepted before the signal came on can always
 * withdraw, or the stored acceptance would take effect again once it goes away.
 *
 * @param state - The visitor's consent state.
 * @param signal - Whether a browser privacy signal (DNT, GPC) is on.
 * @returns 'withdraw' for an acceptance, 'accept' otherwise, null when the opt-in is blocked.
 */
export function privacyToggleAction(state: ConsentState, signal: boolean): 'withdraw' | 'accept' | null {
	if (state === 'accepted') {
		return 'withdraw';
	}
	if (signal) {
		return null;
	}
	return 'accept';
}

/**
 * Whether the Settings overlay shows the Privacy section: whenever telemetry is
 * live, and also whenever an acceptance is on record, so its withdrawal stays
 * reachable while capture is off (a privacy signal at load, a failed init).
 *
 * @param telemetryLive - Whether telemetry is live this page load (host.ts telemetryEnabled).
 * @param state - The visitor's consent state.
 * @returns True when the section is shown.
 */
export function privacySectionVisible(telemetryLive: boolean, state: ConsentState): boolean {
	return telemetryLive || state === 'accepted';
}
