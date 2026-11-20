import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCheckoutScope, sameCheckoutScope } from './checkoutScope';
import type { CheckoutScope } from './checkoutScope';

const base: CheckoutScope = { orgId: 'org', userId: 'user', server: 'wss://x', replaySupported: true };

test('identity check survives a replay downgrade; the mutation guard does not', () => {
	const downgraded = { ...base, replaySupported: false };
	assert.equal(sameCheckoutScope(downgraded, base), true);
	assert.equal(matchesCheckoutScope(downgraded, base), false);
});

test('identity check still rejects a different org, user or server', () => {
	assert.equal(sameCheckoutScope({ ...base, orgId: 'other' }, base), false);
	assert.equal(sameCheckoutScope({ ...base, userId: 'other' }, base), false);
	assert.equal(sameCheckoutScope({ ...base, server: 'wss://y' }, base), false);
	assert.equal(sameCheckoutScope(null, base), false);
});
