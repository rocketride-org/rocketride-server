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

/**
 * node:test suite for the browser half of the resolver's validation — the
 * matrix of plan §14 Step 2 as the form sees it: required / type / enum /
 * bounds on reachable leaves, unknown keys, stale selector values, tolerated
 * switched-away branches, hoisted leaves, encrypted secrets. Run via
 * `./builder shared:test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig, validateLeafValue } from './validate';

// =============================================================================
// Fixture — the qdrant shape (per-branch host, hoisted port) plus a param leaf
// =============================================================================

const QDRANT = {
	properties: [
		{
			name: 'profile',
			type: 'string',
			default: 'cloud',
			path: 'profile',
			enum: {
				cloud: {
					properties: [
						{ name: 'host', type: 'string', required: true, path: 'cloud.host' },
						{ name: 'port', type: 'integer', default: 6333, minimum: 1, maximum: 65535, path: 'port' },
						{ name: 'apikey', type: 'string', secret: true, required: true, path: 'cloud.apikey' },
					],
				},
				local: {
					properties: [
						{ name: 'host', type: 'string', default: 'localhost', path: 'local.host' },
						{ name: 'port', type: 'integer', default: 6333, minimum: 1, maximum: 65535, path: 'port' },
					],
				},
			},
		},
		{ name: 'maxEdge', type: 'integer', default: 1024, minimum: 256, maximum: 4096, path: 'maxEdge' },
		{ name: 'colormap', type: 'string', default: 'viridis', enum: [['viridis', 'Viridis'], ['magma', 'Magma']], path: 'colormap' },
	],
	params: [{ field: 'maxEdge', type: 'integer', title: 'Max edge', description: null, default: 1024, minimum: 256, maximum: 4096 }],
};

const messages = (config: Record<string, unknown>) => validateConfig(QDRANT, config).map((problem) => `${problem.path}: ${problem.message}`);

// =============================================================================
// Leaf rules
// =============================================================================

test('validateLeafValue mirrors the server rules', () => {
	assert.equal(validateLeafValue({ type: 'string', required: true }, ''), 'is required');
	assert.equal(validateLeafValue({ type: 'string', required: true }, undefined), 'is required');
	assert.equal(validateLeafValue({ type: 'string' }, undefined), null);
	assert.equal(validateLeafValue({ type: 'integer' }, 1.5), 'expects integer');
	assert.equal(validateLeafValue({ type: 'number' }, 'x'), 'expects number');
	assert.equal(validateLeafValue({ type: 'integer', minimum: 256 }, 10), 'must be >= 256');
	assert.equal(validateLeafValue({ type: 'integer', maximum: 4096 }, 5000), 'must be <= 4096');
	assert.equal(validateLeafValue({ type: 'string', minLength: 3 }, 'ab'), 'must be at least 3 characters');
	assert.equal(validateLeafValue({ type: 'string', enum: [['a', 'A'], ['b', 'B']] }, 'c'), 'must be one of a, b');
	assert.equal(validateLeafValue({ type: 'array', minItems: 1 }, []), 'must have at least 1 items');
	assert.equal(validateLeafValue({ type: 'array', item: { type: 'integer', minimum: 0 } }, [1, -1]), 'item 2 must be >= 0');
	// A placeholder is typed only once expanded; unchecked types pass
	assert.equal(validateLeafValue({ type: 'integer' }, '${ROCKETRIDE_PORT}'), null);
	assert.equal(validateLeafValue({ type: 'oauth2', required: true }, undefined), null);
});

// =============================================================================
// Whole-config rules
// =============================================================================

test('an empty config is valid where defaults cover the required leaves, else reports them', () => {
	// cloud is the default branch: host and apikey are required with no default
	assert.deepEqual(messages({}), ['cloud.host: is required', 'cloud.apikey: is required']);
	assert.deepEqual(messages({ profile: 'local' }), []);
});

test('defaults are never needed in the file: a ghost default validates like a stored one', () => {
	assert.deepEqual(messages({ profile: 'local', port: 80 }), []);
	assert.deepEqual(messages({ profile: 'local', port: 0 }), ['port: must be >= 1']);
	assert.deepEqual(messages({ profile: 'local', maxEdge: 100 }), ['maxEdge: must be >= 256']);
	assert.deepEqual(messages({ profile: 'local', colormap: 'gray' }), ['colormap: must be one of viridis, magma']);
});

test('a key under the switched-away branch is tolerated, kept and not validated', () => {
	// cloud.apikey missing would be an error on the cloud branch; on local it is unreachable
	assert.deepEqual(messages({ profile: 'local', cloud: { host: 'x.qdrant.io' } }), []);
});

test('an unknown key and a flat dotted key are hard errors', () => {
	assert.deepEqual(messages({ profile: 'local', bogus: 1 }), ['bogus: unknown config key "bogus"']);
	assert.deepEqual(messages({ profile: 'local', 'local.host': 'h' }), ['local.host: config key "local.host" must be written nested, not as one dotted key']);
	// Editor- and engine-owned root keys pass
	assert.deepEqual(messages({ profile: 'local', name: 'My store', secureParameters: { secure: [], token: '' } }), []);
});

test('a stale selector value is an error, never a silent fallback', () => {
	assert.deepEqual(messages({ profile: 'edge' }), ['profile: is set to "edge", which is not one of its options cloud, local']);
});

test('a secret held in the encrypted section satisfies its requirement', () => {
	const config = { cloud: { host: 'x.qdrant.io' }, secureParameters: { secure: ['cloud.apikey'], token: 'abc' } };
	assert.deepEqual(messages(config), []);
});
