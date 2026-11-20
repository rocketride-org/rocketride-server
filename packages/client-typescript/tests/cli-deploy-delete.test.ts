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
 * `client.deploy.delete` and `rocketride deploy delete`, against a stubbed
 * client — no server. The SDK verb is one DAP call on the generic rail door;
 * the CLI verb confirms on a terminal, needs --yes off one, and passes the
 * server's refusal through by name.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as common from '../src/cli/common';
import { executeDeployDelete } from '../src/cli/commands/deploy';
import { Output } from '../src/cli/output';
import { DeployApi } from '../src/client/deploy';
import type { RocketRideClient } from '../src/client/client';

type DeployClient = NonNullable<Awaited<ReturnType<typeof common.connectDeploy>>>;

let logs: string[];
let errors: string[];
const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

beforeEach(() => {
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
	// step: put the terminal flag back the way the runner had it
	if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY);
	else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

/** Pretend stdin is (or is not) a terminal for one test. */
function terminal(on: boolean): void {
	Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true, writable: true });
}

/** An async mock that accepts any arguments (so call assertions type-check). */
const stub = <T>(value: T) => jest.fn(async (..._args: unknown[]) => value);

const DELETED = { projectId: 'acme.docBrain', version: 3, kind: 'pipe', sha256: 'abc', deleted: true, orgId: 'org-1' };

/** A deploy client stub; `connectDeploy` hands it to the command. */
function stubClient(deleteImpl = stub(DELETED)) {
	const client = { deploy: { delete: deleteImpl } };
	jest.spyOn(common, 'connectDeploy').mockImplementation(async () => client as unknown as DeployClient);
	return client;
}

const target = { uri: 'https://deploy.test', apikey: 'k' };

describe('client.deploy.delete', () => {
	it('is one call on the generic rail door with the version as a number', async () => {
		const call = stub(DELETED);
		const api = new DeployApi({ call } as unknown as RocketRideClient);
		await expect(api.delete('docBrain', 3)).resolves.toEqual(DELETED);
		expect(call).toHaveBeenCalledWith('rrext_deploy', { subcommand: 'delete', projectId: 'docBrain', version: 3 });
	});
});

describe('rocketride deploy delete', () => {
	it('deletes with --yes and prints what went', async () => {
		const client = stubClient();
		const out = new Output(undefined);
		expect(await executeDeployDelete('docBrain', '3', { ...target, yes: true }, out)).toBe(0);
		out.finish();
		expect(client.deploy.delete).toHaveBeenCalledWith('docBrain', 3);
		expect(logs.join('\n')).toContain('Deleted docBrain v3 from the server.');
	});

	it('accepts a v-prefixed version and refuses a non-version', async () => {
		const client = stubClient();
		expect(await executeDeployDelete('docBrain', 'v3', { ...target, yes: true }, new Output(undefined))).toBe(0);
		expect(client.deploy.delete).toHaveBeenCalledWith('docBrain', 3);
		expect(await executeDeployDelete('docBrain', 'latest', { ...target, yes: true }, new Output(undefined))).toBe(1);
		expect(errors.join('\n')).toContain("Invalid version 'latest'");
		expect(client.deploy.delete).toHaveBeenCalledTimes(1);
	});

	it('refuses anything that is not a whole registry number, so a typo never deletes a neighbour', async () => {
		const client = stubClient();
		// parseInt would have read every one of these as 3.
		for (const typed of ['3.5', '3abc', '3e1', '0', '-3', 'v', '', ' 3 4 ', '1e400']) {
			expect(await executeDeployDelete('docBrain', typed, { ...target, yes: true }, new Output(undefined))).toBe(1);
		}
		expect(client.deploy.delete).not.toHaveBeenCalled();
		expect(await executeDeployDelete('docBrain', ' V3 ', { ...target, yes: true }, new Output(undefined))).toBe(0);
		expect(client.deploy.delete).toHaveBeenCalledWith('docBrain', 3);
	});

	it('needs --yes off a terminal and never reaches the server without it', async () => {
		const client = stubClient();
		terminal(false);
		expect(await executeDeployDelete('docBrain', '3', target, new Output(undefined))).toBe(1);
		expect(errors.join('\n')).toContain('needs confirmation');
		expect(errors.join('\n')).toContain('--yes');
		expect(client.deploy.delete).not.toHaveBeenCalled();
	});

	it('confirms on a terminal: no is a cancel, yes deletes', async () => {
		const client = stubClient();
		terminal(true);
		const prompt = jest.spyOn(common, 'promptLine').mockResolvedValueOnce('n').mockResolvedValueOnce('y');
		expect(await executeDeployDelete('docBrain', '3', target, new Output(undefined))).toBe(1);
		expect(client.deploy.delete).not.toHaveBeenCalled();
		expect(logs.join('\n')).toContain('Cancelled.');
		expect(await executeDeployDelete('docBrain', '3', target, new Output(undefined))).toBe(0);
		expect(client.deploy.delete).toHaveBeenCalledWith('docBrain', 3);
		expect(prompt.mock.calls[0][0]).toContain('Delete docBrain v3 from the server?');
	});

	it('passes the server refusal through by name', async () => {
		stubClient(jest.fn(async () => Promise.reject(new Error('acme.docBrain v3 is published to @team/Production; unpublish it first'))));
		await expect(executeDeployDelete('docBrain', '3', { ...target, yes: true }, new Output(undefined))).rejects.toThrow('published to @team/Production; unpublish it first');
	});
});
