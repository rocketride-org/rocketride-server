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

import { RocketRideClient } from '../src/client';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const TEST_CONFIG = {
	uri: process.env.ROCKETRIDE_URI || 'http://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'MYAPIKEY',
	timeout: 120000,
};

const PROJECT_ID = `test-project-${Math.random().toString(16).slice(2, 10)}`;

const PIPELINE = {
	project_id: PROJECT_ID,
	components: [
		{
			id: 'webhook_1',
			provider: 'webhook',
			name: 'Test webhook',
			config: { hideForm: true, mode: 'Source', type: 'webhook' },
		},
		{
			id: 'response_1',
			provider: 'response',
			config: { lanes: [] },
			input: [{ lane: 'text', from: 'webhook_1' }],
		},
	],
	source: 'webhook_1',
};

const PIPELINE_V2 = {
	project_id: PROJECT_ID,
	components: [
		{
			id: 'chat_1',
			provider: 'chat',
			name: 'Test chat',
			config: { hideForm: true, mode: 'Source', type: 'chat' },
		},
		{
			id: 'response_1',
			provider: 'response',
			config: { lanes: [] },
			input: [{ lane: 'questions', from: 'chat_1' }],
		},
	],
	source: 'chat_1',
};

/**
 * Integration tests for the deploy client API.
 *
 * These tests connect to a live server and exercise the full CRUD lifecycle
 * (add, list, status, update, remove). They predate the TaskScheduler and
 * remain valid without modification for the following reasons:
 *
 * - Tests that use the default schedule ('manual') are completely unaffected:
 *   manual deployments are never dispatched by the scheduler.
 * - Tests that supply a cron schedule (e.g. '* /15 * * * *') remove the
 *   deployment before the scheduler could ever fire — the minimum cron
 *   granularity is 60 s and all tests clean up in the finally block.
 * - 'remove' now also calls scheduler.unschedule() server-side, but the
 *   observable client behaviour (status throws after remove) is unchanged.
 *
 * These tests therefore cover the client API contract only. Scheduler
 * registration and execution are covered separately — see:
 *   packages/ai/tests/ai/modules/task/test_task_scheduler.py
 */
describe('Deploy API Integration Tests', () => {
	let client: RocketRideClient;

	beforeEach(async () => {
		client = new RocketRideClient({ auth: TEST_CONFIG.auth, uri: TEST_CONFIG.uri });
		await client.connect();
	});

	afterEach(async () => {
		if (client.isConnected()) {
			await Promise.race([client.disconnect(), new Promise<void>((resolve) => setTimeout(resolve, 10000))]);
		}
	});

	// ── add ────────────────────────────────────────────────────────────────────

	it(
		'add returns full record',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				expect(rec.pipeline!.project_id!).toBeTruthy();
				expect(rec.pipeline).toEqual(PIPELINE);
				expect(rec.schedule).toBe('manual');
				expect(rec.state).toBe('active');
				expect(rec.userId).toBeTruthy();
				// The stored user credential must never be echoed back to clients.
				expect(rec).not.toHaveProperty('userToken');
				expect(rec.createdAt).toBeGreaterThan(0);
				expect(rec.updatedAt).toBeGreaterThan(0);
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	it(
		'add with cron schedule',
		async () => {
			const rec = await client.deploy.add(PIPELINE, { schedule: '*/15 * * * *' });
			try {
				expect(rec.schedule).toBe('*/15 * * * *');
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	it(
		'add with invalid schedule throws',
		async () => {
			await expect(client.deploy.add(PIPELINE, { schedule: 'not-a-cron' })).rejects.toThrow();
		},
		TEST_CONFIG.timeout,
	);

	it(
		'add duplicate throws',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				await expect(client.deploy.add(PIPELINE)).rejects.toThrow();
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	// ── list ───────────────────────────────────────────────────────────────────

	it(
		'list includes created deployment',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				const deployments = await client.deploy.list();
				const ids = deployments.map((d) => d.pipeline!.project_id!);
				expect(ids).toContain(rec.pipeline!.project_id!);
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	it(
		'list returns array',
		async () => {
			const deployments = await client.deploy.list();
			expect(Array.isArray(deployments)).toBe(true);
		},
		TEST_CONFIG.timeout,
	);

	// ── status ─────────────────────────────────────────────────────────────────

	it(
		'status returns deployment',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				const s = await client.deploy.status(rec.pipeline!.project_id!);
				expect(s.pipeline!.project_id!).toBe(rec.pipeline!.project_id!);
				expect(s.state).toBe('active');
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	it(
		'status with unknown id throws',
		async () => {
			await expect(client.deploy.status('nonexistent-deployment-id')).rejects.toThrow();
		},
		TEST_CONFIG.timeout,
	);

	// ── update ─────────────────────────────────────────────────────────────────

	it(
		'update schedule',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				await client.deploy.update(rec.pipeline!.project_id!, { schedule: '0 * * * *' });
				const s = await client.deploy.status(rec.pipeline!.project_id!);
				expect(s.schedule).toBe('0 * * * *');
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	it(
		'update pipeline',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				await client.deploy.update(rec.pipeline!.project_id!, { pipeline: PIPELINE_V2 });
				const s = await client.deploy.status(rec.pipeline!.project_id!);
				expect(s.pipeline).toEqual(PIPELINE_V2);
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);


	it(
		'update bumps updatedAt',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			try {
				await client.deploy.update(rec.pipeline!.project_id!, { schedule: '@hourly' });
				const s = await client.deploy.status(rec.pipeline!.project_id!);
				expect(s.updatedAt!).toBeGreaterThanOrEqual(rec.updatedAt!);
			} finally {
				await client.deploy.remove(rec.pipeline!.project_id!);
			}
		},
		TEST_CONFIG.timeout,
	);

	// ── remove ─────────────────────────────────────────────────────────────────

	it(
		'remove deletes deployment',
		async () => {
			const rec = await client.deploy.add(PIPELINE);
			await client.deploy.remove(rec.pipeline!.project_id!);
			await expect(client.deploy.status(rec.pipeline!.project_id!)).rejects.toThrow();
		},
		TEST_CONFIG.timeout,
	);

	it(
		'remove unknown id throws',
		async () => {
			await expect(client.deploy.remove('nonexistent-deployment-id')).rejects.toThrow();
		},
		TEST_CONFIG.timeout,
	);

	// ── update errors ──────────────────────────────────────────────────────────

	it(
		'update nonexistent throws',
		async () => {
			await expect(client.deploy.update('nonexistent-deployment-id', { schedule: 'manual' })).rejects.toThrow();
		},
		TEST_CONFIG.timeout,
	);
});
