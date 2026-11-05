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
// GRAPH-UI DOCUMENTS INSTANCE
// =============================================================================
//
// The app-owned Documents instance shared between GraphApp and GraphSidebar. Every
// Graph Explorer document is STATIC (the connections landing, a connection's
// workbench, a connection's write console): nothing is VFS-backed, so the instance
// is created over the shared NOOP_VFS. The endpoint rides as the document's content
// payload; it carries no token (endpoints never do).
// =============================================================================

import { Documents, NOOP_VFS } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';

/** The app's Documents instance. Set by GraphApp on mount. */
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
 * Create and store the app's Documents instance (called once by GraphApp on mount).
 *
 * @returns The new instance.
 */
export function createDocs(): Documents {
	_docs = new Documents(NOOP_VFS);
	return _docs;
}

/** Destroy the instance (called by GraphApp on unmount). */
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}

/** What a workbench or write-console document carries as its static content. */
export interface IConnectionDocPayload {
	endpoint: IExplorerEndpoint;
}
