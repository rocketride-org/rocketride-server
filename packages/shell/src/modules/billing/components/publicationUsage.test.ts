// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationUsage } from 'rocketride';
import { monthPeriod, publicationRows, publishingTeamLabel } from './publicationUsage';

const usage = (over: Partial<PublicationUsage>): PublicationUsage => ({
	pipe: 'acme.docBrain',
	rung: 'team',
	team: 'team-prod',
	teamName: 'Production',
	version: 4,
	requestCount: 0,
	credits: {},
	...over,
});

test('monthPeriod bounds the UTC month and names it', () => {
	assert.deepEqual(monthPeriod(new Date('2026-11-20T15:30:00Z')), {
		since: '2026-11-01T00:00:00.000Z',
		until: '2026-12-01T00:00:00.000Z',
		label: 'November 2026',
	});
});

test('monthPeriod rolls December into the next year', () => {
	const period = monthPeriod(new Date('2026-12-31T23:59:59Z'));

	assert.equal(period.since, '2026-12-01T00:00:00.000Z');
	assert.equal(period.until, '2027-01-01T00:00:00.000Z');
	assert.equal(period.label, 'December 2026');
});

test('publishingTeamLabel names the org team, and the rung where no team answers', () => {
	assert.equal(publishingTeamLabel(usage({})), 'Production');
	assert.equal(publishingTeamLabel(usage({ rung: 'dev', team: null, teamName: null, version: null })), 'Development run');
	assert.equal(publishingTeamLabel(usage({ rung: 'me', team: 'user-a', teamName: null })), 'Only me');
	assert.equal(publishingTeamLabel(usage({ rung: 'public', team: 'other-org-team', teamName: null })), 'Public');
	assert.equal(publishingTeamLabel(usage({ team: 'other-org-team', teamName: null })), '--');
});

test('publicationRows draws one row per publication: version, team, requests, summed tokens', () => {
	const rows = publicationRows([usage({ version: 5, team: 'team-stage', teamName: 'Staging', requestCount: 912, credits: { tokens: 2000, hold_time: 140 } }), usage({ requestCount: 18204, credits: { tokens: 41000, hold_time: 377 } }), usage({ pipe: 'acme.leadSync', version: 7, requestCount: 3006, credits: { tokens: 9811 } })]);

	assert.deepEqual(rows, [
		{ id: 'acme.docBrain:team:team-prod:4', publication: 'acme.docBrain', version: 'v4', team: 'Production', requests: 18204, tokens: 41377 },
		{ id: 'acme.leadSync:team:team-prod:7', publication: 'acme.leadSync', version: 'v7', team: 'Production', requests: 3006, tokens: 9811 },
		{ id: 'acme.docBrain:team:team-stage:5', publication: 'acme.docBrain', version: 'v5', team: 'Staging', requests: 912, tokens: 2140 },
	]);
});

test('publicationRows shows a development run without a version and keeps ids distinct', () => {
	const rows = publicationRows([usage({ rung: 'dev', team: null, teamName: null, version: null, requestCount: 3, credits: { tokens: 10 } }), usage({ credits: { tokens: 5 } })]);

	assert.deepEqual(
		rows.map((r) => [r.id, r.version, r.team]),
		[
			['acme.docBrain:dev:-:-', '--', 'Development run'],
			['acme.docBrain:team:team-prod:4', 'v4', 'Production'],
		]
	);
});

test('publicationRows of nothing is nothing', () => {
	assert.deepEqual(publicationRows([]), []);
});
