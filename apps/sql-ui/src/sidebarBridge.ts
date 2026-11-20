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
// SQL-UI — SIDEBAR BRIDGE (what the sidebar asks of whoever hosts documents)
// =============================================================================
//
// The sidebar renders the saved-connection list in two mounts: AppLayout's
// sidebar slot in the full app (localEnv.ts: straight calls into the app's
// documents and engine core) and the host's sidebar panel as the dev tool's
// controller (sqlController.ts: host documents and the controller's core).
// =============================================================================

import type { SavedSqlConnection } from './connect';

/** The sidebar's frame-facing actions plus the frame's state feeds. */
export interface SqlSidebarBridge {
	/** Open (or focus) a saved connection's workbench document. */
	openConnection(conn: SavedSqlConnection): void;
	/** Open the add/edit connection editor as a top-level document (null = add). */
	openConnectionEditor(editing: SavedSqlConnection | null): void;
	/** Delete a saved connection (a direct one's temp pipeline is stopped first, best effort). */
	deleteConnection(conn: SavedSqlConnection): void;
	/** Subscribe to the active connection key (replays current). Returns unsubscribe. */
	subscribeActive(cb: (key: string | null) => void): () => void;
	/** Subscribe to open failures (direct resolves can fail). Returns unsubscribe. */
	subscribeError(cb: (message: string) => void): () => void;
}
