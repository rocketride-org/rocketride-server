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

/**
 * The endpoint key minter: the key a webhook caller holds is `task.data` on
 * exactly one address, frozen to the owner's home team (plan §2.4).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConnectResult, CreateKeyParams } from 'rocketride';

import { endpointKeyName, endpointKeyTeam, mintEndpointKey, type IEndpointKeyClient } from './endpointKey';

const ADDRESS = 'acme.docBrain.webhook_1';

/** A client slice that records the create call and answers a fixed key. */
function fakeClient(info: Partial<ConnectResult> | undefined): IEndpointKeyClient & { calls: CreateKeyParams[] } {
	const calls: CreateKeyParams[] = [];
	return {
		calls,
		getAccountInfo: () => info as ConnectResult | undefined,
		account: {
			createKey: async (params) => {
				calls.push(params);
				return { key: 'rr_EXAMPLE_NOT_A_REAL_KEY' };
			},
		},
	};
}

test('the key is named after the pipe and its source', () => {
	assert.equal(endpointKeyName(ADDRESS), 'docBrain webhook_1 key');
	assert.equal(endpointKeyName('acme.docBrain'), 'docBrain key');
});

test('the team is the home team: devTeam first, else the first of the team order, else none', () => {
	assert.equal(endpointKeyTeam({ devTeam: 'prod', teamOrder: ['staging', 'prod'] } as ConnectResult), 'prod');
	assert.equal(endpointKeyTeam({ devTeam: '', teamOrder: ['staging'] } as ConnectResult), 'staging');
	assert.equal(endpointKeyTeam({ devTeam: '' } as ConnectResult), null);
	assert.equal(endpointKeyTeam(undefined), null);
});

test('minting asks for task.data on exactly this address, frozen to the home team', async () => {
	const client = fakeClient({ devTeam: 'prod' });
	const minted = await mintEndpointKey(client, ADDRESS);
	assert.equal(client.calls.length, 1);
	const params = client.calls[0]!;
	assert.deepEqual(params.permissions, ['task.data']);
	assert.deepEqual(params.endpoints, [ADDRESS]);
	assert.equal(params.teamId, 'prod');
	assert.equal(params.name, 'docBrain webhook_1 key');
	assert.equal(params.expiresAt, undefined);
	assert.deepEqual(minted, { key: 'rr_EXAMPLE_NOT_A_REAL_KEY', name: 'docBrain webhook_1 key', teamId: 'prod' });
});

test('an account with no team mints a key that follows the team order (no teamId sent)', async () => {
	const client = fakeClient({ devTeam: '' });
	const minted = await mintEndpointKey(client, ADDRESS);
	assert.equal('teamId' in client.calls[0]!, false);
	assert.equal(minted.teamId, null);
});
