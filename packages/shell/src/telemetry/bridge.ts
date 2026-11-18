// =============================================================================
// CONSENT BRIDGE - one journey across the accept moment.
//
// Accepting mid-visit moves capture from the cookieless instance to the
// consented one, a new identity with a new session. So that this session holds
// the whole journey from landing, the page views and section views the page
// load already sent are sent once more on the consented instance, marked
// rr_bridged. The cookieless session gets one consent:handoff (funnels leave
// that session out); every event of the consented session that continues the
// visit carries rr_continued_visit (session and visitor counts leave it out,
// since the cookieless session already counted the visit). Nothing here is
// stored: the record lives in memory for one page load. Pure; unit-tested
// under node:test (test/unit/bridge.test.ts).
// =============================================================================

/** The events a bridge re-sends: what funnels and section reach are built from. */
export const BRIDGE_EVENTS: ReadonlySet<string> = new Set(['$pageview', 'section:view']);

/** At most this many events are kept for one page load (the landing page view is the first one kept). */
export const MAX_BRIDGED = 100;

/** Marks a re-sent copy. */
export const BRIDGED_KEY = 'rr_bridged';

/** Session-scoped on the consented instance: the id of the session that continues a cookieless visit. */
export const CONTINUED_KEY = 'rr_continued_visit';

/**
 * Properties that belong to the instance that sent the original (its identity, session, page-view
 * state, SDK bookkeeping) or that the consented instance sets itself: never copied.
 */
const INSTANCE_KEYS: ReadonlySet<string> = new Set([
	'distinct_id', 'token', '$session_id', '$window_id', '$pageview_id', '$device_id', '$cookieless_mode',
	'$is_identified', '$process_person_profile', '$insert_id', '$time', '$config_defaults', '$duration',
	'consent_state', '$set', '$set_once', '$unset', '$groups', '$sent_at',
]);
const INSTANCE_PREFIXES = ['$prev_pageview_', '$lib', '$sdk_debug'];

/** A page view or section view as it was sent, with the properties a bridge may copy (copyableProperties). */
export type RecordedEvent = {
	event: string;
	properties: Record<string, unknown>;
};

/**
 * The properties of a sent event that describe the page and the visit, without the sending instance's own.
 *
 * @param props The event's properties as sent, or nothing.
 * @returns A copy without INSTANCE_KEYS and the keys starting with INSTANCE_PREFIXES.
 */
export function copyableProperties(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!props || typeof props !== 'object') {
		return out;
	}
	for (const [key, value] of Object.entries(props)) {
		if (INSTANCE_KEYS.has(key)) {
			continue;
		}
		const isInstancePrefixed = INSTANCE_PREFIXES.some((prefix) => {
			return key.startsWith(prefix);
		});
		if (isInstancePrefixed) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

/** Keeps, in memory, the events of this page load that a later bridge would re-send. */
export class BridgeLog {
	private readonly entries: RecordedEvent[] = [];
	private isClosed = false;

	/**
	 * Record an event as it was sent (after sanitising). Only bridge events, at most MAX_BRIDGED, and nothing once
	 * the log was taken.
	 *
	 * @param event The event as sent, or null when it was dropped.
	 */
	record(event: { event?: unknown; properties?: Record<string, unknown> | null } | null): void {
		if (this.isClosed || !event || typeof event.event !== 'string' || !BRIDGE_EVENTS.has(event.event)) {
			return;
		}
		if (this.entries.length >= MAX_BRIDGED) {
			return;
		}
		this.entries.push({ event: event.event, properties: copyableProperties(event.properties) });
	}

	/**
	 * The recorded events, once: the log stops recording (one bridge per page load).
	 *
	 * @returns The recorded events in the order they were sent; empty on a second call.
	 */
	take(): RecordedEvent[] {
		this.isClosed = true;
		return this.entries.splice(0);
	}
}

/** One event the bridge re-sends on the consented instance (planBridge), marked rr_bridged. */
export type BridgeStep = {
	event: string;
	properties: Record<string, unknown>;
	/**
	 * Milliseconds from the bridge moment for an explicit timestamp; null for the last page view,
	 * which is captured at its real time: posthog-js keys its page-view state (web vitals, replay)
	 * on the latest $pageview's timestamp, and an explicit earlier one broke both.
	 */
	offsetMs: number | null;
};

/** Gap between the last page view (captured at its real time) and the events that followed it. */
export const AFTER_LAST_PAGEVIEW_MS = 50;

/**
 * Order and timing of the re-sent events: the original order, every event before the last page
 * view a millisecond apart just before the bridge moment, the last page view at its real time,
 * and its section views just after it. Each copy is marked rr_bridged.
 *
 * @param recorded The events the log took, in the order they were sent.
 * @returns One step per event, in the same order.
 */
export function planBridge(recorded: RecordedEvent[]): BridgeStep[] {
	let last = -1;
	for (let i = 0; i < recorded.length; i++) {
		if (recorded[i].event === '$pageview') {
			last = i;
		}
	}
	const steps: BridgeStep[] = [];
	for (let i = 0; i < recorded.length; i++) {
		let offsetMs: number | null;
		if (last < 0) {
			// no page view recorded: every event a millisecond apart, just before the bridge moment
			offsetMs = -(recorded.length - i);
		} else if (i < last) {
			offsetMs = -(last - i);
		} else if (i === last) {
			offsetMs = null; // the last page view keeps its real time
		} else {
			offsetMs = AFTER_LAST_PAGEVIEW_MS + (i - last);
		}
		steps.push({ event: recorded[i].event, properties: { ...recorded[i].properties, [BRIDGED_KEY]: true }, offsetMs });
	}
	return steps;
}

/**
 * The consented instance's before_send step for rr_continued_visit: the session-scoped value is
 * the session that continued the cookieless visit. On that session's events it becomes `true`;
 * on any later session (the stored value outlives a session rotation) it is removed.
 *
 * @param event The event about to be sent, or null when it is dropped.
 * @returns The same event, with rr_continued_visit set to true or removed.
 */
export function normalizeContinued<T extends { properties?: Record<string, unknown> | null } | null>(event: T): T {
	if (!event || !event.properties || typeof event.properties !== 'object') {
		return event;
	}
	const props = event.properties as Record<string, unknown>;
	if (!(CONTINUED_KEY in props)) {
		return event;
	}
	const value = props[CONTINUED_KEY];
	const isContinuedSession = value === true || (typeof value === 'string' && value === props.$session_id);
	if (isContinuedSession) {
		props[CONTINUED_KEY] = true;
	} else {
		delete props[CONTINUED_KEY];
	}
	return event;
}

/**
 * A per-page-load journey key, never stored by the site (an opted-in instance persists its super properties):
 * joins the cookieless and the consented halves of one load.
 *
 * @param random Random numbers in [0, 1), for the fallback key.
 * @param uuid   A UUID source (crypto.randomUUID), used when it is given and works.
 * @returns A UUID, or 32 random hex digits.
 */
export function newJourneyKey(random: () => number = Math.random, uuid?: () => string): string {
	if (uuid) {
		try {
			return uuid();
		} catch {
			// crypto.randomUUID throws outside a secure context: the random hex below stands in
		}
	}
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += Math.floor(random() * 16).toString(16);
	}
	return out;
}
