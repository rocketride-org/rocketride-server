// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE STORE — the host-agnostic workspace manager
// =============================================================================
//
// The single owner of workspace state: app slices, shell-wide prefs and
// setting overrides, loaded from and debounced back to the server file store
// through `client.fs*`.
//
// NO REACT. This is a plain class so EVERY host can run one:
//   - the browser shell drives it from `useWorkspaceState` (a thin subscriber)
//   - the VS Code extension host drives it directly and republishes the state
//     to its webview realms as retained topics
//
// There must be exactly ONE per host. Realms NEVER read or write the workspace
// files themselves — that is shared state, and direct access means lost
// updates (two realms read, both write, one silently wins). The store is the
// single writer; it debounces the dump.
//
// Partition model (one file per partition, so the write path stays dumb — no
// prefix filtering, no merge logic that could leak one side into the other):
//
//   shell:        -> <dir>/global.json
//   app:<id>      -> <dir>/<id>.workspace.json
//   preview:<id>  -> <dir>/<id>.preview.json
//
// Setting OVERRIDES live in their OWNING partition's file (a `settings`
// section beside prefs/appState; the shell partition's inside global.json).
// There is NO shared settings file — a legacy flat `settings.json` is never
// read nor written.
//
// =============================================================================

import { RocketRideClient } from 'rocketride';
import type { AppWorkspaceState, WorkspacePrefs, SettingValue } from '../components/workspace/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Milliseconds to wait after the last state change before writing to disk. */
const SAVE_DEBOUNCE_MS = 500;

/** Baseline preferences applied to every new app workspace session. */
const defaultPrefs: WorkspacePrefs = {
	activeView: 'welcome',
	activeActivity: 'explorer',
	sidePanelOpen: true,
	theme: 'rocketride-light',
};

/**
 * Creates a fresh `AppWorkspaceState` for an app with no saved state.
 *
 * @returns A complete state with default prefs and an empty appState.
 */
export function makeDefaultAppState(): AppWorkspaceState {
	// Theme survives unauthenticated sessions, before any workspace exists.
	// Guarded by globalThis rather than try/catch: this class also runs in the
	// VS Code extension host, which compiles without the DOM lib.
	const savedTheme = (() => {
		const ls = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
		try {
			return ls?.getItem('rr:theme') || '';
		} catch {
			return '';
		}
	})();
	return { prefs: { ...defaultPrefs, ...(savedTheme ? { theme: savedTheme } : {}) }, appState: {} };
}

/** Shape of the global workspace file — last active app + shell-wide prefs.
 *  `shellPrefs` IS the `shell` partition's bag: theme and sidePanelOpen (the
 *  two that must survive an app switch) plus every shell-owned chrome key
 *  (sidebarMode, devToolPins, theme, ...). */
interface GlobalFile {
	version: 3;
	activeAppId: string;
	shellPrefs?: Record<string, unknown>;
	/** Setting overrides the SHELL partition owns (store 'user' keys; deltas only). */
	settings?: Record<string, SettingValue>;
}

/**
 * True when the client exposes the filesystem JSON API. A minimal stub client
 * degrades gracefully: the shell runs, nothing persists.
 *
 * @param client - The client to inspect.
 * @returns Whether `fsReadJson`/`fsWriteJson` are available.
 */
function hasStoreApi(client: RocketRideClient): boolean {
	return typeof (client as unknown as { fsReadJson?: unknown }).fsReadJson === 'function';
}

// =============================================================================
// PARTITIONS
// =============================================================================

/** A partition name: `shell`, `app:<id>` or `preview:<id>`. */
export type Partition = string;

/** The shell's own cross-app partition (theme, sidePanelOpen). */
export const SHELL_PARTITION: Partition = 'shell';

/**
 * The partition an app's state lives in.
 *
 * @param appId - The app id.
 * @param preview - True when this is an App Builder preview of the app.
 * @returns The partition name.
 */
export function appPartition(appId: string, preview = false): Partition {
	return `${preview ? 'preview' : 'app'}:${appId}`;
}

/**
 * The file one partition persists to. ONE file per partition — the separation
 * is a file boundary, which a writer bug cannot cross.
 *
 * @param dir - The workspace directory.
 * @param partition - The partition name.
 * @returns The file path.
 */
export function partitionPath(dir: string, partition: Partition): string {
	if (partition === SHELL_PARTITION) return `${dir}/global.json`;
	const [kind, ...rest] = partition.split(':');
	const id = rest.join(':');
	return kind === 'preview' ? `${dir}/${id}.preview.json` : `${dir}/${id}.workspace.json`;
}

// =============================================================================
// SNAPSHOT
// =============================================================================

/** The immutable view subscribers read. Identity changes only on real change. */
export interface WorkspaceSnapshot {
	/** True once the initial disk read (or its no-op) has completed. */
	loaded: boolean;
	/** True once ANY state exists — pre-auth seed counts. */
	seeded: boolean;
	activeAppId: string;
	/** The active partition's prefs. */
	prefs: WorkspacePrefs;
	/** The active partition's opaque app-owned blob. */
	appState: Record<string, unknown>;
	/** Setting OVERRIDES (deltas only) — the MERGED view across the shell
	 *  partition and every loaded partition's own `settings` section. */
	settings: Record<string, SettingValue>;
}

/** Construction options. */
export interface WorkspaceStoreOptions {
	defaultAppId: string;
	/** Directory for all persistence files. */
	workspaceDir?: string;
	/** Overrides the saved active app on first load (URL deep-link). */
	startupAppId?: string;
	/** True when this host is an App Builder preview — every partition it
	 *  writes becomes `preview:<id>`, sealing it from the real app's files. */
	preview?: boolean;
	/** True for a host with NO app surface (the VS Code extension host):
	 *  `defaultAppId` is then only a constructor-required placeholder, so the
	 *  store never reads the "active" partition's file — `.workspace/` holds
	 *  one `<appId>.workspace.json` per real app, and a placeholder must
	 *  never probe for (or ever materialize) one. */
	headless?: boolean;
}

// =============================================================================
// STORE
// =============================================================================

/**
 * The workspace manager. One per host; the single writer of workspace files.
 */
export class WorkspaceStore {
	private readonly defaultAppId: string;
	private readonly workspaceDir: string;
	private readonly startupAppId: string | undefined;
	private readonly preview: boolean;
	private readonly headless: boolean;

	private client: RocketRideClient | null = null;
	private isConnected = false;

	/** In-memory state, keyed by PARTITION (not by app id). */
	private partitions: Record<Partition, AppWorkspaceState> = {};
	private activeAppId: string;
	/** The shell partition's setting overrides (persisted in global.json). */
	private shellSettings: Record<string, SettingValue> = {};
	/** The `shell` partition's bag (persisted in global.json). */
	private shellPrefs: Record<string, unknown> = {};

	private loaded = false;
	private seeded = false;
	private preAuthSeeded = false;
	private diskLoaded = false;

	/** ONE debounce timer PER PARTITION. A single shared timer would drop a
	 *  write to partition A when B changed inside the same window — which the
	 *  mirror makes routine (a realm writing its tool's bag while the shell
	 *  writes its own). */
	private appSaveTimers = new Map<Partition, ReturnType<typeof setTimeout>>();
	private globalSaveTimer: ReturnType<typeof setTimeout> | undefined;

	private listeners = new Set<() => void>();
	private snapshot: WorkspaceSnapshot;

	/**
	 * @param options - See {@link WorkspaceStoreOptions}.
	 */
	constructor(options: WorkspaceStoreOptions) {
		this.defaultAppId = options.defaultAppId;
		this.workspaceDir = options.workspaceDir ?? '.workspace';
		this.startupAppId = options.startupAppId;
		this.preview = options.preview === true;
		this.headless = options.headless === true;
		this.activeAppId = options.defaultAppId;
		this.snapshot = this.buildSnapshot();
	}

	/**
	 * Writes every pending debounced change immediately.
	 *
	 * For a LIVE page only — an app switch, a teardown the page outlives.
	 *
	 * NEVER call this from `pagehide`/`beforeunload`. These writes ride the
	 * engine socket, and a reload closes it mid-flight: the server has
	 * already opened the target file, never receives the body, and leaves a
	 * ZERO-BYTE file where the workspace used to be. Losing the last half
	 * second of a debounce is a nuisance; losing global.json is not. If a
	 * teardown-safe flush is ever needed it has to be a transport that
	 * survives unload (a keepalive beacon), not this one.
	 */
	public flushNow = (): void => {
		for (const [partition, timer] of this.appSaveTimers) {
			clearTimeout(timer);
			this.writeAppNow(partition);
		}
		this.appSaveTimers.clear();

		if (this.globalSaveTimer !== undefined) {
			clearTimeout(this.globalSaveTimer);
			this.globalSaveTimer = undefined;
			if (this.canSave()) {
				this.client!
					.fsWriteJson(partitionPath(this.workspaceDir, SHELL_PARTITION), this.globalFileBody())
					.catch(() => {});
			}
		}
	};

	// =========================================================================
	// SUBSCRIPTION
	// =========================================================================

	/**
	 * Subscribes to state changes.
	 *
	 * @param cb - Called after every committed change.
	 * @returns Unsubscribe.
	 */
	public subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	};

	/**
	 * The current snapshot. Reference-stable until something actually changes,
	 * so `useSyncExternalStore` does not loop.
	 *
	 * @returns The snapshot.
	 */
	public getSnapshot = (): WorkspaceSnapshot => this.snapshot;

	/** The partition the active app currently reads and writes. */
	public get activePartition(): Partition {
		return appPartition(this.activeAppId, this.preview);
	}

	private buildSnapshot(): WorkspaceSnapshot {
		const slice = this.partitions[this.activePartition] ?? makeDefaultAppState();
		return {
			loaded: this.loaded,
			seeded: this.seeded,
			activeAppId: this.activeAppId,
			prefs: slice.prefs,
			appState: slice.appState,
			settings: this.mergedSettings(),
		};
	}

	/** Rebuilds the snapshot and notifies subscribers. */
	private commit(): void {
		this.snapshot = this.buildSnapshot();
		for (const cb of [...this.listeners]) cb();
	}

	// =========================================================================
	// CONNECTION — drives the load
	// =========================================================================

	/**
	 * Supplies (or updates) the live client. Pre-auth this seeds defaults so
	 * the shell can render unauthenticated apps; on first connect it loads.
	 *
	 * @param client - The client, or null while constructing.
	 * @param isConnected - Whether the socket is open.
	 */
	public setConnection(client: RocketRideClient | null, isConnected: boolean): void {
		this.client = client;
		this.isConnected = isConnected;
		if (!client) return;

		if (!isConnected) {
			// Pre-auth seed — does NOT set `loaded`, which means "read from disk".
			if (this.preAuthSeeded) return;
			this.preAuthSeeded = true;
			this.activeAppId = this.startupAppId ?? this.defaultAppId;
			this.partitions = { [this.activePartition]: makeDefaultAppState() };
			this.seeded = true;
			this.commit();
			return;
		}

		if (this.diskLoaded) return;
		this.diskLoaded = true;
		void this.load();
	}

	/** Whether writes are safe: a live client that exposes the store API. */
	private canSave(): boolean {
		return this.client != null && this.isConnected && hasStoreApi(this.client);
	}

	// =========================================================================
	// LOAD
	// =========================================================================

	private async load(): Promise<void> {
		const client = this.client;
		if (!client) return;

		// Graceful degradation: a client with no filesystem API.
		if (!hasStoreApi(client)) {
			if (!this.loaded) {
				this.activeAppId = this.startupAppId ?? this.defaultAppId;
				this.partitions = { [this.activePartition]: makeDefaultAppState() };
				this.seeded = true;
				this.loaded = true;
				this.commit();
			}
			return;
		}

		try {
			const globalFile = await client.fsReadJson<GlobalFile>(partitionPath(this.workspaceDir, SHELL_PARTITION)).catch(() => null);

			// Active app: URL deep-link or built-in default.
			this.activeAppId = this.startupAppId ?? this.defaultAppId;
			if (globalFile?.shellPrefs) this.shellPrefs = globalFile.shellPrefs;
			if (globalFile?.settings && typeof globalFile.settings === 'object') this.shellSettings = globalFile.settings;

			let slice: AppWorkspaceState | undefined;
			// A headless host's "active" partition is a placeholder, not an app —
			// probing the store for its file would be a read that can never find
			// anything legitimate (and logs a miss server-side on every connect).
			if (!this.headless) {
				try {
					const raw = await client.fsReadJson<AppWorkspaceState>(partitionPath(this.workspaceDir, this.activePartition));
					// Accept the file only with the minimum required shape.
					if (raw?.prefs) slice = raw;
				} catch {
					/* no saved state */
				}
			}

			this.partitions = { [this.activePartition]: this.withShellPrefs(slice ?? makeDefaultAppState()) };
			this.notifyPrefs(SHELL_PARTITION);
			this.notifyPrefs(this.activePartition);
			this.seeded = true;
			this.loaded = true;
			this.commit();
		} catch {
			// Best-effort: a missing or corrupt workspace must not block the shell.
			this.activeAppId = this.defaultAppId;
			this.partitions = { [this.activePartition]: makeDefaultAppState() };
			this.seeded = true;
			this.loaded = true;
			this.commit();
		}
	}

	/** Overlays the shell-wide prefs onto a slice, for visual consistency. */
	private withShellPrefs(slice: AppWorkspaceState): AppWorkspaceState {
		const sp = this.shellPrefs;
		return {
			...slice,
			appState: slice.appState ?? {}, // v2 files carry no appState
			prefs: {
				...slice.prefs,
				...(typeof sp.theme === 'string' ? { theme: sp.theme } : {}),
				...(typeof sp.sidePanelOpen === 'boolean' ? { sidePanelOpen: sp.sidePanelOpen } : {}),
			},
		};
	}

	// =========================================================================
	// WRITES — debounced; this store is the only writer
	// =========================================================================

	private scheduleAppWrite(partition: Partition): void {
		if (!this.canSave()) return;
		clearTimeout(this.appSaveTimers.get(partition));
		this.appSaveTimers.set(
			partition,
			setTimeout(() => {
				this.appSaveTimers.delete(partition);
				const slice = this.partitions[partition];
				if (slice) this.client!.fsWriteJson(partitionPath(this.workspaceDir, partition), slice).catch(() => {});
			}, SAVE_DEBOUNCE_MS),
		);
	}

	private writeAppNow(partition: Partition): void {
		if (!this.canSave()) return;
		const slice = this.partitions[partition];
		if (slice) this.client!.fsWriteJson(partitionPath(this.workspaceDir, partition), slice).catch(() => {});
	}

	/** The global.json body: active app + shell prefs + shell-owned settings. */
	private globalFileBody(): GlobalFile {
		return {
			version: 3,
			activeAppId: this.activeAppId,
			shellPrefs: this.shellPrefs,
			settings: this.shellSettings,
		};
	}

	private scheduleGlobalWrite(): void {
		if (!this.canSave()) return;
		clearTimeout(this.globalSaveTimer);
		this.globalSaveTimer = setTimeout(() => {
			this.client!.fsWriteJson(partitionPath(this.workspaceDir, SHELL_PARTITION), this.globalFileBody()).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}

	// =========================================================================
	// MUTATIONS
	// =========================================================================

	/**
	 * Switches the active app: flushes the outgoing partition immediately (no
	 * debounce), clears the outgoing app's server monitors, loads the incoming
	 * partition, then commits.
	 *
	 * @param newAppId - The app to switch to.
	 */
	public switchApp = async (newAppId: string): Promise<void> => {
		if (newAppId === this.activeAppId) return;

		// 1. Flush the outgoing partition now — no in-flight debounce is lost.
		clearTimeout(this.appSaveTimers.get(this.activePartition));
		this.appSaveTimers.delete(this.activePartition);
		this.writeAppNow(this.activePartition);

		// 2. Clear the outgoing app's server monitors and re-identify.
		if (this.client) {
			try {
				await this.client.clearAllMonitors();
			} catch (err) {
				console.error('[Workspace] Failed to clear monitors on app switch:', err);
			}
			this.client.identify(`Cloud Shell-UI — ${newAppId}`).catch(() => {});
		}

		// 3. Load the incoming partition if it is not already in memory.
		const nextPartition = appPartition(newAppId, this.preview);
		let slice = this.partitions[nextPartition];
		if (!slice && this.canSave()) {
			try {
				const raw = await this.client!.fsReadJson<AppWorkspaceState>(partitionPath(this.workspaceDir, nextPartition));
				if (raw?.prefs) slice = raw;
			} catch {
				/* no saved state for this app */
			}
		}

		this.partitions = { ...this.partitions, [nextPartition]: this.withShellPrefs(slice ?? makeDefaultAppState()) };
		this.activeAppId = newAppId;
		this.notifyPrefs(nextPartition);
		this.commit();
		this.scheduleGlobalWrite();
	};

	/** Applies an updater to the active partition's slice and schedules a write. */
	private updateActive(updater: (prev: AppWorkspaceState) => AppWorkspaceState): void {
		const partition = this.activePartition;
		const current = this.partitions[partition] ?? makeDefaultAppState();
		this.partitions = { ...this.partitions, [partition]: updater(current) };
		this.commit();
		this.scheduleAppWrite(partition);
		// The mirror must see shell-driven changes too (a theme toggle in the
		// chrome is the same fact as a realm's setPref).
		this.notifyPrefs(partition);
	}

	/**
	 * Merges a preferences patch into the active partition.
	 *
	 * @param patch - Partial prefs to merge.
	 */
	public updatePrefs = (patch: Partial<WorkspacePrefs>): void => {
		this.updateActive((s) => ({ ...s, prefs: { ...s.prefs, ...patch } }));
		// theme and sidePanelOpen ALSO live in the shell partition so they
		// survive app switches — mirror them there.
		const shellPatch: Record<string, unknown> = {};
		if (patch.theme !== undefined) shellPatch.theme = patch.theme;
		if (patch.sidePanelOpen !== undefined) shellPatch.sidePanelOpen = patch.sidePanelOpen;
		if (Object.keys(shellPatch).length > 0) {
			this.shellPrefs = { ...this.shellPrefs, ...shellPatch };
			this.scheduleGlobalWrite();
			this.notifyPrefs(SHELL_PARTITION);
		}
	};

	/**
	 * Replaces the active partition's opaque appState.
	 *
	 * @param updater - Functional updater over the current appState.
	 */
	public updateAppState = (updater: (prev: Record<string, unknown>) => Record<string, unknown>): void => {
		this.updateActive((s) => ({ ...s, appState: updater(s.appState) }));
	};

	/**
	 * Sets or clears one setting override in its OWNING partition. `undefined`
	 * DELETES the key — overrides are deltas only, so "reset to default" and
	 * "set to the default value" both remove the entry rather than writing it.
	 *
	 * The caller resolves the partition from the registry (the entry's owner;
	 * SHELL_PARTITION for 'user'-store and shell-owned keys) — the store stays
	 * registry-blind and writes where it is told.
	 *
	 * @param partition - The owning partition.
	 * @param key - The dotted setting key.
	 * @param value - The override, or undefined to delete it.
	 */
	public updateSetting = (partition: Partition, key: string, value: SettingValue | undefined): void => {
		if (partition === SHELL_PARTITION) {
			const next = { ...this.shellSettings };
			if (value === undefined) delete next[key];
			else next[key] = value;
			this.shellSettings = next;
			this.scheduleGlobalWrite();
		} else {
			const current = this.partitions[partition] ?? makeDefaultAppState();
			const next = { ...(current.settings ?? {}) };
			if (value === undefined) delete next[key];
			else next[key] = value;
			this.partitions = { ...this.partitions, [partition]: { ...current, settings: next } };
			this.scheduleAppWrite(partition);
		}
		this.commit();
		this.notifyPrefs(partition);
	};

	/**
	 * The merged override view: the shell partition's settings overlaid with
	 * every loaded partition's own section. Owners are disjoint by the
	 * registry's first-wins rule, so merge order cannot matter.
	 */
	private mergedSettings(): Record<string, SettingValue> {
		const merged: Record<string, SettingValue> = { ...this.shellSettings };
		for (const slice of Object.values(this.partitions)) {
			if (slice.settings) Object.assign(merged, slice.settings);
		}
		return merged;
	}

	/**
	 * One partition's OWN setting overrides (not the merged view) — what the
	 * hosts publish on the partition's settings topic.
	 *
	 * @param partition - The partition name.
	 * @returns The partition's deltas (empty object when it owns none).
	 */
	public settingsFor(partition: Partition): Record<string, SettingValue> {
		if (partition === SHELL_PARTITION) return this.shellSettings;
		return this.partitions[partition]?.settings ?? {};
	}

	// =========================================================================
	// THE PREFS MIRROR SURFACE — partition-addressed, for the bus
	// =========================================================================
	//
	// The React view above reads the ACTIVE partition only. The mirror needs
	// any partition by name, because a realm hosts partitions this store may
	// never have activated (a dev tool's `app:<id>` bag while a different app
	// is active).

	/**
	 * One partition's prefs bag.
	 *
	 * @param partition - The partition name.
	 * @returns The bag (empty object when the partition holds nothing).
	 */
	public prefsFor(partition: Partition): Record<string, unknown> {
		if (partition === SHELL_PARTITION) return this.shellPrefs;
		return (this.partitions[partition]?.prefs ?? {}) as Record<string, unknown>;
	}

	/**
	 * Writes ONE key into ONE partition — the single-writer entry point every
	 * realm's `shell.setPref` lands on.
	 *
	 * @param partition - The partition to write.
	 * @param key - The key.
	 * @param value - The value, stored verbatim.
	 */
	public setPref(partition: Partition, key: string, value: unknown): void {
		if (partition === SHELL_PARTITION) {
			this.shellPrefs = { ...this.shellPrefs, [key]: value };
			this.scheduleGlobalWrite();
			// theme/sidePanelOpen are ALSO overlaid onto the active app slice,
			// so the React view re-renders with them.
			if (key === 'theme' || key === 'sidePanelOpen') this.commit();
		} else {
			const current = this.partitions[partition] ?? makeDefaultAppState();
			this.partitions = { ...this.partitions, [partition]: { ...current, prefs: { ...current.prefs, [key]: value } } };
			this.scheduleAppWrite(partition);
			if (partition === this.activePartition) this.commit();
		}
		this.notifyPrefs(partition);
	}

	/**
	 * One partition's opaque appState blob.
	 *
	 * NOTE this is NOT mirrored, by design: appState is the Documents
	 * library's blob, the bulk of a workspace file, and opaque to the shell.
	 * A realm that needs part of it pulls that part through its own protocol
	 * (the pipeline editor pulls per-document view state with its load op).
	 *
	 * @param partition - The partition name.
	 * @returns The blob (empty object when the partition holds nothing).
	 */
	public appStateFor(partition: Partition): Record<string, unknown> {
		return this.partitions[partition]?.appState ?? {};
	}

	/**
	 * Writes ONE key into a partition's appState. Key-granular like
	 * {@link setPref}, so two writers touching different keys cannot drop
	 * each other's value.
	 *
	 * @param partition - The partition to write.
	 * @param key - The key (e.g. a document URI).
	 * @param value - The value, stored verbatim. `undefined` DELETES it.
	 */
	public setAppStateKey(partition: Partition, key: string, value: unknown): void {
		const current = this.partitions[partition] ?? makeDefaultAppState();
		const appState = { ...current.appState };
		if (value === undefined) delete appState[key];
		else appState[key] = value;
		this.partitions = { ...this.partitions, [partition]: { ...current, appState } };
		this.scheduleAppWrite(partition);
		if (partition === this.activePartition) this.commit();
	}

	/**
	 * Loads a partition from disk if it is not already in memory, so its bag
	 * can be mirrored. Idempotent and best-effort: a partition with no file is
	 * a legitimate empty bag, not an error.
	 *
	 * @param partition - The partition to load.
	 */
	public async ensurePartition(partition: Partition): Promise<void> {
		if (partition === SHELL_PARTITION || this.partitions[partition]) return;
		let slice: AppWorkspaceState | undefined;
		if (this.canSave()) {
			try {
				const raw = await this.client!.fsReadJson<AppWorkspaceState>(partitionPath(this.workspaceDir, partition));
				if (raw?.prefs) slice = raw;
			} catch {
				/* no saved state for this partition */
			}
		}
		// Seed even on failure: an in-memory bag is what makes later writes
		// land somewhere, and re-reading on every attach would be a round-trip
		// per realm.
		this.partitions = { ...this.partitions, [partition]: slice ?? makeDefaultAppState() };
		// Commit too: the loaded slice may carry a `settings` section, and the
		// merged snapshot view must reflect it.
		this.commit();
		this.notifyPrefs(partition);
	}

	/**
	 * Watches per-partition pref changes, so a host can republish that
	 * partition's topic.
	 *
	 * @param cb - Receives the partition whose bag changed.
	 * @returns Unsubscribe.
	 */
	public onPrefsChanged(cb: (partition: Partition) => void): () => void {
		this.prefsListeners.add(cb);
		return () => {
			this.prefsListeners.delete(cb);
		};
	}

	private prefsListeners = new Set<(partition: Partition) => void>();

	private notifyPrefs(partition: Partition): void {
		for (const cb of [...this.prefsListeners]) cb(partition);
	}

	/** Flushes pending writes and clears timers. */
	public dispose(): void {
		for (const timer of this.appSaveTimers.values()) clearTimeout(timer);
		this.appSaveTimers.clear();
		clearTimeout(this.globalSaveTimer);
	}
}
