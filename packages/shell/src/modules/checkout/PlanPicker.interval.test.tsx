// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanPicker } from './PlanPicker';
import type { CheckoutPlan } from './types';

const plan = (nickname: string, interval: CheckoutPlan['interval'], order: number): CheckoutPlan => ({
	id: `${nickname}-${interval}`,
	appId: 'app',
	stripePriceId: `price_${nickname}_${interval}`,
	nickname,
	amountCents: 1000 * order,
	currency: 'usd',
	interval,
	metadata: { description: [`${nickname} ${interval}`], order: String(order) },
	isActive: true,
	createdAt: null,
});

// Starter is monthly only; Pro has both intervals, so the toggle shows.
const starterMonth = plan('Starter', 'month', 1);
const plans = [starterMonth, plan('Pro', 'month', 2), plan('Pro', 'year', 2)];

test('an explicit interval toggle shows that interval even when the kept selection has no twin there', async (t) => {
	const dom = new JSDOM('<div id="app"></div>', { url: 'https://shell.example.invalid' });
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	const container = dom.window.document.getElementById('app')!;
	const root = createRoot(container);
	t.after(() => act(() => root.unmount()));

	// Controlled selection with no onIntervalChange: the selection stays Starter/month after the toggle.
	await act(async () => root.render(<PlanPicker plans={plans} selectedPlan={starterMonth} onSelectPlan={() => {}} keepSelectedPlanVisible />));
	assert.match(container.textContent ?? '', /Starter month/);

	const annual = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Annual');
	assert.ok(annual);
	await act(async () => annual.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

	const text = container.textContent ?? '';
	assert.match(text, /Pro year/);
	assert.doesNotMatch(text, /Starter month/);
});

test('a kept selection stays visible at its own interval when the toggle starts elsewhere', async (t) => {
	const dom = new JSDOM('<div id="app"></div>', { url: 'https://shell.example.invalid' });
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	const container = dom.window.document.getElementById('app')!;
	const root = createRoot(container);
	t.after(() => act(() => root.unmount()));

	// Both intervals exist from the start and the picker defaults to monthly, so
	// only keepSelectedPlanVisible can show the yearly selection.
	const proYear = plan('Pro', 'year', 2);
	const both = [plan('Pro', 'month', 2), proYear];
	await act(async () => root.render(<PlanPicker plans={both} selectedPlan={proYear} defaultInterval="month" keepSelectedPlanVisible />));
	assert.match(container.textContent ?? '', /Pro year/);
	// A refreshed catalog (new array, same prices) keeps it too.
	await act(async () => root.render(<PlanPicker plans={[...both]} selectedPlan={proYear} defaultInterval="month" keepSelectedPlanVisible />));
	assert.match(container.textContent ?? '', /Pro year/);
	assert.doesNotMatch(container.textContent ?? '', /Pro month/);
});
