// =============================================================================
// Consent store - the visitor's choice, stored and watched. The RECORD's
// contract (key, versioned expiring shape, pure parser) lives in the SDK
// (rocketride/analytics consent.ts) — the ONE copy, shared with the sign-in
// path readers that must parse it without booting any analytics; this module
// re-exports it and owns everything stateful: storing a choice, listeners,
// the cross-tab reload. PostHog's internal consent flag is never used.
// Storing the choice is strictly necessary (it is what "remember my answer"
// means), so the record lives in localStorage; when storage throws or is
// unavailable the choice lives in memory for the page. A record stops counting
// at its expiry even on a page left open: while anyone listens, a timer re-reads
// the record when it is due and tells the listeners. Pure: no SDK, no DOM
// beyond the injected storage and timers; unit-tested under node:test.
// =============================================================================

import { CONSENT_KEY, CONSENT_TTL_MS, CONSENT_VERSION, parseConsent, type ConsentChoice, type ConsentRecord, type ConsentState } from 'rocketride/analytics';

export { CONSENT_KEY, CONSENT_TTL_MS, CONSENT_VERSION, parseConsent, type ConsentChoice, type ConsentRecord, type ConsentState };

/** Where the record is kept: localStorage, or a fake in tests. */
export type ConsentStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

/**
 * The page's localStorage, when it is usable.
 *
 * @returns localStorage, or null where there is none or reading it throws.
 */
function defaultStorage(): ConsentStorage | null {
	try {
		const s = (globalThis as { localStorage?: ConsentStorage }).localStorage;
		if (s && typeof s.getItem === 'function') {
			return s;
		}
		return null;
	} catch {
		return null;
	}
}

/** Schedules the expiry re-check; tests inject one. */
export type ConsentTimers = {
	/** Run `fn` after `ms` milliseconds; returns a handle for clear(). */
	set(fn: () => void, ms: number): unknown;
	/** Cancel a pending set(). */
	clear(handle: unknown): void;
};

/** The longest delay setTimeout honours (2^31 - 1 ms); a longer one would fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * The global timers.
 *
 * @returns setTimeout/clearTimeout; a pending check never keeps a non-browser runtime (node:test) alive.
 */
function defaultTimers(): ConsentTimers {
	return {
		set: (fn, ms) => {
			const handle = globalThis.setTimeout(fn, ms);
			(handle as { unref?: () => void }).unref?.();
			return handle;
		},
		clear: (handle) => {
			globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
		},
	};
}

/**
 * Where a state change came from: this page ('local'), or anything this page did not decide
 * ('external'): another tab's storage write, or the record reaching its expiry.
 */
export type ConsentOrigin = 'local' | 'external';

/** ConsentStore's options; tests inject each one. */
export type ConsentStoreOptions = {
	/** Where the record is kept; null keeps it in memory only. Default: localStorage when it is usable. */
	storage?: ConsentStorage | null;
	/** The clock (ms) that stamps and expires records. Default: Date.now. */
	now?: () => number;
	/** The consent version a stored record must carry to count. Default: CONSENT_VERSION. */
	version?: number;
	/** The timers that schedule the expiry re-check. Default: the global setTimeout/clearTimeout. */
	timers?: ConsentTimers;
};

/**
 * The visitor's consent record and its listeners. One per page (consented.ts creates it). A choice
 * made here is stored and reported to the listeners with origin 'local'; another tab's choice reaches
 * it through reload() with origin 'external'. A record that is malformed, of another version or
 * expired reads as undecided.
 */
export class ConsentStore {
	private readonly storage: ConsentStorage | null;
	private readonly now: () => number;
	private readonly version: number;
	private memory: ConsentRecord | null = null;
	/**
	 * True when this page's last decision could not be written: the stored record
	 * (possibly an older 'accepted') is stale, so the page's own decision wins.
	 */
	private writeFailed = false;
	private readonly listeners = new Set<(state: ConsentState, origin: ConsentOrigin) => void>();
	private last: ConsentState | null = null;
	private readonly timers: ConsentTimers;
	/** The pending expiry re-check, armed only while someone listens. */
	private expiryTimer: unknown = null;

	/** @param options Storage, clock and version (each optional; see ConsentStoreOptions). */
	constructor(options?: ConsentStoreOptions) {
		if (options && 'storage' in options) {
			this.storage = options.storage ?? null;
		} else {
			this.storage = defaultStorage();
		}
		this.now = options?.now ?? (() => {
			return Date.now();
		});
		this.version = options?.version ?? CONSENT_VERSION;
		this.timers = options?.timers ?? defaultTimers();
	}

	/**
	 * The visitor's record.
	 *
	 * @returns The stored record if valid, else what this page decided (while valid), else null.
	 */
	record(): ConsentRecord | null {
		// This page's own decision obeys the same version and expiry rules as a stored one.
		const memory = this.validMemory();
		if (this.writeFailed && this.memory) {
			// The store is stale: a reject or withdrawal must not read back as 'accepted'. An expired
			// decision reads as undecided here, never as the stale stored record.
			return memory;
		}
		let raw: string | null = null;
		try {
			if (this.storage) {
				raw = this.storage.getItem(CONSENT_KEY);
			}
		} catch {
			raw = null; // unreadable storage: fall back to the page's own memory
		}
		return parseConsent(raw, this.now(), this.version) ?? memory;
	}

	/**
	 * This page's decision, through the record parser (version, expiry, clock skew).
	 *
	 * @returns The in-memory record while it still counts, else null.
	 */
	private validMemory(): ConsentRecord | null {
		if (!this.memory) {
			return null;
		}
		return parseConsent(JSON.stringify(this.memory), this.now(), this.version);
	}

	/**
	 * Whether this page holds a decision that storage does not carry (no usable storage, or its
	 * write failed): it ends with the page, so a reader that must carry the decision across a
	 * navigation (the OAuth redirect) fails closed.
	 *
	 * @returns True when the page's decision lives in memory only.
	 */
	hasUnsavedDecision(): boolean {
		return this.memory !== null && (this.writeFailed || this.storage === null);
	}

	/** @returns The current choice, or 'undecided' when no valid record exists. */
	state(): ConsentState {
		return this.record()?.choice ?? 'undecided';
	}

	/**
	 * Record a choice (idempotent); listeners run when the state changes.
	 *
	 * @param choice - 'accepted' or 'rejected'.
	 */
	decide(choice: ConsentChoice): void {
		const before = this.state();
		const rec: ConsentRecord = { v: this.version, choice, at: this.now() };
		this.memory = rec;
		this.writeFailed = false;
		try {
			this.storage?.setItem(CONSENT_KEY, JSON.stringify(rec));
		} catch {
			// Quota or disabled storage: the choice holds for this page, over
			// whatever stale record storage still returns. Best effort, drop that
			// record too, so other tabs stop following it.
			this.writeFailed = true;
			try {
				this.storage?.removeItem(CONSENT_KEY);
			} catch {
				/* unavailable */
			}
		}
		this.last = choice;
		if (before !== choice) {
			this.emit(choice, 'local');
		}
		// The old record's check (an acceptance being withdrawn, say) gives way to the new record's.
		this.armExpiry();
	}

	/**
	 * Another tab decided or withdrew (a `storage` event): re-read the record and
	 * tell the listeners with origin 'external', so this tab follows the choice
	 * without reporting a decision of its own.
	 */
	reload(): void {
		const before = this.last ?? 'undecided';
		this.memory = null;
		this.writeFailed = false; // another tab's write is the record now
		const now = this.state();
		this.last = now;
		if (now !== before) {
			this.emit(now, 'external');
		}
		this.armExpiry();
	}

	/**
	 * Listen for state changes: a choice in this page ('local') or another tab's ('external').
	 * A listener runs only when the state changes, and one that throws does not stop the others.
	 * The record reaching its expiry is a change too (origin 'external'), checked while anyone listens.
	 *
	 * @param fn Called with the new state and where the change came from.
	 * @returns Unsubscribes `fn`; the last unsubscribe cancels the expiry check.
	 */
	subscribe(fn: (state: ConsentState, origin: ConsentOrigin) => void): () => void {
		if (this.last === null) {
			this.last = this.state();
		}
		this.listeners.add(fn);
		if (this.expiryTimer === null) {
			this.armExpiry();
		}
		return () => {
			this.listeners.delete(fn);
			if (this.listeners.size === 0) {
				this.disarmExpiry();
			}
		};
	}

	/**
	 * Schedule the re-check for the current record's expiry (replacing any pending one). Nothing is
	 * scheduled without a record or without listeners. A delay beyond what setTimeout honours is
	 * split: the check fires early, finds the record still valid, and re-arms.
	 */
	private armExpiry(): void {
		this.disarmExpiry();
		if (this.listeners.size === 0) {
			return;
		}
		const record = this.record();
		if (!record) {
			return;
		}
		// parseConsent still accepts a record AT its TTL: the first moment it rejects it is one ms later.
		const due = record.at + CONSENT_TTL_MS + 1 - this.now();
		const delay = Math.min(Math.max(due, 0), MAX_TIMER_MS);
		this.expiryTimer = this.timers.set(() => {
			this.expiryTimer = null;
			this.checkExpiry();
		}, delay);
	}

	/** Cancel the pending expiry re-check, if any. */
	private disarmExpiry(): void {
		if (this.expiryTimer !== null) {
			this.timers.clear(this.expiryTimer);
			this.expiryTimer = null;
		}
	}

	/** The expiry re-check: an expired record now reads undecided, and the listeners follow; then re-arm. */
	private checkExpiry(): void {
		const before = this.last ?? 'undecided';
		const now = this.state();
		this.last = now;
		if (now !== before) {
			this.emit(now, 'external');
		}
		this.armExpiry();
	}

	private emit(state: ConsentState, origin: ConsentOrigin): void {
		for (const fn of Array.from(this.listeners)) {
			try {
				fn(state, origin);
			} catch {
				/* a listener never breaks the store */
			}
		}
	}
}
