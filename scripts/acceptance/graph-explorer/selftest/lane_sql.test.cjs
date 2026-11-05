// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/lane_sql.cjs's card-roles check, without a browser or an
 * engine (stand_in.cjs). The SQL landing always has other buttons (Refresh,
 * "+ New connection", the shell's own), so the check must look at the cards'
 * Edit control itself: it fails on a page whose Edit sits inside the card's own
 * button (descendants of a button are presentational, so assistive technology
 * never reaches it), and passes once Edit is a button outside it.
 * Run: node --test scripts/acceptance/graph-explorer/selftest/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runWithStandIn } = require('./stand_in.cjs');

const CHECK = 'connection cards expose';
// The landing around the cards: listed nodes and the buttons every landing has.
const LANDING = {
	text: 'Connections\ngx-local SQL write-enabled (pgvector)\ndb_postgres\ndb_supabase\nrocketride_sql\nRunning',
	aria: [
		'- heading "Connections"',
		'- button "Refresh"',
		'- button "+ New connection"',
		'- button "Open SQL Explorer"',
		'- button "Edit"',
	].join('\n'),
	visible: true,
	count: 1,
};

const cardRow = (page) => {
	const run = runWithStandIn('lane_sql.cjs', ['chrome'], 'lane_sql.json', page);
	const row = run.data.find((r) => r.name.startsWith(CHECK));
	assert.ok(row, `the card check did not run:\n${run.stdout}`);
	return row;
};

test('lane_sql: the card check fails when Edit sits inside the card button', () => {
	const row = cardRow({ ...LANDING, evaluate: { editControls: [{ role: 'button', insideButton: true }] } });
	assert.strictEqual(
		row.status,
		'FAIL',
		`passed although Edit is presentational inside the card button: ${JSON.stringify(row)}`
	);
});

test('lane_sql: the card check fails when no card offers Edit', () => {
	const row = cardRow({ ...LANDING, count: 0, evaluate: { editControls: [] } });
	assert.strictEqual(row.status, 'FAIL', `passed with no Edit control on the page: ${JSON.stringify(row)}`);
});

test('lane_sql: the card check passes when Edit is a button outside the card button', () => {
	const row = cardRow({ ...LANDING, evaluate: { editControls: [{ role: 'button', insideButton: false }] } });
	assert.strictEqual(row.status, 'PASS', JSON.stringify(row));
});

test('lane_sql: the card check fails on an empty page', () => {
	const row = cardRow({});
	assert.strictEqual(row.status, 'FAIL', JSON.stringify(row));
});
