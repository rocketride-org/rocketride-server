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
// STORE PATH TESTS — T16
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { ENTRY_A, ENTRY_B, makeRoot, refAppKey } from './__test__/fixtures';
import { clientRequest, dap } from './__test__/realm';
import { assertDenied, assertNotForwarded, brief } from './__test__/util';

test('T16 store paths are canonicalised and confined to apps/<appKey>', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const key = refAppKey(ENTRY_A.id);
	const otherKey = refAppKey(ENTRY_B.id);

	const bad = ['../x', `apps/${key}/../y`, `apps/${key}/%2e%2e/y`, `apps\\${key}\\x`, `apps/${key}/a\u0000b`, `Apps/${key}/x`, `/apps/${key}/x`, '@/Team/x', '@/Org/x', `apps/${otherKey}/x`];
	const msg = (command: string, path: string): DAPMessage => {
		if (command === 'fs_open') return dap('rrext_store', { subcommand: 'fs_open', path, mode: 'r' });
		if (command === 'fs_stat') return dap('rrext_store', { subcommand: 'fs_stat', path });
		return dap('rrext_store', { subcommand: 'fs_rename', old_path: path, new_path: `apps/${key}/ok` });
	};
	for (const command of ['fs_stat', 'fs_open', 'fs_rename']) {
		for (const path of bad) {
			const before = engine.received.length;
			assertDenied(await clientRequest(A, msg(command, path)), 'schema', `${command} ${JSON.stringify(path)}`);
			assertNotForwarded(engine, before, `${command} ${JSON.stringify(path)}`);
		}
	}
	for (const path of bad) {
		const before = engine.received.length;
		assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_rename', old_path: `apps/${key}/ok`, new_path: path })), 'schema', `fs_rename new_path ${JSON.stringify(path)}`);
		assertNotForwarded(engine, before, `fs_rename new_path ${JSON.stringify(path)}`);
	}

	for (const path of [`apps/${key}`, `apps/${key}/`, `apps/${key}/a/b.json`]) {
		const envelope = await clientRequest(A, dap('rrext_store', { subcommand: 'fs_stat', path }));
		assert.equal(envelope.ok, true, `${path} must be allowed, got ${brief(envelope)}`);
	}
	const nfd = 'café.txt';
	const envelope = await clientRequest(A, dap('rrext_store', { subcommand: 'fs_stat', path: `apps/${key}/${nfd}` }));
	assert.equal(envelope.ok, true, 'an NFD name must be allowed');
	assert.equal((engine.received.at(-1)!.message.arguments as { path: string }).path, `apps/${key}/${nfd.normalize('NFC')}`, 'the forwarded path must be NFC');
});
