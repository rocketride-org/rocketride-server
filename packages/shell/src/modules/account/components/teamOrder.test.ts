// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamInfo } from 'rocketride';
import { moveItem, orderTeams, ordinal, pushRetiresSave } from './teamOrder';

const team = (id: string): TeamInfo => ({ id, name: id.toUpperCase(), permissions: [] });
const ids = (teams: TeamInfo[]): string[] => teams.map((t) => t.id);

test('ordinal labels positions the English way, teens included', () => {
	assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
});

test('orderTeams puts the ordered teams first and the rest after, in listing order', () => {
	const teams = [team('dev'), team('staging'), team('prod'), team('qa')];

	assert.deepEqual(ids(orderTeams(teams, ['prod', 'dev'])), ['prod', 'dev', 'staging', 'qa']);
});

test('orderTeams ignores ids the org has no team for and a repeated id', () => {
	const teams = [team('dev'), team('prod')];

	assert.deepEqual(ids(orderTeams(teams, ['gone', 'prod', 'prod'])), ['prod', 'dev']);
});

test('orderTeams with an empty order keeps the listing order', () => {
	const teams = [team('dev'), team('prod')];

	assert.deepEqual(ids(orderTeams(teams, [])), ['dev', 'prod']);
});

test('moveItem moves an element down and up, and copies on a no-op', () => {
	const list = ['a', 'b', 'c', 'd'];

	assert.deepEqual(moveItem(list, 0, 2), ['b', 'c', 'a', 'd']);
	assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c']);
	const same = moveItem(list, 1, 1);
	assert.deepEqual(same, list);
	assert.notEqual(same, list);
	assert.deepEqual(moveItem(list, 1, 9), list);
	assert.deepEqual(list, ['a', 'b', 'c', 'd']);
});

test('pushRetiresSave: a push carrying the saved order retires the save', () => {
	assert.equal(pushRetiresSave(['prod', 'dev'], { ids: ['prod', 'dev'], resolved: false }), true);
});

test('pushRetiresSave: a stale response with the old order, before the call resolves, does not acknowledge the save', () => {
	assert.equal(pushRetiresSave(['dev', 'prod'], { ids: ['prod', 'dev'], resolved: false }), false);
	assert.equal(pushRetiresSave(['prod'], { ids: ['prod', 'dev'], resolved: false }), false);
});

test('pushRetiresSave: any push after the call resolved retires the save (server-normalized order)', () => {
	assert.equal(pushRetiresSave(['dev', 'prod', 'qa'], { ids: ['prod', 'dev'], resolved: true }), true);
});
