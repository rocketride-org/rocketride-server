/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { BillingApi } from '../src/client/billing';

const checkout = { clientSecret: 'client-secret', subscriptionId: 'sub-1', status: 'incomplete' };
const redemption = { mode: 'credits_only', credits: { tokens: 20 } };
const attemptId = 'adad1fc37c3f45158d2175d1c55421ba';

describe('BillingApi attempts', () => {
	it('preserves the checkout and promo payloads when no identifier is supplied', async () => {
		const call = jest.fn(async () => checkout);
		const billing = new BillingApi({ call } as any);
		await billing.createCheckoutSession('org-1', 'app-1', 'price-1', 'SUMMER');
		await billing.redeemPromoCode('org-1', 'GRANT');

		expect(call.mock.calls).toEqual([
			['rrext_account_billing', { subcommand: 'subscribe', orgId: 'org-1', appId: 'app-1', priceId: 'price-1', promotionCode: 'SUMMER' }],
			['rrext_account_billing', { subcommand: 'promo_redeem', orgId: 'org-1', code: 'GRANT' }],
		]);
	});

	it('forwards the same checkout identifier when a response is lost and the caller retries', async () => {
		const call = jest.fn(async () => checkout).mockRejectedValueOnce(new Error('response lost'));
		const billing = new BillingApi({ call } as any);
		const subscribe = () => billing.createCheckoutSession('org-1', 'app-1', 'price-1', undefined, attemptId);
		await expect(subscribe()).rejects.toThrow('response lost');
		await expect(subscribe()).resolves.toEqual(checkout);

		const payload = { subcommand: 'subscribe', orgId: 'org-1', appId: 'app-1', priceId: 'price-1', attemptId };
		expect(call.mock.calls).toEqual([['rrext_account_billing', payload], ['rrext_account_billing', payload]]);
	});

	it('forwards the same redemption identifier when the caller retries', async () => {
		const call = jest.fn(async () => redemption).mockRejectedValueOnce(new Error('response lost'));
		const billing = new BillingApi({ call } as any);
		const redeem = () => billing.redeemPromoCode('org-1', 'GRANT', attemptId);
		await expect(redeem()).rejects.toThrow('response lost');
		await expect(redeem()).resolves.toEqual(redemption);

		const payload = { subcommand: 'promo_redeem', orgId: 'org-1', code: 'GRANT', attemptId };
		expect(call.mock.calls).toEqual([['rrext_account_billing', payload], ['rrext_account_billing', payload]]);
	});
});
