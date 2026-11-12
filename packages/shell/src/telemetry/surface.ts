// =============================================================================
// Signed-out surface allowlist. Rich capture - session replay, heatmaps,
// click autocapture, rage clicks, dead clicks, dead swipes and exception
// reports - is allowed only on a surface known to be signed out. "Unknown" counts as signed in, so the
// default is closed. The gate below is the consented instance's before_send:
// whatever an extension still emits after the switch-off (the replay buffer
// flushed by stopSessionRecording, a dead-click timer, a late heatmap batch,
// an exception caught before the switch-off, an event already queued) is
// dropped while the surface is not signed out. An event that describes a
// clicked element is also dropped unless the element sits inside the home
// remote's root: the shell's surfaces (its debug panel among them) are outside
// it, whatever their styling.
// Pure; unit-tested under node:test.
// =============================================================================

/** Events that describe page content or pointer activity (an exception's message and stack can carry page text): signed-out surfaces only. */
export const RICH_EVENTS: ReadonlySet<string> = new Set(['$snapshot', '$autocapture', '$rageclick', '$dead_click', '$dead_swipe', '$$heatmap', '$exception']);

/** Events that describe a clicked element (its chain of ancestors, with their attributes and text). */
export const ELEMENT_EVENTS: ReadonlySet<string> = new Set(['$autocapture', '$rageclick', '$dead_click', '$dead_swipe']);

/** The attribute the home remote renders on its own root element (HomeApp); the shell renders its surfaces outside it. */
export const HOME_ROOT_ATTRIBUTE = 'data-rr-home-root';

/**
 * The home root as an attribute key of the serialised element chain: right after an element's ':' or after the
 * closing quote of the attribute before it (posthog-js escapes every quote inside a value, so a value that only
 * contains this text never matches).
 */
const HOME_ROOT_IN_CHAIN = new RegExp(`(?:^|:|[^\\\\]")attr__${HOME_ROOT_ATTRIBUTE}="`);

type Named = { event?: unknown; properties?: unknown } | null;

/**
 * Whether a clicked element sits inside the home root: posthog-js lists the element and every ancestor up to the
 * body, with their attributes, in `$elements_chain` (or in `$elements` before it serialises them).
 *
 * @param properties - The event's properties.
 * @returns True when the chain holds the home root; false for any other chain, or none.
 */
export function isInsideHome(properties: unknown): boolean {
	if (!properties || typeof properties !== 'object') {
		return false;
	}
	const props = properties as { $elements_chain?: unknown; $elements?: unknown };
	if (typeof props.$elements_chain === 'string' && HOME_ROOT_IN_CHAIN.test(props.$elements_chain)) {
		return true;
	}
	if (!Array.isArray(props.$elements)) {
		return false;
	}
	return props.$elements.some((el) => {
		return Boolean(el) && typeof el === 'object' && `attr__${HOME_ROOT_ATTRIBUTE}` in (el as object);
	});
}

/**
 * A before_send for the consented instance: rich events are dropped unless `signedOut()` is true at send time, and
 * an element event is dropped unless its element sits inside the home root; every other event goes through `next`.
 *
 * @param signedOut - Whether the surface is known to be signed out now.
 * @param next - The rest of the before_send chain.
 * @returns The gated before_send.
 */
export function richEventGate<T extends Named>(signedOut: () => boolean, next: (event: T) => T): (event: T) => T | null {
	return (event: T): T | null => {
		if (!event) {
			return event;
		}
		if (typeof event.event !== 'string') {
			return next(event);
		}
		if (RICH_EVENTS.has(event.event) && !signedOut()) {
			return null;
		}
		if (ELEMENT_EVENTS.has(event.event) && !isInsideHome(event.properties)) {
			return null;
		}
		return next(event);
	};
}
