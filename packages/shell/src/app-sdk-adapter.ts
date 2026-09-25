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
// app-sdk-adapter — the host-side implementation behind the
// 'rocketride/app-sdk' Module Federation share key
// =============================================================================
//
// rocketride/app-sdk (packages/client-typescript/src/app-sdk) ships
// declaration-only stubs that throw when called directly: real apps are meant
// to get the shell's actual implementation via MF's shared-singleton
// mechanism. That substitution only happens for a share key BOTH sides
// register under the exact same string - sharing 'shell' does not cover
// 'rocketride/app-sdk', a different specifier (see rsbuild.config.mts). This
// file is what the host registers under that exact key, so a remote that
// shares 'rocketride/app-sdk' gets these real implementations instead of the
// SDK's own bundled throwing stubs.
//
// Every export here is either re-exported directly from api.ts (nothing
// duplicated - importing an app-sdk hook and importing the 'shell' hook of
// the same name reach the identical function) or, where app-sdk declares a
// shape api.ts doesn't expose under a matching name (connectionManager as an
// object, getDebugLog, clearDebugLog, onAny), a thin wrapper around
// ConnectionManager's own singleton methods - no new state, no new instance.
// ConnectionManager.getInstance() anchors on a globalThis symbol specifically
// so it returns the same object across separately bundled MF module copies
// (see connection.ts), which is what makes this adapter meaningful at all:
// a remote's own bundled ConnectionManager class would otherwise be a
// different, disconnected instance from the shell's.
// =============================================================================

// Imported from their own source files, not the `./api` barrel: that barrel
// re-exports every UI component too (DataGrid, ChatView, ...), some of which
// pull in CSS at import time - fine for a browser bundle, fatal for this
// adapter's own co-located node:test suite, which needs to import these
// values directly. Each one is still the exact same function api.ts itself
// imports and re-exports, so nothing is duplicated.
export { useShellConnection } from './connection/ConnectionContext';
export { useShellApiConfig } from './connection/ShellApiConfigContext';
export { useWorkspace } from './components/workspace/WorkspaceContext';
export { useAuthUser, useLogout } from './hooks/useAuthUser';
export { useSubscriptions } from './hooks/useSubscriptions';
export { useAppComponent } from './hooks/useAppComponent';
export { getClient } from './util/getClient';
export { Documents } from './components/docs/Documents';

import { ConnectionManager } from './connection/connection';
import type { ShellConnectionEventMap } from './types/shell';

/**
 * Module-level connection manager singleton, matching app-sdk's
 * `connectionManager` shape. Every method forwards to the real
 * `ConnectionManager` singleton - no independent state.
 */
export const connectionManager = {
	/** Emit a typed shell event. */
	emit<K extends keyof ShellConnectionEventMap>(event: K, payload: ShellConnectionEventMap[K]): void {
		ConnectionManager.getInstance().emit(event, payload);
	},
	/** Subscribe to a typed shell event. Returns an unsubscribe function. */
	on<K extends keyof ShellConnectionEventMap>(event: K, handler: (payload: ShellConnectionEventMap[K]) => void): () => void {
		return ConnectionManager.getInstance().on(event, handler);
	},
	/** Returns the RocketRide client singleton, or null if not initialised. */
	getClient() {
		return ConnectionManager.getInstance().getClient();
	},
	/** Returns true when the WebSocket is authenticated and connected. */
	isConnected(): boolean {
		return ConnectionManager.getInstance().isConnected();
	},
};

/** Returns a snapshot of the debug event log (last 500 events). */
export function getDebugLog() {
	return ConnectionManager.getInstance().getDebugLog();
}

/** Clears all entries from the debug log. */
export function clearDebugLog(): void {
	ConnectionManager.getInstance().clearDebugLog();
}

/**
 * Registers a wildcard listener called for every emitted event.
 * Returns an unsubscribe function.
 */
export function onAny(handler: (event: string, payload: unknown) => void): () => void {
	return ConnectionManager.getInstance().onAny(handler);
}
