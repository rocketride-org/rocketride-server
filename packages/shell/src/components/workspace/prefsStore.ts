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
// `typedPrefs` (compile-time keys) and hosts hand tools their partition.
//
// PARTITIONS ARE THE ONLY AXIS. There is deliberately no second durability
// 'scope': an app has ONE bag, and state that must outlive or span apps goes
// in the `shell` partition, which is what "global" ever meant here.
//
// Reads are SYNCHRONOUS (grid persistence and boot paths demand it): a
// store hydrates once (await `ready` before first mount where ordering
// matters) and serves snapshots from memory; writes are fire-and-forget
// merges.
// =============================================================================

import { useSyncExternalStore } from 'react';

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
	set(key: string, value: unknown): void;
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
	set<K extends keyof M & string>(key: K, value: M[K]): void;
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
		set: (key, value) => store.set(prefix + key, value),
		subscribe: (cb) => store.subscribe(cb),
		ready: store.ready,
	};
}

// =============================================================================
// THE MIRROR — how a REALM gets a prefs store
// =============================================================================
//
// Prefs are the fourth mirror, beside status/account/services: the workspace
// manager (the browser shell root, or the VS Code extension host) owns the
// state and is the SINGLE WRITER. Realms never touch the workspace files —
// that is state shared across realms, and direct access means lost updates
// (two realms read, both write, one silently wins).
//
// ONE RETAINED TOPIC PER PARTITION, not one for the whole workspace. A realm
// receives the handful of small keys for the app it hosts and cannot even
// OBSERVE another app's prefs — the isolation `scopedPrefs` gives by key
// prefix, now enforced at the transport. (These topic names are keyed by
// partition, against the usual static-name doctrine. The exception is
// deliberate and bounded: partitions are durable app identities, a handful
// per workspace, not per-session — the thing that doctrine exists to stop.)
//
// `appState` — the Documents blob, and the bulk of a workspace file — has no
// place here. It is opaque to the shell and already owned by the Documents
// library; if a realm ever needs it, that is a separate channel.
// =============================================================================

/** The retained topic carrying ONE partition's prefs. */
export function prefsTopic(partition: string): string {
	return `shell:prefs:${partition}`;
}

/** The retained topic carrying ONE partition's setting OVERRIDES (the
 *  `settings` section of its file — deltas the partition OWNS, never the
 *  merged view). Published by the same hosts that publish prefsTopic. */
export function settingsTopic(partition: string): string {
	return `shell:settings:${partition}`;
}

/** The minimal bus surface a mirrored prefs store needs. */
export interface IPrefsBus {
	/** Subscribe to a retained topic (replays the current snapshot). */
	subscribe(topic: string, cb: (snapshot: unknown) => void): () => void;
	/** Fire-and-forget op to the workspace manager. */
	emitOp(op: string, params: unknown): void;
}

/**
 * A MIRRORED prefs store for ONE partition — the shape every realm uses.
 *
 * Reads are SYNCHRONOUS off the realm's mirrored copy (never a round-trip,
 * which is the constraint grid persistence and boot paths impose). Writes go
 * to the manager as a fire-and-forget `shell.setPref`; it merges,
 * republishes, and debounces the dump, so every realm converges.
 *
 * `shell.prefs.attach` is what makes the first snapshot arrive: the registry
 * cannot tell the manager that someone subscribed, and a partition the
 * manager has not loaded has no retained value to replay. The realm
 * therefore DECLARES its partition and the manager publishes it — even when
 * empty, so `ready` resolves either way.
 *
 * @param bus - The realm's connection manager (subscribe + emitOp).
 * @param partition - The partition this store is confined to.
 * @returns The store plus a disposer for its subscription.
 */
export function createMirroredPrefsStore(bus: IPrefsBus, partition: string): { store: PrefsStore; dispose(): void } {
	let values: Record<string, unknown> = {};
	const subs = new Set<() => void>();
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => (resolveReady = resolve));
	const notify = (): void => subs.forEach((cb) => cb());

	const off = bus.subscribe(prefsTopic(partition), (snapshot) => {
		values = { ...((snapshot as Record<string, unknown>) ?? {}) };
		resolveReady();
		notify();
	});
	// Subscribe FIRST, then declare — a publish answering the attach must not
	// land before there is anyone to receive it.
	bus.emitOp('shell.prefs.attach', { partition });

	const store: PrefsStore = {
		snapshot: () => values,
		get: (key) => values[key],
		set(key, value) {
			// Optimistic: a read in the same tick sees the write. The
			// manager's republish confirms it (and corrects it if it merged
			// something else in between).
			values = { ...values, [key]: value };
			notify();
			bus.emitOp('shell.setPref', { partition, key, value });
		},
		subscribe(cb) {
			subs.add(cb);
			return () => {
				subs.delete(cb);
			};
		},
		ready,
	};
	return { store, dispose: off };
}

/** A realm's per-partition prefs stores, created on demand. */
export interface IPrefsHub {
	/** The mirrored store for one partition (cached per name). */
	partition(name: string): PrefsStore;
	/** Drops every subscription this hub opened. */
	dispose(): void;
}

/**
 * A realm's prefs hub: one mirrored store per partition, created on demand
 * and cached.
 *
 * A realm hosts more than one partition — its own chrome reads `shell`, and
 * every tool it mounts reads `app:<id>` (or `preview:<id>`). Each gets its
 * own topic; the hub keeps them from being subscribed twice.
 *
 * @param bus - The realm's connection manager.
 * @returns The hub, plus a disposer that drops every subscription.
 */
/** This realm's hub (see {@link realmPrefsHub}). */
let realmHub: IPrefsHub | null = null;

/**
 * THE prefs hub for this realm — one per page/webview, created over the
 * realm's bus on first use.
 *
 * Every consumer shares it, so a partition has exactly ONE mirrored store
 * and one subscription no matter how many components read it. Before this
 * existed each host built its own hub (and the dev-tool strip kept a third
 * store of its own), which meant several mirrors of the same partition
 * racing to answer the same question.
 *
 * Never dispose this from a component: it belongs to the realm, not to
 * whoever happened to read prefs first. `createPrefsHub` stays for the
 * cases that genuinely need an isolated hub (tests, a second bus).
 *
 * @param bus - The realm's bus; used only on the first call.
 * @returns The realm's hub.
 */
export function realmPrefsHub(bus: IPrefsBus): IPrefsHub {
	if (!realmHub) realmHub = createPrefsHub(bus);
	return realmHub;
}

export function createPrefsHub(bus: IPrefsBus): IPrefsHub {
	const stores = new Map<string, { store: PrefsStore; dispose(): void }>();
	return {
		partition(name) {
			let entry = stores.get(name);
			if (!entry) {
				entry = createMirroredPrefsStore(bus, name);
				stores.set(name, entry);
			}
			return entry.store;
		},
		dispose() {
			for (const entry of stores.values()) entry.dispose();
			stores.clear();
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
