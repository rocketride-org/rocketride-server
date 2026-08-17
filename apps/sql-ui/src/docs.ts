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

// =============================================================================
// DOCUMENT URIS
// =============================================================================

/** URI of the Connections landing document. */
export const CONNECTIONS_URI = 'connections';

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
	return uri.startsWith('connection:') ? uri.slice('connection:'.length) : null;
}

/**
 * Extract the endpoint key from ANY SQL Explorer document URI, so the sidebar
 * schema tree stays bound while a query/table/design/diagram tab is active.
 * The key itself contains colons (`projectId:source:nodeId`), so the suffixed
 * schemes strip exactly ONE trailing `:segment` instead of splitting on ':'.
 *
 * @param uri - A document URI of any scheme.
 * @returns The endpoint key, or null for non-endpoint documents (landing doc).
 */
export function endpointKeyFromAnyUri(uri: string): string | null {
	const m = /^(connection|diagram|query|table|design):(.+)$/.exec(uri);
	if (!m || !m[1] || !m[2]) return null;
	// connection:/diagram: carry the key verbatim.
	if (m[1] === 'connection' || m[1] === 'diagram') return m[2];
	// query:/table:/design: append one `:segment` (seq, table, or draft name).
	const cut = m[2].lastIndexOf(':');
	return cut > 0 ? m[2].slice(0, cut) : null;
}

// Monotonic query-document counter — labels new query tabs Query 1, 2, ...
let querySeq = 0;

/**
 * Build the URI + label for a fresh query document on one connection.
 *
 * @param endpointKey - The endpoint's stable key.
 * @returns The new document's uri and tab label.
 */
export function nextQueryDoc(endpointKey: string): { uri: string; label: string } {
	querySeq += 1;
	return { uri: `query:${endpointKey}:${querySeq}`, label: `Query ${querySeq}` };
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
 * Build the URI for a table's data-browser document.
 *
 * @param endpointKey - The endpoint's stable key.
 * @param table - The table name.
 * @returns The document URI.
 */
export function tableDataUri(endpointKey: string, table: string): string {
	return `table:${endpointKey}:${table}`;
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
let designSeq = 0;

/**
 * Build the URI for a table-designer document.
 *
 * @param endpointKey - The endpoint's stable key.
 * @param table - The table to design, or null for a fresh create-table draft.
 * @returns The document URI.
 */
export function designUri(endpointKey: string, table: string | null): string {
	if (table === null) {
		designSeq += 1;
		return `design:${endpointKey}:*new*${designSeq}`;
	}
	return `design:${endpointKey}:${table}`;
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
