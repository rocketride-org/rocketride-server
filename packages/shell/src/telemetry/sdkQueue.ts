// =============================================================================
// SDK queue: the captures made before posthog-js starts, replayed at its start —
// plus the sessionStorage HOLD that lets them survive the page being torn down
// first.
//
// The TelemetryHost starts posthog-js after the first frame (its init cost
// would otherwise push back the phone LCP), and the posthog chunk itself is
// lazy (fetched only when the probe served a key). Until the start, every
// capture waits here with the super properties as they stood when it was made;
// the start replays the queue, then registers the super properties, so a
// property registered in between (is_authed, rr_traffic_activated) is never
// applied to an earlier event by the instance the queue starts.
//
// TEARDOWN SURVIVAL: home-ui's original queue could rely on a statically
// imported posthog-js — pagehide started the SDK synchronously and beaconed
// the replay. A lazy chunk cannot promise that: an OAuth redirect or tab close
// that lands before the chunk does would drop the queue. So every pending
// capture is also MIRRORED to sessionStorage at enqueue time (never at
// pagehide — teardown handlers don't run on crash/kill), with the semantics
// the retired TelemetryChannel proved: bounded buffer, TTL, per-entry ids, a
// corrupt mirror reads as empty. The next page load of the tab drains the
// inherited entries into the SDK at ITS start — with their original timestamps
// and their id as the event uuid (drain order: capture first, clear after).
// The id is minted as an RFC 4122-shaped UUID because posthog-js keeps an
// explicit uuid only when it matches that shape (it mints a fresh one
// otherwise), and PostHog drops an event whose uuid it already ingested — so
// an at-least-once replay of the same entry dedupes instead of double-counting. A pending
// capture and its mirrored entry share ONE uuid, and this load's replay passes it too, so a
// load that captured and then died before clearing the mirror is deduped by the next load's
// drain. This load's own replay keeps start-time stamps as before: posthog-js keys its page-view
// state on the $pageview's timestamp, and an explicit earlier timestamp broke
// web vitals and replay. Accepted loss windows are stated in the plan: a tab
// closed forever before the chunk lands, storage-disabled visitors, and
// overflow beyond the bounded hold.
//
// The start runs once, whichever trigger comes first (the frame, the fallback
// timer, a click, the page leaving); a failed init empties the queue and the
// hold and drops every later capture. Pure, no DOM: the SDK calls and the
// storage are injected and unit-tested under node:test.
// =============================================================================

import type { CaptureOptions, PostHog } from 'posthog-js';
import { sanitizeEvent } from './sanitize';

/** The posthog-js calls the queue drives; a posthog-js instance satisfies it as is. */
export type SdkLike = Pick<PostHog, 'capture' | 'register'>;

/** The slice of the Web Storage interface the hold uses; injectable for tests. */
export type HoldStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

/** What the queue needs from its owner. */
export type SdkQueueDeps = {
	/** Initialise the SDK. Throws when it cannot start. */
	init(): void;
	/** The instance a capture goes to once the SDK started. */
	target(): SdkLike;
	/** Register super properties on the started SDK. */
	register(props: Record<string, unknown>): void;
	/** init threw: nothing is sent from this page load. */
	onFailure(): void;
	/** Where the hold is mirrored (default: the tab's sessionStorage; null = memory only). */
	storage?: HoldStorage | null;
	/** The clock (tests inject one). */
	now?: () => number;
};

/** The most captures held before the start; later ones are dropped. */
export const MAX_PENDING = 200;
/** The most captures the sessionStorage hold mirrors; oldest are dropped first. */
export const HOLD_MAX = 32;
/** A held capture older than this is discarded at drain: it no longer belongs to the visit. */
export const HOLD_TTL_MS = 30 * 60 * 1000;
/** sessionStorage key of the hold (per tab; survives the OAuth round trip). */
export const HOLD_STORAGE_KEY = 'rr:shell:capture-hold';

/** A capture waiting for this load's start; `id` is the uuid its mirrored entry carries too. */
type Pending = { event: string; props: Record<string, unknown>; options?: CaptureOptions; id: string };
/** A mirrored capture: what a next page load needs to replay it truthfully. */
type Held = { event: string; props: Record<string, unknown>; ts: number; id: string };

/** The shape posthog-js requires of an explicit capture uuid (it replaces anything else with a fresh one). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of Web Crypto the uuid minting uses; injectable for tests. */
export type UuidCrypto = { randomUUID?: () => string; getRandomValues?: <T extends Uint8Array>(array: T) => T };

/**
 * Whether `id` is a uuid posthog-js keeps as the event uuid.
 *
 * @param id - The candidate.
 * @returns True for an 8-4-4-4-12 hex string.
 */
export function isEventUuid(id: unknown): id is string {
	return typeof id === 'string' && UUID_RE.test(id);
}

/**
 * Mint a v4 uuid for a held capture: crypto.randomUUID where available (secure contexts), else a
 * getRandomValues-based v4, else a Math.random-based v4 — always 8-4-4-4-12 so posthog-js keeps it.
 *
 * @param c - The crypto to use (default: globalThis.crypto; null = none).
 * @returns The uuid.
 */
export function newEventUuid(c: UuidCrypto | null | undefined = (globalThis as { crypto?: UuidCrypto }).crypto): string {
	try {
		const id = c?.randomUUID?.();
		if (isEventUuid(id)) return id.toLowerCase();
	} catch {
		/* not a secure context, or unsupported: fall through */
	}
	const bytes = new Uint8Array(16);
	let filled = false;
	try {
		if (c?.getRandomValues) {
			c.getRandomValues(bytes);
			filled = true;
		}
	} catch {
		/* fall through to Math.random */
	}
	if (!filled) {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The tab's sessionStorage, or null where there is none or its accessor throws (storage disabled). */
function defaultStorage(): HoldStorage | null {
	try {
		const s = (globalThis as { sessionStorage?: HoldStorage }).sessionStorage;
		return s && typeof s.getItem === 'function' ? s : null;
	} catch {
		return null; // the accessor itself throws when storage is disabled
	}
}

/** Holds captures and super properties until the SDK starts, then hands everything to it. */
/**
 * The properties as JSON serialization would send them, owned by the queue: nested objects copied, custom
 * serialization (a URL, a Date) applied, functions and undefined dropped. Null when they cannot be
 * serialized (a cycle), which the caller treats as "do not hold".
 *
 * @param props - The caller's properties.
 * @returns An owned copy, or null.
 */
function ownedSnapshot(props: Record<string, unknown>): Record<string, unknown> | null {
try {
	const copy: unknown = JSON.parse(JSON.stringify(props));
	return copy && typeof copy === 'object' && !Array.isArray(copy) ? (copy as Record<string, unknown>) : null;
} catch {
	return null;
}
}

export class SdkQueue {
	private readonly deps: SdkQueueDeps;
	private readonly pending: Pending[] = [];
	private readonly superProps: Record<string, unknown> = {};
	private state: 'queued' | 'started' | 'failed' = 'queued';
	/** Captures an earlier page load of the tab mirrored and never delivered; read once, at construction. */
	private inherited: Held[];
	/** This page load's mirrored entries (parallel to `pending`). */
	private held: Held[] = [];
	private readonly storage: HoldStorage | null;
	private readonly now: () => number;

	/**
	 * @param deps - The SDK calls: init, the capture target, register, the failure report, and
	 *               (optional) the hold's storage and clock.
	 */
	constructor(deps: SdkQueueDeps) {
		this.deps = deps;
		this.storage = 'storage' in deps ? deps.storage || null : defaultStorage();
		this.now = deps.now ?? (() => Date.now());
		const { entries, normalized } = this.readMirror();
		this.inherited = entries;
		if (normalized) {
			// A legacy entry got a fresh uuid: write it back now, so a load that crashes mid-drain and the
			// load after it replay the SAME uuid (and dedupe) instead of minting another one each time.
			this.persist();
		}
	}

	/**
	 * Whether the SDK started.
	 *
	 * @returns True once start() initialised it; captures then go straight to it.
	 */
	get started(): boolean {
		return this.state === 'started';
	}

	/**
	 * Every super property registered so far.
	 *
	 * @returns A copy: registered on the SDK at its start, and on the consented instance when an opt-in creates it.
	 */
	properties(): Record<string, unknown> {
		return { ...this.superProps };
	}

	/**
	 * Capture an event: on the SDK once it started; queued AND mirrored before, with the super
	 * properties of this moment.
	 *
	 * @param event - The event name.
	 * @param props - The event's own properties (none by default).
	 * @param options - posthog-js capture options (the beacon transport).
	 */
	capture(event: string, props: Record<string, unknown> = {}, options?: CaptureOptions): void {
		if (this.state === 'started') {
			this.deps.target().capture(event, props, options);
			return;
		}
		if (this.state === 'failed' || this.pending.length >= MAX_PENDING) {
			return;
		}
		// An OWNED snapshot, then reduced HERE, before anything is held: the mirror below lands in
		// storage at once, and the transport's before_send runs only when the SDK captures the event
		// later (or never, when its chunk does not load), so a callback URL in an app's properties
		// must not wait for it. The snapshot is what JSON serialization would send (a URL instance
		// becomes its address, nested objects are copied), so the caller's own objects are neither
		// mutated by the reduction nor able to change the held event afterwards. Fails closed like
		// before_send: an event that cannot be serialized or reduced is not held.
		const reduced = sanitizeEvent({ event, properties: ownedSnapshot({ ...this.superProps, ...props }) });
		if (!reduced || !reduced.properties) {
			return;
		}
		const stamped = reduced.properties;
		// One uuid for both representations: the replay below and a next load's drain of the mirror
		// send the same event uuid, so PostHog dedupes a capture whose mirror was never cleared.
		const id = newEventUuid();
		this.pending.push({ event, props: stamped, options, id });
		// Mirror AT ENQUEUE: a redirect or crash a moment later still finds the entry.
		const ts = this.now();
		this.held.push({ event, props: stamped, ts, id });
		this.persist();
	}

	/**
	 * Register super properties: kept for the start, and registered on the SDK at once when it started.
	 *
	 * @param props - The properties to add to every later event.
	 */
	register(props: Record<string, unknown>): void {
		Object.assign(this.superProps, props);
		if (this.state === 'started') {
			this.deps.register(props);
		}
	}

	/**
	 * Start the SDK; drain the inherited hold; replay this load's queue, in order; then register the
	 * super properties. Runs once.
	 *
	 * Inherited entries (an earlier page load's mirror — the OAuth round trip's other half) are
	 * replayed FIRST, each with its original timestamp and its id (a v4 uuid, which posthog-js keeps)
	 * as the event uuid: at-least-once with dedupe, and a prior load's event is never stamped with this load's time. This load's own
	 * entries keep start-time stamps — posthog-js keys page-view state on the $pageview timestamp —
	 * and carry the uuid their mirrored entry holds.
	 * The mirror is cleared only after the drain captured everything (capture first, clear after).
	 *
	 * @param unloading - The page is going away: the replay goes out by sendBeacon, not the batch queue.
	 */
	start(unloading = false): void {
		if (this.state !== 'queued') {
			return;
		}
		try {
			this.deps.init();
		} catch {
			this.state = 'failed';
			this.pending.length = 0;
			this.held.length = 0;
			this.inherited = [];
			this.clearMirror(); // telemetry is off this load; a stale hold must not outlive it
			this.deps.onFailure();
			return;
		}
		this.state = 'started';
		const target = this.deps.target();
		const now = this.now();
		for (const entry of this.inherited.splice(0)) {
			if (now - entry.ts > HOLD_TTL_MS) {
				continue; // expired: it can no longer be attributed to the visit it belongs to
			}
			try {
				target.capture(entry.event, entry.props, { timestamp: new Date(entry.ts), uuid: entry.id, ...(unloading ? { transport: 'sendBeacon' as const } : {}) });
			} catch {
				/* the SDK boundary: one event that throws does not stop the drain */
			}
		}
		for (const entry of this.pending.splice(0)) {
			// The mirrored entry's uuid: a crash between this capture and clearMirror() is deduped at the next drain.
			const options: CaptureOptions = { ...entry.options, uuid: entry.id };
			if (unloading) {
				// One beacon per event: posthog-js has no public batched beacon, and the queue holds only what was
				// captured before the first frame, a few small events, well under the in-flight beacon budget.
				options.transport = 'sendBeacon';
			}
			// Replayed at the start time, not the original time: posthog-js keys its page-view state (which web
			// vitals and replay read) on the $pageview's timestamp, and an earlier explicit timestamp broke both. The
			// queue spans one frame.
			try {
				target.capture(entry.event, entry.props, options);
			} catch {
				/* the SDK boundary: one event that throws does not stop the replay */
			}
		}
		this.held.length = 0;
		this.clearMirror(); // capture first, clear after: a crash mid-drain replays (uuid dedupes)
		this.deps.register(this.properties());
	}

	/**
	 * A non-consuming view of what waits for the start: inherited entries (an
	 * earlier page load's mirror) first, then this load's pending captures —
	 * the channel's peek(), kept for the same reasons (tests, debug surfaces).
	 *
	 * @returns Copies of every waiting capture, oldest first.
	 */
	peekPending(): Array<{ event: string; props: Record<string, unknown>; options?: CaptureOptions }> {
		return [
			...this.inherited.map((h) => ({ event: h.event, props: { ...h.props } })),
			...this.pending.map((p) => ({ event: p.event, props: { ...p.props }, ...(p.options ? { options: { ...p.options } } : {}) })),
		];
	}

	/**
	 * Drop the hold, this load's pending captures and the mirror without delivering. A sign-out calls
	 * this: captures observed for one session must never be forwarded under the next account that
	 * signs in on this tab, and a later start would otherwise replay the pending ones.
	 */
	clearHold(): void {
		this.inherited = [];
		this.pending.length = 0;
		this.held.length = 0;
		this.clearMirror();
	}

	/** Mirror the held captures (inherited first, bounded) to storage. Never throws. */
	private persist(): void {
		if (!this.storage) return;
		try {
			this.storage.setItem(HOLD_STORAGE_KEY, JSON.stringify([...this.inherited, ...this.held].slice(-HOLD_MAX)));
		} catch {
			/* storage full or unavailable: the in-memory queue still serves this page load */
		}
	}

	/**
	 * Read what an earlier page load of the tab mirrored: valid entries within the TTL only; a corrupt
	 * mirror reads as empty. An entry whose id is missing or not uuid-shaped (a mirror written before
	 * ids were uuids) gets a fresh uuid HERE, once per load and never at replay, so every capture of
	 * that entry carries the same uuid; posthog-js would otherwise mint a new one per capture.
	 *
	 * @returns The entries, and whether any id was normalized (the constructor then rewrites the mirror).
	 */
	private readMirror(): { entries: Held[]; normalized: boolean } {
		const empty = { entries: [] as Held[], normalized: false };
		if (!this.storage) return empty;
		try {
			const raw = this.storage.getItem(HOLD_STORAGE_KEY);
			if (!raw) return empty;
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return empty;
			const now = this.now();
			const out: Held[] = [];
			let normalized = false;
			for (const item of parsed) {
				if (!item || typeof item !== 'object') continue;
				const { event, props, ts, id } = item as Partial<Held>;
				if (typeof event !== 'string' || event === '' || typeof ts !== 'number' || !Number.isFinite(ts)) continue;
				if (now - ts > HOLD_TTL_MS || ts - now > 60_000) continue; // expired, or written by a clock ahead of this one
				const uuid = isEventUuid(id) ? id : newEventUuid();
				normalized ||= uuid !== id;
				out.push({ event, props: props && typeof props === 'object' ? { ...props } : {}, ts, id: uuid });
			}
			return { entries: out, normalized };
		} catch {
			return empty; // unreadable or corrupt mirror: nothing to replay
		}
	}

	/** Remove the mirror from storage. Never throws. */
	private clearMirror(): void {
		if (!this.storage) return;
		try {
			this.storage.removeItem(HOLD_STORAGE_KEY);
		} catch {
			/* unavailable */
		}
	}
}
