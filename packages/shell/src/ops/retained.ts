// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// RETAINED TOPICS — the shell bus's third lane
// =============================================================================
//
// The lanes, side by side:
//
//   - EVENTS (`emit`/`on`): realm-local broadcast, ephemeral.
//   - OPS (`request`/`handle`/`emitOp`): cross-realm, ONE owner, answers.
//   - RETAINED TOPICS (`publish`/`subscribe`/`read`): cross-realm, one
//     writer, N readers, LAST VALUE REPLAYED — "this is the current state
//     of X".
//
// The registry (one per framework root — THE authority) keeps the last
// snapshot per topic. A publish REPLACES the snapshot and fans out to every
// subscriber; a subscribe replays the current snapshot first (when one
// exists), then receives every replacement; a read answers with the current
// snapshot. Realms hold no replicas — at most a subscriber keeps a local
// copy as a CACHE (rebuildable from a fresh subscribe, written by nobody).
//
// DOCTRINE (convention, like the op-name separator — stated, not enforced):
//
//   - ONE WRITER per topic: each topic has an owning authority; multi-writer
//     last-wins is how two halves of a tool silently fight over state.
//   - STATIC topic names, code-shaped (`shell:account`, `explorer:selection`)
//     — NEVER dynamically keyed (a `log.event.<sessionId>` topic is a memory
//     leak with a naming convention; per-session streams belong on ops).
//   - Snapshots are IMMUTABLE MESSAGES: publish a new one, never mutate what
//     a subscription delivered. They cross process boundaries, so they must
//     be structured-clone/JSON-safe data — no functions, no class instances.
//   - Retention OUTLIVES the publisher by design (a reopened panel replays
//     the state its dead predecessor published). `publish(topic, undefined)`
//     retracts. A reborn publisher that intends continuity must READ BEFORE
//     IT WRITES — publishing boot defaults clobbers the retained snapshot.
//
// Delivery is ALWAYS async (a fresh task): synchronous delivery inside
// subscribe()/publish() recurses through React mounts ("maximum call stack
// size exceeded" — the cloud peer twin's hard-won lesson).
// =============================================================================

/** A topic subscriber. `undefined` delivers a retraction. */
export type RetainedSubscriber = (snapshot: unknown) => void;

/** The retained-topic registry — one per framework root, THE authority. */
export interface IRetainedRegistry {
	/**
	 * Replaces the topic's snapshot and fans out to every subscriber (local
	 * and, via the router's watcher, remote). `undefined` RETRACTS the topic:
	 * the entry is deleted and subscribers are notified with `undefined`.
	 */
	publish(topic: string, snapshot: unknown): void;

	/**
	 * Delivers a TRANSIENT payload to the topic's subscribers — same
	 * fan-out as publish, but nothing is stored: read() never sees it and
	 * late subscribers replay nothing. The N-subscriber ephemeral lane
	 * (cross-realm events) the one-owner op model cannot provide.
	 */
	signal(topic: string, payload: unknown): void;

	/**
	 * Subscribes to a topic. When a snapshot exists it is REPLAYED first
	 * (async, before any later publish); then every replacement AND every
	 * signal is delivered. Subscribing before the first publish is the
	 * natural case — the callback simply fires on that first publish.
	 *
	 * @returns Unsubscribe.
	 */
	subscribe(topic: string, cb: RetainedSubscriber): () => void;

	/** The current snapshot, or `undefined` when never published/retracted.
	 *  Synchronous — only the root (and in-realm users of a local registry)
	 *  can call this; bridged realms read through their async port. */
	read(topic: string): unknown;

	/**
	 * Watches EVERY topic change AND signal (the router's remote fan-out
	 * seam) — delivered synchronously with the publish/signal so the router
	 * can order its wire sends; local subscribers still get async delivery.
	 *
	 * @param cb - Receives (topic, value, transient) — transient marks a
	 *             signal (nothing stored).
	 * @returns Unsubscribe.
	 */
	onChange(cb: (topic: string, value: unknown, transient: boolean) => void): () => void;

	/** Every retained topic with its snapshot (a late realm's replay seed). */
	entries(): Array<[string, unknown]>;
}

/**
 * Creates a retained-topic registry.
 *
 * @returns The registry.
 */
export function createRetainedRegistry(): IRetainedRegistry {
	const snapshots = new Map<string, unknown>();
	const subscribers = new Map<string, Set<RetainedSubscriber>>();
	const watchers = new Set<(topic: string, value: unknown, transient: boolean) => void>();

	/** Async delivery on a fresh task — never inside the caller's stack. */
	const deliver = (cb: RetainedSubscriber, snapshot: unknown): void => {
		setTimeout(() => {
			try {
				cb(snapshot);
			} catch (err) {
				console.error('[retained] subscriber threw:', err);
			}
		}, 0);
	};

	/** Watchers (sync) + topic subscribers (async) for one value. */
	const fanOut = (topic: string, value: unknown, transient: boolean): void => {
		for (const w of watchers) {
			try {
				w(topic, value, transient);
			} catch (err) {
				console.error('[retained] watcher threw:', err);
			}
		}
		const subs = subscribers.get(topic);
		if (subs) for (const cb of subs) deliver(cb, value);
	};

	return {
		publish(topic, snapshot) {
			if (snapshot === undefined) snapshots.delete(topic);
			else snapshots.set(topic, snapshot);
			fanOut(topic, snapshot, false);
		},

		signal(topic, payload) {
			fanOut(topic, payload, true);
		},

		subscribe(topic, cb) {
			let set = subscribers.get(topic);
			if (!set) {
				set = new Set();
				subscribers.set(topic, set);
			}
			set.add(cb);
			// Replay the current snapshot (if any) — async, and guarded so a
			// publish that lands before the replay task runs doesn't deliver
			// twice out of order (the publish's own delivery supersedes).
			if (snapshots.has(topic)) {
				const atSubscribe = snapshots.get(topic);
				deliver((snap) => {
					// Replay only if still subscribed and nothing newer delivered.
					if (set!.has(cb) && snapshots.get(topic) === atSubscribe) cb(snap);
				}, atSubscribe);
			}
			return () => {
				set!.delete(cb);
				if (set!.size === 0) subscribers.delete(topic);
			};
		},

		read(topic) {
			return snapshots.get(topic);
		},

		onChange(cb) {
			watchers.add(cb);
			return () => watchers.delete(cb);
		},

		entries() {
			return [...snapshots.entries()];
		},
	};
}

// =============================================================================
// THE REALM-SIDE PORT
// =============================================================================

/**
 * What a realm's ConnectionManager speaks retained topics through. The root
 * realm's port IS its local registry; a bridged realm's port is installed by
 * attachRealmToRoot and rides the wire.
 */
export interface IRetainedPort {
	publish(topic: string, snapshot: unknown): void;
	signal(topic: string, payload: unknown): void;
	subscribe(topic: string, cb: RetainedSubscriber): () => void;
	/** Async everywhere — a bridged realm cannot read the root's map
	 *  synchronously, and one signature keeps call sites portable. */
	read(topic: string): Promise<unknown>;
}

/**
 * Adapts a local registry to the port shape (the root realm's port, and the
 * default for unbridged realms — tests, standalone).
 *
 * @param registry - The local registry.
 * @returns The port.
 */
export function localRetainedPort(registry: IRetainedRegistry): IRetainedPort {
	return {
		publish: (topic, snapshot) => registry.publish(topic, snapshot),
		signal: (topic, payload) => registry.signal(topic, payload),
		subscribe: (topic, cb) => registry.subscribe(topic, cb),
		read: (topic) => Promise.resolve(registry.read(topic)),
	};
}
