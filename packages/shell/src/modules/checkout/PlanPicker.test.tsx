// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanPicker } from './PlanPicker';
import type { CheckoutPlan } from './types';

const plan = (interval: 'month' | 'year', description: string[]): CheckoutPlan => ({
	id: `pro-${interval}`,
	appId: 'app',
	stripePriceId: `price_pro_${interval}`,
	nickname: 'Pro',
	amountCents: 1000,
	currency: 'usd',
	interval,
	metadata: { description },
	isActive: true,
	createdAt: null,
});

const plans = [plan('month', ['Monthly line']), plan('year', ['Monthly line', 'Annual bonus line'])];

test('uniform height lays out the other interval list in the card, hidden', () => {
	const html = renderToStaticMarkup(<PlanPicker plans={plans} uniformCardHeight />);
	assert.match(html, /visibility:hidden" aria-hidden="true">.*Annual bonus line/);
});

test('without uniform height a card holds only its own list', () => {
	const html = renderToStaticMarkup(<PlanPicker plans={plans} />);
	assert.match(html, /Monthly line/);
	assert.doesNotMatch(html, /Annual bonus line/);
});
