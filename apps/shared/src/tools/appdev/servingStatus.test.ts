// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// Unit tests: the App Builder serving-state wording (#2461).
//
// Pins how the server's per-pin serving truth (serving / reason / servesYou)
// becomes the Deploy tab's live-row words, the dashboard sentences and
// badges, and the version card's badge — including the fallback to today's
// wording when an older server sends none of the new fields.
//
// Run via `shared:test` (node --import tsx --test), matching the package convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveBadgeOf, pinStatusOf, servingSentenceOf, versionBadgeOf, youSentenceOf } from './servingStatus';
import type { RungPin } from './types';

/** One where-live pin; fields default to a serving @me v3 (1.2.0). */
function pin(overrides: Partial<RungPin> = {}): RungPin {
	return {
		rung: 'personal',
		label: 'Personal',
		handle: '@me',
		registryVersion: 3,
		version: '1.2.0',
		state: 'enabled',
		audience: 'on your desktop',
		serving: true,
		reason: '',
		servesYou: false,
		...overrides,
	};
}

/** A pin exactly as an older server sends it: no serving fields at all. */
function legacyPin(overrides: Partial<RungPin> = {}): RungPin {
	const p = pin(overrides);
	delete p.serving;
	delete p.reason;
	delete p.servesYou;
	return p;
}

test('pinStatusOf: a serving pin reads serving', () => {
	assert.deepEqual(pinStatusOf(pin()), { word: 'serving', tone: 'ok' });
});

test('pinStatusOf: each reason names why the audience is not served', () => {
	const cases: Array<[string, string, string]> = [
		['disabled', 'disabled', 'muted'],
		['building', 'not serving: still building', 'warn'],
		['in-review', 'in review', 'warn'],
		['not-approved', 'not approved', 'warn'],
		['rejected', 'rejected', 'error'],
		['failed', 'not serving: build failed', 'error'],
		['build-failed', 'not serving: build failed', 'error'],
		['something-new', 'not serving: something-new', 'warn'],
	];
	for (const [reason, word, tone] of cases) {
		assert.deepEqual(pinStatusOf(pin({ serving: false, reason })), { word, tone }, reason);
	}
});

test("pinStatusOf: an older server keeps today's words", () => {
	assert.deepEqual(pinStatusOf(legacyPin({ state: 'pending' })), { word: 'in review', tone: 'warn' });
	assert.deepEqual(pinStatusOf(legacyPin({ state: 'enabled' })), { word: 'enabled', tone: 'ok' });
	assert.deepEqual(pinStatusOf(legacyPin({ state: 'approved' })), { word: 'approved', tone: 'ok' });
});

test('servingSentenceOf: says who is served and who is set but not served', () => {
	const pins = [pin(), pin({ rung: 'team', handle: '@team/qa', registryVersion: 4, version: '', serving: false, reason: 'disabled' })];
	assert.equal(servingSentenceOf(pins), "Right now @me serves v3 (1.2.0); @team/qa is set to v4, but it isn't serving (disabled).");
});

test('servingSentenceOf: nothing served says so, and why', () => {
	const pins = [pin({ serving: false, reason: 'building' })];
	assert.equal(servingSentenceOf(pins), "It is not being served to anyone right now: @me is set to v3 (1.2.0), but it isn't serving (still building).");
});

test("servingSentenceOf: an older server keeps today's sentence; no pins says nothing", () => {
	const pins = [legacyPin(), legacyPin({ rung: 'public', handle: '@public', registryVersion: 2, version: '' })];
	assert.equal(servingSentenceOf(pins), 'Right now @me serves v3 (1.2.0), @public serves v2.');
	assert.equal(servingSentenceOf([]), '');
});

test('youSentenceOf: names the version the caller would get', () => {
	const pins = [pin({ rung: 'public', handle: '@public', registryVersion: 2, version: '' }), pin({ servesYou: true })];
	assert.equal(youSentenceOf(pins), "You'd get v3 (1.2.0) through @me.");
});

test('youSentenceOf: says when the caller gets no published version', () => {
	assert.equal(youSentenceOf([pin({ serving: false, reason: 'disabled' })]), "You wouldn't get any published version.");
});

test('youSentenceOf: silent for an older server and for no pins', () => {
	assert.equal(youSentenceOf([legacyPin()]), '');
	assert.equal(youSentenceOf([]), '');
});

test("liveBadgeOf: serving reads live; not serving reads why; older server keeps today's badge", () => {
	assert.deepEqual(liveBadgeOf(pin()), { variant: 'info', label: 'live' });
	assert.deepEqual(liveBadgeOf(pin({ serving: false, reason: 'disabled' })), { variant: 'muted', label: 'disabled' });
	assert.deepEqual(liveBadgeOf(pin({ serving: false, reason: 'building' })), { variant: 'warning', label: 'not serving: still building' });
	assert.deepEqual(liveBadgeOf(pin({ serving: false, reason: 'rejected' })), { variant: 'error', label: 'rejected' });
	assert.deepEqual(liveBadgeOf(legacyPin({ state: 'enabled' })), { variant: 'info', label: 'live' });
	assert.deepEqual(liveBadgeOf(legacyPin({ state: 'approved' })), { variant: 'info', label: 'live' });
	assert.deepEqual(liveBadgeOf(legacyPin({ state: 'pending' })), { variant: 'muted', label: 'in review' });
});

test('versionBadgeOf: a running build replaces the review badge', () => {
	assert.deepEqual(versionBadgeOf('ready', 'building'), { variant: 'warning', label: 'building', opensBuildLog: false });
	assert.deepEqual(versionBadgeOf('ready', 'queued'), { variant: 'warning', label: 'queued', opensBuildLog: false });
});

test('versionBadgeOf: a failed build opens the log; a built version shows its review state', () => {
	assert.deepEqual(versionBadgeOf('ready', 'failed'), { variant: 'error', label: 'failed', opensBuildLog: true });
	assert.deepEqual(versionBadgeOf('ready', ''), { variant: 'success', label: 'ready', opensBuildLog: false });
	assert.deepEqual(versionBadgeOf('submit', ''), { variant: 'warning', label: 'in review', opensBuildLog: false });
	assert.deepEqual(versionBadgeOf('private', ''), { variant: 'muted', label: 'draft', opensBuildLog: false });
});

test('versionBadgeOf: an unknown state shows raw and muted; nothing known shows nothing', () => {
	assert.deepEqual(versionBadgeOf('archived' as never, ''), { variant: 'muted', label: 'archived', opensBuildLog: false });
	assert.equal(versionBadgeOf(undefined, ''), null);
});
