// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The Teams card with and without a way to save the order.
 *
 * `onSetTeamOrder` is optional on the account view (a host written for shell
 * contract v14 passes `onSetDevTeam` instead, which is ignored). Without it
 * the card still shows the order and the home team, and offers no control
 * that would have nothing to call.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TeamInfo } from 'rocketride';
import { TeamOrderCard } from './ProfilePanel';

// =============================================================================
// FIXTURES
// =============================================================================

const team = (id: string): TeamInfo => ({ id, name: id.toUpperCase(), permissions: [] });
const teams = [team('dev'), team('staging'), team('prod')];
const save = async (): Promise<void> => {};

/** The rendered names in row order. */
const rowNames = (html: string): string[] => [...html.matchAll(/aria-label="([A-Z]+), \d+(?:st|nd|rd|th)/g)].map((m) => m[1]);

// =============================================================================
// TESTS
// =============================================================================

test('with a save handler the rows can be dragged and moved with the arrows', () => {
	const html = renderToStaticMarkup(<TeamOrderCard teams={teams} order={['prod', 'dev']} onSetTeamOrder={save} />);

	assert.deepEqual(rowNames(html), ['PROD', 'DEV', 'STAGING']);
	assert.equal((html.match(/draggable="true"/g) ?? []).length, 3);
	assert.match(html, /title="Move DEV up"/);
	assert.match(html, /drag or use the arrows to order/);
});

test('without a save handler the card shows the order and offers nothing to change it', () => {
	const html = renderToStaticMarkup(<TeamOrderCard teams={teams} order={['prod', 'dev']} />);

	assert.deepEqual(rowNames(html), ['PROD', 'DEV', 'STAGING']);
	assert.match(html, /aria-label="PROD, 1st, home team"/);
	assert.match(html, />Home</);
	assert.doesNotMatch(html, /draggable="true"/);
	assert.doesNotMatch(html, /title="Move /);
	assert.doesNotMatch(html, /drag or use the arrows/);
	assert.match(html, /the first team is your home team/);
});

test('one team is its own home team either way: no controls', () => {
	for (const props of [{ onSetTeamOrder: save }, {}]) {
		const html = renderToStaticMarkup(<TeamOrderCard teams={[team('dev')]} order={[]} {...props} />);

		assert.deepEqual(rowNames(html), ['DEV']);
		assert.doesNotMatch(html, /draggable="true"/);
		assert.doesNotMatch(html, /title="Move /);
		assert.match(html, /your home team/);
	}
});
