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
 * Integration tests for `client.tool()` and `DataPipe.tool()`.
 *
 * Starts a pipeline with a tool_python node and invokes its `execute` tool
 * via the new DAP `tool` subcommand -- both standalone (borrowed pipe) and
 * pipe-bound paths.
 */

import { RocketRideClient } from '../src/client';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getToolPipeline } from './tool.pipeline';

const TEST_CONFIG = {
	uri: process.env.ROCKETRIDE_URI || 'http://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'MYAPIKEY',
	timeout: 120000,
};

const TOOL_TOKEN = 'TS-TOOL';

async function ensureCleanPipeline(client: RocketRideClient, token: string): Promise<void> {
	try {
		await client.terminate(token);
	} catch {
		// Ignore errors - pipeline might not be running
	}
}

describe('Tool Operations', () => {
	let client: RocketRideClient;
	let pipelineToken: string;

	beforeEach(async () => {
		client = new RocketRideClient({
			auth: TEST_CONFIG.auth,
			uri: TEST_CONFIG.uri,
		});
		await client.connect();
		await ensureCleanPipeline(client, TOOL_TOKEN);

		const result = await client.use({
			pipeline: getToolPipeline(),
			token: TOOL_TOKEN,
		});
		pipelineToken = result.token;
	});

	afterEach(async () => {
		if (pipelineToken) {
			try {
				await client.terminate(pipelineToken);
			} catch {
				// Ignore cleanup errors
			}
		}
		await ensureCleanPipeline(client, TOOL_TOKEN);
		if (client.isConnected()) {
			await Promise.race([
				client.disconnect(),
				new Promise<void>((resolve) => setTimeout(resolve, 10000)),
			]);
		}
	});

	// ------------------------------------------------------------------
	// Standalone client.tool() -- borrows a pipe from the pool
	// ------------------------------------------------------------------

	describe('standalone client.tool()', () => {
		it('executes python and returns result', async () => {
			const result = await client.tool<{
				exit_code: number;
				result: { answer: number };
			}>({
				token: pipelineToken,
				tool: 'execute',
				nodeId: 'tool_python_1',
				input: { code: 'result = {"answer": 2 + 2}' },
			});

			expect(result).toBeDefined();
			expect(result.exit_code).toBe(0);
			expect(result.result).toEqual({ answer: 4 });
		}, TEST_CONFIG.timeout);

		it('captures stdout from sandboxed script', async () => {
			const result = await client.tool<{
				exit_code: number;
				stdout: string;
			}>({
				token: pipelineToken,
				tool: 'execute',
				nodeId: 'tool_python_1',
				input: { code: 'print("hello")' },
			});

			expect(result).toBeDefined();
			expect(result.exit_code).toBe(0);
			expect(result.stdout).toContain('hello');
		}, TEST_CONFIG.timeout);

		it('invalid tool name throws', async () => {
			await expect(
				client.tool({
					token: pipelineToken,
					tool: 'nonexistent_tool',
					nodeId: 'tool_python_1',
					input: {},
				}),
			).rejects.toThrow();
		}, TEST_CONFIG.timeout);
	});

	// ------------------------------------------------------------------
	// DataPipe.tool() -- reuses an already-open pipe
	// ------------------------------------------------------------------

	describe('pipe-bound DataPipe.tool()', () => {
		it('executes python using open pipe', async () => {
			const pipe = await client.pipe(pipelineToken, {}, 'text/plain');
			await pipe.open();

			try {
				const result = await pipe.tool<{
					exit_code: number;
					result: number[];
				}>('execute', 'tool_python_1', { code: 'result = list(range(5))' });

				expect(result).toBeDefined();
				expect(result.exit_code).toBe(0);
				expect(result.result).toEqual([0, 1, 2, 3, 4]);
			} finally {
				await pipe.close();
			}
		}, TEST_CONFIG.timeout);

		it('before open throws', async () => {
			const pipe = await client.pipe(pipelineToken, {}, 'text/plain');

			await expect(
				pipe.tool('execute', 'tool_python_1', { code: 'pass' }),
			).rejects.toThrow('not open');
		}, TEST_CONFIG.timeout);
	});
});
