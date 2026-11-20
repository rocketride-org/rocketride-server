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
// SQL-UI DOCUMENTS INSTANCE
// =============================================================================
//
// App-owned Documents instance shared between SqlApp and SqlSidebar. Every
// SQL Explorer document is STATIC (connections landing, connection workbench,
// and later query/designer/diagram docs) — nothing is VFS-backed, so the
// instance is created over the shared NOOP_VFS.
// =============================================================================

import { Documents } from 'shell';
import { NOOP_VFS } from 'shell';
import { createCounter, endpointKeyFromAnyUri as keyFromAnyUri, endpointKeyFromUri as keyFromUri } from 'shared/explorer/nav/addresses';
import type { SqlEndpoint } from './connect';

/** The app's Documents instance. Set by SqlApp on mount. */
let _docs: Documents | null = null;

/**
 * Returns the app's Documents instance, or null if not yet initialised.
 *
 * @returns The Documents instance or null.
 */
export function getDocs(): Documents | null {
	return _docs;
}

/**
 * Creates and stores the app's Documents instance.
 * Called once by SqlApp on mount.
 *
 * @returns The created Documents instance.
 */
export function createDocs(): Documents {
	_docs = new Documents(NOOP_VFS);
	return _docs;
}

/**
 * Destroys the app's Documents instance.
 * Called by SqlApp on unmount.
 */
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}

/** The part of a Documents instance {@link closeConnectionDocuments} needs. */
export interface ConnectionDocsHost {
	/** The current state: every open editor and the document it shows. */
	getState(): { editors: Readonly<Record<string, { documentUri: string }>> };
	/** Close one editor (the document is released with its last editor). */
	closeEditor(editorId: string): void;
}

/**
 * Close every tab that belongs to the signed-in account's connections —
 * workbench, query, table, designer and diagram, in every editor group — and
 * every connection editor (it shows a record from that account's list).
 *
 * Used when the signed-in account changes: those tabs hold the previous
 * account's query results, schema and records. Every SQL Explorer document is
 * static, so none is ever dirty and closing its last editor releases it.
 * (Port of 98277843b; this app has no Connections landing to keep.)
 *
 * @param docs - The app's Documents instance.
 * @returns How many editors were closed.
 */
export function closeConnectionDocuments(docs: ConnectionDocsHost): number {
	const editors = Object.entries(docs.getState().editors);
	let closed = 0;
	for (const [editorId, editor] of editors) {
		if (endpointKeyFromAnyUri(editor.documentUri) === null && !isConnectionEditorUri(editor.documentUri)) continue;
		docs.closeEditor(editorId);
		closed += 1;
	}
	return closed;
}

/**
 * Closes every editor showing one document URI (Documents has no close-by-uri
 * of its own — editors are the closable unit).
 *
 * @param uri - The document URI to close.
 */
export function closeDocumentByUri(uri: string): void {
	const docs = _docs;
	if (!docs) return;
	const state = docs.getState();
	for (const [editorId, editor] of Object.entries(state.editors)) {
		if (editor.documentUri === uri) docs.closeEditor(editorId);
	}
}

// =============================================================================
// DOCUMENT PAYLOADS
// =============================================================================

/**
 * What a query document carries as its static content.
 *
 * It lives here, beside the URI builders, because every producer of a query
 * document already imports this module and none of them should have to
 * import a VIEW to describe what they are handing it. Typing the payload at
 * the call site is what stops a generated query from quietly shipping a
 * misspelled field that the reader would never see.
 */
export interface QueryDocPayload {
	/** The connection the document is pinned to for life. */
	endpoint: SqlEndpoint;
	/** Tab label ("Query 3"). */
	label: string;
	/** Text to seed the editor with. */
	initialSql?: string;
	/** `generated` marks SQL the app wrote rather than the user. */
	origin?: 'generated';
}

// =============================================================================
// DOCUMENT URIS
// =============================================================================

/**
 * SQL Explorer's endpoint document schemes, for the shared key-extraction
 * rule. The connection editor's `connedit:` (and its host docKey `edit:`) is
 * deliberately absent: it names a saved connection, not an endpoint.
 */
const SCHEMES = {
	bare: ['connection', 'diagram'],
	suffixed: ['query', 'table', 'design'],
} as const;

/**
 * Build the workbench document URI for one connection.
 *
 * @param endpointKey - The endpoint's stable key.
 * @returns The document URI.
 */
export function connectionUri(endpointKey: string): string {
	return `connection:${endpointKey}`;
}

/**
 * Extract the endpoint key from a connection document URI.
 *
 * @param uri - A document URI.
 * @returns The endpoint key, or null when the URI is not a connection doc.
 */
export function endpointKeyFromUri(uri: string): string | null {
	return keyFromUri(uri, 'connection');
}

/**
 * Extract the endpoint key from ANY SQL Explorer document URI, so the sidebar
 * schema tree stays bound while a query/table/design/diagram tab is active.
 * The key itself contains colons (`projectId:source:nodeId`), so the suffixed
 * schemes strip exactly ONE trailing `:segment` instead of splitting on ':'.
 *
 * That split is only sound because every suffix is colon-free: query and
 * design-draft suffixes are generated counters, and table names are
 * percent-encoded by {@link tableDataUri} / {@link designUri}
 * (encodeURIComponent escapes ':' as '%3A').
 *
 * @param uri - A document URI of any scheme.
 * @returns The endpoint key, or null for non-endpoint documents (landing doc).
 */
export function endpointKeyFromAnyUri(uri: string): string | null {
	// connection:/diagram: carry the key verbatim; query:/table:/design: append
	// one `:segment` (seq, table, or draft name) that the shared rule strips.
	return keyFromAnyUri(uri, SCHEMES);
}

// Monotonic query-document counter — labels new query tabs Query 1, 2, ...
const nextQuerySeq = createCounter();

/**
 * Build the URI + label for a fresh query document on one connection.
 *
 * @param endpointKey - The endpoint's stable key.
 * @returns The new document's uri and tab label.
 */
export function nextQueryDoc(endpointKey: string): { uri: string; label: string } {
	const seq = nextQuerySeq();
	return { uri: `query:${endpointKey}:${seq}`, label: `Query ${seq}` };
}

/**
 * Check whether a document URI is a query document.
 *
 * @param uri - A document URI.
 * @returns True for query documents.
 */
export function isQueryUri(uri: string): boolean {
	return uri.startsWith('query:');
}

/**
 * Build the URI for a table's data-browser document. The table name is
 * percent-encoded so a name containing ':' cannot fake a scheme separator
 * (see {@link endpointKeyFromAnyUri}).
 *
 * @param endpointKey - The endpoint's stable key.
 * @param table - The table name.
 * @returns The document URI.
 */
export function tableDataUri(endpointKey: string, table: string): string {
	return `table:${endpointKey}:${encodeURIComponent(table)}`;
}

/**
 * Check whether a document URI is a table data-browser document.
 *
 * @param uri - A document URI.
 * @returns True for table data documents.
 */
export function isTableDataUri(uri: string): boolean {
	return uri.startsWith('table:');
}

// Monotonic create-table counter — each "+ Create Table" opens a fresh draft.
const nextDesignSeq = createCounter();

/**
 * Build the URI for a table-designer document. An existing table's name is
 * percent-encoded for the same reason as in {@link tableDataUri}; a draft's
 * `*new*N` suffix is generated here and needs no encoding.
 *
 * @param endpointKey - The endpoint's stable key.
 * @param table - The table to design, or null for a fresh create-table draft.
 * @returns The document URI.
 */
export function designUri(endpointKey: string, table: string | null): string {
	if (table === null) {
		return `design:${endpointKey}:*new*${nextDesignSeq()}`;
	}
	return `design:${endpointKey}:${encodeURIComponent(table)}`;
}

/**
 * Check whether a document URI is a table-designer document.
 *
 * @param uri - A document URI.
 * @returns True for designer documents.
 */
export function isDesignUri(uri: string): boolean {
	return uri.startsWith('design:');
}

// =============================================================================
// CONNECTION EDITOR (the add/edit form as a top-level document, not a modal)
// =============================================================================

/**
 * Build the in-app document URI for the connection editor. One URI per
 * editing target, so re-invoking focuses the existing tab instead of
 * stacking a second form.
 *
 * @param connId - The connection being edited, or null for a new one.
 * @returns The document URI.
 */
export function connectionEditorUri(connId: string | null): string {
	return `connedit:${connId ?? '*new*'}`;
}

/**
 * Check whether a document URI is the connection editor.
 *
 * @param uri - A document URI.
 * @returns True for connection-editor documents.
 */
export function isConnectionEditorUri(uri: string): boolean {
	return uri.startsWith('connedit:');
}

/**
 * The editing target of a connection-editor URI.
 *
 * @param uri - A connection-editor document URI.
 * @returns The connection id being edited, or null for the add form.
 */
export function connectionEditorIdFromUri(uri: string): string | null {
	const rest = uri.slice('connedit:'.length);
	return rest === '*new*' ? null : rest;
}

/**
 * The HOST-document key for the connection editor (VS Code mounts each tool
 * document as its own editor panel; saved-connection ids are the other keys).
 *
 * @param connId - The connection being edited, or null for a new one.
 * @returns The docKey to pass to DevToolProps.documents.open.
 */
export function connectionEditorDocKey(connId: string | null): string {
	return `edit:${connId ?? '*new*'}`;
}

/**
 * Parse a host docKey as a connection-editor key.
 *
 * @param docKey - A host-document key.
 * @returns The editing target ({ connId: null } = add), or null when the key
 *          names a connection workbench instead.
 */
export function parseConnectionEditorDocKey(docKey: string): { connId: string | null } | null {
	if (!docKey.startsWith('edit:')) return null;
	const rest = docKey.slice('edit:'.length);
	return { connId: rest === '*new*' ? null : rest };
}

/**
 * Build the URI for a connection's ER diagram document.
 *
 * @param endpointKey - The endpoint's stable key.
 * @returns The document URI.
 */
export function diagramUri(endpointKey: string): string {
	return `diagram:${endpointKey}`;
}

/**
 * Check whether a document URI is an ER diagram document.
 *
 * @param uri - A document URI.
 * @returns True for diagram documents.
 */
export function isDiagramUri(uri: string): boolean {
	return uri.startsWith('diagram:');
}
