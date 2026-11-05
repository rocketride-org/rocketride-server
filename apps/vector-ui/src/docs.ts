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
// VECTOR-UI DOCUMENTS INSTANCE
// =============================================================================
//
// The app-owned Documents instance shared between VectorApp and VectorSidebar.
// Every Vector Explorer document is STATIC (the connections landing, a
// connection's console, one stored document's tab): nothing is VFS-backed, so
// the instance is created over the shared NOOP_VFS. The endpoint rides as the
// document's content payload; it carries no token (endpoints never do).
// =============================================================================

import { Documents, NOOP_VFS } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { documentTitle, documentUri } from './vector/addresses';

/** The app's Documents instance. Set by VectorApp on mount. */
let _docs: Documents | null = null;

/**
 * The app's Documents instance, or null before the app mounted.
 *
 * @returns The instance or null.
 */
export function getDocs(): Documents | null {
	return _docs;
}

/**
 * Create and store the app's Documents instance (called once by VectorApp on mount).
 *
 * @returns The new instance.
 */
export function createDocs(): Documents {
	_docs = new Documents(NOOP_VFS);
	return _docs;
}

/** Destroy the instance (called by VectorApp on unmount). */
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}

/** What a console document carries as its static content. */
export interface IConsoleDocPayload {
	endpoint: IExplorerEndpoint;
}

/** What a document tab carries as its static content. */
export interface IDocumentDocPayload {
	endpoint: IExplorerEndpoint;
	objectId: string;
	path: string | null;
	chunkId?: number;
}

/** The tabs a press just opened or brought forward, each waiting to take the focus once it mounts. */
const arriving = new Set<string>();

/**
 * Note that a press opened (or brought forward) a tab: its own page is hidden then, so the tab takes the focus when it
 * mounts (consoles and documents opened another way, or restored, leave the focus alone).
 *
 * @param uri - The tab's document URI.
 */
export function markArrival(uri: string): void {
	arriving.add(uri);
}

/**
 * Whether a press opened this tab (taken once, by the tab as it mounts).
 *
 * @param uri - The tab's document URI.
 * @returns True once after {@link markArrival}.
 */
export function takeArrival(uri: string): boolean {
	return arriving.delete(uri);
}

/**
 * Open one stored document's tab (the full app's documents).
 *
 * @param endpoint - The connection.
 * @param objectId - The document.
 * @param path - Its path, when known.
 * @param chunkId - A chunk to scroll to.
 */
export function openDocumentTab(endpoint: IExplorerEndpoint, objectId: string, path: string | null, chunkId?: number): void {
	markArrival(documentUri(endpoint.key, objectId));
	getDocs()?.openStaticDocument(documentUri(endpoint.key, objectId), documentTitle(objectId, path), { endpoint, objectId, path, ...(chunkId === undefined ? {} : { chunkId }) });
}
