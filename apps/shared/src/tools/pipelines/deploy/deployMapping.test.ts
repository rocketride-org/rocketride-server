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
import { mapTeamDeploymentRows, rungOfSlot, withReviewStates } from './deployMapping';
import type { DeployTeamRefDTO, DeployVersionCardDTO } from './deployTypes';

describe('rungOfSlot', () => {
	it('reads the one audience grammar from the caller side', () => {
		assert.equal(rungOfSlot('user~u1', 'u1'), 'me');
		assert.equal(rungOfSlot('user~u2', 'u1'), 'personal');
		assert.equal(rungOfSlot('~public', 'u1'), 'public');
		assert.equal(rungOfSlot('team-prod', 'u1'), 'team');
	});

	it("never claims a personal space as the caller's own when the caller is unknown", () => {
		assert.equal(rungOfSlot('user~u1', ''), 'personal');
	});
});

describe('mapTeamDeploymentRows', () => {
	it("stamps each row's rung and names the caller's own space Me", () => {
		const teams: DeployTeamRefDTO[] = [{ id: 'team-prod', name: 'Production', canControl: true }];
		const rows = mapTeamDeploymentRows(
			[
				{ projectId: 'acme.docBrain', teamId: 'user~u1', version: 5, state: 'enabled' },
				{ projectId: 'acme.docBrain', teamId: 'team-prod', version: 4, state: 'enabled' },
				{ projectId: 'acme.other', teamId: 'team-prod', version: 1, state: 'enabled' },
			] as Deployment[],
			'acme.docBrain',
			teams,
			'u1'
		);
		assert.deepEqual(
			rows.map((r) => [r.teamId, r.teamName, r.rung, r.version]),
			[
				['user~u1', 'Me', 'me', 5],
				['team-prod', 'Production', 'team', 4],
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
