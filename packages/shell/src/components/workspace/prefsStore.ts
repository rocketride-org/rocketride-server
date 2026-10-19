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
// WORKSPACE PREFS STORE — the host framework's persisted-preference seam
// =============================================================================
//
// ONE mechanism for every persisted preference, with OWNERSHIP PARTITIONS:
//
//   - SYSTEM prefs: defined and typed by the shell (ShellPrefsMap below) —
//     sidebar chrome state, grid layouts, pins. Hosts implement storage.
//   - APP prefs: each app/tool declares its OWN typed key map privately
//     (the protocol-map pattern — same as ToolStateMap/ToolOpMap) and
//     receives a store PRE-SCOPED to its partition. An app cannot name
//     another app's keys: isolation is by construction, not convention.
//
// There is deliberately NO shared flat bag. The raw string-keyed PrefsStore
// below is the HOST/storage layer; tool and shell code consume it through
// `typedPrefs` (compile-time keys) and hosts hand tools `scopedPrefs`
// partitions. Orthogonal to ownership, each WRITE may carry a durability
// SCOPE: 'workspace' (roams with the workspace) or 'global' (per user).
// The key's OWNER decides its scope; storage backends map both.
//
// Reads are SYNCHRONOUS (grid persistence and boot paths demand it): a
// store hydrates once (await `ready` before first mount where ordering
// matters) and serves snapshots from memory; writes are fire-and-forget
// merges.
// =============================================================================

import { useSyncExternalStore } from 'react';

/** Durability of one written key: roams with the workspace, or per-user. */
export type PrefScope = 'workspace' | 'global';

/**
 * The raw, string-keyed preference store a HOST implements. Tool and shell
 * code should not consume this directly — use {@link typedPrefs} for
 * compile-time keys, and hosts hand tools {@link scopedPrefs} partitions.
 */
export interface PrefsStore {
	/** The current hydrated snapshot (synchronous, from memory). */
	snapshot(): Record<string, unknown>;
	/** One key's current value (synchronous). */
	get(key: string): unknown;
	/** Writes one key (fire-and-forget merge; notifies subscribers). */
	set(key: string, value: unknown, scope?: PrefScope): void;
	/** Subscribe to any change; returns unsubscribe. */
	subscribe(cb: () => void): () => void;
	/** Resolves once the store has hydrated from its backend. */
	readonly ready: Promise<void>;
}

/**
 * The SYSTEM partition's typed key map — shell-owned preferences every host
 * persists. Apps never read or write these through their scoped stores;
 * extending this interface is the shell's privilege alone (app prefs are
 * typed in the app's own module and never enter this map).
 */
export interface ShellPrefsMap {
	/** The sidebar chrome style ('rocketride' | 'vscode' | 'cursor'). */
	sidebarMode?: string;
	/** The sidebar strip's tab order (mode ids + `tool:<appId>` ids). */
	sidebarTabOrder?: string[];
	/** Pinned dev-tool app ids, in pin order. */
	devToolPins?: string[];
	/** Disabled builtin tool ids (builtins are disabled, never removed). */
	disabledBuiltins?: string[];
	/** DataGrid layout blobs: tableId -> { persistence type -> blob }. */
	tableLayouts?: Record<string, Record<string, unknown>>;
}

/** A strict-typed view over a store: keys and value types from one map. */
export interface TypedPrefsStore<M> {
	/** The current snapshot, typed by the map. */
	snapshot(): Partial<M>;
	/** One key's current value. */
	get<K extends keyof M & string>(key: K): M[K] | undefined;
	/** Writes one key. */
	set<K extends keyof M & string>(key: K, value: M[K], scope?: PrefScope): void;
	/** Subscribe to any change; returns unsubscribe. */
	subscribe(cb: () => void): () => void;
	/** Resolves once hydrated. */
	readonly ready: Promise<void>;
}

/**
 * Narrows a raw store to a typed view. A cast, not a wrapper — the runtime
 * object IS the underlying store.
 *
 * @param store - The raw store (host-provided, or a scoped partition).
 * @returns The same store, typed by the owner's key map.
 */
export function typedPrefs<M>(store: PrefsStore): TypedPrefsStore<M> {
	return store as unknown as TypedPrefsStore<M>;
}

/**
 * A derived store confined to one partition: every key maps to
 * `<partition>.<key>` in the backing store. This is how hosts hand an app
 * its prefs — the app's handle physically cannot address keys outside its
 * partition.
 *
 * @param store - The backing store.
 * @param partition - The partition name (e.g. `app:rocketride.sql`).
 * @returns The confined store.
 */
export function scopedPrefs(store: PrefsStore, partition: string): PrefsStore {
	const prefix = `${partition}.`;
	return {
		snapshot() {
			const all = store.snapshot();
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(all)) {
				if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
			}
			return out;
		},
		get: (key) => store.get(prefix + key),
		set: (key, value, scope) => store.set(prefix + key, value, scope),
		subscribe: (cb) => store.subscribe(cb),
		ready: store.ready,
	};
}

/**
 * A hydrate-once, in-memory store over a message bridge — the shape every
 * ISOLATED host realm needs (a VS Code webview, an iframe): the host seeds
 * the full snapshot once (`seed`), writes go up through `post`, and remote
 * echoes land through `apply`. Reads never wait on the wire.
 *
 * @param post - Sends one write to the owning side.
 * @returns The store plus the bridge's seed/apply feeds.
 */
export function createBridgedPrefsStore(post: (key: string, value: unknown, scope: PrefScope) => void): {
	store: PrefsStore;
	/** Seeds (or replaces) the hydrated snapshot; resolves `ready`. */
	seed(values: Record<string, unknown>): void;
	/** Applies one remote write (another realm changed a key). */
	apply(key: string, value: unknown): void;
} {
	let values: Record<string, unknown> = {};
	const subs = new Set<() => void>();
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => (resolveReady = resolve));
	const notify = () => subs.forEach((cb) => cb());

	const store: PrefsStore = {
		snapshot: () => values,
		get: (key) => values[key],
		set(key, value, scope) {
			// Optimistic: the local cache is current immediately; the owning
			// side persists (fire-and-forget, like every prefs write).
			values = { ...values, [key]: value };
			notify();
			post(key, value, scope ?? 'workspace');
		},
		subscribe(cb) {
			subs.add(cb);
			return () => { subs.delete(cb); };
		},
		ready,
	};
	return {
		store,
		seed(next) {
			values = { ...next };
			resolveReady();
			notify();
		},
		apply(key, value) {
			values = { ...values, [key]: value };
			notify();
		},
	};
}

/**
 * The live value of one preference key (re-renders on store changes).
 *
 * @param store - The owner's typed store view.
 * @param key - The key to follow.
 * @returns The current value, or undefined before hydration / when unset.
 */
export function usePref<M, K extends keyof M & string>(store: TypedPrefsStore<M>, key: K): M[K] | undefined {
	return useSyncExternalStore(
		(cb) => store.subscribe(cb),
		() => store.get(key),
	);
}
