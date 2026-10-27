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
		organization: { id: 'o', name: 'Org', permissions: [], teams: [{ id: 't-qa', name: 'QA', permissions: ['task.control'] }, { id: 't-prod', name: 'Production', permissions: [] }] } as unknown as ConnectResult['organization'],
	});

	it('resolveDeployTeams lists @me first, then the roster with control rights', () => {
		expect(resolveDeployTeams(roster, [])).toEqual([
			{ id: '@me', name: 'Me', canControl: true },
			{ id: 't-qa', name: 'QA', canControl: true },
			{ id: 't-prod', name: 'Production', canControl: false },
		]);
	});

	it('resolveDeployTeams derives teams from rows for a rosterless identity, never personal rows', () => {
		const teams = resolveDeployTeams(withIdentity({ userId: 'u1', organization: null }), [{ teamId: 'local' }, { teamId: 'user~u1' }, { teamId: 'local' }]);
		expect(teams.map((t) => t.id)).toEqual(['@me', 'local']);
	});

	it('resolveTeamArg maps @me, ids, and names (case-insensitive); unknowns pass through', () => {
		const teams = resolveDeployTeams(roster, []);
		expect(resolveTeamArg('@me', teams)).toBe('@me');
		expect(resolveTeamArg('t-qa', teams)).toBe('t-qa');
		expect(resolveTeamArg('production', teams)).toBe('t-prod');
		expect(resolveTeamArg('t-other', teams)).toBe('t-other');
		expect(resolveTeamArg('', teams)).toBe('');
	});

	it('resolveTeamArg refuses an ambiguous name', () => {
		const teams = [{ id: 'a', name: 'Ops', canControl: true }, { id: 'b', name: 'ops', canControl: true }];
		expect(() => resolveTeamArg('OPS', teams)).toThrow(/ambiguous.*a, b/);
	});

	it('teamNameOf names personal spaces and falls back to the id', () => {
		const teams = resolveDeployTeams(roster, []);
		expect(teamNameOf(teams, 'user~u1', 'u1')).toBe('Me');
		expect(teamNameOf(teams, 'user~u2', 'u1')).toBe('Personal');
		expect(teamNameOf(teams, 't-qa', 'u1')).toBe('QA');
		expect(teamNameOf(teams, 't-gone', 'u1')).toBe('t-gone');
	});

	it("wireTeamIdOf addresses the caller's own space as @me", () => {
		expect(wireTeamIdOf('user~u1', 'u1')).toBe('@me');
		expect(wireTeamIdOf('t-qa', 'u1')).toBe('t-qa');
	});
});

describe('pipelineNameFromPath', () => {
	it('strips .pipe and .pipe.json from the basename on either separator', () => {
		expect(pipelineNameFromPath('pipelines/ingest.pipe')).toBe('ingest');
		expect(pipelineNameFromPath('C:\\work\\chat.pipe.json')).toBe('chat');
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
