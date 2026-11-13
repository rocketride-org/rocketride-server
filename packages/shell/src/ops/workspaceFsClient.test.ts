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

// Unit tests: the watch-key format the VS Code host relies on.
// WatchRegistry.pageOf (apps/vscode/src/providers/toolhost/watchRegistry.ts)
// splits a key on its LAST '-' to find the page, and the sidebar sends
// watchPrefixOf() with view:ready so the host keeps exactly that page.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkspaceFs, watchPrefixOf } from './workspaceFsClient';
import type { IWorkspaceFsBus } from './workspaceFsClient';

/** A bus that records the fire-and-forget ops a client emits. */
function recordingBus(): { bus: IWorkspaceFsBus; emitted: { op: string; params: { sub?: string } }[] } {
	const emitted: { op: string; params: { sub?: string } }[] = [];
	const bus: IWorkspaceFsBus = {
		request: async () => undefined,
		emitOp: (op, params) => {
			emitted.push({ op, params: params as { sub?: string } });
		},
		handle: () => {
			return () => undefined;
		},
	};
	return { bus, emitted };
}

test('watch keys are <prefix>-<seq>, under the prefix watchPrefixOf reports', () => {
	const { bus, emitted } = recordingBus();
	const fs = createWorkspaceFs(bus);
	const prefix = watchPrefixOf(fs);
	assert.ok(prefix, 'a client from createWorkspaceFs has a prefix');
	fs.watch(['**/*.rrapp'], () => undefined);
	fs.watch(['**/package.json'], () => undefined);
	const subs = emitted.filter((e) => e.op === 'host.fs.watch').map((e) => e.params.sub);
	assert.deepEqual(subs, [`${prefix}-1`, `${prefix}-2`]);
});

test('the prefix\'s random part is dash-free, so splitting on the last dash finds it', () => {
	const fs = createWorkspaceFs(recordingBus().bus);
	const prefix = watchPrefixOf(fs) ?? '';
	assert.match(prefix, /^fs-[^-]+$/);
});

test('one client per bus, so the prefix is the same instance the tools watch through', () => {
	const { bus } = recordingBus();
	assert.equal(watchPrefixOf(createWorkspaceFs(bus)), watchPrefixOf(createWorkspaceFs(bus)));
});
