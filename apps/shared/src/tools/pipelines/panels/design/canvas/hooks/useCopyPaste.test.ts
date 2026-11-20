// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Node } from '@xyflow/react';

import { getNodesToCopy } from './useCopyPaste';
import type { INodeData } from '../types';

type FlowNode = Node<INodeData>;

function node(id: string, selected: boolean): FlowNode {
	return {
		id,
		selected,
		position: { x: 0, y: 0 },
		data: { provider: id } as INodeData,
	};
}

test('contextual copy targets the overflow-menu node when nothing is selected', () => {
	const menuNode = node('response_image_1', false);
	const copied = getNodesToCopy([menuNode, node('parse_1', false)], [menuNode.id]);

	assert.deepEqual(copied.map((candidate) => candidate.id), ['response_image_1']);
});

test('contextual copy targets the overflow-menu node instead of another selected node', () => {
	const selectedParse = node('parse_1', true);
	const menuNode = node('response_text_1', false);
	const copied = getNodesToCopy([selectedParse, menuNode], [menuNode.id]);

	assert.deepEqual(copied.map((candidate) => candidate.id), ['response_text_1']);
});

test('copy without an explicit target keeps selection-based behaviour for keyboard copy', () => {
	const copied = getNodesToCopy([node('parse_1', false), node('response_text_1', true)]);

	assert.deepEqual(copied.map((candidate) => candidate.id), ['response_text_1']);
});
