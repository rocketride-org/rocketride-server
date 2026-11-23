// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ServiceParamDescriptor } from 'rocketride';

import { parseDefault } from './paramDefault';

/** A descriptor with the given members over a bare leaf. */
const leaf = (members: Partial<ServiceParamDescriptor>): ServiceParamDescriptor => ({ field: 'f', type: 'string', title: null, description: null, default: null, ...members });

test('a number field takes a number inside its bounds, a whole one when it is an integer', () => {
	assert.deepEqual(parseDefault('120', leaf({ type: 'number', minimum: 0 })), { value: 120 });
	assert.deepEqual(parseDefault('0.5', leaf({ type: 'number' })), { value: 0.5 });
	assert.deepEqual(parseDefault('abc', leaf({ type: 'number' })), { problem: 'A number' });
	assert.deepEqual(parseDefault('-1', leaf({ type: 'number', minimum: 0 })), { problem: 'At least 0' });
	assert.deepEqual(parseDefault('5000', leaf({ type: 'integer', minimum: 256, maximum: 4096 })), { problem: 'At most 4096' });
	assert.deepEqual(parseDefault('1.5', leaf({ type: 'integer' })), { problem: 'A whole number' });
	assert.deepEqual(parseDefault('1024', leaf({ type: 'integer', minimum: 256, maximum: 4096 })), { value: 1024 });
});

test('an enum takes one of its values, as the value the node declares', () => {
	assert.deepEqual(parseDefault('token', leaf({ enum: ['mask', 'token'] })), { value: 'token' });
	// The text 8 finds the number 8, so the config stores the node's own value
	assert.deepEqual(parseDefault('8', leaf({ type: 'integer', enum: [4, 8] })), { value: 8 });
	assert.deepEqual(parseDefault('other', leaf({ enum: ['mask', 'token'] })), { problem: 'One of: mask, token' });
});

test('a boolean takes true or false; a list or an object takes JSON; a string takes the text', () => {
	assert.deepEqual(parseDefault('true', leaf({ type: 'boolean' })), { value: true });
	assert.deepEqual(parseDefault('false', leaf({ type: 'boolean' })), { value: false });
	assert.deepEqual(parseDefault('yes', leaf({ type: 'boolean' })), { problem: 'true or false' });
	assert.deepEqual(parseDefault('["a","b"]', leaf({ type: 'array' })), { value: ['a', 'b'] });
	assert.deepEqual(parseDefault('[a', leaf({ type: 'array' })), { problem: 'Valid JSON' });
	assert.deepEqual(parseDefault('gpt-5.2', leaf({ type: 'string' })), { value: 'gpt-5.2' });
});
