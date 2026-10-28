// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TelemetryChannel - product-telemetry facts the shell observed while no app
// was listening.
//
// The shell carries no analytics SDK. Facts such as auth:start (raised when the
// OAuth redirect starts) and auth:complete (raised when the callback resolves
// an identity, BEFORE the home remote mounts) are broadcast as `shell:telemetry`
// while an app is subscribed; otherwise they are held here until an app drains
// the channel at its analytics init. The hold is bounded and mirrored to
// sessionStorage, so a fact raised on a page load that never mounts the
// forwarding app (a sign-in that lands in a product app, the goodbye screen's
// sign-in) reaches the next page load of the same tab, for TELEMETRY_TTL_MS at
// most. No DOM: unit-tested under node:test with an injected storage.
// =============================================================================

export interface TelemetryFact {
	event: string;
	props: Record<string, unknown>;
	/** Wall-clock milliseconds when the fact was observed: the forwarding app's event time. */
	ts: number;
	/** Unique within the tab: the forwarding app's once-per-fact key. */
	id: string;
}

/** Oldest facts are dropped first once the hold is full. */
export const TELEMETRY_BUFFER_MAX = 32;
/** A held fact older than this is discarded at drain: it can no longer be attributed to the visit it belongs to. */
export const TELEMETRY_TTL_MS = 30 * 60 * 1000;
/** sessionStorage key of the mirror (per tab; survives the OAuth round trip and an app landing). */
export const TELEMETRY_STORAGE_KEY = 'rr:shell:telemetry';

/** The slice of the Web Storage interface the channel uses; injectable for tests. */
export interface FactStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** The tab's sessionStorage, or null where there is none or its accessor throws (storage disabled). */
function defaultStorage(): FactStorage | null {
	try {
		const s = (globalThis as { sessionStorage?: FactStorage }).sessionStorage;
		return s && typeof s.getItem === 'function' ? s : null;
	} catch {
		return null; // the accessor itself throws when storage is disabled
	}
}

/** The bounded hold of telemetry facts no app has drained yet, optionally mirrored to storage. */
export class TelemetryChannel {
	/** Facts this page load observed and nobody has drained. */
	private facts: TelemetryFact[] = [];
	/** Facts an earlier page load of the tab mirrored and never handed over; read once, at construction. */
	private inherited: TelemetryFact[];
	private seq = 0;
	private readonly storage: FactStorage | null;
	private readonly now: () => number;

	/**
	 * @param options - `storage`: where to mirror the hold (default: the tab's sessionStorage;
	 *                  null keeps it in memory only); `now`: the clock (tests inject one).
	 */
	constructor(options?: { storage?: FactStorage | null; now?: () => number }) {
		if (options && 'storage' in options) {
			// passed explicitly: a storage to mirror to, or null (or undefined) for memory only
			this.storage = options.storage || null;
		} else {
			this.storage = defaultStorage();
		}
		this.now = options?.now ?? (() => Date.now());
		this.inherited = this.readMirror();
	}

	/**
	 * Hold a fact. Non-string or empty event names are ignored; props are copied; `ts` defaults to now.
	 *
	 * @returns The fact as held, or null when the event name was ignored.
	 */
	report(event: string, props: Record<string, unknown>, ts?: number): TelemetryFact | null {
		if (typeof event !== 'string' || event === '') return null;
		const when = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : this.now();
		const fact: TelemetryFact = { event, props: { ...(props ?? {}) }, ts: when, id: `${when.toString(36)}-${(this.seq++).toString(36)}` };
		this.facts.push(fact);
		if (this.facts.length > TELEMETRY_BUFFER_MAX) this.facts.splice(0, this.facts.length - TELEMETRY_BUFFER_MAX);
		this.persist();
		return fact;
	}

	/**
	 * Hand over every held fact once, oldest first, and empty the hold: what an
	 * earlier page load of the tab mirrored, then this page load's facts, all
	 * within the TTL and bounded as a whole.
	 */
	drain(): TelemetryFact[] {
		const now = this.now();
		const out: TelemetryFact[] = [];
		for (const fact of this.inherited.concat(this.facts)) {
			if (now - fact.ts <= TELEMETRY_TTL_MS) out.push(fact);
		}
		// bounded as a whole: the oldest go first, as in report()
		if (out.length > TELEMETRY_BUFFER_MAX) out.splice(0, out.length - TELEMETRY_BUFFER_MAX);
		this.inherited = [];
		this.facts = [];
		this.clearMirror();
		return out;
	}

	/**
	 * Drop every held fact and the mirror without handing them over. A sign-out
	 * calls this: facts observed for one session must never be forwarded under
	 * the next account that signs in on this tab.
	 */
	clear(): void {
		this.inherited = [];
		this.facts = [];
		this.clearMirror();
	}

	/** Facts held in memory by this page load (the inherited ones are not counted). */
	get size(): number {
		return this.facts.length;
	}

	/** Mirror the held facts (inherited first, bounded) to storage. Never throws. */
	private persist(): void {
		if (!this.storage) return;
		try {
			this.storage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify([...this.inherited, ...this.facts].slice(-TELEMETRY_BUFFER_MAX)));
		} catch {
			/* storage full or unavailable: the in-memory hold still serves this page load */
		}
	}

	/** Read what an earlier page load of the tab mirrored: valid facts within the TTL only; a corrupt mirror reads as empty. */
	private readMirror(): TelemetryFact[] {
		if (!this.storage) return [];
		try {
			const raw = this.storage.getItem(TELEMETRY_STORAGE_KEY);
			if (!raw) return [];
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			const now = this.now();
			const out: TelemetryFact[] = [];
			for (const [index, item] of parsed.entries()) {
				if (!item || typeof item !== 'object') continue;
				const { event, props, ts, id } = item as Partial<TelemetryFact>;
				if (typeof event !== 'string' || event === '' || typeof ts !== 'number' || !Number.isFinite(ts)) continue;
				if (now - ts > TELEMETRY_TTL_MS || ts - now > 60_000) continue; // expired, or written by a clock ahead of this one
				out.push({ event, props: props && typeof props === 'object' ? { ...props } : {}, ts, id: typeof id === 'string' && id ? id : `${ts.toString(36)}-m${index.toString(36)}` });
			}
			return out;
		} catch {
			return []; // unreadable or corrupt mirror: nothing to replay
		}
	}

	/** Remove the mirror from storage. Never throws. */
	private clearMirror(): void {
		if (!this.storage) return;
		try {
			this.storage.removeItem(TELEMETRY_STORAGE_KEY);
		} catch {
			/* unavailable */
		}
	}
}
