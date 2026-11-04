// =============================================================================
// Consent store - the visitor's choice, stored and watched. The RECORD's
// contract (key, versioned expiring shape, pure parser) lives in the SDK
// (rocketride/analytics consent.ts) — the ONE copy, shared with the sign-in
// path readers that must parse it without booting any analytics; this module
// re-exports it and owns everything stateful: storing a choice, listeners,
// the cross-tab reload. PostHog's internal consent flag is never used.
// Storing the choice is strictly necessary (it is what "remember my answer"
// means), so the record lives in localStorage; when storage throws or is
// unavailable the choice lives in memory for the page. Pure: no SDK, no DOM
// beyond the injected storage; unit-tested under node:test.
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

/** Where a state change came from: this page ('local') or another tab's storage write ('external'). */
export type ConsentOrigin = 'local' | 'external';

/** ConsentStore's options; tests inject each one. */
export type ConsentStoreOptions = {
	/** Where the record is kept; null keeps it in memory only. Default: localStorage when it is usable. */
	storage?: ConsentStorage | null;
	/** The clock (ms) that stamps and expires records. Default: Date.now. */
	now?: () => number;
	/** The consent version a stored record must carry to count. Default: CONSENT_VERSION. */
	version?: number;
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
	}

	/**
	 * The visitor's record.
	 *
	 * @returns The stored record if valid, else what this page decided, else null.
	 */
	record(): ConsentRecord | null {
		if (this.writeFailed && this.memory) {
			return this.memory; // the store is stale: a reject or withdrawal must not read back as 'accepted'
		}
		let raw: string | null = null;
		try {
			if (this.storage) {
				raw = this.storage.getItem(CONSENT_KEY);
			}
		} catch {
			raw = null; // unreadable storage: fall back to the page's own memory
		}
		return parseConsent(raw, this.now(), this.version) ?? this.memory;
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
	}

	/**
	 * Listen for state changes: a choice in this page ('local') or another tab's ('external').
	 * A listener runs only when the state changes, and one that throws does not stop the others.
	 *
	 * @param fn Called with the new state and where the change came from.
	 * @returns Unsubscribes `fn`.
	 */
	subscribe(fn: (state: ConsentState, origin: ConsentOrigin) => void): () => void {
		if (this.last === null) {
			this.last = this.state();
		}
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
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
