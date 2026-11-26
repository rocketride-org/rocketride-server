// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CheckoutModal attempt-ID and retry paths: what the customer sees when the
 * server refuses an attempt, when the response is lost, and after the result
 * is final. Only the no-payment paths run here, so Stripe Elements never mounts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { CheckoutModalProps, CheckoutPlan, PromoRedemption, PromoValidation } from './types';

const starter: CheckoutPlan = {
	id: 'starter-month',
	appId: 'app-a',
	stripePriceId: 'price_starter_month',
	nickname: 'Starter',
	amountCents: 1000,
	currency: 'usd',
	interval: 'month',
	metadata: { description: ['Starter'], order: '1' },
	isActive: true,
	createdAt: null,
};

type CheckoutResult = Awaited<ReturnType<CheckoutModalProps['onCreateCheckout']>>;

/** What the SDK's call() raises for a `success: false` response. */
function serverRejection(message: string): Error {
	const error = new Error(message);
	error.name = 'CommandException';
	return error;
}

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function renderModal(t: { after: (fn: () => void) => void }, props: Partial<CheckoutModalProps>) {
	const dom = new JSDOM('<div id="app"></div>', { url: 'https://shell.example.invalid' });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	// react-dom decides at load time whether the DOM fires `input` events, so it
	// (and the modal that pulls it in) load only once a DOM exists.
	const [{ createRoot }, { CheckoutModal }] = await Promise.all([import('react-dom/client'), import('./CheckoutModal')]);
	const container = dom.window.document.getElementById('app')!;
	const root = createRoot(container);
	t.after(() => {
		act(() => root.unmount());
		dom.window.close();
	});
	const base = {
		appName: 'App A',
		appDescription: 'Test app',
		appId: 'app-a',
		stripePublishableKey: 'pk_test_placeholder',
		onFetchPlans: async () => [starter],
		onCreateCheckout: async (): Promise<CheckoutResult> => { throw new Error('unexpected checkout'); },
		onConfirmPending: async () => {},
		onSuccess: () => {},
		onClose: () => {},
		requireCheckoutStatus: true,
	};
	await act(async () => root.render(<CheckoutModal {...({ ...base, ...props } as CheckoutModalProps)} />));
	await flush();

	const text = () => container.textContent ?? '';
	const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
	const click = async (label: string) => {
		const target = button(label);
		assert.ok(target, `button "${label}" is on screen (text: ${text()})`);
		await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		await flush();
	};
	const type = async (value: string) => {
		const input = container.querySelector('input[aria-label="Promo code"]') as HTMLInputElement | null;
		assert.ok(input, 'promo input is on screen');
		const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
		await act(async () => {
			setValue.call(input, value);
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		});
	};
	return { text, button, click, type };
}

test('a server error shows its message and Continue retries with the same attempt', async (t) => {
	const attempts: Array<string | undefined> = [];
	const responses: Array<() => Promise<CheckoutResult>> = [
		async () => { throw serverRejection("Another checkout for 'app-a' is already in progress for this organization"); },
		async () => ({ clientSecret: null, subscriptionId: 'sub_1', status: 'active' }),
	];
	let successes = 0;
	const ui = await renderModal(t, {
		onCreateCheckout: (_priceId, _promotionCode, attemptId) => {
			attempts.push(attemptId);
			return responses.shift()!();
		},
		onSuccess: () => { successes += 1; },
	});

	await ui.click('Continue');
	assert.match(ui.text(), /already in progress/);
	assert.doesNotMatch(ui.text(), /unconfirmed/);
	assert.ok(ui.button('Continue'), 'the plan picker stays up for a retry');

	await ui.click('Continue');
	assert.equal(attempts.length, 2);
	assert.ok(attempts[0] && attempts[1]);
	assert.equal(attempts[0], attempts[1], 'the server dedupes the retry by its attempt ID');
	assert.match(ui.text(), /Checkout complete/);
	assert.equal(successes, 1);
});

test('an attempt refused twice is final, so the next Continue gets a fresh ID', async (t) => {
	const attempts: Array<string | undefined> = [];
	const responses: Array<() => Promise<CheckoutResult>> = [
		async () => { throw serverRejection('Your card was declined.'); },
		async () => { throw serverRejection('Your card was declined.'); },
		async () => ({ clientSecret: null, subscriptionId: 'sub_2', status: 'active' }),
	];
	const ui = await renderModal(t, {
		onCreateCheckout: (_priceId, _promotionCode, attemptId) => {
			attempts.push(attemptId);
			return responses.shift()!();
		},
	});
	await ui.click('Continue');
	await ui.click('Continue');
	await ui.click('Continue');
	assert.equal(attempts.length, 3);
	assert.equal(attempts[0], attempts[1], 'the first retry is deduplicated');
	assert.notEqual(attempts[1], attempts[2], 'a repeated refusal is not replayed again');
	assert.match(ui.text(), /Checkout complete/);
});

test('a lost response stays unconfirmed without replay support', async (t) => {
	const ui = await renderModal(t, {
		onCreateCheckout: async () => { throw new Error('Request timed out after 30000ms'); },
	});
	await ui.click('Continue');
	assert.match(ui.text(), /unconfirmed/);
	assert.equal(ui.button('Continue'), undefined);
});

test('a lost response retries the same attempt when the server supports replay', async (t) => {
	const attempts: Array<string | undefined> = [];
	const responses: Array<() => Promise<CheckoutResult>> = [
		async () => { throw new Error('Request timed out after 30000ms'); },
		async () => ({ clientSecret: null, subscriptionId: 'sub_1', status: 'active' }),
	];
	const ui = await renderModal(t, {
		supportsCheckoutReplay: true,
		onCreateCheckout: (_priceId, _promotionCode, attemptId) => {
			attempts.push(attemptId);
			return responses.shift()!();
		},
	});
	await ui.click('Continue');
	await ui.click('Retry checkout');
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0], attempts[1]);
	assert.match(ui.text(), /Checkout complete/);
});

test('a server error on a replay retry keeps the unresolved attempt', async (t) => {
	const attempts: Array<string | undefined> = [];
	const responses: Array<() => Promise<CheckoutResult>> = [
		async () => { throw new Error('Request timed out after 30000ms'); },
		async () => { throw serverRejection("Another checkout for 'app-a' is already in progress for this organization"); },
		async () => ({ clientSecret: null, subscriptionId: 'sub_1', status: 'active' }),
	];
	const ui = await renderModal(t, {
		supportsCheckoutReplay: true,
		onCreateCheckout: (_priceId, _promotionCode, attemptId) => {
			attempts.push(attemptId);
			return responses.shift()!();
		},
	});
	await ui.click('Continue');
	await ui.click('Retry checkout');
	assert.match(ui.text(), /already in progress/);
	// The first attempt may still be completing: the retry control stays, with its ID.
	await ui.click('Retry checkout');
	assert.equal(new Set(attempts).size, 1);
	assert.equal(attempts.length, 3);
	assert.match(ui.text(), /Checkout complete/);
});

test('a final result reaches the host even after the checkout scope stops matching', async (t) => {
	let current = true;
	let successes = 0;
	let acknowledged = 0;
	const ui = await renderModal(t, {
		isCheckoutCurrent: () => current,
		onCreateCheckout: async () => {
			// The connection drops (or replay support is withdrawn) while the
			// server is already answering with the completed subscription.
			current = false;
			return { clientSecret: null, subscriptionId: 'sub_1', status: 'active' };
		},
		onConfirmPending: async () => { acknowledged += 1; },
		onSuccess: () => { successes += 1; },
	});
	await ui.click('Continue');
	assert.match(ui.text(), /Checkout complete/);
	assert.equal(acknowledged, 1);
	assert.equal(successes, 1);

	await ui.click('Continue');
	assert.equal(successes, 2, 'Continue still reaches the host');
});

function promoProps(redeem: (code: string, attemptId?: string) => Promise<PromoRedemption>): Partial<CheckoutModalProps> {
	return {
		onValidatePromoCode: async (code: string): Promise<PromoValidation> => ({ valid: true, code: code.toUpperCase(), appId: 'app-a' } as PromoValidation),
		onRedeemPromoCode: redeem,
	};
}

test('an already-redeemed grant code is a success, not an unconfirmed result', async (t) => {
	let successes = 0;
	const ui = await renderModal(t, {
		...promoProps(async () => ({ redeemed: true, mode: 'already_redeemed', appId: 'app-a', status: 'active', credits: {} } as unknown as PromoRedemption)),
		onSuccess: () => { successes += 1; },
	});
	await ui.type('grant');
	await ui.click('Apply');
	assert.match(ui.text(), /already redeemed/);
	assert.doesNotMatch(ui.text(), /unconfirmed/);
	await ui.click('Continue to App A');
	assert.equal(successes, 1);
});

test('a redemption error shows the server message and retries with the same attempt', async (t) => {
	const attempts: Array<string | undefined> = [];
	const responses: Array<() => Promise<PromoRedemption>> = [
		async () => { throw serverRejection('This code has reached its redemption limit'); },
		async () => ({ redeemed: true, mode: 'credits_only', appId: 'app-a', credits: { tokens: 5 } }),
	];
	const ui = await renderModal(t, promoProps((_code, attemptId) => {
		attempts.push(attemptId);
		return responses.shift()!();
	}));
	await ui.type('grant');
	await ui.click('Apply');
	assert.match(ui.text(), /redemption limit/);
	assert.doesNotMatch(ui.text(), /unconfirmed/);

	await ui.click('Apply');
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0], attempts[1]);
	assert.match(ui.text(), /Code redeemed/);
});

test('an explicit redeemed:false from a server without replay is a refusal', async (t) => {
	const ui = await renderModal(t, promoProps(async () => ({ redeemed: false, mode: 'credits_only', appId: 'app-a', credits: {} })));
	await ui.type('grant');
	await ui.click('Apply');
	assert.match(ui.text(), /could not be redeemed/);
	assert.doesNotMatch(ui.text(), /unconfirmed/);
});
