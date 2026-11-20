// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OPEN-TOOL DOCUMENT — a database node's Explore button (plan 3.6)
// =============================================================================
//
// The host opens `tool:rocketride.sql/<address>/<nodeId>`; the frame reads
// the key back and binds a workbench to that endpoint with no saved
// connection behind it. Saved-connection ids (UUIDs) and editor keys must
// never be mistaken for one.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolDocKey } from 'shared/tools/pipelines/components/pipeline-actions/openTool';
import { endpointForOpenTool, endpointKeyForConnection } from '../src/connect/resolver';
import { parseConnectionEditorDocKey } from '../src/docs';

describe('the Explore document key', () => {
	it('binds an endpoint to the running control and the node, keyed like a pipeline-bound connection', () => {
		const key = parseToolDocKey('acme.docBrain.dropper_1/postgres_1');
		assert.deepEqual(key, { address: 'acme.docBrain.dropper_1', nodeId: 'postgres_1' });
		const endpoint = endpointForOpenTool(key!.address, key!.nodeId!);
		assert.deepEqual(endpoint, { key: 'acme.docBrain.dropper_1:postgres_1', address: 'acme.docBrain.dropper_1', pipelineName: 'acme.docBrain.dropper_1', nodeId: 'postgres_1', nodeName: 'postgres_1' });
		// The same endpoint saved as a connection keys identically, so history and the schema tree agree
		assert.equal(endpointKeyForConnection({ id: 'x', name: 'n', mode: 'pipeline', address: 'acme.docBrain.dropper_1', pipelineName: 'p', nodeId: 'postgres_1' }), endpoint.key);
	});

	it('is told apart from a saved-connection id and from an editor key', () => {
		assert.equal(parseToolDocKey('3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c'), null);
		assert.equal(parseToolDocKey(Math.random().toString(36).slice(2)), null);
		assert.deepEqual(parseConnectionEditorDocKey('edit:*new*'), { connId: null });
		assert.equal(parseToolDocKey('edit:*new*'), null);
	});

	it('a bare address names no node, so it is not an Explore document', () => {
		assert.equal(parseToolDocKey('acme.docBrain')?.nodeId, undefined);
	});
});
