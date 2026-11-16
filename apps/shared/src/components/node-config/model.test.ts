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
 * node:test suite for the form model: the three path primitives, the schema
 * walk (hoisted vs branch leaves, reachability), ghost defaults and the
 * constant markers. Run via `./builder shared:test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearSecure, constantMarkers, deleteAtPath, dottedNames, effectiveValue, flattenLeaves, getAtPath, hasConfigurableSchema, isReachable, setAtPath } from './model';
import type { ILeafEntry } from './model';

// =============================================================================
// Fixture — the Google Workspace shape of plan §5.6.1 plus a root constant
// =============================================================================

const GOOGLE = {
	properties: [
		{ name: 'type', type: 'constant', default: 'tool_calendar', path: 'type' },
		{ name: 'mode', type: 'constant', default: 'Source', path: 'mode' },
		{
			name: 'authType',
			type: 'string',
			default: 'service',
			path: 'authType',
			enum: {
				service: { title: 'Service', properties: [{ name: 'customerId', type: 'string', path: 'service.customerId' }, { name: 'serviceKey', type: 'upload', path: 'service.serviceKey' }] },
				user: { title: 'User', properties: [{ name: 'userAuth', type: 'oauth2', path: 'user.userAuth' }] },
			},
		},
		{ name: 'access', type: 'string', default: 'write', path: 'access', enum: [['readonly', 'Read-only'], ['write', 'Read/write']] },
	],
};

const byPath = (leaves: ILeafEntry[]) => new Map(leaves.map((entry) => [entry.path, entry]));

// =============================================================================
// Path primitives
// =============================================================================

test('get/set/delete address the tree by dotted path and never mutate the input', () => {
	const original = { authType: 'user', service: { customerId: 'C01' } };
	const next = setAtPath(original, 'user.userAuth', 'grant');
	assert.equal(getAtPath(next, 'user.userAuth'), 'grant');
	assert.equal(getAtPath(next, 'service.customerId'), 'C01');
	assert.deepEqual(original, { authType: 'user', service: { customerId: 'C01' } });

	const reset = deleteAtPath(next, 'user.userAuth');
	assert.equal(getAtPath(reset, 'user.userAuth'), undefined);
	// A group left empty by the delete leaves no `{}` behind
	assert.equal('user' in reset, false);
	assert.deepEqual(getAtPath(reset, 'service'), { customerId: 'C01' });
});

test('a branch switch is one key: the other branch block survives', () => {
	let config = setAtPath({}, 'service.customerId', 'C01');
	config = setAtPath(config, 'authType', 'user');
	config = setAtPath(config, 'user.userAuth', 'grant');
	assert.deepEqual(config, { service: { customerId: 'C01' }, authType: 'user', user: { userAuth: 'grant' } });
	// Switching back finds the service values intact
	config = setAtPath(config, 'authType', 'service');
	assert.equal(getAtPath(config, 'service.customerId'), 'C01');
});

test('a declared name holding a dot is one key, as the server stores it', () => {
	const schema = [{ name: 'model', type: 'string', default: 'gpt-5.2', path: 'model', enum: { 'gpt-5.2': { properties: [{ name: 'temperature', type: 'number', path: 'gpt-5.2.temperature' }] }, 'gpt-4': { properties: [] } } }];
	const dotted = dottedNames(schema);
	assert.deepEqual([...dotted], ['gpt-5.2']);
	const config = setAtPath({}, 'gpt-5.2.temperature', 0.7, dotted);
	assert.deepEqual(config, { 'gpt-5.2': { temperature: 0.7 } });
	assert.equal(getAtPath(config, 'gpt-5.2.temperature', dotted), 0.7);
	assert.deepEqual(deleteAtPath(config, 'gpt-5.2.temperature', dotted), {});
	// Without the schema's names the same path would split naively
	assert.deepEqual(setAtPath({}, 'gpt-5.2.temperature', 0.7), { 'gpt-5': { '2': { temperature: 0.7 } } });
});

test('clearSecure removes an encrypted value the engine would otherwise restore', () => {
	const two = { cloud: { host: 'h' }, secureParameters: { secure: ['cloud.apikey', 'user.userAuth'], readonly: [], token: 't' } };
	// Another secret remains: the path is written empty so the engine keeps it empty
	assert.deepEqual(clearSecure(two, 'user.userAuth'), { cloud: { host: 'h' }, user: { userAuth: '' }, secureParameters: { secure: ['cloud.apikey'], readonly: [], token: 't' } });
	// The last secret: the section goes, no marker needed
	const one = { cloud: { host: 'h' }, secureParameters: { secure: ['cloud.apikey'], readonly: [], token: 't' } };
	assert.deepEqual(clearSecure(one, 'cloud.apikey'), { cloud: { host: 'h' } });
	// Not secured: a plain delete
	assert.deepEqual(clearSecure({ cloud: { host: 'h', apikey: 'k' } }, 'cloud.apikey'), { cloud: { host: 'h' } });
});

// =============================================================================
// Schema walk
// =============================================================================

test('flattenLeaves lists every leaf once with its selector chain', () => {
	const leaves = flattenLeaves(GOOGLE.properties);
	assert.deepEqual(
		leaves.map((entry) => entry.path),
		['type', 'mode', 'authType', 'service.customerId', 'service.serviceKey', 'user.userAuth', 'access']
	);
	const map = byPath(leaves);
	assert.deepEqual(map.get('service.customerId')?.under, [['authType', 'service']]);
	assert.deepEqual(map.get('access')?.under, []);
});

test('reachability follows the selector value, default included', () => {
	const leaves = flattenLeaves(GOOGLE.properties);
	const map = byPath(leaves);
	// Nothing stored: the default branch (service) is reachable
	assert.equal(isReachable({}, map.get('service.customerId')!, map), true);
	assert.equal(isReachable({}, map.get('user.userAuth')!, map), false);
	// Stored choice flips it
	assert.equal(isReachable({ authType: 'user' }, map.get('user.userAuth')!, map), true);
	assert.equal(isReachable({ authType: 'user' }, map.get('service.customerId')!, map), false);
});

// =============================================================================
// Ghost defaults and constants
// =============================================================================

test('effectiveValue is stored ?? default, and a constant always resolves to its default', () => {
	const leaves = byPath(flattenLeaves(GOOGLE.properties));
	assert.equal(effectiveValue({}, leaves.get('access')!.property), 'write');
	assert.equal(effectiveValue({ access: 'readonly' }, leaves.get('access')!.property), 'readonly');
	assert.equal(effectiveValue({ type: 'bogus' }, leaves.get('type')!.property), 'tool_calendar');
});

test('constantMarkers yields only the root-level constants', () => {
	assert.deepEqual(constantMarkers(GOOGLE), { type: 'tool_calendar', mode: 'Source' });
	assert.deepEqual(constantMarkers({ properties: [{ name: 'profile', type: 'string', path: 'profile', enum: { a: { properties: [{ name: 'model', type: 'constant', default: 'm', path: 'a.model' }] } } }] }), {});
	assert.deepEqual(constantMarkers(undefined), {});
});

test('hasConfigurableSchema needs a visible, non-constant leaf', () => {
	assert.equal(hasConfigurableSchema(GOOGLE), true);
	assert.equal(hasConfigurableSchema({ properties: [{ name: 'type', type: 'constant', default: 'x', path: 'type' }] }), false);
	assert.equal(hasConfigurableSchema({ properties: [{ name: 'actions', type: 'object', hidden: true, path: 'actions' }] }), false);
	assert.equal(hasConfigurableSchema({}), false);
	assert.equal(hasConfigurableSchema(undefined), false);
});
