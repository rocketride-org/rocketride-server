// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanChangeOutcome, planChangeCompletion } from './planChange';

test('reads the two outcomes the server reports', () => {
	assert.deepEqual(parsePlanChangeOutcome({ status: 'upgraded', direction: 'upgrade', subscriptionId: 'sub_1' }), { status: 'upgraded' });
	assert.deepEqual(
		parsePlanChangeOutcome({ status: 'downgrade_scheduled', direction: 'downgrade', effectiveDate: '2026-12-24T00:00:00Z' }),
		{ status: 'downgrade_scheduled', effectiveDate: '2026-12-24T00:00:00Z' },
	);
	assert.deepEqual(parsePlanChangeOutcome({ status: 'downgrade_scheduled', effectiveDate: 42 }), { status: 'downgrade_scheduled' });
});

test('an unrecognized success is not an error: the change may already be applied', () => {
	for (const response of [undefined, null, {}, 'upgraded', { status: 'applied' }, { status: 'requires_action' }]) {
		assert.equal(parsePlanChangeOutcome(response), null);
	}
	assert.match(planChangeCompletion(null), /requested/);
	assert.match(planChangeCompletion(undefined), /requested/);
});

test('describes what the server actually did', () => {
	assert.match(planChangeCompletion({ status: 'upgraded' }), /upgraded.*active now/i);
	assert.match(planChangeCompletion({ status: 'downgrade_scheduled' }), /end of this billing period/);
	const dated = planChangeCompletion({ status: 'downgrade_scheduled', effectiveDate: '2026-12-24T12:00:00Z' });
	assert.match(dated, /stays active until/);
	assert.doesNotMatch(dated, /end of this billing period/);
	assert.match(planChangeCompletion({ status: 'downgrade_scheduled', effectiveDate: 'not a date' }), /end of this billing period/);
});
