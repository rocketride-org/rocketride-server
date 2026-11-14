// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// STATUS ROW TESTS — live status rows from an injected request transport
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../types';
import { makeStatusSink } from './statusRows';

test('the sink appends a row per call, in order, with fresh ids', () => {
	const rows: ChatMessage[] = [];
	let n = 0;
	const sink = makeStatusSink(
		(row) => rows.push(row),
		() => ++n,
		() => '12:00'
	);

	sink('thinking', 'first');
	assert.equal(rows.length, 1, 'the row lands at once, while the request is still pending');
	sink('note', 'second');

	// the type is the transport's
	assert.deepEqual(rows, [
		{ id: 1, text: 'first', sender: 'status', sseType: 'thinking', timestamp: '12:00' },
		{ id: 2, text: 'second', sender: 'status', sseType: 'note', timestamp: '12:00' },
	]);
});
