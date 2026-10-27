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
// SQL — LOCAL ENV (the full app, over its own engine core)
// =============================================================================
//
// The full app (`app:` in the shell) legitimately owns the engine connection,
// so its views call the realm's engine core directly (sqlCore.ts) rather than
// going through ops. Its sidebar sits in the same document, so the sidebar
// bridge is straight calls too. Dev-tool frames never import this module.
// =============================================================================

import { createMessageGridPersistence } from 'shell';
import type { IDataGridPersistence } from 'shell';
import { createCopyingGridPersistence } from 'shared/explorer/devtool/gridPersistence';
import { connectionEditorUri, connectionUri, getDocs } from './docs';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { APP_PRIVACY_NOTICE } from './history/api';
import type { SqlHistoryApi } from './history/api';
import { clearForKey, historyAccess, removeEntry, setNote, setRecording, togglePin, useHistory, useHistoryAccess, useRecording } from './history/historyStore';
import { emitRun } from './history/runEvents';
import { createLocalSavedQueries } from './history/localSavedQueries';
import type { LocalSavedQueries } from './history/localSavedQueries';
import type { HistoryEntry } from './history/types';
import { ANOTHER_ACCOUNT_HISTORY, APP_WORKSPACE_PIN, pinnedGrids, pinnedPrefs } from './history/workspacePin';
import { getActiveConnection, subscribeActiveConnection } from './navigation';
import type { SqlSidebarBridge } from './sidebarBridge';
import type { SqlCore } from './sqlCore';
import type { SqlEnv } from './sqlEnv';

/** Shared empty list, so a refused read keeps a stable snapshot. */
const NO_ENTRIES: HistoryEntry[] = [];

/**
 * Whether the account signed in now may change the full app's history: not
 * another account than the one the page's preferences were read for
 * (history/workspacePin.ts). Its runs are not recorded and its edits change
 * nothing, so nothing of it is held, shown or written until a reload.
 *
 * @returns True unless another account is signed in.
 */
const writable = (): boolean => historyAccess() !== 'another';

/** The full app's history: the module store, persisted through the shell's workspace preferences. */
export const LOCAL_HISTORY: SqlHistoryApi = {
	useHistory: (endpoint) => {
		const entries = useHistory(endpoint.key);
		return useHistoryAccess() === 'another' ? NO_ENTRIES : entries;
	},
	useRecording: (endpoint) => useRecording(endpoint.key),
	usePrivacyNotice: () => APP_PRIVACY_NOTICE,
	useRefusal: () => (useHistoryAccess() === 'another' ? ANOTHER_ACCOUNT_HISTORY : null),
	record: (endpoint, entry) => { if (writable()) emitRun(endpoint.key, entry); },
	removeEntry: (endpoint, id) => { if (writable()) removeEntry(endpoint.key, id); },
	togglePin: (endpoint, id) => { if (writable()) togglePin(endpoint.key, id); },
	setNote: (endpoint, id, note) => { if (writable()) setNote(endpoint.key, id, note); },
	clearForKey: (endpoint) => { if (writable()) clearForKey(endpoint.key); },
	setRecording: (endpoint, on) => { if (writable()) setRecording(endpoint.key, on); },
};

/**
 * The full app's grid layouts: its own workspace prefs, through the shell's
 * grid config channel, but stored and handed out as plain-JSON copies, so
 * Tabulator never rewrites a stored layout in place
 * (shared/explorer/devtool/gridPersistence). The channel is made on first use.
 */
const APP_GRIDS: IDataGridPersistence = createCopyingGridPersistence(() => createMessageGridPersistence());

/** What the full app keeps in its workspace preferences, for one engine core. */
interface LocalPersistence {
	/** Small per-user switches. */
	prefs: IPrefsAccessor;
	/** Grid layouts. */
	grids: IDataGridPersistence;
	/** Saved queries. */
	savedQueries: LocalSavedQueries;
}

/**
 * The full app's preferences, one set per engine core (the env is rebuilt on
 * a reconnect, and its grids must keep their persistence object). Every one
 * reads and writes only for the account the page's preferences were read
 * for: the pin is the page's, so a new core (the app switched away and back)
 * does not start a new one.
 */
const LOCAL_PERSISTENCE = new WeakMap<SqlCore, LocalPersistence>();

/**
 * The core-backed environment (the full app).
 *
 * @param core - The realm's engine core.
 * @param isConnected - The shell's connection flag.
 * @param serviceTitle - A provider's title from the realm's cached service list.
 * @param prefs - The shell's workspace preferences (a stable accessor over `usePrefs`).
 * @returns The environment (rebuild on core/connection change).
 */
export function createLocalSqlEnv(core: SqlCore, isConnected: boolean, serviceTitle: (provider: string) => string | undefined, prefs: IPrefsAccessor): SqlEnv {
	const persistence = persistenceFor(core, prefs);
	return {
		history: LOCAL_HISTORY,
		prefs: persistence.prefs,
		ready: isConnected,
		// The core's session: an apply goes through the core's own gate
		// (sqlCore.ts applyBatch), as the controller's op does.
		getSession: (endpoint) => core.sessionFor(endpoint),
		resolveEndpoint: (conn) => core.resolve(conn.id),
		releaseEndpoint: (connId, key) => {
			void core.release(connId, key).catch(() => undefined);
		},
		discoverEndpoints: () => core.pickable(),
		getService: (provider) => core.getService(provider),
		validate: (pipeline) => core.validate(pipeline),
		getEnvironmentKeys: async () => {
			try {
				return await core.envKeys();
			} catch {
				return [];
			}
		},
		saveConnection: (conn) => core.saveConnection(conn),
		setConnectionSafety: (connId, safety) => core.setConnectionSafety(connId, safety),
		deleteConnection: (conn) => core.deleteConnection(conn.id),
		getConnection: (connId) => core.connection(connId),
		serviceTitle,
		gridPersistence: persistence.grids,
		// Beside history, in the same workspace preferences, for the account
		// the core vouches for now (and only the one they were read for).
		savedQueries: persistence.savedQueries,
	};
}

/**
 * The full app's preferences for one engine core (made on first use), each
 * pinned to the account the page's preferences were read for.
 *
 * @param core - The full app's engine core.
 * @param prefs - The shell's workspace preferences (a stable accessor).
 * @returns The core's preferences.
 */
function persistenceFor(core: SqlCore, prefs: IPrefsAccessor): LocalPersistence {
	let persistence = LOCAL_PERSISTENCE.get(core);
	if (!persistence) {
		const ownerNow = (): string | null => {
			const now = core.identity.get();
			return now.known ? now.fingerprint : null;
		};
		persistence = {
			prefs: pinnedPrefs(APP_WORKSPACE_PIN, prefs, ownerNow),
			grids: pinnedGrids(APP_WORKSPACE_PIN, APP_GRIDS, ownerNow),
			savedQueries: createLocalSavedQueries(prefs, ownerNow, APP_WORKSPACE_PIN),
		};
		LOCAL_PERSISTENCE.set(core, persistence);
	}
	return persistence;
}

/**
 * The in-document sidebar bridge — straight calls into the full app's engine
 * core and the shared singletons.
 *
 * @param core - The full app's engine core.
 * @returns The bridge.
 */
export function createLocalSidebarBridge(core: SqlCore): SqlSidebarBridge {
	const errorSubs = new Set<(message: string) => void>();
	const report = (err: unknown): void => {
		const message = err instanceof Error ? err.message : String(err);
		errorSubs.forEach((fn) => fn(message));
	};
	return {
		openConnection(conn) {
			// Resolves the saved connection (direct mode materialises its temp
			// pipeline) and opens its workbench document.
			core.resolve(conn.id)
				.then((endpoint) => { getDocs()?.openStaticDocument(connectionUri(endpoint.key), conn.name, endpoint); })
				.catch(report);
		},

		openConnectionEditor(editing) {
			getDocs()?.openStaticDocument(connectionEditorUri(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
		},

		deleteConnection(conn) {
			void core.deleteConnection(conn.id).catch(report);
		},

		subscribeActive(cb) {
			cb(getActiveConnection());
			return subscribeActiveConnection(() => cb(getActiveConnection()));
		},

		subscribeError(cb) {
			errorSubs.add(cb);
			return () => { errorSubs.delete(cb); };
		},

		subscribeStatus: (cb) => core.subscribeStatus(cb),
	};
}
