// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanChangePreview, planChangeCompletion } from './planChange';

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

test('parses supported server preview transitions', () => {
	assert.deepEqual(parsePlanChangePreview({ direction: 'upgrade', timing: 'immediate', billingIntervalChanges: true }), {
		direction: 'upgrade', timing: 'immediate', billingIntervalChanges: true,
	});
	for (const timing of ['immediate', 'next_renewal']) {
		assert.equal(parsePlanChangePreview({ direction: 'interval_change', timing }).timing, timing);
	}
});

test('rejects empty, malformed and contradictory preview responses', () => {
	for (const response of [null, {}, { success: true }, { direction: 'upgrade', timing: 'next_renewal' },
		{ direction: 'interval_change', timing: 'unchanged' }, { direction: 'downgrade', timing: 'next_renewal', billingIntervalChanges: 'false' }]) {
		assert.throws(() => parsePlanChangePreview(response), /invalid plan change preview/);
	}
});
