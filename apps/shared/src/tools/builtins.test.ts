// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_ENABLED } from './agent/enabled';
import { registerBuiltinTools } from './builtins';
import { getBuiltinTools, isBuiltinTool } from './core/registry';

// Pins the gate to the switch, not to the switch's current value: deleting
// the `if (AGENT_ENABLED)` gate fails this test, and flipping the switch
// back on needs no edit here.
test('the builtin catalog follows AGENT_ENABLED', () => {
	registerBuiltinTools();
	const ids = getBuiltinTools().map((tool) => tool.descriptor.id);

	assert.equal(isBuiltinTool('agent'), AGENT_ENABLED);
	assert.equal(isBuiltinTool('builtin.agent'), AGENT_ENABLED);
	assert.deepEqual(ids, [...(AGENT_ENABLED ? ['agent'] : []), 'apps', 'nodes', 'pipelines']);
});

test('the nodes tool opens a document per node', () => {
	registerBuiltinTools();
	const nodes = getBuiltinTools().find((tool) => tool.descriptor.id === 'nodes');

	assert.ok(nodes?.descriptor.devToolFrame);
});
