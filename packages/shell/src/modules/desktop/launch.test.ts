// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_LABEL, isAgent, switchAppRequestOf } from './launch';

test('an app tile opens the app by its id, with no parameters', () => {
	assert.deepEqual(switchAppRequestOf({ id: 'rocketride.chat' }), { appId: 'rocketride.chat' });
	assert.deepEqual(switchAppRequestOf({ id: 'rocketride.chat', kind: 'app' }), { appId: 'rocketride.chat' });
});

test('an agent tile opens its host app bound to its address', () => {
	const agent = { id: 'acme.supportBot', kind: 'pipe', pipe: 'acme.supportBot', hostAppId: 'rocketride.playground' };
	assert.deepEqual(switchAppRequestOf(agent), { appId: 'rocketride.playground', params: { pipe: 'acme.supportBot' } });
});

test('an agent entry missing its host or address never opens a host bound to nothing', () => {
	assert.deepEqual(switchAppRequestOf({ id: 'acme.supportBot', kind: 'pipe', pipe: 'acme.supportBot' }), {
		appId: 'acme.supportBot',
	});
	assert.deepEqual(switchAppRequestOf({ id: 'acme.supportBot', kind: 'pipe', hostAppId: 'rocketride.playground' }), {
		appId: 'acme.supportBot',
	});
});

test('only a pipe entry is an agent, and the UI calls it one', () => {
	assert.equal(isAgent({ kind: 'pipe' }), true);
	assert.equal(isAgent({ kind: 'app' }), false);
	assert.equal(isAgent({}), false);
	assert.equal(AGENT_LABEL, 'Agent');
});
