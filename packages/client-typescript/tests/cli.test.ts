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
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli', 'cli', 'rocketride.js');

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
function writePipeline(projectId: string): string {
	const file = path.join(workDir, 'echo.pipe');
	fs.writeFileSync(file, JSON.stringify(getEchoPipeline(projectId)), 'utf8');
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
	const PIPELINE_TOKEN = 'TS-CLI-START';
	const PROJECT_ID = '1a4d7f22-3b65-4e19-8c47-2d9b6e05f731';

	let client: RocketRideClient;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
	});

	afterEach(async () => {
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
		if (client.isConnected()) await client.disconnect();
	});

	it('should start a pipeline the server reports', async () => {
		const pipeline = writePipeline(PROJECT_ID);

		const { code, output } = await runCli(['start', '--pipeline', pipeline, '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Execution Error');

		// The task the CLI started is a task the server knows about
		const status = await client.getTaskStatus(PIPELINE_TOKEN);
		expect(status).toHaveProperty('state');
	});

	it('should report a task token the user can act on', async () => {
		const pipeline = writePipeline(PROJECT_ID);

		const { code, output } = await runCli(['start', '--pipeline', pipeline, '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(0);

		// The follow-up command it prints has to name the real token
		expect(output).toContain(PIPELINE_TOKEN);
		expect(output).not.toContain('[object Object]');
	});

	it('should fail without a pipeline file', async () => {
		const { code, output } = await runCli(['start', ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Pipeline file is required');
	});

	it('should fail on a missing pipeline file without leaving a task behind', async () => {
		const missing = path.join(workDir, 'no-such.pipe');

		const { code } = await runCli(['start', '--pipeline', missing, '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(1);
		expect(await listTaskTokens(client)).not.toContain(PIPELINE_TOKEN);
	});
});

describe('CLI upload Integration Tests', () => {
	const PIPELINE_TOKEN = 'TS-CLI-UPLOAD';
	const PROJECT_ID = '2b5e8a33-4c76-4f2a-9d58-3e0c7f16a842';

	// The token the upload command hardcodes when it starts its own task
	const MANAGED_TOKEN = 'UPLOAD_TASK';

	let client: RocketRideClient;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
		await ensureCleanPipeline(client, MANAGED_TOKEN);
	});

	afterEach(async () => {
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
		await ensureCleanPipeline(client, MANAGED_TOKEN);
		if (client.isConnected()) await client.disconnect();
	});

	it('should upload files to an existing task and leave it running', async () => {
		await client.use({ pipeline: getEchoPipeline(PROJECT_ID), token: PIPELINE_TOKEN });

		const files = writeUploadFiles();
		const { code, output } = await runCli(['upload', ...files, '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Upload Error');

		// A task the CLI did not create is a task it must leave running
		expect(await listTaskTokens(client)).toContain(PIPELINE_TOKEN);
	});

	it('should start and terminate its own task', async () => {
		const pipeline = writePipeline(PROJECT_ID);
		const files = writeUploadFiles();

		const { code, output } = await runCli(['upload', ...files, '--pipeline', pipeline, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Upload Error');

		// A task the CLI created is a task it has to clean up
		expect(await waitUntilGone(client, MANAGED_TOKEN)).toBe(true);
	});

	it('should fail without a pipeline or a token', async () => {
		const files = writeUploadFiles();

		const { code, output } = await runCli(['upload', ...files, ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Either --pipeline or --token');
	});

	it('should fail when no file matches', async () => {
		await client.use({ pipeline: getEchoPipeline(PROJECT_ID), token: PIPELINE_TOKEN });

		const missing = path.join(workDir, 'nothing-*.txt');
		const { code, output } = await runCli(['upload', missing, '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('No files found');
	});

	it('should reject a non-positive --max-concurrent', async () => {
		const files = writeUploadFiles();

		const { code, output } = await runCli(['upload', ...files, '--token', PIPELINE_TOKEN, ...serverArgs(), '--max-concurrent', '0']);

		expect(code).toBe(1);
		expect(output).toContain('--max-concurrent must be a positive integer');
	});
});

describe('CLI stop Integration Tests', () => {
	const PIPELINE_TOKEN = 'TS-CLI-STOP';
	const PROJECT_ID = '3c6f9b44-5d87-4a3b-ae69-4f1d8027b953';

	let client: RocketRideClient;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
	});

	afterEach(async () => {
		await ensureCleanPipeline(client, PIPELINE_TOKEN);
		if (client.isConnected()) await client.disconnect();
	});

	it('should stop a running pipeline', async () => {
		await client.use({ pipeline: getEchoPipeline(PROJECT_ID), token: PIPELINE_TOKEN });
		expect(await listTaskTokens(client)).toContain(PIPELINE_TOKEN);

		const { code, output } = await runCli(['stop', '--token', PIPELINE_TOKEN, ...serverArgs()]);

		expect(code).toBe(0);
		expect(output).not.toContain('Stop Error');
		expect(await waitUntilGone(client, PIPELINE_TOKEN)).toBe(true);
	});

	it('should fail without a token', async () => {
		const { code, output } = await runCli(['stop', ...serverArgs()]);

		expect(code).toBe(1);
		expect(output).toContain('Token is required');
	});
});
