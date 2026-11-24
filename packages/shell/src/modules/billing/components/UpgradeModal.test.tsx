// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * UpgradeModal against the server's real `upgrade` contract: labels come from
 * the plan amounts before the change, and the confirmation reports the
 * outcome the server returned.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { CheckoutPlan } from '../../checkout/types';
import type { UpgradeModalProps } from './UpgradeModal';

const plan = (nickname: string, amountCents: number, order: number): CheckoutPlan => ({
	id: nickname,
	appId: 'app-a',
	stripePriceId: `price_${nickname.toLowerCase()}`,
	nickname,
	amountCents,
	currency: 'usd',
	interval: 'month',
	metadata: { description: [nickname], order: String(order) },
	isActive: true,
	createdAt: null,
});
const starter = plan('Starter', 1000, 1);
const pro = plan('Pro', 3000, 2);
const plans = [starter, pro];

async function renderModal(t: { after: (fn: () => void) => void }, props: Partial<UpgradeModalProps>) {
	const dom = new JSDOM('<div id="app"></div>', { url: 'https://shell.example.invalid' });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
		HTMLElement: dom.window.HTMLElement,
		Node: dom.window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	// react-dom picks its event support at load time, so load it once a DOM exists.
	const [{ createRoot }, { UpgradeModal }] = await Promise.all([import('react-dom/client'), import('./UpgradeModal')]);
	const container = dom.window.document.body;
	const root = createRoot(dom.window.document.getElementById('app')!);
	t.after(() => {
		act(() => root.unmount());
		dom.window.close();
	});
	const base: UpgradeModalProps = { plans, currentPriceId: starter.stripePriceId, currentPlanName: 'Starter', onUpgrade: async () => {}, onClose: () => {} };
	await act(async () => root.render(<UpgradeModal {...base} {...props} />));
	const text = () => container.textContent ?? '';
	const button = (pattern: RegExp) => [...container.querySelectorAll('button')].find((b) => pattern.test(b.textContent ?? ''));
	const click = async (pattern: RegExp) => {
		const target = button(pattern);
		assert.ok(target, `a button matching ${pattern} is on screen (text: ${text()})`);
		await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	};
	return { text, button, click };
}

test('labels the change from the plan amounts and reports the server outcome', async (t) => {
	const sent: string[] = [];
	const ui = await renderModal(t, {
		preselectedPriceId: pro.stripePriceId,
		onUpgrade: async (priceId) => { sent.push(priceId); return { status: 'upgraded' }; },
	});
	assert.ok(ui.button(/^Upgrade to Pro/), 'a pricier plan is labelled Upgrade');
	await ui.click(/^Upgrade to Pro/);
	assert.deepEqual(sent, [pro.stripePriceId]);
	assert.match(ui.text(), /Plan upgraded/);
});

test('a cheaper plan is labelled Downgrade with the renewal note', async (t) => {
	const ui = await renderModal(t, {
		currentPriceId: pro.stripePriceId,
		currentPlanName: 'Pro',
		preselectedPriceId: starter.stripePriceId,
		onUpgrade: async () => ({ status: 'downgrade_scheduled' }),
	});
	assert.ok(ui.button(/^Downgrade to Starter/));
	assert.match(ui.text(), /next renewal/);
	await ui.click(/^Downgrade to Starter/);
	assert.match(ui.text(), /Downgrade scheduled/);
});

test('the confirmation reports what the server did, even when the label guessed otherwise', async (t) => {
	// The server decides direction by tier and interval as well as price, so a
	// pricier plan can still be scheduled as a downgrade.
	const ui = await renderModal(t, {
		preselectedPriceId: pro.stripePriceId,
		onUpgrade: async () => ({ status: 'downgrade_scheduled', effectiveDate: '2026-12-24T00:00:00Z' }),
	});
	await ui.click(/^Upgrade to Pro/);
	assert.match(ui.text(), /Downgrade scheduled/);
	assert.match(ui.text(), /December 24, 2026|24 December 2026/);
	assert.doesNotMatch(ui.text(), /Plan upgraded/);
});

test('a refused change shows the server message and keeps the dialog open', async (t) => {
	let closed = 0;
	const ui = await renderModal(t, {
		preselectedPriceId: pro.stripePriceId,
		onUpgrade: async () => { throw new Error('Your card was declined.'); },
		onClose: () => { closed += 1; },
	});
	await ui.click(/^Upgrade to Pro/);
	assert.match(ui.text(), /Your card was declined/);
	assert.ok(ui.button(/^Upgrade to Pro/), 'the user can try again');
	assert.equal(closed, 0);
});

test('the confirm control is disabled while the host cannot apply plan changes', async (t) => {
	const ui = await renderModal(t, { available: false, preselectedPriceId: pro.stripePriceId });
	const confirm = ui.button(/^Plan changes unavailable/);
	assert.ok(confirm);
	assert.equal(confirm.disabled, true);
});
