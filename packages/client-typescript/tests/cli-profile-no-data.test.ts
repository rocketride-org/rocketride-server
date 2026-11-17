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
 * Exit codes of `rocketride profile report`, `threads` and `tree` before any
 * session has completed, as ROCKETRIDE_CLI.md documents them. The Python
 * suite pins the same (client-python/tests/test_profile_cli_format.py,
 * TestNoData).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { Command } from 'commander';
import { registerProfileCommands } from '../src/cli/commands/profile';
import { connectClient } from '../src/cli/common';

jest.mock('../src/cli/common', () => ({
	...jest.requireActual<object>('../src/cli/common'),
	connectClient: jest.fn(),
}));

const NO_DATA = 'No profiling data available. Run a session first.';

// Answers as the server does before any session has completed
const noDataClient = {
	cprofileReport: async () => ({ report: NO_DATA }),
	cprofileThreads: async () => ({ threads: [], error: NO_DATA }),
	cprofileReportTree: async () => ({ tree: null, functions: [], total_time: 0, total_calls: 0, error: NO_DATA }),
};

async function runProfile(subcommand: string): Promise<{ code: unknown; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
	jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void err.push(args.join(' ')));
	const program = new Command();
	registerProfileCommands(program);
	await program.parseAsync(['node', 'rocketride', 'profile', subcommand, '--uri', 'http://127.0.0.1:9']);
	return { code: process.exitCode, out: out.join('\n'), err: err.join('\n') };
}

describe('profile without a completed session', () => {
	beforeEach(() => {
		jest.mocked(connectClient).mockResolvedValue(noDataClient as never);
		// runCliCommand arms a forced exit; it must never fire inside the test worker
		jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
		jest.restoreAllMocks();
		process.exitCode = 0;
	});

	it('should print the placeholder report and exit 0', async () => {
		const { code, out, err } = await runProfile('report');

		expect(code).toBe(0);
		expect(out).toContain(NO_DATA);
		expect(err).not.toContain(NO_DATA);
	});

	it('should fail threads with exit 1', async () => {
		const { code, out, err } = await runProfile('threads');

		expect(code).toBe(1);
		expect(err).toContain(NO_DATA);
		expect(out).not.toContain(NO_DATA);
	});

	it('should fail tree with exit 1', async () => {
		const { code, out, err } = await runProfile('tree');

		expect(code).toBe(1);
		expect(err).toContain(NO_DATA);
		expect(out).not.toContain(NO_DATA);
	});
});
