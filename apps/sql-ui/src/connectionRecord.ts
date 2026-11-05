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
// SQL-UI — ONE SAVED CONNECTION, BY ID (both mounts)
// =============================================================================
//
// A document needs one record: the connection it opens, or the one its
// editor edits. Where the list is owned (the full app, and in-shell where the
// controller shares the realm) it is in the list. A dev-tool frame of its own
// realm (VS Code) holds the controller's published replica, and a very long
// list is published in part (ops.ts ConnectionsState.partial): a record the
// partial replica does not hold is asked for (`sql.connection`), and is never
// reported as gone because it was left out.
// =============================================================================

import { useEffect, useState } from 'react';
import { useSavedConnections, useSavedConnectionsPartial, useSavedConnectionsStatus } from './connect';
import type { ReplicaPartial, SavedConnectionsStatus, SavedSqlConnection } from './connect';
import { useSqlEnv } from './sqlEnv';

/** Where a record is. */
export type ConnectionLookup =
	| { kind: 'found'; record: SavedSqlConnection }
	| { kind: 'loading' }
	| { kind: 'missing' }
	| { kind: 'ask' };

/**
 * Find a record in the list this realm holds.
 *
 * @param connId - The connection id.
 * @param view - The list, its status and its partial note.
 * @returns found; loading (the list is not read yet); missing (the whole
 *   list is here and does not hold it); ask (the list is partial: ask its owner).
 */
export function lookupConnection(connId: string, view: { list: SavedSqlConnection[]; status: SavedConnectionsStatus; partial: ReplicaPartial | null }): ConnectionLookup {
	const record = view.list.find((c) => c.id === connId);
	if (record) return { kind: 'found', record };
	if (view.status !== 'ready') return { kind: 'loading' };
	return view.partial === null ? { kind: 'missing' } : { kind: 'ask' };
}

/** A document's record. */
export interface ConnectionRecord {
	/** The record, or null (not known yet, or there is no such connection). */
	record: SavedSqlConnection | null;
	/** 'ready' once `record` is the answer (null then means there is no such connection). */
	status: SavedConnectionsStatus;
}

/**
 * One saved connection, wherever it is (see the header).
 *
 * @param connId - The connection id, or null (an add form: there is none).
 * @returns The record and whether it is known.
 */
export function useConnectionRecord(connId: string | null): ConnectionRecord {
	const env = useSqlEnv();
	const list = useSavedConnections();
	const status = useSavedConnectionsStatus();
	const partial = useSavedConnectionsPartial();
	const lookup = connId === null ? null : lookupConnection(connId, { list, status, partial });
	const asking = lookup?.kind === 'ask';
	const [asked, setAsked] = useState<{ connId: string; record: SavedSqlConnection | null } | null>(null);

	// Asked again whenever the published list changes (an edit or a delete
	// elsewhere); the last answer stands meanwhile, so an open document is
	// not taken down by every publish.
	useEffect(() => {
		if (!asking || connId === null || !env.ready) return undefined;
		let alive = true;
		env.getConnection(connId).then(
			(record) => {
				if (!alive) return;
				setAsked((prev) => (prev !== null && prev.connId === connId && JSON.stringify(prev.record) === JSON.stringify(record) ? prev : { connId, record }));
			},
			// Not answered (not signed in, the list not read yet): the next
			// snapshot asks again.
			() => undefined,
		);
		return () => { alive = false; };
	}, [asking, connId, env, list]);

	if (lookup === null) return { record: null, status: 'ready' };
	switch (lookup.kind) {
		case 'found': return { record: lookup.record, status: 'ready' };
		case 'missing': return { record: null, status: 'ready' };
		case 'loading': return { record: null, status };
		default: return asked !== null && asked.connId === connId ? { record: asked.record, status: 'ready' } : { record: null, status: 'loading' };
	}
}
