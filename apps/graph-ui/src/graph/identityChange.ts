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
// GRAPH - A CHANGE OF IDENTITY: close what belonged to the previous one
// =============================================================================
//
// Every connection, with its token, probe and session, belongs to ONE identity:
// this user, in this organization, with this development team. On a change (an
// account update that picks another team) or a sign-out, the shared endpoint
// store forgets all of it. The open documents are the app's own, though: a
// workbench or write console keeps its results, graph and editor on screen, and
// still shows the previous identity's endpoint as ready until a discovery runs.
//
// So on every change of the identity fingerprint (the one the shared store
// tracks: user, organization, team; never a token or a permission list) the app
// closes every connection-scoped document and clears its per-connection caches.
// The Connections landing stays; when something was closed it is focused (or
// opened), so the new identity's connections are discovered and shown at once.
// =============================================================================

import { CONNECTIONS_URI, endpointKeyFromUri } from './addresses';
import type { ISchemaStore } from './schemaStore';

/** The part of the app's Documents instance this needs. */
export interface IConnectionDocs {
	/** The current state: every open editor and the document it shows. */
	getState(): { editors: Record<string, { documentUri: string }> };
	/** Close one editor (a static document is disposed with its last editor). */
	closeEditor(editorId: string): void;
	/** Focus the document's tab, or open it in the active group. */
	openStaticDocument(uri: string, label: string): void;
}

/** The per-connection caches that outlive a document. */
export interface IConnectionCaches {
	/** Schema snapshots, one per connection. */
	schemas: Pick<ISchemaStore, 'clear'>;
}

/**
 * The editors that show a connection's document (a workbench or a write console), never the landing.
 *
 * @param editors - The open editors by id.
 * @returns Their ids, in the order given.
 */
export function connectionEditorIds(editors: Record<string, { documentUri: string }>): string[] {
	return Object.entries(editors)
		.filter(([, editor]) => endpointKeyFromUri(editor.documentUri) !== null)
		.map(([id]) => id);
}

/**
 * Forget everything that belonged to the previous identity: close every connection-scoped document and clear the
 * per-connection caches (a schema load still in flight is dropped when it lands). When something was closed, the
 * landing is focused, or opened if the user had closed it.
 *
 * @param docs - The app's Documents instance, or null before it exists.
 * @param caches - The per-connection caches.
 * @returns How many documents were closed.
 */
export function forgetConnections(docs: IConnectionDocs | null, caches: IConnectionCaches): number {
	caches.schemas.clear();
	if (docs === null) return 0;
	const ids = connectionEditorIds(docs.getState().editors);
	for (const id of ids) docs.closeEditor(id);
	if (ids.length > 0) docs.openStaticDocument(CONNECTIONS_URI, 'Connections');
	return ids.length;
}
