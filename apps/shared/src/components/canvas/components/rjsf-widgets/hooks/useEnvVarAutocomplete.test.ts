/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { insertEnvVarRef } from './useEnvVarAutocomplete';

test('insertEnvVarRef inserts at the caret when openAll leaves triggerStart === cursorPos', () => {
	assert.equal(insertEnvVarRef('hello world', 'ROCKETRIDE_NAME', 6, 6), 'hello ${ROCKETRIDE_NAME}world');
});

test('insertEnvVarRef replaces an incomplete ${ trigger span', () => {
	const value = 'pre ${ROCKETRID';
	assert.equal(insertEnvVarRef(value, 'ROCKETRIDE_API_KEY', 4, value.length), 'pre ${ROCKETRIDE_API_KEY}');
});

test('insertEnvVarRef preserves text after the cursor', () => {
	assert.equal(insertEnvVarRef('abCD', 'ROCKETRIDE_X', 2, 2), 'ab${ROCKETRIDE_X}CD');
});
