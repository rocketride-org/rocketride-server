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
// ROCKET-UI DOCUMENTS INSTANCE
// =============================================================================
//
// App-owned Documents instance shared between RocketApp and SidebarProvider.
// Created by RocketApp on mount, imported by SidebarProvider.
// =============================================================================

import { Documents } from 'shell';

/** The app's Documents instance. Set by RocketApp on mount. */
let _docs: Documents | null = null;

/**
 * Returns the app's Documents instance, or null if not yet initialised.
 */
export function getDocs(): Documents | null {
	return _docs;
}

/**
 * Creates and stores the app's Documents instance.
 * Called once by RocketApp on mount.
 *
 * @param vfs       - Virtual file system for file I/O.
 * @param workspace - Optional workspace binding for automatic persistence.
 */
export function createDocs(
	vfs: import('shell').IVirtualFileSystem,
	workspace?: import('shell').WorkspaceBinding,
): Documents {
	_docs = new Documents(vfs, workspace);
	return _docs;
}

/**
 * Destroys the app's Documents instance.
 * Called by RocketApp on unmount.
 */
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}
