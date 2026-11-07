// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planChangeCompletion } from './planChange';

test('uses neutral copy for legacy callbacks without a result', () => {
	assert.deepEqual(planChangeCompletion(undefined), { message: 'Plan change requested.', pending: false });
});

test('only reports scheduling after the server confirms it', () => {
	assert.match(planChangeCompletion({ status: 'downgrade_scheduled' }).message, /scheduled/);
	assert.match(planChangeCompletion({ status: 'scheduled' }).message, /renewal/);
	assert.match(planChangeCompletion({ status: 'unknown', timing: 'next_renewal' }).message, /requested/);
});

test('displays the actual applied or unchanged result', () => {
	assert.match(planChangeCompletion({ status: 'applied' }).message, /applied/);
	assert.match(planChangeCompletion({ status: 'unchanged' }).message, /current plan/);
});

test('keeps authentication and payment states pending', () => {
	for (const status of ['payment_pending', 'requires_action', 'requires_payment_method']) {
		assert.equal(planChangeCompletion({ status }).pending, true);
	}
});

test('reports a failed payment as an error', () => {
	assert.throws(() => planChangeCompletion({ status: 'payment_failed' }), /Payment failed/);
});
