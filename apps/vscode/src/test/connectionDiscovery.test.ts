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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	connectionDiscoveryPath,
	parseConnectionDiscovery,
	serializeConnectionDiscovery,
	CONNECTION_DISCOVERY_FILENAME,
	type ConnectionDiscoveryInfo,
} from '../engine/local/connectionDiscovery';

const INFO: ConnectionDiscoveryInfo = {
	uri: 'http://localhost:54321',
	apiKey: 'MYAPIKEY',
	pid: 4242,
	updatedAt: '2026-08-05T12:00:00.000Z',
};

// --- connectionDiscoveryPath --------------------------------------------------

test('builds the discovery path under the given engine directory', () => {
	assert.equal(
		connectionDiscoveryPath('/Users/dev/Library/Application Support/RocketRide/engine'),
		`/Users/dev/Library/Application Support/RocketRide/engine/${CONNECTION_DISCOVERY_FILENAME}`,
	);
});

// --- serializeConnectionDiscovery / parseConnectionDiscovery round-trip ------

test('round-trips a well-formed info object', () => {
	const parsed = parseConnectionDiscovery(serializeConnectionDiscovery(INFO));
	assert.deepEqual(parsed, INFO);
});

test('serialized output is valid, human-readable JSON ending in a newline', () => {
	const text = serializeConnectionDiscovery(INFO);
	assert.ok(text.endsWith('\n'));
	assert.deepEqual(JSON.parse(text), INFO);
});

test('defaults a missing apiKey to an empty string on parse', () => {
	const parsed = parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: INFO.pid }));
	assert.deepEqual(parsed, { uri: INFO.uri, apiKey: '', pid: INFO.pid, updatedAt: '' });
});

// --- parseConnectionDiscovery must never throw on bad input ------------------

test('returns null for invalid JSON', () => {
	assert.equal(parseConnectionDiscovery('not json'), null);
});

test('returns null for JSON that is not an object', () => {
	assert.equal(parseConnectionDiscovery('42'), null);
	assert.equal(parseConnectionDiscovery('"a string"'), null);
	assert.equal(parseConnectionDiscovery('null'), null);
	assert.equal(parseConnectionDiscovery('[]'), null);
});

test('returns null when uri is missing or not a string', () => {
	assert.equal(parseConnectionDiscovery(JSON.stringify({ pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: 123, pid: 1 })), null);
});

test('returns null when pid is missing or not a number', () => {
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: '4242' })), null);
});

test('ignores unknown extra fields from a future file version', () => {
	const parsed = parseConnectionDiscovery(
		JSON.stringify({ ...INFO, someFutureField: 'ignore me' }),
	);
	assert.deepEqual(parsed, INFO);
});
