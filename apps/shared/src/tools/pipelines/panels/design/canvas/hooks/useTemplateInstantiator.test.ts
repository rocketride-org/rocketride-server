// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Node } from '@xyflow/react';

import { claimPostReadyBatch } from './useTemplateInstantiator';

type MeasuredNode = Pick<Node, 'id' | 'measured'>;

function measured(id: string): MeasuredNode {
	return { id, measured: { width: 120, height: 40 } };
}

function unmeasured(id: string): MeasuredNode {
	return { id };
}

function latch(current: readonly string[] | null = null): { current: readonly string[] | null } {
	return { current };
}

test('a measured batch that has not been handled runs and is latched', () => {
	const handled = latch();
	const batch = ['parse_1'];

	assert.equal(claimPostReadyBatch(handled, batch, true, [measured('parse_1')]), true);
	assert.equal(handled.current, batch);
});

test('the same batch array is skipped once handled (the starved Sync-lane re-render)', () => {
	const handled = latch();
	const batch = ['parse_1'];
	const nodes = [measured('parse_1')];

	assert.equal(claimPostReadyBatch(handled, batch, true, nodes), true);
	assert.equal(claimPostReadyBatch(handled, batch, true, nodes), false);
	assert.equal(claimPostReadyBatch(handled, batch, true, nodes), false);
});

test('a new array with the same ids is a new batch and runs', () => {
	const handled = latch(['parse_1']);
	const next = ['parse_1'];

	assert.equal(claimPostReadyBatch(handled, next, true, [measured('parse_1')]), true);
	assert.equal(handled.current, next);
});

test('an empty batch is skipped and leaves the latch alone', () => {
	const previous = ['parse_1'];
	const handled = latch(previous);

	assert.equal(claimPostReadyBatch(handled, [], true, [measured('parse_1')]), false);
	assert.equal(handled.current, previous);
});

test('a batch is skipped while the flow is not ready, without latching', () => {
	const handled = latch();

	assert.equal(claimPostReadyBatch(handled, ['parse_1'], false, [measured('parse_1')]), false);
	assert.equal(handled.current, null);
});

test('an unmeasured batch is skipped and not latched, so it runs once measured', () => {
	const handled = latch();
	const batch = ['parse_1', 'response_text_1'];

	assert.equal(claimPostReadyBatch(handled, batch, true, [measured('parse_1'), unmeasured('response_text_1')]), false);
	assert.equal(handled.current, null);

	assert.equal(claimPostReadyBatch(handled, batch, true, [measured('parse_1'), measured('response_text_1')]), true);
	assert.equal(handled.current, batch);
	assert.equal(claimPostReadyBatch(handled, batch, true, [measured('parse_1'), measured('response_text_1')]), false);
});

test('a pending id with no matching node counts as unmeasured', () => {
	const handled = latch();

	assert.equal(claimPostReadyBatch(handled, ['missing_1'], true, [measured('parse_1')]), false);
	assert.equal(handled.current, null);
});
