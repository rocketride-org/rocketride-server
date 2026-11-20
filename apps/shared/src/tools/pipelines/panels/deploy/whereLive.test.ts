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

/** The pipeline DEPLOY page's rung rules (mockups 2.13, 2.14, 2.15): which rows appear, in what order, and what the Publish dialog offers. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishTargetsOf, rowOfTarget, servingOf, whereLiveRungsOf } from './whereLive';
import type { DeployTeamRef, TeamDeploymentRow } from './types';

/** The caller's roster as the SDK resolves it: '@me' first, then the teams. */
const TEAMS: DeployTeamRef[] = [
	{ id: '@me', name: 'Me', canControl: true },
	{ id: 'team-staging', name: 'Staging', canControl: true },
	{ id: 'team-prod', name: 'Production', canControl: true },
	{ id: 'team-ops', name: 'Ops', canControl: false },
];

/** One publication row; defaults to the caller's own serving @me row on v5. */
function row(overrides: Partial<TeamDeploymentRow> = {}): TeamDeploymentRow {
	return { teamId: 'user~u1', teamName: 'Me', rung: 'me', version: 5, state: 'enabled', deployedAt: 1, sources: [], ...overrides };
}

const ME = row();
const STAGING = row({ teamId: 'team-staging', teamName: 'Staging', rung: 'team' });
const PROD = row({ teamId: 'team-prod', teamName: 'Production', rung: 'team', version: 4 });
const STORE = row({ teamId: '~public', teamName: '~public', rung: 'public', version: 4 });
const OTHER = row({ teamId: 'user~u2', teamName: 'Personal', rung: 'personal', version: 3 });

describe('whereLiveRungsOf', () => {
	it('draws one row per rung in rung order: Me, other spaces, teams in roster order, the store', () => {
		const rungs = whereLiveRungsOf([STORE, PROD, OTHER, STAGING, ME], TEAMS);
		assert.deepEqual(
			rungs.map((r) => r.row.teamId),
			['user~u1', 'user~u2', 'team-staging', 'team-prod', '~public']
		);
	});

	it('names each rung by label and handle', () => {
		const rungs = whereLiveRungsOf([ME, STAGING, STORE, OTHER], TEAMS);
		assert.deepEqual(
			rungs.map((r) => [r.label, r.handle]),
			[
				['Me', '@me'],
				['Personal', ''],
				['Staging', '@team/Staging'],
				['Store', '@public'],
			]
		);
	});

	it('draws no row for a removed publication; a disabled one keeps its row', () => {
		const rungs = whereLiveRungsOf([ME, { ...STAGING, state: 'removed' }, { ...PROD, state: 'disabled' }], TEAMS);
		assert.deepEqual(
			rungs.map((r) => r.row.teamId),
			['user~u1', 'team-prod']
		);
	});

	it('lets only a team rung schedule its sources', () => {
		const rungs = whereLiveRungsOf([ME, STAGING, STORE, OTHER], TEAMS);
		assert.deepEqual(
			rungs.map((r) => [r.row.rung, r.scheduleEditable]),
			[
				['me', false],
				['personal', false],
				['team', true],
				['public', false],
			]
		);
	});

	it('puts a team outside the roster after the roster, by name', () => {
		const zeta = row({ teamId: 'team-zeta', teamName: 'Zeta', rung: 'team' });
		const alpha = row({ teamId: 'team-alpha', teamName: 'Alpha', rung: 'team' });
		assert.deepEqual(
			whereLiveRungsOf([zeta, PROD, alpha], TEAMS).map((r) => r.label),
			['Production', 'Alpha', 'Zeta']
		);
	});
});

describe('rowOfTarget', () => {
	it("finds the caller's own row for '@me' although the row carries the raw user~ slot", () => {
		assert.equal(rowOfTarget([OTHER, ME, STAGING], '@me'), ME);
	});

	it("finds a team's row by id, the store's by '@public', and nothing for an audience without one", () => {
		assert.equal(rowOfTarget([ME, STAGING, PROD], 'team-prod'), PROD);
		assert.equal(rowOfTarget([ME, STORE], '@public'), STORE);
		assert.equal(rowOfTarget([OTHER], '@me'), undefined);
		assert.equal(rowOfTarget([{ ...STAGING, state: 'removed' }], 'team-staging'), undefined);
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
	it('offers every audience the caller controls, Me first, with what it points at now', () => {
		const targets = publishTargetsOf(TEAMS, [ME, PROD], 6);
		assert.deepEqual(
			targets.map((t) => [t.id, t.label, t.note, t.disabled ?? false]),
			[
				['@me', 'Me', 'upgrade from v5', false],
				['team-staging', 'Staging', 'not published yet', false],
				['team-prod', 'Production', 'upgrade from v4', false],
			]
		);
	});

	it('keeps the audience already on the version visible and not choosable, and names a rollback', () => {
		const targets = publishTargetsOf(TEAMS, [ME, PROD], 4);
		const byId = new Map(targets.map((t) => [t.id, t]));
		assert.equal(byId.get('@me')?.note, 'rollback from v5');
		assert.equal(byId.get('team-prod')?.note, 'already on v4');
		assert.equal(byId.get('team-prod')?.disabled, true);
		assert.match(byId.get('team-prod')?.disabledTitle ?? '', /already points at v4/);
	});
});
