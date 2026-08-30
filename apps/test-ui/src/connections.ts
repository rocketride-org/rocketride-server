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
// CONNECTION STORE — Saved test server connections with workspace persistence
// =============================================================================

import type { TestConfig } from './types';
import { DEFAULT_CONFIG } from './session';
import { createExternalStore } from './store';

// =============================================================================
// TYPES
// =============================================================================

/** A saved test server connection. */
export interface SavedConnection {
	id: string;
	name: string;
	url: string;
	apiKey: string;
	config: TestConfig;
	selectedPhases: string[];
}

/** Content stored in a Document tab for a test connection. */
export interface TestConnectionContent {
	connectionId: string;
	url: string;
	apiKey: string;
	config: TestConfig;
	selectedPhases: string[];
}

// =============================================================================
// STORE
// =============================================================================

let _connections: SavedConnection[] = [];
let _updateAppState: ((key: string, value: unknown) => void) | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Shared pub/sub backing useSavedConnections(). */
const _store = createExternalStore();

/** Emit change to all React subscribers. */
function emit() {
	_store.emit();
}

/** Schedule debounced persist to workspace. */
function schedulePersist() {
	if (_persistTimer) clearTimeout(_persistTimer);
	_persistTimer = setTimeout(() => {
		_updateAppState?.('savedConnections', _connections);
		_persistTimer = null;
	}, 500);
}

/** Flush any pending persist immediately. */
function flushPersist() {
	if (_persistTimer) {
		clearTimeout(_persistTimer);
		_updateAppState?.('savedConnections', _connections);
		_persistTimer = null;
	}
}

// =============================================================================
// PUBLIC API
// =============================================================================

const ALL_PHASES = ['sweep', 'stress', 'flood', 'pipe', 'chaos', 'hammer'];

/**
 * Initialise the connection store from workspace appState.
 * Seeds a default localhost connection if none exist.
 */
export function initConnectionStore(appState: Record<string, unknown>, updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void) {
	// Bridge the workspace functional updater to key/value
	_updateAppState = (key, value) => {
		updateAppState((prev) => ({ ...prev, [key]: value }));
	};

	// Restore saved connections
	const saved = appState?.savedConnections;
	if (Array.isArray(saved) && saved.length > 0) {
		_connections = saved as SavedConnection[];
	} else {
		// Seed default
		_connections = [
			{
				id: `conn_${Date.now()}_default`,
				name: 'Local OSS Server',
				url: 'localhost:5565',
				apiKey: '',
				config: { ...DEFAULT_CONFIG },
				selectedPhases: [...ALL_PHASES],
			},
		];
		schedulePersist();
	}
	emit();
}

/** Clean up the store. */
export function destroyConnectionStore() {
	flushPersist();
	_connections = [];
	_updateAppState = null;
	_store.clear();
}

/** Get all saved connections (non-reactive). */
export function getSavedConnections(): SavedConnection[] {
	return _connections;
}

/** React hook — subscribe to connection list changes. */
export function useSavedConnections(): SavedConnection[] {
	return _store.useValue(() => _connections);
}

/** Add a new connection. Returns the generated ID. */
export function addConnection(conn: Omit<SavedConnection, 'id'>): string {
	const id = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	_connections = [..._connections, { ...conn, id }];
	emit();
	schedulePersist();
	return id;
}

/** Update an existing connection. */
export function updateConnection(id: string, patch: Partial<SavedConnection>) {
	_connections = _connections.map((c) => (c.id === id ? { ...c, ...patch } : c));
	emit();
	schedulePersist();
}

/** Delete a connection. */
export function deleteConnection(id: string) {
	_connections = _connections.filter((c) => c.id !== id);
	emit();
	schedulePersist();
}
