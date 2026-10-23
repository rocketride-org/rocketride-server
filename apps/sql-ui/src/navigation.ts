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
// NAVIGATION — shared UI state between SqlApp and SqlSidebar
// =============================================================================
//
// SQL Explorer's own stores, made by the shared factories
// (shared/explorer/nav): the shell mounts the App and Sidebar as siblings, so
// cross-cutting UI state lives in external stores (admin-ui navigation
// pattern). Each app creates its own, so SQL's active connection never leaks
// into another Explorer. The connection-overlay slot below is SQL Explorer's
// alone: a request that can also be dismissed (null), which the shared
// one-way request channel does not model.
// =============================================================================

import { useSyncExternalStore } from 'react';
import { createActiveKeyStore, createRequestChannel } from 'shared/explorer/nav/stores';
import type { SavedSqlConnection } from './connect';

// =============================================================================
// ACTIVE CONNECTION (which workbench document currently has focus)
// =============================================================================

const activeConnection = createActiveKeyStore();

/**
 * Record which connection document is active (null = none). Called by SqlApp
 * whenever the active editor changes; read by the sidebar to decide whose
 * schema tree to show.
 *
 * @param key - The active connection's endpoint key, or null.
 */
export const setActiveConnection = activeConnection.set;

/**
 * Plain subscription to the active connection key (for non-React consumers —
 * the peer host pushes it to the sidebar mount). Returns unsubscribe.
 *
 * @param cb - Called on every change (not with the current value).
 */
export const subscribeActiveConnection = activeConnection.subscribe;

/**
 * The current active connection key (pairs with subscribeActiveConnection).
 *
 * @returns The active connection's endpoint key, or null.
 */
export const getActiveConnection = activeConnection.get;

/**
 * React hook that subscribes to the active connection key.
 *
 * @returns The active connection's endpoint key, or null.
 */
export const useActiveConnection = activeConnection.use;

// =============================================================================
// TABLE RECORD REQUESTS (sidebar tree click -> overview record drawer)
// =============================================================================

/** A request to open one table's record drawer in a connection's overview. */
export interface TableRecordRequest {
	/** The connection's endpoint key. */
	key: string;
	/** The table to inspect. */
	table: string;
	/** Monotonic sequence so repeat clicks on the same table re-fire. */
	seq: number;
}

const tableRequests = createRequestChannel<{ key: string; table: string }>();

/**
 * Request the record drawer for one table (fired by the sidebar tree; the
 * owning OverviewPanel consumes it).
 *
 * @param key - The connection's endpoint key.
 * @param table - The table name.
 */
export function requestTableRecord(key: string, table: string): void {
	tableRequests.request({ key, table });
}

/**
 * React hook that subscribes to table record requests.
 *
 * @returns The latest request, or null when none has been made.
 */
export function useTableRecordRequest(): TableRecordRequest | null {
	return tableRequests.use();
}

// =============================================================================
// CONNECTION OVERLAYS (sidebar request -> app-root modal/confirm)
// =============================================================================
//
// The shell Modal/ConfirmDialog render fixed-position markup IN PLACE (no
// portal), and the compact drawer is a transformed ancestor — an overlay
// rendered inside the sidebar subtree gets trapped in the drawer. So the
// sidebar only REQUESTS overlays here, and SqlApp hosts them at the app
// root, outside any transformed container.

/** One requested connection overlay. */
export type ConnectionOverlayRequest =
	/** The add/edit modal (editing null = add). */
	| { kind: 'modal'; editing: SavedSqlConnection | null }
	/** The delete confirm for one connection. */
	| { kind: 'delete'; conn: SavedSqlConnection };

let overlayRequest: ConnectionOverlayRequest | null = null;
const overlayListeners = new Set<() => void>();

/**
 * Request a connection overlay (replaces any current one).
 *
 * @param req - The overlay to show, or null to dismiss.
 */
export function requestConnectionOverlay(req: ConnectionOverlayRequest | null): void {
	overlayRequest = req;
	overlayListeners.forEach((fn) => fn());
}

/**
 * React hook that subscribes to the requested connection overlay.
 *
 * @returns The current request, or null when none is open.
 */
export function useConnectionOverlay(): ConnectionOverlayRequest | null {
	return useSyncExternalStore(
		(cb) => { overlayListeners.add(cb); return () => overlayListeners.delete(cb); },
		() => overlayRequest,
	);
}
