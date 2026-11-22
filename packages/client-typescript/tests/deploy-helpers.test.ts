/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The pure deploy/publish helpers shared by the VS Code panels and the CLI,
 * plus the client's build waiter.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { RocketRideClient } from '../src/client/client';
import { parseRegistryVersion, pickPublishVersion, pipelineNameFromPath, resolveDeployTeams, resolveTeamArg, teamNameOf, wireTeamIdOf } from '../src/client/deploy-helpers';
import type { ConnectResult } from '../src/client/types';

afterEach(() => {
	jest.restoreAllMocks();
});

/** A client stand-in carrying only a cached identity. */
const withIdentity = (info: Partial<ConnectResult> | undefined) => ({ getAccountInfo: () => info as ConnectResult | undefined });

describe('parseRegistryVersion', () => {
	it('accepts positive integers as numbers, strings, and v-prefixed strings', () => {
		expect(parseRegistryVersion(3)).toBe(3);
		expect(parseRegistryVersion(' 12 ')).toBe(12);
		expect(parseRegistryVersion('v4')).toBe(4);
	});

	it.each([0, -1, 1.5, '', 'abc', null, undefined, NaN])('rejects %p', (value) => {
		expect(() => parseRegistryVersion(value)).toThrow(/Invalid registry version/);
	});
});

describe('pickPublishVersion', () => {
	const row = (registryVersion: number, state: string, buildStatus: string) => ({ registryVersion, state, buildStatus });

	it('picks the newest version that has not failed, even while it is still building', () => {
		expect(pickPublishVersion([row(1, 'private', 'ok'), row(3, 'private', 'building'), row(2, 'private', 'ok')])?.registryVersion).toBe(3);
	});

	it('skips failed builds and failed review states', () => {
		expect(pickPublishVersion([row(1, 'ready', 'ok'), row(2, 'private', 'failed'), row(3, 'failed', 'ok')])?.registryVersion).toBe(1);
	});

	it('is null when nothing qualifies', () => {
		expect(pickPublishVersion([row(1, 'private', 'failed')])).toBeNull();
		expect(pickPublishVersion([])).toBeNull();
	});
});

describe('teams', () => {
	const roster = withIdentity({
		userId: 'u1',
		organization: {
			id: 'o',
			name: 'Org',
			permissions: [],
			teams: [
				{ id: 't-qa', name: 'QA', permissions: ['task.control'], audience: '=team/t-qa' },
				{ id: 't-prod', name: 'Production', permissions: [], audience: '=team/t-prod' },
			],
		} as unknown as ConnectResult['organization'],
	});

	it('resolveDeployTeams lists @me first, then the roster by its audience with control rights', () => {
		expect(resolveDeployTeams(roster, [])).toEqual([
			{ id: '@me', name: 'Me', canControl: true },
			{ id: '=team/t-qa', name: 'QA', canControl: true },
			{ id: '=team/t-prod', name: 'Production', canControl: false },
		]);
	});

	it('resolveDeployTeams lists the org rung last by its audience, controlled by an org admin only', () => {
		const member = withIdentity({ userId: 'u1', organization: { id: 'o', name: 'Org', permissions: [], teams: [], audience: '=org/o' } as unknown as ConnectResult['organization'] });
		expect(resolveDeployTeams(member, [])).toEqual([
			{ id: '@me', name: 'Me', canControl: true },
			{ id: '=org/o', name: 'Org', canControl: false },
		]);
		const admin = withIdentity({ userId: 'u1', organization: { id: 'o', name: 'Org', permissions: ['org.admin'], teams: [{ id: 't', name: 'T', permissions: [], audience: '=team/t' }], audience: '=org/o' } as unknown as ConnectResult['organization'] });
		expect(resolveDeployTeams(admin, []).map((t) => [t.id, t.canControl])).toEqual([
			['@me', true],
			['=team/t', true],
			['=org/o', true],
		]);
	});

	it('resolveDeployTeams skips a team with no audience', () => {
		const info = withIdentity({ userId: 'u1', organization: { id: 'o', name: 'Org', permissions: [], teams: [{ id: 't', name: 'T', permissions: [] }] } as unknown as ConnectResult['organization'] });
		expect(resolveDeployTeams(info, []).map((t) => t.id)).toEqual(['@me']);
	});

	it('resolveDeployTeams derives teams from the team rows by rung for a rosterless identity', () => {
		const rows = [
			{ teamId: '=team/local', rung: 'team' as const, handle: '@Development' },
			{ teamId: '=user/u1', rung: 'me' as const, handle: '@me' },
			{ teamId: '@public', rung: 'public' as const, handle: '@public' },
			{ teamId: '=team/local', rung: 'team' as const, handle: '@Development' },
		];
		expect(resolveDeployTeams(withIdentity({ userId: 'u1', organization: null }), rows)).toEqual([
			{ id: '@me', name: 'Me', canControl: true },
			{ id: '=team/local', name: '@Development', canControl: true },
		]);
	});

	it('resolveTeamArg passes what was typed through: the server resolves every spelling', () => {
		const teams = resolveDeployTeams(roster, []);
		for (const typed of ['@me', '@public', '@Production', '@production', '=team/t-qa', 'Production', 't-other', '']) {
			expect(resolveTeamArg(typed, teams)).toBe(typed);
		}
		expect(resolveTeamArg('  @QA ', teams)).toBe('@QA');
		// Two names that differ only by case are the server's to refuse
		expect(resolveTeamArg('@OPS', [{ id: 'a', name: 'Ops', canControl: true }, { id: 'b', name: 'ops', canControl: true }])).toBe('@OPS');
	});

	it('teamNameOf is a roster lookup that parses nothing', () => {
		const teams = resolveDeployTeams(roster, []);
		expect(teamNameOf(teams, '=team/t-qa', 'u1')).toBe('QA');
		expect(teamNameOf(teams, '@me', 'u1')).toBe('Me');
		// Anything else comes back unchanged: rows carry their handle
		for (const value of ['=user/u1', '=user/u2', '@public', '=team/t-gone', 't-qa']) {
			expect(teamNameOf(teams, value, 'u1')).toBe(value);
		}
	});

	it("wireTeamIdOf passes a row's audience through", () => {
		for (const value of ['=user/u1', '@public', '=team/t-qa', '@me']) {
			expect(wireTeamIdOf(value, 'u1')).toBe(value);
		}
	});
});

describe('pipelineNameFromPath', () => {
	it('strips .pipe from the basename on either separator', () => {
		expect(pipelineNameFromPath('pipelines/ingest.pipe')).toBe('ingest');
		expect(pipelineNameFromPath('C:\\work\\chat.pipe')).toBe('chat');
		expect(pipelineNameFromPath('plain.json')).toBe('plain.json');
	});
});

describe('RocketRideClient.waitForAppBuild', () => {
	type Rail = Awaited<ReturnType<RocketRideClient['listDeployments']>>;
	const rail = (buildStatus: string, state = 'private') => [{ registryVersion: 2, buildStatus, state }] as unknown as Rail;

	it('polls until the build is ok, reporting each status change once', async () => {
		const client = new RocketRideClient({ persist: false });
		const responses = [rail('queued'), rail('building'), rail('building'), rail('ok')];
		jest.spyOn(client, 'listDeployments').mockImplementation(async () => responses.shift() as Rail);
		const statuses: string[] = [];

		const row = await client.waitForAppBuild('acme.clock', 2, { intervalMs: 1, onStatus: (s) => statuses.push(s) });

		expect(row.buildStatus).toBe('ok');
		expect(statuses).toEqual(['queued', 'building', 'ok']);
	});

	it('throws on a failed build, naming buildLog', async () => {
		const client = new RocketRideClient({ persist: false });
		jest.spyOn(client, 'listDeployments').mockImplementation(async () => rail('failed'));

		await expect(client.waitForAppBuild('acme.clock', 2, { intervalMs: 1 })).rejects.toThrow(/failed its server build.*buildLog/);
	});

	it('throws when the version is unknown or the wait times out', async () => {
		const client = new RocketRideClient({ persist: false });
		jest.spyOn(client, 'listDeployments').mockImplementation(async () => rail('building'));

		await expect(client.waitForAppBuild('acme.clock', 9, { intervalMs: 1 })).rejects.toThrow(/not found/);
		await expect(client.waitForAppBuild('acme.clock', 2, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(/Timed out/);
	});
});
