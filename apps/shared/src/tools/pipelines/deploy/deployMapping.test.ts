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

/** The pipeline DEPLOY page's SDK-to-view mapping: each row's rung from its slot, and each version's review state from the rail. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Deployment } from 'rocketride';
import { mapHistoryRows, mapTeamDeploymentRows, withReviewStates } from './deployMapping';
import type { DeployTeamRefDTO, DeployVersionCardDTO } from './deployTypes';

describe('mapTeamDeploymentRows', () => {
	it("draws each row on the server's rung, names a team by the caller's roster, and keeps its audience and handle", () => {
		const teams: DeployTeamRefDTO[] = [{ id: '=team/team-prod', name: 'Production', canControl: true }];
		const rows = mapTeamDeploymentRows(
			[
				{ projectId: 'acme.docBrain', teamId: '=user/u1', rung: 'me', handle: '@me', version: 5, state: 'enabled' },
				{ projectId: 'acme.docBrain', teamId: '=team/team-prod', rung: 'team', handle: '@Production', version: 4, state: 'enabled' },
				{ projectId: 'acme.docBrain', teamId: '@public', rung: 'public', handle: '@public', version: 3, state: 'enabled' },
				{ projectId: 'acme.other', teamId: '=team/team-prod', rung: 'team', handle: '@Production', version: 1, state: 'enabled' },
				{ projectId: 'acme.docBrain', teamId: '=user/u2', rung: 'personal', handle: 'Personal', version: 2, state: 'enabled' },
				{ projectId: 'acme.docBrain', teamId: '=team/team-9', rung: 'team', handle: '=team/team-9', version: 1, state: 'enabled' },
			] as Deployment[],
			'acme.docBrain',
			teams
		);
		assert.deepEqual(
			rows.map((r) => [r.teamId, r.teamName, r.handle, r.rung, r.version]),
			[
				['=user/u1', '@me', '@me', 'me', 5],
				['=team/team-prod', 'Production', '@Production', 'team', 4],
				['@public', '@public', '@public', 'public', 3],
				['=user/u2', 'Personal', 'Personal', 'personal', 2],
				['=team/team-9', '=team/team-9', '=team/team-9', 'team', 1],
			]
		);
	});

	it('draws the org rung by its handle (the organisation publishes there, plan 8.3)', () => {
		const rows = mapTeamDeploymentRows([{ projectId: 'acme.docBrain', teamId: '=org/o1', rung: 'org', handle: '@org', version: 1, state: 'enabled' }] as Deployment[], 'acme.docBrain', []);
		assert.deepEqual(
			rows.map((r) => [r.teamId, r.teamName, r.rung, r.version]),
			[['=org/o1', '@org', 'org', 1]]
		);
	});

	it('drops a row on a rung the panel does not draw', () => {
		const rows = mapTeamDeploymentRows([{ projectId: 'acme.docBrain', teamId: '@spec', rung: 'spec', handle: '@spec', version: 1, state: 'enabled' }] as unknown as Deployment[], 'acme.docBrain', []);
		assert.deepEqual(rows, []);
	});
});

describe('mapHistoryRows', () => {
	it("names a pointer change by the row's handle and an org-wide row by nothing", () => {
		const rows = mapHistoryRows([
			{ seq: 2, at: 2, action: 'deploy', teamId: '=team/team-prod', handle: '@Production', version: 4, actor: { userId: 'u1', display: 'Rod' } },
			{ seq: 1, at: 1, action: 'publish', teamId: '', version: 4, actor: { userId: 'u1', display: 'Rod' } },
		]);
		assert.deepEqual(
			rows.map((r) => [r.teamId, r.teamName, r.action]),
			[
				['=team/team-prod', '@Production', 'deploy'],
				['', '', 'publish'],
			]
		);
	});
});

describe('withReviewStates', () => {
	/** A version card; the rail joins its state by version. */
	const card = (version: number): DeployVersionCardDTO => ({ version, sha256: `sha${version}`, publishedAt: version, publishedBy: 'rod' });

	it('gives each card the review state the rail names for its version', () => {
		const cards = withReviewStates(
			[card(3), card(2), card(1)],
			[
				{ registryVersion: 3, state: 'submit' },
				{ registryVersion: 2, state: 'ready' },
				{ registryVersion: 1, state: 'private' },
			]
		);
		assert.deepEqual(
			cards.map((c) => [c.version, c.state]),
			[
				[3, 'submit'],
				[2, 'ready'],
				[1, 'private'],
			]
		);
	});

	it('leaves a card the rail does not name without a state: never a guessed draft', () => {
		const [unnamed, blank] = withReviewStates([card(2), card(1)], [{ registryVersion: 1, state: '' }]);
		assert.equal('state' in (unnamed as DeployVersionCardDTO), false);
		assert.equal('state' in (blank as DeployVersionCardDTO), false);
	});
});
