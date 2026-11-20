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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/APPDEV — the controller loop (scan → publish → watch → rescan)
// =============================================================================

import { APP_BINDING_WATCH_GLOBS, APP_RESCAN_DEBOUNCE_MS, buildWorkspaceAppRows } from './scan';
import type { IWorkspaceAppRow } from './scan';
// Leaf import: these modules also compile in the VS Code EXTENSION HOST
// program, which must not resolve the shell's React barrel.
import type { WorkspaceFs } from 'shell/src/workspace/workspaceFs';

/**
 * Runs the AppDev controller's discovery loop against a host's workspace-FS
 * capability: one scan now, then a debounced rescan on every binding-file
 * event (installs and branch switches touch many files — one rescan after
 * the burst settles). Superseded scans never overwrite newer results.
 *
 * @param fs - The workspace-FS capability.
 * @param onRows - Receives each fresh row set (the controller's state).
 * @returns Stop — cancels the watch, the debounce, and any in-flight scan.
 */
export function startWorkspaceAppDiscovery(fs: WorkspaceFs, onRows: (rows: IWorkspaceAppRow[]) => void): () => void {
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const rescan = (): void => {
		const mine = ++seq;
		void buildWorkspaceAppRows(fs).then((rows) => {
			if (mine === seq) onRows(rows);
		}).catch(() => {
			// A failed scan keeps the previous rows — transient FS errors must
			// not blank the list (the next event retries).
		});
	};

	rescan();
	const offWatch = fs.watch(APP_BINDING_WATCH_GLOBS, (path) => {
		// node_modules churn is excluded at the policy level, not the host's.
		if (path.includes('node_modules')) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timer = undefined; rescan(); }, APP_RESCAN_DEBOUNCE_MS);
	});

	return () => {
		seq++;
		if (timer) clearTimeout(timer);
		offWatch();
	};
}
