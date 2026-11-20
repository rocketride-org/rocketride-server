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
// PR2b final batch — a session-token mismatch detaches the realm (security LOW-6)
// =============================================================================
//
// The request that finds another session token is refused (capability), and
// the realm is detached: its frame shows the Reload tile instead of a realm
// that refuses every op forever. Nothing reaches the engine.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAppRoot } from './types';
import { ENTRY_A, GRANT_A, makeRoot } from './__test__/fixtures';
import { call, expectDenied, expectOk } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';

const execute = (realm: IOpenedRealm): ReturnType<typeof call> => call(realm, 'execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 });
const INIT = { displayName: '', theme: {}, props: { isConnected: true, activeView: '', activeActivity: null, sidePanelOpen: false, theme: '' }, engineHttpUrl: 'http://localhost:5565', proto: 1 };

test('final: after a session-token change the triggering request is refused, the realm is detached, and nothing reaches the engine', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const detachedIds: string[] = [];
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	(t.opts as { onDetached?: (id: string) => void }).onDetached = (id) => void detachedIds.push(id);
	expectOk(await execute(A), 'control');
	t.cm.setSessionToken('sess-another-session-0123456789abcdef');
	const before = t.cm.engine.received.length;
	expectDenied(await execute(A), 'capability', 'the request that found the other token');
	await settle();
	let detached = false;
	try {
		(t.root as IAppRoot).bridgeInit(A.realmId, INIT);
	} catch (err) {
		detached = (err as { name?: string }).name !== 'CapabilityDeniedError';
	}
	assert.equal(detached, true, 'the realm is detached (the frame shows its Reload tile)');
	const later = await Promise.race([execute(A).then((r) => r.kind), new Promise<string>((r) => setTimeout(() => r('silent'), 300))]);
	assert.notEqual(later, 'ok', 'and stays unserved');
	assert.equal(t.cm.engine.received.length, before, 'nothing reached the engine');
});
