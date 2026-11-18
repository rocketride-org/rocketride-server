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
// PROJECTION TESTS — T48 (`rr:bridge:init` from allowlisted inputs)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBridgeInit } from './projection';
import type { IBridgeInitInput } from './projection';
import { ENTRY_A, GRANT_A, frameFor, refAppKey } from './__test__/fixtures';
import { brief } from './__test__/util';

/** The `BridgeInit` keys (`types.ts:99`). */
const KEYS = ['appId', 'appKey', 'capabilities', 'engineHttpUrl', 'entryPrefix', 'expiresAt', 'identity', 'moduleId', 'props', 'proto', 'theme', 'type', 'viewId'];

const input = (frame = GRANT_A.frame!): IBridgeInitInput => ({
	info: { realmId: 'realm-x', label: `${ENTRY_A.id}#realm-x`, appId: ENTRY_A.id, appKey: refAppKey(ENTRY_A.id), moduleId: ENTRY_A.moduleId, viewId: 'view-acme.alpha', version: 1, caps: new Set(['core', 'pipelines.run', 'fs.app']) },
	frame,
	displayName: 'Ada',
	theme: { '--rr-bg': '#101010' },
	props: { isConnected: true, activeView: 'view-acme.alpha', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
	engineHttpUrl: 'http://localhost:5565',
	proto: 1,
});

test('T48 buildBridgeInit: exactly the BridgeInit keys, identity from the grant, entryPrefix the only frame-token occurrence', async (tt) => {
	await tt.test('keys, values and identity', () => {
		const init = buildBridgeInit(input());
		assert.deepEqual(Object.keys(init).sort(), KEYS, `the init must have exactly the BridgeInit keys, got ${brief(Object.keys(init))}`);
		const frame = GRANT_A.frame!;
		assert.equal(init.type, 'rr:bridge:init');
		assert.equal(init.proto, 1);
		assert.equal(init.entryPrefix, frame.entryPrefix, "entryPrefix is the grant's /_t/<frame token>/... path");
		assert.equal(init.expiresAt, frame.expiresAt);
		assert.deepEqual(init.identity, { userId: frame.identity!.userId, displayName: 'Ada', organizations: frame.identity!.organizations }, "identity: the grant's user and org aliases");
		assert.equal(init.appId, ENTRY_A.id);
		assert.equal(init.appKey, refAppKey(ENTRY_A.id));
		assert.equal(init.moduleId, ENTRY_A.moduleId);
		assert.equal(init.viewId, 'view-acme.alpha');
		assert.equal(init.engineHttpUrl, 'http://localhost:5565');
		assert.deepEqual(init.theme, { '--rr-bg': '#101010' });
		assert.equal(init.props.activeView, 'view-acme.alpha');
		assert.ok(Array.isArray(init.capabilities) && init.capabilities.every((c) => typeof c === 'string'), 'capabilities are strings');
	});

	await tt.test('the frame token appears only in entryPrefix; no other key carries a credential or the frame ticket', () => {
		const init = buildBridgeInit(input());
		const frame = GRANT_A.frame!;
		const token = frame.entryPrefix.split('/')[2];
		assert.ok(token && token.length > 8, 'the fixture has a frame token');
		const text = JSON.stringify(init);
		assert.equal(text.split(token).length - 1, 1, `the frame token must occur exactly once in the init, got ${text.split(token).length - 1}`);
		assert.ok(String(init.entryPrefix).includes(token), 'and that occurrence is entryPrefix');
		assert.ok(!/(?:tk|pk)_[A-Za-z0-9_-]{16,}/.test(text), 'no engine credential');
		assert.ok(!text.includes('c=ticket'), 'the frame ticket is not part of the init');
		assert.ok(!text.includes(frame.origin), 'the frame origin is not part of the init');
	});

	await tt.test('an anonymous grant has identity null', () => {
		const init = buildBridgeInit(input(frameFor(ENTRY_A, null)));
		assert.equal(init.identity, null, `anonymous: identity must be null, got ${brief(init.identity)}`);
	});
});
