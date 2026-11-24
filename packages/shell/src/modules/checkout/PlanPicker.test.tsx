// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanPicker } from './PlanPicker';
import type { CheckoutPlan } from './types';

const plan = (interval: CheckoutPlan['interval'], description: string[]): CheckoutPlan => ({
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

/** Inner markup of each div that is both aria-hidden and visibility:hidden, whatever its attribute or style order. */
function hiddenLists(html: string): string[] {
	const lists: string[] = [];
	for (const open of html.matchAll(/<div\b(?=[^>]*\baria-hidden="true")(?=[^>]*\bvisibility:\s*hidden)[^>]*>/g)) {
		const start = open.index + open[0].length;
		// Walk div tags from the opening one to its matching close.
		const tags = /<(\/?)div\b/g;
		tags.lastIndex = start;
		let depth = 1;
		let tag: RegExpExecArray | null = null;
		while (depth > 0 && (tag = tags.exec(html))) {
			if (tag[1]) depth--;
			else depth++;
		}
		lists.push(html.slice(start, tag?.index));
	}
	return lists;
}

test('uniform height lays out the other interval list in the card, hidden', () => {
	const html = renderToStaticMarkup(<PlanPicker plans={plans} uniformCardHeight />);
	const hidden = hiddenLists(html);
	assert.equal(hidden.length, 1);
	assert.match(hidden[0], /Annual bonus line/);
});

test('uniform height reserves the other recurring interval, not a one-time price of the same tier', () => {
	const withOneTime = [plan('one_time', ['One-time line']), ...plans];
	const html = renderToStaticMarkup(<PlanPicker plans={withOneTime} uniformCardHeight />);
	// Only the monthly card has a twin, the annual one; the one-time card reserves nothing extra.
	const hidden = hiddenLists(html);
	assert.equal(hidden.length, 1);
	assert.match(hidden[0], /Annual bonus line/);
});

test('without uniform height a card holds only its own list', () => {
	const html = renderToStaticMarkup(<PlanPicker plans={plans} />);
	assert.match(html, /Monthly line/);
	assert.doesNotMatch(html, /Annual bonus line/);
});

test('a custom feature font size keeps long feature words wrapping', () => {
	const html = renderToStaticMarkup(<PlanPicker plans={plans} featureFontSize={13} />);
	assert.match(html, /font-size:\s*13px/);
	assert.doesNotMatch(html, /white-space:\s*nowrap/);
	assert.match(html, /<span style="overflow-wrap:\s*anywhere">Monthly line<\/span>/);
});
