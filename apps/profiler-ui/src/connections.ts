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
// CONNECTIONS — Saved connection store with workspace persistence
// =============================================================================
//
// Module-level singleton that manages saved server connections for profiling.
// Connections are persisted to the workspace appState under the
// 'savedConnections' key.
//
// Pattern matches models-ui — pub/sub via useSyncExternalStore.
// =============================================================================

import { useSyncExternalStore } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** A saved server connection entry. */
export interface SavedConnection {
	/** Unique identifier. */
	id: string;
	/** Display name (e.g. "Local Dev Server"). */
	name: string;
	/** Hostname or IP address. */
	host: string;
	/** Port number as string. */
	port: string;
}

/** Content payload stored in a static document for an open connection tab. */
export interface ConnectionContent {
	host: string;
	port: string;
}

// =============================================================================
// STORE STATE
// =============================================================================

/** Current list of saved connections. */
let _connections: SavedConnection[] = [];

/** Callback to persist changes to workspace appState. */
let _updateAppState: ((key: string, value: unknown) => void) | null = null;

/** Debounce timer for persistence. */
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Set of subscriber callbacks for useSyncExternalStore. */
const _listeners = new Set<() => void>();

/** Persist debounce interval in milliseconds. */
const PERSIST_DEBOUNCE_MS = 500;

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Notify all subscribers of a state change. */
function _emit(): void {
	for (const fn of _listeners) fn();
}

/** Schedule a debounced persist to workspace appState. */
function _schedulePersist(): void {
	if (_persistTimer) clearTimeout(_persistTimer);
	_persistTimer = setTimeout(() => {
		_updateAppState?.('savedConnections', _connections);
		_persistTimer = null;
	}, PERSIST_DEBOUNCE_MS);
}

/** Generate a simple unique ID for a new connection. */
function _generateId(): string {
	return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialise the connection store from workspace appState.
 * Seeds a default connection from settings if no saved connections exist.
 *
 * @param appState       - Current workspace appState object.
 * @param updateAppState - Callback to persist changes to workspace.
 * @param settings       - Workspace settings (for seeding defaults).
 */
export function initConnectionStore(
	appState: Record<string, unknown>,
	updateAppState: (key: string, value: unknown) => void,
	settings: Record<string, string>,
): void {
	_updateAppState = updateAppState;

	// Restore from persisted state
	const saved = appState.savedConnections as SavedConnection[] | undefined;
	if (saved && Array.isArray(saved) && saved.length > 0) {
		_connections = saved;
	} else {
		// Seed a default connection from shell settings
		const host = settings.PROFILER_SERVER_HOST || 'localhost';
		const port = settings.PROFILER_SERVER_PORT || '5565';
		_connections = [{ id: _generateId(), name: 'Local Server', host, port }];
		_schedulePersist();
	}
	_emit();
}

/**
 * Tear down the connection store.
 * Flushes any pending persist and clears state.
 */
export function destroyConnectionStore(): void {
	if (_persistTimer) {
		// Flush immediately before teardown
		clearTimeout(_persistTimer);
		_updateAppState?.('savedConnections', _connections);
		_persistTimer = null;
	}
	_connections = [];
	_updateAppState = null;
	_listeners.clear();
}

/**
 * Add a new saved connection.
 *
 * @param conn - Connection data (without id).
 * @returns The generated id.
 */
export function addConnection(conn: Omit<SavedConnection, 'id'>): string {
	const id = _generateId();
	_connections = [..._connections, { ...conn, id }];
	_emit();
	_schedulePersist();
	return id;
}

/**
 * Update an existing saved connection.
 *
 * @param id    - Connection id to update.
 * @param patch - Partial fields to merge.
 */
export function updateConnection(id: string, patch: Partial<Omit<SavedConnection, 'id'>>): void {
	_connections = _connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
	_emit();
	_schedulePersist();
}

/**
 * Delete a saved connection.
 *
 * @param id - Connection id to remove.
 */
export function deleteConnection(id: string): void {
	_connections = _connections.filter((c) => c.id !== id);
	_emit();
	_schedulePersist();
}

/**
 * Get current saved connections (non-reactive snapshot).
 */
export function getSavedConnections(): SavedConnection[] {
	return _connections;
}

/**
 * React hook — subscribe to saved connections changes.
 * Re-renders the component whenever connections are added, updated, or deleted.
 */
export function useSavedConnections(): SavedConnection[] {
	return useSyncExternalStore(
		(cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
		() => _connections,
	);
}
