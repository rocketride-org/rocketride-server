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
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

/** Writes an app working copy at apps/<folder> with its marker. */
function writeApp(folder: string, appId: string): string {
	const dir = path.join(ws, 'apps', folder);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: folder, appManifest: { id: appId, name: folder } }));
	fs.writeFileSync(path.join(dir, `${appId.split('.').pop()}.rrapp`), '{}');
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

describe('argument helpers', () => {
	it('splitAppVersion reads a lone number as the version', () => {
		expect(splitAppVersion('3')).toEqual({ version: '3' });
		expect(splitAppVersion('v3')).toEqual({ version: 'v3' });
		expect(splitAppVersion('clock')).toEqual({ app: 'clock', version: undefined });
		expect(splitAppVersion('clock', '3')).toEqual({ app: 'clock', version: '3' });
	});

	it('normalizePublishTarget accepts the three audiences, with or without @', () => {
		expect(normalizePublishTarget('me')).toBe('@me');
		expect(normalizePublishTarget('@public')).toBe('@public');
		expect(normalizePublishTarget('@team/QA')).toBe('@team/QA');
		expect(() => normalizePublishTarget('@everyone')).toThrow(/Unknown publish target/);
	});
});

describe('findApp', () => {
	it('resolves the current directory, a folder, an id, its name part, and its folder name', async () => {
		const dir = writeApp('clock-ui', 'personal.clock');

		expect((await findApp(ws, undefined, dir)).appId).toBe('personal.clock');
		expect((await findApp(ws, 'apps/clock-ui')).app?.folder).toBe(dir);
		expect((await findApp(ws, 'personal.clock')).app?.folder).toBe(dir);
		expect((await findApp(ws, 'clock')).appId).toBe('personal.clock');
		expect((await findApp(ws, 'clock-ui')).appId).toBe('personal.clock');
	});

	it('returns a full id with no working copy for server-only verbs', async () => {
		expect(await findApp(ws, 'acme.remote')).toEqual({ appId: 'acme.remote' });
	});

	it('refuses an ambiguous name and names the local apps when nothing matches', async () => {
		writeApp('clock-ui', 'personal.clock');
		writeApp('clock2-ui', 'acme.clock');

		await expect(findApp(ws, 'clock')).rejects.toThrow(/several apps.*personal\.clock/);
		await expect(findApp(ws, 'nope')).rejects.toThrow(/No app "nope" found.*personal\.clock/);
		await expect(findApp(ws, undefined, ws)).rejects.toThrow(/not an app folder/);
	});

	it('skips node_modules when walking', async () => {
		writeApp('clock-ui', 'personal.clock');
		const hidden = path.join(ws, 'node_modules', 'pkg');
		fs.mkdirSync(hidden, { recursive: true });
		fs.writeFileSync(path.join(hidden, 'package.json'), JSON.stringify({ appManifest: { id: 'other.clock' } }));
		fs.writeFileSync(path.join(hidden, 'clock.rrapp'), '{}');

		expect((await findApp(ws, 'clock')).appId).toBe('personal.clock');
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

	it('takes an explicit version and target', async () => {
		const client = stubClient();

		await executeAppPublish('acme.clock', '1', { ...target, workspace: ws, to: '@team/QA' }, new Output(undefined));

		expect(client.listDeployments).not.toHaveBeenCalled();
		expect(client.publishApp).toHaveBeenCalledWith('acme.clock', 1, '@team/QA');
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
		const dir = writeApp('clock-ui', 'personal.clock');
		const client = stubClient();

		const code = await executeAppDeploy('clock', { ...target, workspace: ws, publish: 'me' }, new Output(undefined));

		expect(code).toBe(0);
		expect(client.deploy.addApp).toHaveBeenCalledWith(dir, expect.objectContaining({ workspaceRoot: ws }));
		expect(client.waitForAppBuild).toHaveBeenCalledWith('personal.clock', 5, expect.any(Object));
		expect(client.publishApp).toHaveBeenCalledWith('personal.clock', 5, '@me');
		expect(logs.join('\n')).toContain('Deployed personal.clock v5 (app 0.1.0)');
	});

	it('prints the publish command instead when --publish is absent', async () => {
		writeApp('clock-ui', 'personal.clock');
		const client = stubClient();

		await executeAppDeploy('clock', { ...target, workspace: ws }, new Output(undefined));

		expect(client.publishApp).not.toHaveBeenCalled();
		expect(logs.join('\n')).toContain('rocketride app publish personal.clock 5 --to @me');
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
