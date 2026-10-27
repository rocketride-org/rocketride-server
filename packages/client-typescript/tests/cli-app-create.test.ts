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
 * `rocketride app create` resolves the app id namespace like the App
 * Builder's New App wizard: --developer, else the account's developer id,
 * else 'local' with a warning — never a failure.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as common from '../src/cli/common';
import { executeAppCreate } from '../src/cli/commands/app';
import { Output } from '../src/cli/output';

type ConnectedClient = Awaited<ReturnType<typeof common.connectClient>>;

let ws: string;
let errors: string[];

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-create-'));
	errors = [];
	jest.spyOn(console, 'log').mockImplementation(() => undefined);
	jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(' '));
	});
});

afterEach(() => {
	jest.restoreAllMocks();
	fs.rmSync(ws, { recursive: true, force: true });
});

/** Runs `app create clock` offline (no install, no vendoring server). */
async function create(options: Record<string, unknown>): Promise<{ code: number; appId: string }> {
	const code = await executeAppCreate('clock', { workspace: ws, install: false, ...options }, new Output(undefined));
	const pkg = JSON.parse(fs.readFileSync(path.join(ws, 'apps', 'clock-ui', 'package.json'), 'utf8'));
	return { code, appId: pkg.appManifest.id };
}

describe('executeAppCreate developer id', () => {
	it('uses the connected account developer id', async () => {
		const connectSpy = jest.spyOn(common, 'connectClient').mockImplementation(async () => ({ getAccountInfo: () => ({ organization: { developerId: 'personal' } }) }) as unknown as ConnectedClient);

		const { code, appId } = await create({ apikey: 'key' });

		expect(code).toBe(0);
		expect(appId).toBe('personal.clock');
		expect(connectSpy).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
	});

	it('lets --developer win without connecting', async () => {
		const connectSpy = jest.spyOn(common, 'connectClient');

		const { appId } = await create({ apikey: 'key', developer: 'acme' });

		expect(appId).toBe('acme.clock');
		expect(connectSpy).not.toHaveBeenCalled();
	});

	it('falls back to local with a warning when the connection fails', async () => {
		jest.spyOn(common, 'connectClient').mockImplementation(async () => {
			throw new Error('ECONNREFUSED');
		});

		const { code, appId } = await create({ apikey: 'key' });

		expect(code).toBe(0);
		expect(appId).toBe('local.clock');
		expect(errors.join('\n')).toMatch(/Warning: could not read the developer id .*ECONNREFUSED.*using 'local'/);
	});

	it('falls back to local with a warning when no key is configured', async () => {
		const connectSpy = jest.spyOn(common, 'connectClient');

		const { appId } = await create({});

		expect(appId).toBe('local.clock');
		expect(connectSpy).not.toHaveBeenCalled();
		expect(errors.join('\n')).toMatch(/Warning: no account credentials/);
	});

	it('falls back to local with a warning when the org has no developer id', async () => {
		jest.spyOn(common, 'connectClient').mockImplementation(async () => ({ getAccountInfo: () => ({ organization: { developerId: null } }) }) as unknown as ConnectedClient);

		const { appId } = await create({ apikey: 'key' });

		expect(appId).toBe('local.clock');
		expect(errors.join('\n')).toMatch(/no registered developer id/);
	});
});
