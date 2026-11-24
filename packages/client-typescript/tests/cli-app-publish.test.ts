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
 * The `rocketride app` publish ladder and `deploy source-config`, against a
 * stubbed deployment client — plus app resolution (findApp) on a temp
 * workspace.
 *
 * App files carry the SLUG only (`clock`): the CLI sends the slug on every
 * SDK call and the server composes `<developerId>.<slug>` from the deploying
 * organization. A qualified id typed with no working copy passes through as
 * written for the server door to check.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RocketRideClient } from '../src/client/client';
import { findApp } from '../src/app-pack/index';
import * as common from '../src/cli/common';
import { executeAppDeploy, executeAppPublish, executeAppReply, executeAppReview, executeAppUnbind, normalizePublishTarget, splitAppVersion } from '../src/cli/commands/app';
import { executeDeploySourceConfig } from '../src/cli/commands/deploy';
import { Output } from '../src/cli/output';

type DeployClient = NonNullable<Awaited<ReturnType<typeof common.connectDeploy>>>;

let ws: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-publish-'));
	logs = [];
	errors = [];
	jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(' '));
	});
	jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
	});
});

afterEach(() => {
	jest.restoreAllMocks();
	fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * Writes an app working copy at apps/<folder> with its marker. `manifestId`
 * is written verbatim as appManifest.id (a slug, or a legacy prefixed id);
 * the trigger is always named after the slug.
 */
function writeApp(folder: string, manifestId: string): string {
	const dir = path.join(ws, 'apps', folder);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: folder, appManifest: { id: manifestId, name: folder } }));
	fs.writeFileSync(path.join(dir, `${manifestId.split('.').pop()}.rrapp`), '{}');
	return dir;
}

/** An async mock that accepts any arguments (so call assertions type-check). */
const stub = <T>(value: T) => jest.fn(async (..._args: unknown[]) => value);

/** A deploy client stub; `connectDeploy` hands it to the command. */
function stubClient(overrides: Record<string, unknown> = {}) {
	const client = {
		listDeployments: stub([
			{ registryVersion: 1, state: 'private', buildStatus: 'ok' },
			{ registryVersion: 2, state: 'private', buildStatus: 'building' },
		]),
		waitForAppBuild: stub({ registryVersion: 2, buildStatus: 'ok' }),
		publishApp: stub({ publish: { audience: '@me', version: 2 } }),
		submitApp: stub({ artifact: { state: 'submitted' } }),
		withdrawApp: stub({ artifact: { state: 'private' } }),
		replyApp: stub({ ok: true }),
		removeAppPublish: stub({ publish: { state: 'removed' } }),
		disableAppPublish: stub({ publish: { state: 'disabled' } }),
		deploy: {
			addApp: stub({ artifact: { registryVersion: 5, appVersion: '0.1.0', buildStatus: 'queued' } }),
			setSourceConfig: stub({ teamId: '@me', schedules: { webhook_1: { traceLevel: 'summary', debugOut: true } } }),
			get: stub({ teamId: '@me', schedules: { webhook_1: { traceLevel: 'metadata', debugOut: true } } }),
		},
		getAccountInfo: () => ({ userId: 'u1', organization: null }),
		...overrides,
	};
	jest.spyOn(common, 'connectDeploy').mockImplementation(async () => client as unknown as DeployClient);
	return client;
}

const target = { uri: 'https://deploy.test', apikey: 'k' };

describe('connectDeploy hard stop', () => {
	it('stops early on an empty or blank key, naming the deploy variable and --apikey', async () => {
		const connect = jest.spyOn(RocketRideClient.prototype, 'connect').mockResolvedValue(undefined as never);
		for (const apikey of ['', '   ', undefined]) {
			errors.length = 0;
			const out = new Output(undefined);
			expect(await common.connectDeploy({ uri: 'https://deploy.test', apikey }, out)).toBeNull();
			expect(errors.join('\n')).toContain('ROCKETRIDE_DEPLOY_APIKEY');
			expect(errors.join('\n')).toContain('--apikey');
		}
		expect(connect).not.toHaveBeenCalled();
	});

	it('passes a set key through to the client', async () => {
		const connect = jest.spyOn(RocketRideClient.prototype, 'connect').mockResolvedValue(undefined as never);
		const out = new Output(undefined);
		expect(await common.connectDeploy({ uri: 'https://deploy.test', apikey: 'k' }, out)).not.toBeNull();
		expect(connect).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
	});
});

describe('argument helpers', () => {
	it('splitAppVersion reads a lone number as the version', () => {
		expect(splitAppVersion('3')).toEqual({ version: '3' });
		expect(splitAppVersion('v3')).toEqual({ version: 'v3' });
		expect(splitAppVersion('clock')).toEqual({ app: 'clock', version: undefined });
		expect(splitAppVersion('clock', '3')).toEqual({ app: 'clock', version: '3' });
	});

	it('normalizePublishTarget adds the @ to me, org and public and passes every other target through for the server', () => {
		expect(normalizePublishTarget('me')).toBe('@me');
		expect(normalizePublishTarget('public')).toBe('@public');
		expect(normalizePublishTarget('org')).toBe('@org');
		expect(normalizePublishTarget('=org/o-1')).toBe('=org/o-1');
		expect(normalizePublishTarget('@public')).toBe('@public');
		expect(normalizePublishTarget('@QA')).toBe('@QA');
		expect(normalizePublishTarget(' =team/t-qa ')).toBe('=team/t-qa');
		// The server owns the grammar: a retired spelling reaches it and is refused there, naming its replacement
		expect(normalizePublishTarget('@team/QA')).toBe('@team/QA');
		expect(() => normalizePublishTarget('  ')).toThrow(/publish target is required/);
	});
});

describe('findApp', () => {
	it('resolves the current directory, a folder, the slug, and the folder name to the slug', async () => {
		const dir = writeApp('clock-ui', 'clock');

		expect(await findApp(ws, undefined, dir)).toEqual({ appId: 'clock', app: expect.objectContaining({ id: 'clock', folder: dir }) });
		expect((await findApp(ws, 'apps/clock-ui')).app?.folder).toBe(dir);
		expect(await findApp(ws, 'clock')).toEqual({ appId: 'clock', app: expect.objectContaining({ folder: dir }) });
		expect((await findApp(ws, 'clock-ui')).appId).toBe('clock');
	});

	it('reads a prefixed id as its slug, in the manifest and in the reference', async () => {
		// a manifest written before the slug rule still carries a prefix: ignored
		const dir = writeApp('clock-ui', 'personal.clock');

		expect(await findApp(ws, undefined, dir)).toEqual({ appId: 'clock', app: expect.objectContaining({ id: 'clock' }) });
		// any namespace typed in front of a local slug names the same working copy
		expect((await findApp(ws, 'personal.clock')).app?.folder).toBe(dir);
		expect((await findApp(ws, 'acme.clock')).app?.folder).toBe(dir);
		expect((await findApp(ws, 'clock')).appId).toBe('clock');
	});

	it('returns a reference with no working copy as written, for server-only verbs', async () => {
		// a qualified id keeps its namespace (the door checks it); a bare slug
		// is composed there
		expect(await findApp(ws, 'acme.remote')).toEqual({ appId: 'acme.remote' });
		expect(await findApp(ws, 'remote')).toEqual({ appId: 'remote' });
	});

	it('prefers the slug over a folder name, refuses two same-named folders, and names the local apps when nothing matches', async () => {
		const bySlug = writeApp('clock-ui', 'clock');
		writeApp('clock', 'timer');
		writeApp(path.join('nested', 'clock'), 'alarm');

		// an exact slug match wins before folder names are considered
		expect(await findApp(ws, 'clock')).toEqual({ appId: 'clock', app: expect.objectContaining({ folder: bySlug }) });
		// with no app of that slug, two folders of that name are ambiguous
		fs.rmSync(bySlug, { recursive: true, force: true });
		await expect(findApp(ws, 'clock')).rejects.toThrow(/matches several apps.*use the full id: timer, alarm/);
		// a well-formed slug with no copy goes to the server; only a reference
		// outside the slug grammar is refused, naming the local apps
		expect(await findApp(ws, 'nope')).toEqual({ appId: 'nope' });
		await expect(findApp(ws, '9nope')).rejects.toThrow(/No app "9nope" found.*timer, alarm/);
		await expect(findApp(ws, undefined, ws)).rejects.toThrow(/not an app folder/);
	});

	it('binds one working copy per slug: the shallowest folder wins, the other stays reachable by path', async () => {
		const shallow = writeApp('clock-ui', 'clock');
		const nested = writeApp(path.join('nested', 'clock-copy'), 'clock');

		expect((await findApp(ws, 'clock')).app?.folder).toBe(shallow);
		expect((await findApp(ws, 'apps/nested/clock-copy')).app?.folder).toBe(nested);
	});

	it('skips node_modules when walking', async () => {
		const dir = writeApp('clock-ui', 'clock');
		// shallower than apps/clock-ui: it would win the slug binding if walked
		const hidden = path.join(ws, 'node_modules');
		fs.mkdirSync(hidden, { recursive: true });
		fs.writeFileSync(path.join(hidden, 'package.json'), JSON.stringify({ appManifest: { id: 'clock' } }));
		fs.writeFileSync(path.join(hidden, 'clock.rrapp'), '{}');

		expect((await findApp(ws, 'clock')).app?.folder).toBe(dir);
	});
});

describe('executeAppPublish', () => {
	it('defaults to the newest non-failed version and @me, waiting for its build', async () => {
		const client = stubClient();

		const code = await executeAppPublish('acme.clock', undefined, { ...target, workspace: ws }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.waitForAppBuild).toHaveBeenCalledWith('acme.clock', 2, expect.any(Object));
		expect(client.publishApp).toHaveBeenCalledWith('acme.clock', 2, '@me');
		expect(logs.join('\n')).toContain('Published acme.clock v2 to @me.');
	});

	it('sends the slug when the app is a local working copy', async () => {
		writeApp('clock-ui', 'clock');
		const client = stubClient();

		await executeAppPublish('clock-ui', '1', { ...target, workspace: ws }, new Output(undefined));

		expect(client.publishApp).toHaveBeenCalledWith('clock', 1, '@me');
	});

	it('takes an explicit version and target', async () => {
		const client = stubClient();

		await executeAppPublish('acme.clock', '1', { ...target, workspace: ws, to: '@QA' }, new Output(undefined));

		expect(client.listDeployments).not.toHaveBeenCalled();
		expect(client.publishApp).toHaveBeenCalledWith('acme.clock', 1, '@QA');
	});

	it('fails clearly when no version can be published', async () => {
		stubClient({ listDeployments: stub([{ registryVersion: 1, state: 'private', buildStatus: 'failed' }]) });

		await expect(executeAppPublish('acme.clock', undefined, { ...target, workspace: ws }, new Output(undefined))).rejects.toThrow(/no deployed version that can be published/);
	});

	it('stops without a deployment target', async () => {
		const code = await executeAppPublish('acme.clock', '1', { workspace: ws }, new Output(undefined));

		expect(code).toBe(1);
		expect(errors.join('\n')).toMatch(/deploy/i);
	});
});

describe('executeAppDeploy', () => {
	it('deploys the working copy and, with --publish, publishes the new version once built', async () => {
		const dir = writeApp('clock-ui', 'clock');
		const client = stubClient();

		const code = await executeAppDeploy('clock', { ...target, workspace: ws, publish: 'me' }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.deploy.addApp).toHaveBeenCalledWith(dir, expect.objectContaining({ workspaceRoot: ws }));
		// the slug goes on the wire; the server composes the registry name
		expect(client.waitForAppBuild).toHaveBeenCalledWith('clock', 5, expect.any(Object));
		expect(client.publishApp).toHaveBeenCalledWith('clock', 5, '@me');
		expect(logs.join('\n')).toContain('Deployed clock v5 (app 0.1.0)');
	});

	it('prints the publish command instead when --publish is absent', async () => {
		writeApp('clock-ui', 'clock');
		const client = stubClient();

		await executeAppDeploy('clock', { ...target, workspace: ws }, new Output(undefined));

		expect(client.publishApp).not.toHaveBeenCalled();
		// the printed command names the slug: `app publish clock` resolves the
		// same working copy and sends the same slug
		expect(logs.join('\n')).toContain('rocketride app publish clock 5 --to @me');
	});

	it('refuses an app with no local working copy', async () => {
		stubClient();

		expect(await executeAppDeploy('acme.remote', { ...target, workspace: ws }, new Output(undefined))).toBe(1);
		expect(errors.join('\n')).toContain('no working copy here');
	});
});

describe('executeAppUnbind', () => {
	it('requires --from', async () => {
		stubClient();

		expect(await executeAppUnbind('unpublish', 'acme.clock', { ...target, workspace: ws }, new Output(undefined))).toBe(1);
	});

	it('removes or disables the binding', async () => {
		const client = stubClient();

		await executeAppUnbind('unpublish', 'acme.clock', { ...target, workspace: ws, from: '@me' }, new Output(undefined));
		await executeAppUnbind('disable', 'acme.clock', { ...target, workspace: ws, from: 'public' }, new Output(undefined));

		expect(client.removeAppPublish).toHaveBeenCalledWith('acme.clock', '@me');
		expect(client.disableAppPublish).toHaveBeenCalledWith('acme.clock', '@public');
	});
});

describe('executeDeploySourceConfig', () => {
	it('persists the trace level and debug output, resolving the team', async () => {
		const client = stubClient();

		const code = await executeDeploySourceConfig('proj', 'webhook_1', { ...target, team: '@me', traceLevel: 'summary', debugOut: true }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.deploy.get).not.toHaveBeenCalled();
		expect(client.deploy.setSourceConfig).toHaveBeenCalledWith('proj', 'webhook_1', '@me', { traceLevel: 'summary', debugOut: true });
		expect(logs.join('\n')).toContain('trace summary, debug output on');
	});

	it('keeps the current debug output when only the trace level is passed', async () => {
		const client = stubClient();

		await executeDeploySourceConfig('proj', 'webhook_1', { ...target, team: '@me', traceLevel: 'summary' }, new Output(undefined));

		expect(client.deploy.get).toHaveBeenCalledWith('proj', '@me');
		expect(client.deploy.setSourceConfig).toHaveBeenCalledWith('proj', 'webhook_1', '@me', { traceLevel: 'summary', debugOut: true });
	});

	it('keeps the current trace level when only debug output is passed', async () => {
		const client = stubClient();

		await executeDeploySourceConfig('proj', 'webhook_1', { ...target, team: '@me', debugOut: false }, new Output(undefined));

		expect(client.deploy.setSourceConfig).toHaveBeenCalledWith('proj', 'webhook_1', '@me', { traceLevel: 'metadata', debugOut: false });
	});

	it('rejects an unknown trace level before connecting', async () => {
		const client = stubClient();

		expect(await executeDeploySourceConfig('proj', 'webhook_1', { ...target, traceLevel: 'loud' }, new Output(undefined))).toBe(1);
		expect(client.deploy.setSourceConfig).not.toHaveBeenCalled();
	});
});

describe('executeAppReview', () => {
	it('waits for the build before submitting the newest version', async () => {
		const client = stubClient();

		const code = await executeAppReview('submit', 'acme.clock', undefined, { ...target, workspace: ws }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.waitForAppBuild).toHaveBeenCalledWith('acme.clock', 2, expect.any(Object));
		expect(client.waitForAppBuild.mock.invocationCallOrder[0]).toBeLessThan(client.submitApp.mock.invocationCallOrder[0]);
		expect(client.submitApp).toHaveBeenCalledWith('acme.clock', 2);
	});

	it('withdraws without waiting for a build', async () => {
		const client = stubClient();

		await executeAppReview('withdraw', 'acme.clock', '1', { ...target, workspace: ws }, new Output(undefined));

		expect(client.waitForAppBuild).not.toHaveBeenCalled();
		expect(client.withdrawApp).toHaveBeenCalledWith('acme.clock', 1);
	});
});

describe('executeAppReply', () => {
	it('takes the version positionally', async () => {
		const client = stubClient();

		const code = await executeAppReply('acme.clock', '3', { ...target, workspace: ws, message: 'hi' }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.replyApp).toHaveBeenCalledWith('acme.clock', 'hi', 3);
	});

	it('replies on the thread with no version', async () => {
		const client = stubClient();

		await executeAppReply('acme.clock', undefined, { ...target, workspace: ws, message: 'hi' }, new Output(undefined));

		expect(client.replyApp).toHaveBeenCalledWith('acme.clock', 'hi', undefined);
	});
});
