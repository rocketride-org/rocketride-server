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
// EXPLORER KEYS — owner-aware identity, and the one legacy bridge
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEndpointKey, encodeSegment, legacyKeyFromKey, parseEndpointKey, roleKeySource } from './keys';
import type { IEndpointKeyParts } from './keys';
import { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from './types';

const BASE: IEndpointKeyParts = {
	runKind: 'dev',
	ownerKind: 'user',
	ownerId: 'user-1',
	teamId: 'team-1',
	projectId: 'proj-1',
	roles: { tools: 'tools_1' },
	nodeId: 'db_1',
};

describe('buildEndpointKey', () => {
	it('lays the key out as k1|runKind|ownerKind|ownerId|teamId|projectId|bindings|nodeId', () => {
		assert.equal(buildEndpointKey(BASE), 'k1|dev|user|user-1|team-1|proj-1|tools=tools_1|db_1');
	});

	it('separates a developer run from the team deployment of the same pipeline', () => {
		const dev = buildEndpointKey(BASE);
		const deploy = buildEndpointKey({ ...BASE, runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' });
		assert.notEqual(dev, deploy);
	});

	it('separates two owners of the same project, source and node', () => {
		assert.notEqual(buildEndpointKey(BASE), buildEndpointKey({ ...BASE, ownerId: 'user-2' }));
		assert.notEqual(buildEndpointKey(BASE), buildEndpointKey({ ...BASE, teamId: 'team-2' }));
	});

	it('separates a personal (@me) deploy from the same user\'s dev run', () => {
		assert.notEqual(buildEndpointKey(BASE), buildEndpointKey({ ...BASE, runKind: 'deploy' }));
	});

	it('percent-encodes every field so none can contain a raw separator', () => {
		const key = buildEndpointKey({ ...BASE, ownerId: 'a|b:c', projectId: 'p,q=r', nodeId: 'n/1' });
		assert.equal(key.split('|').length, 8);
		assert.equal(key.includes(':'), false);
		assert.deepEqual(parseEndpointKey(key), { ...BASE, ownerId: 'a|b:c', projectId: 'p,q=r', nodeId: 'n/1' });
	});

	it('sorts role bindings so key order never depends on discovery order', () => {
		const a = buildEndpointKey({ ...BASE, roles: { tools: 'tools_1', chat: 'chat_1', ingest: 'ingest_1' } });
		const b = buildEndpointKey({ ...BASE, roles: { ingest: 'ingest_1', tools: 'tools_1', chat: 'chat_1' } });
		assert.equal(a, b);
		assert.match(a, /\|chat=chat_1,ingest=ingest_1,tools=tools_1\|/);
	});

	it('never contains a token-shaped value, because it is built from no token', () => {
		const key = buildEndpointKey(BASE);
		assert.equal(/tk_|pk_|rr_|token/i.test(key), false);
	});
});

describe('parseEndpointKey', () => {
	it('round-trips what buildEndpointKey made', () => {
		assert.deepEqual(parseEndpointKey(buildEndpointKey(BASE)), BASE);
	});

	it('returns null for anything that is not a v1 key, including legacy keys', () => {
		assert.equal(parseEndpointKey('proj-1:tools_1:db_1'), null);
		assert.equal(parseEndpointKey(''), null);
		assert.equal(parseEndpointKey('k2|dev|user|u|t|p|tools=x|n'), null);
		assert.equal(parseEndpointKey('k1|dev|user|u|t|p|tools=x'), null);
		assert.equal(parseEndpointKey('k1|dev|user|u|t|p|toolsx|n'), null);
	});

	it('survives a malformed percent escape instead of throwing', () => {
		const parsed = parseEndpointKey('k1|dev|user|%E0%A4%A|t|p|tools=x|n');
		assert.equal(parsed?.ownerId, '%E0%A4%A');
	});
});

describe('roleKeySource', () => {
	it('uses the bound source when the role is running', () => {
		assert.equal(roleKeySource(SINGLE_TOOLS_ROLE.roles.tools!, 'tools_9'), 'tools_9');
	});

	it('keeps a fixed-source role in the key while it is NOT running, so the key survives it stopping', () => {
		assert.equal(roleKeySource(VECTOR_ROLES.roles.ingest!, null), 'ingest_1');
		assert.equal(roleKeySource(VECTOR_ROLES.roles.ingest!, 'ingest_1'), 'ingest_1');
	});

	it('contributes nothing for an any-source role that is not bound', () => {
		assert.equal(roleKeySource(SINGLE_TOOLS_ROLE.roles.tools!, null), '');
	});
});

describe('legacyKeyFromKey', () => {
	it('gives SQL Explorer\'s old projectId:source:nodeId for the caller\'s own dev run', () => {
		assert.equal(legacyKeyFromKey(buildEndpointKey(BASE)), 'proj-1:tools_1:db_1');
	});

	it('reproduces an old key whose ids contained colons', () => {
		const key = buildEndpointKey({ ...BASE, projectId: 'a:b', roles: { tools: 's:1' }, nodeId: 'n:2' });
		assert.equal(legacyKeyFromKey(key), 'a:b:s:1:n:2');
	});

	it('is null for a deployment, a team run or a personal deploy (history never crosses owner or dev/deploy)', () => {
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' })), null);
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, runKind: 'deploy' })), null);
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, ownerKind: 'team' })), null);
	});

	it('is null when the project id is unknown (never token-derived)', () => {
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, projectId: '' })), null);
	});

	it('is null for a multi-role connection and for text that is not a v1 key', () => {
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, roles: { tools: 'tools_1', chat: 'chat_1' } })), null);
		assert.equal(legacyKeyFromKey('proj-1:tools_1:db_1'), null);
		assert.equal(legacyKeyFromKey(buildEndpointKey({ ...BASE, roles: { tools: '' } })), null);
	});
});

describe('encodeSegment', () => {
	it('escapes the characters the format relies on', () => {
		assert.equal(encodeSegment('a|b:c,d=e'), 'a%7Cb%3Ac%2Cd%3De');
	});
});
