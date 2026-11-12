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
 * Integration tests for the RocketRide CLI.
 *
 * The built CLI is run as a real process against a live server, exactly the way
 * a user runs it, and the effect of each command is verified through a
 * RocketRideClient talking to the same server. Nothing is stubbed: a task the
 * CLI starts is a task the server reports, and a task the CLI stops is one the
 * server drops.
 *
 * Note:
 *     These integration tests require a running RocketRide server and a built
 *     CLI (dist/cli), which `builder test` produces before running jest.
 */

import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { RocketRideClient } from '../src/client';
import { getEchoPipeline } from './echo.pipeline';

// Test configuration
const TEST_CONFIG = {
	uri: process.env.ROCKETRIDE_URI || 'http://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'MYAPIKEY',
	timeout: 120000, // 120 second timeout for integration tests (CI runners can be slow)
};

// The CLI as it is published: the compiled entry point named by package.json bin
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli', 'packages', 'client-typescript', 'src', 'cli', 'rocketride.js');

// Commander reads these as option defaults, so the ambient configuration of
// whoever runs the suite must not reach the subprocess
const CLI_ENV_VARS = ['ROCKETRIDE_URI', 'ROCKETRIDE_APIKEY', 'ROCKETRIDE_TOKEN', 'ROCKETRIDE_PIPELINE'];

async function ensureCleanPipeline(client: RocketRideClient, token: string): Promise<void> {
	try {
		await client.terminate(token);
	} catch {
		// Ignore errors - pipeline might not be running
	}
}

/**
 * A unique token so a run gets an address of its own: use({ token }) and
 * start --token override the pipeline-id segment of the task address, so a
 * unique value keeps the run apart from every other test, worker and client
 * on the same server.
 */
function privateToken(base: string): string {
	return `${base}-${randomUUID().slice(0, 8)}`;
}

/** Connection arguments every CLI command needs. */
function serverArgs(): string[] {
	return ['--uri', TEST_CONFIG.uri, '--apikey', TEST_CONFIG.auth];
}

/** Run the built CLI as a separate process and collect its output. */
function runCli(args: string[]): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		for (const name of CLI_ENV_VARS) delete env[name];

		const child = spawn(process.execPath, [CLI_PATH, ...args], { env });

		let output = '';
		child.stdout.on('data', (chunk) => (output += String(chunk)));
		child.stderr.on('data', (chunk) => (output += String(chunk)));

		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`CLI timed out after ${TEST_CONFIG.timeout}ms: ${output}`));
		}, TEST_CONFIG.timeout);

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 0, output });
		});
	});
}

/** The task address a start or managed upload command printed on its "Token:" line. */
function startedToken(output: string): string {
	const line = output.split(/\r?\n/).find((text) => text.startsWith('Token: '));
	if (!line) throw new Error(`command printed no token:\n${output}`);
	return line.slice('Token: '.length).trim();
}

/** Every task token the server currently reports. */
async function listTaskTokens(client: RocketRideClient): Promise<string[]> {
	const response = await client.request(client.buildRequest('rrext_get_tasks'));
	const tasks = ((response.body as Record<string, unknown>)?.tasks || []) as Array<{ token?: string }>;
	return tasks.map((task) => task.token || '');
}

/** Poll until the server stops reporting the token, or the timeout expires. */
async function waitUntilGone(client: RocketRideClient, token: string, timeoutMs = 30000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const tokens = await listTaskTokens(client);
		if (!tokens.includes(token)) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	return false;
}

let workDir: string;

beforeAll(() => {
	if (!fs.existsSync(CLI_PATH)) {
		throw new Error(`Built CLI not found at ${CLI_PATH}. Run "builder build vscode" or "builder test" first.`);
	}
});

beforeEach(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-test-'));
});

afterEach(() => {
	fs.rmSync(workDir, { recursive: true, force: true });
});

/** Write the echo pipeline to a file the CLI can load. */
function writePipeline(): string {
	const file = path.join(workDir, 'echo.pipe');
	fs.writeFileSync(file, JSON.stringify(getEchoPipeline()), 'utf8');
	return file;
}

/** Create two non-empty files to upload. */
function writeUploadFiles(): string[] {
	return ['alpha.txt', 'beta.txt'].map((name) => {
		const file = path.join(workDir, name);
		fs.writeFileSync(file, `contents of ${name}`, 'utf8');
		return file;
	});
}

describe('CLI start Integration Tests', () => {
	const TOKEN_BASE = 'ts-cli-start';

	let client: RocketRideClient;
	let pipelineToken: string | undefined;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		pipelineToken = undefined;
	});

	afterEach(async () => {
		if (pipelineToken) await ensureCleanPipeline(client, pipelineToken);
		if (client.isConnected()) await client.disconnect();
	});

	it('should start a pipeline the server reports', async () => {
		const pipeline = writePipeline();

		const { code, output } = await runCli(['start', '--pipeline', pipeline, '--token', privateToken(TOKEN_BASE), ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Execution Error');
		pipelineToken = startedToken(output);

		// The task the CLI started is a task the server knows about
		const status = await client.getTaskStatus(pipelineToken);
		expect(status).toHaveProperty('state');
	});

	it('should report a task token the user can act on', async () => {
		const pipeline = writePipeline();

		const { code, output } = await runCli(['start', '--pipeline', pipeline, '--token', privateToken(TOKEN_BASE), ...serverArgs()]);

		expect(code).toBe(0);
		pipelineToken = startedToken(output);

		// The follow-up command it prints has to name the real token
		expect(output).toContain(`rocketride stop --token ${pipelineToken}`);
		expect(await listTaskTokens(client)).toContain(pipelineToken);
		expect(output).not.toContain('[object Object]');
	});

	it('should fail without a pipeline file', async () => {
		const { code, output } = await runCli(['start', ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Pipeline file is required');
	});

	it('should fail on a missing pipeline file without leaving a task behind', async () => {
		const missing = path.join(workDir, 'no-such.pipe');
		// A private token names the only address this invocation could have
		// started, so other clients' tasks cannot affect the check
		const token = privateToken(TOKEN_BASE);

		const { code } = await runCli(['start', '--pipeline', missing, '--token', token, ...serverArgs()]);

		expect(code).toBe(1);
		expect((await listTaskTokens(client)).filter((address) => address.split('.')[1] === token)).toEqual([]);
	});
});

describe('CLI upload Integration Tests', () => {
	const TOKEN_BASE = 'ts-cli-upload';

	let client: RocketRideClient;
	let pipelineToken: string | undefined;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		pipelineToken = undefined;
	});

	afterEach(async () => {
		// The test's own run, or the one the upload command started for itself
		if (pipelineToken) await ensureCleanPipeline(client, pipelineToken);
		if (client.isConnected()) await client.disconnect();
	});

	it('should upload files to an existing task and leave it running', async () => {
		pipelineToken = (await client.use({ pipeline: getEchoPipeline(), token: privateToken(TOKEN_BASE) })).token;

		const files = writeUploadFiles();
		const { code, output } = await runCli(['upload', ...files, '--token', pipelineToken, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Upload Error');

		// A task the CLI did not create is a task it must leave running
		expect(await listTaskTokens(client)).toContain(pipelineToken);
	});

	it('should start and terminate its own task', async () => {
		const pipeline = writePipeline();
		const files = writeUploadFiles();

		const { code, output } = await runCli(['upload', ...files, '--pipeline', pipeline, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Upload Error');

		// A task the CLI created is a task it has to clean up: the one at
		// the private address it printed
		pipelineToken = startedToken(output);
		expect(await waitUntilGone(client, pipelineToken)).toBe(true);
	});

	it('should fail without a pipeline or a token', async () => {
		const files = writeUploadFiles();

		const { code, output } = await runCli(['upload', ...files, ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Either --pipeline or --token');
	});

	it('should fail when no file matches', async () => {
		pipelineToken = (await client.use({ pipeline: getEchoPipeline(), token: privateToken(TOKEN_BASE) })).token;

		const missing = path.join(workDir, 'nothing-*.txt');
		const { code, output } = await runCli(['upload', missing, '--token', pipelineToken, ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('No files found');
	});

	it('should reject a non-positive --max-concurrent', async () => {
		const files = writeUploadFiles();

		// Refused before connecting, so the token names no task
		const { code, output } = await runCli(['upload', ...files, '--token', 'local.no-such-pipe', ...serverArgs(), '--max-concurrent', '0']);

		expect(code).toBe(1);
		expect(output).toContain('--max-concurrent must be a positive integer');
	});
});

describe('CLI stop Integration Tests', () => {
	const TOKEN_BASE = 'ts-cli-stop';

	let client: RocketRideClient;
	let pipelineToken: string | undefined;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		pipelineToken = undefined;
	});

	afterEach(async () => {
		if (pipelineToken) await ensureCleanPipeline(client, pipelineToken);
		if (client.isConnected()) await client.disconnect();
	});

	it('should stop a running pipeline', async () => {
		pipelineToken = (await client.use({ pipeline: getEchoPipeline(), token: privateToken(TOKEN_BASE) })).token;
		expect(await listTaskTokens(client)).toContain(pipelineToken);

		const { code, output } = await runCli(['stop', '--token', pipelineToken, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Stop Error');
		expect(await waitUntilGone(client, pipelineToken)).toBe(true);
	});

	it('should fail without a token', async () => {
		const { code, output } = await runCli(['stop', ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Token is required');
	});
});

// Every session is on a task of the test's own. One on the server process
// would profile everything else using this shared server, and leave data
// behind that other suites expect to be absent.
describe('CLI profile Integration Tests', () => {
	const TOKEN_BASE = 'ts-cli-profile';

	let client: RocketRideClient;
	let pipelineToken: string;
	let tokenArgs: string[];

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		pipelineToken = '';
		pipelineToken = (await client.use({ pipeline: getEchoPipeline(), token: privateToken(TOKEN_BASE) })).token;
		tokenArgs = ['--token', pipelineToken];
	});

	afterEach(async () => {
		if (pipelineToken) await ensureCleanPipeline(client, pipelineToken);
		if (client.isConnected()) await client.disconnect();
	});

	// A task's session belongs to the server's link to it, so it outlives each CLI process
	it('should profile a task across separate invocations', async () => {
		let result = await runCli(['profile', 'start', ...tokenArgs, '--session', 'ts-cli', ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output).toContain(`Profiling started: session 'ts-cli' on task ${pipelineToken}`);

		result = await runCli(['profile', 'status', ...tokenArgs, ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output).toContain(`Profiling active on task ${pipelineToken}: session 'ts-cli'`);

		result = await runCli(['profile', 'stop', ...tokenArgs, ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output).toContain("Profiling stopped: session 'ts-cli'");

		result = await runCli(['profile', 'report', ...tokenArgs, ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output.startsWith('Session: ts-cli')).toBe(true);
	});

	it("should list threads and draw one thread's tree", async () => {
		// Data goes through so engine worker threads run while profiled
		expect((await client.cprofileStart(pipelineToken)).status).toBe('started');
		await client.send(pipelineToken, 'profile me', {}, 'text/plain');
		expect((await client.cprofileStop(pipelineToken)).status).toBe('completed');

		let result = await runCli(['profile', 'threads', ...tokenArgs, '--json', ...serverArgs()]);
		expect(result.code).toBe(0);
		const threads = JSON.parse(result.output).threads as Array<{ id: number; calls: number }>;
		const busiest = threads[0];

		result = await runCli(['profile', 'threads', ...tokenArgs, ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output.split('\n')[0].split(/\s+/)).toEqual(['ID', 'NAME', 'TID', 'TIME', 'SHARE']);
		expect(result.output).toContain(`${threads.length} thread(s)`);

		const thread = ['--thread', String(busiest.id), '--min-pct', '0'];
		result = await runCli(['profile', 'tree', ...tokenArgs, ...thread, '--json', ...serverArgs()]);
		expect(result.code).toBe(0);
		// Only that thread's calls, so the total is the one listed for it
		expect(JSON.parse(result.output).total_calls).toBe(busiest.calls);

		result = await runCli(['profile', 'tree', ...tokenArgs, ...thread, ...serverArgs()]);
		expect(result.code).toBe(0);
		expect(result.output.startsWith(`Call tree, thread ${busiest.id}:`)).toBe(true);
		expect(result.output).toContain('FUNCTION');

		const missing = String(Math.max(...threads.map((t) => t.id)) + 1000);
		result = await runCli(['profile', 'tree', ...tokenArgs, '--thread', missing, ...serverArgs()]);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`Thread ${missing} not found in the last session`);
	});

	it('should run a timed session to completion', async () => {
		const { code, output } = await runCli(['profile', 'run', ...tokenArgs, '--duration', '1', ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).toContain('Profiling stopped: session');
		// A task's session outlives this command, so it says how to end one left behind
		expect(output).toContain(`Killing this command leaves the session running: rocketride profile stop --token ${pipelineToken}`);

		// The session it stopped left data behind to read
		const status = await client.cprofileStatus(pipelineToken);
		expect(status.active).toBe(false);
		expect(status.has_report).toBe(true);
	});

	it('should list which tasks are being profiled', async () => {
		let other: string | undefined;
		try {
			other = (await client.use({ pipeline: getEchoPipeline(), token: privateToken(`${TOKEN_BASE}-other`) })).token;
			expect((await client.cprofileStart(pipelineToken)).status).toBe('started');

			let result = await runCli(['profile', 'list', '--json', ...serverArgs()]);
			expect(result.code).toBe(0);
			const processes = JSON.parse(result.output).processes as Array<{ token: string | null; status?: { active?: boolean } }>;
			// The server process, listed under a null token
			expect(processes.some((process) => process.token === null)).toBe(true);
			expect(processes.find((process) => process.token === pipelineToken)?.status?.active).toBe(true);
			expect(processes.find((process) => process.token === other)?.status?.active).toBe(false);

			result = await runCli(['profile', 'list', '--active', ...serverArgs()]);
			expect(result.code).toBe(0);
			expect(result.output).toContain(pipelineToken);
			expect(result.output).not.toContain(other);
		} finally {
			if (other) await ensureCleanPipeline(client, other);
		}
	});

	it('should fail when the task has no session yet', async () => {
		const { code, output } = await runCli(['profile', 'tree', ...tokenArgs, ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('No profiling data available');
	});
});

// Refused before connecting, with the Python CLI's messages and exit code
describe('CLI profile option checks', () => {
	// Nothing listens on port 9: a connection attempt would fail with a different message
	const NOWHERE = ['--uri', 'http://127.0.0.1:9'];

	it.each([
		[['start'], 'profile start needs --token'],
		[['stop'], 'profile stop needs --token'],
		[['run', '--duration', '0'], '--duration must be a positive number of seconds'],
		[['run', '--duration', '1e3'], '--duration must be a positive number of seconds'],
		// Digits alone are not a number: this many overflow to Infinity
		[['run', '--duration', '9'.repeat(400)], '--duration must be a positive number of seconds'],
		[['tree', '--thread', 'main'], "--thread must be a thread id from 'rocketride profile threads'"],
		[['tree', '--thread', '-1'], "--thread must be a thread id from 'rocketride profile threads'"],
		[['tree', '--min-pct', 'abc'], '--min-pct must be a number from 0 to 100'],
		[['tree', '--min-pct', '100.5'], '--min-pct must be a number from 0 to 100'],
		[['tree', '--max-depth', '0'], '--max-depth must be a positive integer'],
		[['tree', '--max-depth', '2.5'], '--max-depth must be a positive integer'],
		// Past 2^53 a JavaScript number drops the digits it was given; both CLIs refuse it
		[['tree', '--max-depth', '9007199254740993'], '--max-depth must be a positive integer'],
		[['tree', '--thread', '9007199254740993'], "--thread must be a thread id from 'rocketride profile threads'"],
	])('should refuse profile %j without connecting', async (argv, message) => {
		const { code, output } = await runCli(['profile', ...argv, ...NOWHERE]);

		expect(code).toBe(1);
		expect(output).toContain(message);
	});
});
