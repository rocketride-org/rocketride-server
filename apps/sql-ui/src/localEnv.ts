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
import { clearForKey, removeEntry, setNote, setRecording, togglePin, useHistory, useRecording } from './history/historyStore';
import { emitRun } from './history/runEvents';
import { getActiveConnection, subscribeActiveConnection } from './navigation';
import type { SqlSidebarBridge } from './sidebarBridge';
import type { SqlCore } from './sqlCore';
import type { SqlEnv } from './sqlEnv';

/** The full app's history: the module store, persisted through the shell's workspace preferences. */
export const LOCAL_HISTORY: SqlHistoryApi = {
	useHistory: (endpoint) => useHistory(endpoint.key),
	useRecording: (endpoint) => useRecording(endpoint.key),
	usePrivacyNotice: () => APP_PRIVACY_NOTICE,
	record: (endpoint, entry) => emitRun(endpoint.key, entry),
	removeEntry: (endpoint, id) => removeEntry(endpoint.key, id),
	togglePin: (endpoint, id) => togglePin(endpoint.key, id),
	setNote: (endpoint, id, note) => setNote(endpoint.key, id, note),
	clearForKey: (endpoint) => clearForKey(endpoint.key),
	setRecording: (endpoint, on) => setRecording(endpoint.key, on),
};

/**
 * The full app's grid layouts: its own workspace prefs, through the shell's
 * grid config channel, but stored and handed out as plain-JSON copies, so
 * Tabulator never rewrites a stored layout in place
 * (shared/explorer/devtool/gridPersistence). The channel is made on first use.
 */
const APP_GRIDS: IDataGridPersistence = createCopyingGridPersistence(() => createMessageGridPersistence());

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
	return {
		history: LOCAL_HISTORY,
		prefs,
		ready: isConnected,
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
		deleteConnection: (conn) => core.deleteConnection(conn.id),
		getConnection: (connId) => core.connection(connId),
		serviceTitle,
		gridPersistence: APP_GRIDS,
	};
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
	};
}
