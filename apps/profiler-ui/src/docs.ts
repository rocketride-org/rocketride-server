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
// PROFILER-UI DOCUMENTS INSTANCE
// =============================================================================
//
// App-owned Documents instance shared between ProfilerApp and ProfilerSidebar.
// Created by ProfilerApp on mount.
// All documents are static (profiler sessions per connection) — no VFS needed.
// =============================================================================

import { Documents } from 'shell-ui';
import type { WorkspaceBinding } from 'shell-ui';

/** The app's Documents instance. Set by ProfilerApp on mount. */
let _docs: Documents | null = null;

/**
 * Returns the app's Documents instance, or null if not yet initialised.
 */
export function getDocs(): Documents | null {
	return _docs;
}

/**
 * Creates and stores the app's Documents instance.
 * Called once by ProfilerApp on mount.
 *
 * @param workspace - Optional workspace binding for automatic persistence.
 */
export function createDocs(workspace?: WorkspaceBinding): Documents {
	_docs = new Documents(null, workspace);
	return _docs;
}

/**
 * Destroys the app's Documents instance.
 * Called by ProfilerApp on unmount.
 */
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}
