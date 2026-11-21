// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** The pipeline DEPLOY page's rung rules (mockups 2.13 and 2.14): which rows appear, in what order, and what the Publish dialog offers. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STORE_AUDIENCE, audienceOfTarget, publishTargetsOf, rowOfTarget, servingOf, whereLiveRungsOf } from './whereLive';
import type { DeployTeamRef, TeamDeploymentRow } from './types';

/** The caller's roster as the SDK resolves it: '@me' first, then the teams. */
const TEAMS: DeployTeamRef[] = [
	{ id: '@me', name: 'Me', canControl: true },
	{ id: '=team/team-staging', name: 'Staging', canControl: true },
	{ id: '=team/team-prod', name: 'Production', canControl: true },
	{ id: '=team/team-ops', name: 'Ops', canControl: false },
];

/** One publication row; defaults to the caller's own serving @me row on v5. */
function row(overrides: Partial<TeamDeploymentRow> = {}): TeamDeploymentRow {
	return { teamId: '=user/u1', teamName: 'Me', handle: '@me', rung: 'me', version: 5, state: 'enabled', deployedAt: 1, sources: [], ...overrides };
}

const ME = row();
const STAGING = row({ teamId: '=team/team-staging', teamName: 'Staging', handle: '@Staging', rung: 'team' });
const PROD = row({ teamId: '=team/team-prod', teamName: 'Production', handle: '@Production', rung: 'team', version: 4 });
const STORE = row({ teamId: '@public', teamName: '@public', handle: '@public', rung: 'public', version: 4 });
const OTHER = row({ teamId: '=user/u2', teamName: 'Personal', handle: 'Personal', rung: 'personal', version: 3 });

describe('whereLiveRungsOf', () => {
	it('draws one row per rung in rung order: Me, other spaces, teams in roster order, the store', () => {
		const rungs = whereLiveRungsOf([STORE, PROD, OTHER, STAGING, ME], TEAMS);
		assert.deepEqual(
			rungs.map((r) => r.row.teamId),
			['=user/u1', '=user/u2', '=team/team-staging', '=team/team-prod', '@public']
		);
	});

	it('names each rung by label and handle', () => {
		const rungs = whereLiveRungsOf([ME, STAGING, STORE, OTHER], TEAMS);
		assert.deepEqual(
			rungs.map((r) => [r.label, r.handle]),
			[
				['Me', '@me'],
				['Personal', ''],
				['Staging', '@Staging'],
				['Store', '@public'],
			]
		);
	});

	it('draws no row for a removed publication; a disabled one keeps its row', () => {
		const rungs = whereLiveRungsOf([ME, { ...STAGING, state: 'removed' }, { ...PROD, state: 'disabled' }], TEAMS);
		assert.deepEqual(
			rungs.map((r) => r.row.teamId),
			['=user/u1', '=team/team-prod']
		);
	});

	it('puts a team outside the roster after the roster, by name', () => {
		const zeta = row({ teamId: '=team/team-zeta', teamName: 'Zeta', rung: 'team' });
		const alpha = row({ teamId: '=team/team-alpha', teamName: 'Alpha', rung: 'team' });
		assert.deepEqual(
			whereLiveRungsOf([zeta, PROD, alpha], TEAMS).map((r) => r.label),
			['Production', 'Alpha', 'Zeta']
		);
	});
});

describe('rowOfTarget', () => {
	it("finds the caller's own row for '@me' although the row carries its audience =user/<uid>", () => {
		assert.equal(rowOfTarget([OTHER, ME, STAGING], '@me'), ME);
	});

	it("finds a team's row by id, the store's by '@public', and nothing for an audience without one", () => {
		assert.equal(rowOfTarget([ME, STAGING, PROD], '=team/team-prod'), PROD);
		assert.equal(rowOfTarget([ME, STORE], '@public'), STORE);
		assert.equal(rowOfTarget([OTHER], '@me'), undefined);
		assert.equal(rowOfTarget([{ ...STAGING, state: 'removed' }], '=team/team-staging'), undefined);
	});
});

describe('servingOf', () => {
	it('serves while enabled; otherwise the state is the reason', () => {
		assert.deepEqual(servingOf({ state: 'enabled' }), { serving: true, reason: '', state: 'enabled' });
		assert.deepEqual(servingOf({ state: 'disabled' }), { serving: false, reason: 'disabled', state: 'enabled' });
		assert.deepEqual(servingOf({ state: 'errored' }), { serving: false, reason: 'errored', state: 'enabled' });
	});
});

describe('publishTargetsOf', () => {
	it('offers every audience the caller controls, Me first, then the store, each with what it points at now', () => {
		const targets = publishTargetsOf(TEAMS, [ME, PROD, STORE], 6, 'ready');
		assert.deepEqual(
			targets.map((t) => [t.id, t.label, t.note, t.disabled ?? false]),
			[
				['@me', 'Me', 'upgrade from v5', false],
				['=team/team-staging', 'Staging', 'not published yet', false],
				['=team/team-prod', 'Production', 'upgrade from v4', false],
				['@public', 'Public: the store', 'upgrade from v4', false],
			]
		);
	});

	it('keeps the audience already on the version visible and not choosable, and names a rollback', () => {
		const targets = publishTargetsOf(TEAMS, [ME, PROD], 4, 'ready');
		const byId = new Map(targets.map((t) => [t.id, t]));
		assert.equal(byId.get('@me')?.note, 'rollback from v5');
		assert.equal(byId.get('=team/team-prod')?.note, 'already on v4');
		assert.equal(byId.get('=team/team-prod')?.disabled, true);
		assert.match(byId.get('=team/team-prod')?.disabledTitle ?? '', /already points at v4/);
	});

	it('keeps the store closed with the reason until the version is approved', () => {
		for (const state of ['private', 'submit', 'rejected', undefined]) {
			const store = publishTargetsOf(TEAMS, [], 6, state).at(-1);
			assert.deepEqual([store?.id, store?.note, store?.disabled], ['@public', 'needs review approval', true], String(state));
			assert.match(store?.disabledTitle ?? '', /approved \('ready'\) version/);
		}
		assert.deepEqual(publishTargetsOf(TEAMS, [], 6, 'ready').at(-1), { id: '@public', label: 'Public: the store', note: 'not published yet' });
	});

	it('keeps an approved version the store already serves visible and not choosable', () => {
		const store = publishTargetsOf(TEAMS, [STORE], 4, 'ready').at(-1);
		assert.deepEqual([store?.note, store?.disabled], ['already on v4', true]);
	});
});

describe('audienceOfTarget', () => {
	it('stages the store for the store row and a team of the roster for its row', () => {
		assert.equal(audienceOfTarget(TEAMS, '@public'), STORE_AUDIENCE);
		assert.deepEqual(STORE_AUDIENCE, { id: '@public', name: 'the store', canControl: true });
		assert.equal(audienceOfTarget(TEAMS, '=team/team-prod')?.name, 'Production');
		assert.equal(audienceOfTarget(TEAMS, '@me')?.name, 'Me');
		assert.equal(audienceOfTarget(TEAMS, '=team/team-gone'), undefined);
	});
});
