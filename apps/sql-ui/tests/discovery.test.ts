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
// DISCOVERY — the picker's choice becomes the endpoint a connection binds to
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DATABASE_CLASS_TYPE, endpointFromChoice } from '../src/connect/discovery';

// =============================================================================
// endpointFromChoice
// =============================================================================

describe('endpointFromChoice', () => {
	it('keys the endpoint by the address the node answered under and its node id', () => {
		assert.deepEqual(endpointFromChoice({ address: 'acme.p1', nodeId: 'pg_1', nodeName: 'Analytics', pipeName: 'Pipeline A' }), {
			key: 'acme.p1:pg_1',
			address: 'acme.p1',
			pipelineName: 'Pipeline A',
			nodeId: 'pg_1',
			nodeName: 'Analytics',
		});
	});

	it('keeps a source address when the node answered under one', () => {
		const endpoint = endpointFromChoice({ address: 'acme.p1.chat', nodeId: 'db_main', nodeName: 'Ops DB', pipeName: 'Doc brain' });
		assert.equal(endpoint.address, 'acme.p1.chat');
		assert.equal(endpoint.key, 'acme.p1.chat:db_main');
	});

	it('falls back to the address and the node id when the names are blank', () => {
		const endpoint = endpointFromChoice({ address: 'acme.p1', nodeId: 'ch_1', nodeName: '', pipeName: '' });
		assert.equal(endpoint.pipelineName, 'acme.p1');
		assert.equal(endpoint.nodeName, 'ch_1');
	});

	it('carries no provider: a node learned from interfaces() is known by its classType until dialect answers', () => {
		const endpoint = endpointFromChoice({ address: 'acme.p1', nodeId: 'pg_1', nodeName: 'Analytics', pipeName: 'Pipeline A' });
		assert.equal('provider' in endpoint, false);
	});
});

describe('DATABASE_CLASS_TYPE', () => {
	it('is the catalog word the picker filters on', () => {
		assert.equal(DATABASE_CLASS_TYPE, 'database');
	});
});
