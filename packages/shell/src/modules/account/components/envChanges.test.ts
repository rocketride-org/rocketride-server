// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { envChanges } from './envChanges';

const MASK = '••••••••';

test('a stored name the draft no longer has is sent as null', () => {
	const stored = { ROCKETRIDE_A: MASK, ROCKETRIDE_B: MASK };

	assert.deepEqual(envChanges([['ROCKETRIDE_A', MASK]], stored), { ROCKETRIDE_A: MASK, ROCKETRIDE_B: null });
});

test('a typed value is sent, and an untouched row keeps its mask', () => {
	const stored = { ROCKETRIDE_A: MASK, ROCKETRIDE_B: MASK };

	assert.deepEqual(
		envChanges(
			[
				['ROCKETRIDE_A', 'new'],
				['ROCKETRIDE_B', MASK],
				['ROCKETRIDE_C', 'added'],
			],
			stored
		),
		{ ROCKETRIDE_A: 'new', ROCKETRIDE_B: MASK, ROCKETRIDE_C: 'added' }
	);
});

test('a row with an empty name is skipped, and nothing stored means nothing deleted', () => {
	assert.deepEqual(
		envChanges(
			[
				['  ', 'x'],
				[' ROCKETRIDE_A ', 'a'],
			],
			undefined
		),
		{ ROCKETRIDE_A: 'a' }
	);
});
