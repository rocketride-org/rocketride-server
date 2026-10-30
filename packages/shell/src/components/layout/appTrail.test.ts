// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The app trail behind the sidebar's "Back to <app>" row.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getReturnAppId, recordAppVisit } from './appTrail';

const HOME = 'rocketride.home';

test('recordAppVisit: opening another app pushes it', () => {
	assert.deepEqual(recordAppVisit(['console'], 'files', HOME), ['console', 'files']);
});

test('recordAppVisit: going back to the previous app pops instead of pushing', () => {
	assert.deepEqual(recordAppVisit(['console', 'files'], 'console', HOME), ['console']);
});

test('recordAppVisit: the active app again changes nothing', () => {
	const trail = ['console', 'files'];
	assert.equal(recordAppVisit(trail, 'files', HOME), trail);
});

test('recordAppVisit: Home starts the trail over', () => {
	assert.deepEqual(recordAppVisit(['console', 'files'], HOME, HOME), [HOME]);
});

test('recordAppVisit: an empty id is ignored', () => {
	const trail = ['console'];
	assert.equal(recordAppVisit(trail, '', HOME), trail);
});

test('recordAppVisit: the trail is capped at its oldest end', () => {
	let trail: readonly string[] = [];
	for (let index = 0; index < 25; index++) {
		trail = recordAppVisit(trail, `app${index}`, HOME);
	}
	assert.equal(trail.length, 20);
	assert.equal(trail[0], 'app5');
	assert.equal(trail[19], 'app24');
});

test('getReturnAppId: names the previous app', () => {
	assert.equal(getReturnAppId(['console', 'files'], HOME), 'console');
});

test('getReturnAppId: nothing when there is no previous app', () => {
	assert.equal(getReturnAppId(['console'], HOME), null);
	assert.equal(getReturnAppId([], HOME), null);
});

test('getReturnAppId: never Home, which the logo already reaches', () => {
	assert.equal(getReturnAppId([HOME, 'console'], HOME), null);
});
