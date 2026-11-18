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
 * `rocketride app create` writes the SLUG as the app id. The developer
 * namespace is attached by the organization that deploys the app (the
 * server composes `<developerId>.<slug>` at its door), so create never
 * reads a developer id off an account and has no namespace fallback.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as common from '../src/cli/common';
import { executeAppCreate } from '../src/cli/commands/app';
import { Output } from '../src/cli/output';

let ws: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-create-'));
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

/** Runs `app create clock` offline (no install, no vendoring server). */
async function create(options: Record<string, unknown>): Promise<{ code: number; appId: string; folder: string }> {
	const code = await executeAppCreate('clock', { workspace: ws, install: false, ...options }, new Output(undefined));
	const folder = path.join(ws, 'apps', 'clock-ui');
	const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
	return { code, appId: pkg.appManifest.id, folder };
}

describe('executeAppCreate app id', () => {
	it('writes the slug as the app id and names the trigger after it', async () => {
		const { code, appId, folder } = await create({});

		expect(code).toBe(0);
		expect(appId).toBe('clock');
		expect(fs.existsSync(path.join(folder, 'clock.rrapp'))).toBe(true);
		expect(logs.join('\n')).toContain('Created clock at apps/clock-ui');
		expect(errors).toEqual([]);
	});

	it('never connects to read a developer id, with or without credentials', async () => {
		const connectSpy = jest.spyOn(common, 'connectClient').mockImplementation(async () => {
			throw new Error('app create must not connect');
		});

		const withKey = await create({ apikey: 'key' });
		fs.rmSync(path.join(ws, 'apps'), { recursive: true, force: true });
		const withoutKey = await create({});

		expect(withKey.appId).toBe('clock');
		expect(withoutKey.appId).toBe('clock');
		expect(connectSpy).not.toHaveBeenCalled();
		// no namespace fallback exists any more, so nothing warns about one
		expect(errors).toEqual([]);
	});
});
