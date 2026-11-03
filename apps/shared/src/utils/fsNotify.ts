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
// FS NOTIFY — store-write change notification on the shell event bus
// =============================================================================

/**
 * The ONE page-wide emitter for store-VFS change notifications. Every module
 * that writes the user's file store (app-dev working copies, agent session
 * history, ...) announces the write here so same-realm listeners (sidebars,
 * open editors) can re-read. Lives in shared so all writers share the single
 * page-monotonic revision counter — two counters would break the monotonicity
 * consumers use to drop stale notifications.
 */

import { ConnectionManager } from 'shell';

// =============================================================================
// CHANGE NOTIFICATION
// =============================================================================

/** Page-monotonic revision counter for onFsChange notifications. */
let fsChangeRev = 0;

/**
 * Announces one store-VFS write on the shell notification bus
 * (`shell:notify` / kind `onFsChange`). Called AFTER the server write
 * resolves, so a listener that re-reads the path sees the new content.
 * Page-local by design: same-realm listeners only — cross-tab and
 * cross-client delivery is the future server-pushed feed's job.
 *
 * @param uri - The full store path that changed.
 * @param origin - The writer's identity (a dev-session id, or a verb like
 *                 'scaffold') — listeners skip their own echo.
 */
export function emitFsChange(uri: string, origin: string): void {
	ConnectionManager.getInstance().emit('shell:notify', { kind: 'onFsChange', uri, origin, rev: ++fsChangeRev });
}
