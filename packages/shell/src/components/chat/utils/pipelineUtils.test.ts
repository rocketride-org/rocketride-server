// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PIPELINE_RESULT } from 'rocketride';
import { extractTextFromResult, NO_RESPONSE_MESSAGE } from './pipelineUtils';

test('extractTextFromResult directs user to add a Return Answers node when result_types is absent', () => {
	const result = { name: 'chat' } as PIPELINE_RESULT;
	assert.deepEqual(extractTextFromResult(result), [
		{
			text: NO_RESPONSE_MESSAGE,
			key: '',
		},
	]);
	assert.ok(NO_RESPONSE_MESSAGE.includes('Return Answers'));
});

test('extractTextFromResult extracts string, array, and object answer payloads', () => {
	const result = {
		name: 'chat',
		result_types: {
			answers: 'answers',
			summary: 'text',
			structured: 'answers',
		},
		answers: ['First answer', '  ', 'Second answer'],
		summary: 'Summary text',
		structured: { answer: '  Object answer  ', expectJson: false },
	} as unknown as PIPELINE_RESULT;

	assert.deepEqual(extractTextFromResult(result), [
		{ text: 'First answer', key: 'answers' },
		{ text: 'Second answer', key: 'answers' },
		{ text: 'Summary text', key: 'summary' },
		{ text: 'Object answer', key: 'structured' },
	]);
});
