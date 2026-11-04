// =============================================================================
// The consent state, chunk-free: the ONE ConsentStore instance (the device's
// rr:consent record), the storage watcher, and the read/decide API the
// banner, the Settings Privacy section and useConsent() work against.
//
// Deliberately free of posthog-js: consent must be readable and decidable
// before the lazy transport chunk loads (and the capture mode must be able to
// follow a decision made then). The transport chunk subscribes to this store
// when it arms (consented.ts: followConsent); nothing here knows about
// instances or capture. Pure, no DOM at module scope; the storage listener is
// installed by watchConsentStorage(), once, by the TelemetryHost.
// =============================================================================

import { ConsentStore, CONSENT_KEY, CONSENT_TTL_MS, parseConsent, type ConsentChoice, type ConsentOrigin, type ConsentState } from './consent';
import { privacySignalOn } from 'rocketride/analytics';

/** The device's consent record (rr:consent); it drives the banner, the settings toggle and the capture mode. */
export const consentStore = new ConsentStore();

/** True while withdrawConsent records the decline, so consent:decision reports 'withdrawn'. */
let withdrawing = false;

/** @returns Whether the decline being recorded right now is a withdrawal of an earlier opt-in. */
export function isWithdrawing(): boolean {
	return withdrawing;
}

/**
 * The visitor's consent state (our own record).
 *
 * @returns The choice, or 'undecided' when nothing valid is stored.
 */
export function getConsentState(): ConsentState {
	return consentStore.state();
}

/**
 * Record the visitor's choice; every subscriber (the transport's capture mode
 * among them) follows. With a browser privacy signal on, an opt-in is not
 * stored: nothing would be captured, and the record would claim otherwise.
 *
 * @param choice - 'accepted' or 'rejected'.
 */
export function decideConsent(choice: ConsentChoice): void {
	if (choice === 'accepted' && privacySignalOn()) {
		return;
	}
	try {
		consentStore.decide(choice);
	} catch {
		/* never throws */
	}
}

/**
 * Withdraw an opt-in ("No thanks" in the reopened banner, or the Settings
 * toggle): the decline is stored, so the visitor is not asked again; the
 * transport's capture mode follows (teardown, storage scrub, fresh journey);
 * consent:decision reports choice 'withdrawn'. Without an opt-in it is a
 * plain decline.
 */
export function withdrawConsent(): void {
	if (consentStore.state() !== 'accepted') {
		decideConsent('rejected');
		return;
	}
	withdrawing = true;
	try {
		consentStore.decide('rejected');
	} catch {
		/* never throws */
	}
	withdrawing = false;
}

/**
 * Listen for consent changes, in this tab ('local') or another ('external');
 * the banner uses it to close after a decision and to reopen after another
 * tab's withdrawal, the Settings toggle to render the current state.
 *
 * @param fn Called with the new state and where the change came from.
 * @returns Unsubscribes `fn`.
 */
export function subscribeConsent(fn: (state: ConsentState, origin: ConsentOrigin) => void): () => void {
	return consentStore.subscribe(fn);
}

/**
 * Accepted consent expiry in milliseconds, or null when not accepted/valid.
 * Pure localStorage read — experiment gates (home-ui's roulette) use it
 * without starting any SDK.
 */
export function consentExpiresAt(): number | null {
	const record = parseConsent(JSON.stringify(consentStore.record()), Date.now());
	return record?.choice === 'accepted' ? record.at + CONSENT_TTL_MS : null;
}

/** Follow another tab's decision or withdrawal (its storage event). Installed once, by the TelemetryHost. */
export function watchConsentStorage(): void {
	window.addEventListener('storage', (e) => {
		if (e.key === null || e.key === CONSENT_KEY) {
			consentStore.reload();
		}
	});
}
