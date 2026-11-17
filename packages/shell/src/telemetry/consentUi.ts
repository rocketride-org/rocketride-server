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
