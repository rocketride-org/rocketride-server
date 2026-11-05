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
// SQL-UI — WHICH DIRECT PIPELINES TO STOP WHEN DOCUMENTS CLOSE (full app)
// =============================================================================
//
// The full app stops a direct connection's temporary tool pipeline when the
// last document that uses it closes. Its documents are keyed by the endpoint
// key they opened, and an edit to the connection (another provider) changes
// that key without re-keying documents already open. So the plan groups the
// open keys by CONNECTION:
//
//   no document of the connection is left, under any key
//       release it UNKEYED: whatever pipeline the connection has now is
//       stopped (the same as a delete), the edited one included;
//   another document of the connection is still open
//       release the closed key only: the core stops nothing when that key is
//       no longer the connection's (the edited pipeline keeps running).
// =============================================================================

import { connIdFromDirectKey, isDirectEndpointKey } from './connect';

/** One release to make. */
export interface DirectRelease {
	/** The saved connection. */
	connId: string;
	/** The endpoint key the closed documents opened, or undefined: stop whatever the connection runs now. */
	key?: string;
}

/**
 * The releases owed when the open documents change.
 *
 * @param before - The direct endpoint keys open before.
 * @param now - The direct endpoint keys open now.
 * @returns The releases, at most one per connection.
 */
export function directReleasesOnClose(before: ReadonlySet<string>, now: ReadonlySet<string>): DirectRelease[] {
	const stillOpen = new Set<string>();
	for (const key of now) {
		const connId = isDirectEndpointKey(key) ? connIdFromDirectKey(key) : null;
		if (connId !== null) stillOpen.add(connId);
	}
	const releases = new Map<string, DirectRelease>();
	for (const key of before) {
		if (now.has(key)) continue;
		const connId = isDirectEndpointKey(key) ? connIdFromDirectKey(key) : null;
		if (connId === null || releases.has(connId)) continue;
		releases.set(connId, stillOpen.has(connId) ? { connId, key } : { connId });
	}
	return [...releases.values()];
}
