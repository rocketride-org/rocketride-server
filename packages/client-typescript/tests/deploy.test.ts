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

/** The one team on the OSS test server. */
const TEAM = 'local';

/** A unique project id per test — registry versions accumulate forever. */
function freshProject(): string {
	return `sdk-deploy-${Math.random().toString(16).slice(2, 12)}`;
}

/** A minimal valid pipeline for one throwaway project id. */
function makePipeline(projectId: string) {
	return {
		project_id: projectId,
		name: 'SDK deploy test',
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
}

/**
 * CRC-32 (IEEE 802.3, reflected) of a byte array — the checksum a zip's
 * local + central directory headers must carry so the server's zip reader
 * accepts the entry.
 *
 * @param bytes - The bytes to checksum.
 * @returns The unsigned 32-bit CRC.
 */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		// Process each bit with the reflected CRC-32 polynomial.
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A minimal in-memory app SOURCE zip carrying one STORED (uncompressed)
 * package.json — enough for the server to read the appManifest and route
 * the deploy down its app branch. Mirrors a real app's package.json: the
 * semver at the top level, the appManifest projection alongside.
 *
 * @param appId - The app id declared in appManifest (`<developerId>.<name>`).
 * @returns The zip bytes, ready for `deploy.add({ kind: 'app', data })`.
 */
function makeAppZip(appId: string): Uint8Array {
	const name = new TextEncoder().encode('package.json');
	const file = new TextEncoder().encode(
		JSON.stringify({ name: 'sdk-app', version: '1.0.0', appManifest: { id: appId, name: 'SDK App' } })
	);
	const crc = crc32(file);
	const out: number[] = [];
	const u16 = (n: number): void => void out.push(n & 0xff, (n >>> 8) & 0xff);
	const u32 = (n: number): void => void out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
	const raw = (b: Uint8Array): void => b.forEach((x) => out.push(x));

	// Local file header (STORED — compression 0, compressed size == length).
	u32(0x04034b50);
	u16(20); // version needed to extract
	u16(0); // general-purpose flags
	u16(0); // compression method: stored
	u16(0); // mod time
	u16(0); // mod date
	u32(crc);
	u32(file.length); // compressed size
	u32(file.length); // uncompressed size
	u16(name.length);
	u16(0); // extra length
	raw(name);
	raw(file);

	// Central directory header for the single entry.
	const cdOffset = out.length;
	u32(0x02014b50);
	u16(20); // version made by
	u16(20); // version needed to extract
	u16(0); // general-purpose flags
	u16(0); // compression method
	u16(0); // mod time
	u16(0); // mod date
	u32(crc);
	u32(file.length); // compressed size
	u32(file.length); // uncompressed size
	u16(name.length);
	u16(0); // extra length
	u16(0); // comment length
	u16(0); // disk number start
	u16(0); // internal attributes
	u32(0); // external attributes
	u32(0); // local header offset
	raw(name);

	// End of central directory record.
	const cdSize = out.length - cdOffset;
	u32(0x06054b50);
	u16(0); // this disk number
	u16(0); // disk with central directory
	u16(1); // entries on this disk
	u16(1); // total entries
	u32(cdSize);
	u32(cdOffset);
	u16(0); // comment length

	return new Uint8Array(out);
}

/**
 * Integration tests for the deploy client API (teams-as-environments).
 *
 * These tests connect to a live server and exercise the published contract:
 * add (immutable registry versions), deploy (pointing a team at a
 * version — promotion and rollback alike), the standard list envelopes on
 * list/versions/history, pause/resume, soft remove with a surviving audit
 * trail, per-source schedules, and the single cron evaluator.
 *
 * Every test uses a fresh project id and soft-removes its deployment in a
 * finally block so scheduled work never leaks across tests. Scheduler
 * dispatch itself is covered server-side (test_task_scheduler.py).
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

	/** Soft-remove the test deployment; tolerate never-deployed projects. */
	async function cleanup(projectId: string): Promise<void> {
		try {
			await client.deploy.remove(projectId, TEAM);
		} catch {
			// Never deployed — nothing to clean.
		}
	}

	// ── publish ────────────────────────────────────────────────────────────────

	it(
		'publish returns an immutable artifact and versions accumulate',
		async () => {
			const project = freshProject();
			const result = await client.deploy.add({ pipeline: makePipeline(project), comment: 'first cut' });
			expect(result.artifact?.version).toBe(1);
			expect(result.artifact?.sha256).toBeTruthy();
			expect(result.artifact?.comment).toBe('first cut');
			expect(result.artifact?.publishedBy?.userId).toBeTruthy();
			expect(result.deployment).toBeUndefined();

			const result2 = await client.deploy.add({ pipeline: makePipeline(project) });
			expect(result2.artifact?.version).toBe(2);

			const versions = await client.deploy.versions(project);
			expect(versions.rows.map((v) => v.version)).toEqual([2, 1]);
		},
		TEST_CONFIG.timeout
	);

	it(
		'publish with deployTo is one-step publish+deploy',
		async () => {
			const project = freshProject();
			try {
				const result = await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				expect(result.deployment?.teamId).toBe(TEAM);
				expect(result.deployment?.projectId).toBe(project);
				expect(result.deployment?.version).toBe(1);
				expect(result.deployment?.state).toBe('enabled');
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'add routes kind:"app" through the app branch',
		async () => {
			// Guards kind routing: kind:'app' must reach the server's app
			// handler (zip transport), NOT the pipe path. The OSS test org owns
			// no developer namespace, so an app deploy can never mint an
			// artifact here — but the namespace rejection fires only AFTER the
			// server has parsed the zip and read its appManifest, which proves
			// the call landed on the app branch. A routing regression (kind:'app'
			// mis-sent as a pipe, or `data` dropped) errors elsewhere and never
			// mentions the developer namespace, so this assertion fails on it.
			const data = makeAppZip('sdk.app');
			await expect(
				client.deploy.add({ kind: 'app', data, metadata: { projectId: freshProject() } })
			).rejects.toThrow(/developer/i);
		},
		TEST_CONFIG.timeout
	);

	// ── deploy: promotion and rollback are the same pointer move ───────────────

	it(
		'deploy and rollback move the pointer; history labels honestly',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project) });
				await client.deploy.add({ pipeline: makePipeline(project) });

				let dep = await client.deploy.deploy(project, 2, TEAM);
				expect(dep.version).toBe(2);

				dep = await client.deploy.deploy(project, 1, TEAM);
				expect(dep.version).toBe(1);

				const history = await client.deploy.history(project, { teamId: TEAM });
				expect(history.rows[0].action).toBe('rollback');
				// seq is the stable append-order identity: strictly descending.
				const seqs = history.rows.map((h) => h.seq ?? 0);
				expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'deploying an unpublished version throws',
		async () => {
			const project = freshProject();
			await client.deploy.add({ pipeline: makePipeline(project) });
			await expect(client.deploy.deploy(project, 7, TEAM)).rejects.toThrow();
		},
		TEST_CONFIG.timeout
	);

	it(
		'run-now dispatches as the team and is stoppable; disabled refuses',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				const result = await client.deploy.run(project, 'webhook_1', TEAM);
				expect(result.token).toBeTruthy();
				// The UI's stop path: resolve the live task and terminate it.
				// The lookup is TEAM-scoped — without teamId it would address
				// the caller's own dev run of this pipeline (and find none).
				const token = await client.getTaskToken({ projectId: project, source: 'webhook_1', teamId: TEAM });
				expect(token).toBe(result.token);
				if (token) await client.terminate(token);

				await client.deploy.disable(project, TEAM);
				await expect(client.deploy.run(project, 'webhook_1', TEAM)).rejects.toThrow();
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	// ── reads: standard list envelopes ─────────────────────────────────────────

	it(
		'list returns the standard envelope with paging',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });

				const body = await client.deploy.list();
				expect(Object.keys(body).sort()).toEqual(['page', 'pageSize', 'rows', 'total']);
				expect(body.rows.some((d) => d.projectId === project)).toBe(true);

				const page = await client.deploy.list({ teamId: TEAM, pageSize: 1 });
				expect(page.pageSize).toBe(1);
				expect(page.rows.length).toBeLessThanOrEqual(1);
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'get returns the registry-joined record; unknown project throws',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				const dep = await client.deploy.get(project, TEAM);
				expect(dep.projectId).toBe(project);
				expect(dep.sha256).toBeTruthy();
				expect(dep.schedules).toEqual({});
			} finally {
				await cleanup(project);
			}
			await expect(client.deploy.get('nonexistent-project', TEAM)).rejects.toThrow();
		},
		TEST_CONFIG.timeout
	);

	// ── state: enable / disable / soft remove ──────────────────────────────────

	it(
		'disable and enable flip the state',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				expect((await client.deploy.disable(project, TEAM)).state).toBe('disabled');
				expect((await client.deploy.enable(project, TEAM)).state).toBe('enabled');
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'remove is soft: hidden from list, history survives',
		async () => {
			const project = freshProject();
			await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
			const dep = await client.deploy.remove(project, TEAM);
			expect(dep.state).toBe('removed');

			const body = await client.deploy.list();
			expect(body.rows.some((d) => d.projectId === project)).toBe(false);

			const history = await client.deploy.history(project);
			expect(history.rows.map((h) => h.action)).toContain('remove');
		},
		TEST_CONFIG.timeout
	);

	// ── schedules + the single evaluator ───────────────────────────────────────

	it(
		'setSchedule sets and clears a per-source schedule',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });

				let dep = await client.deploy.setSchedule(project, 'webhook_1', '0 * * * *', TEAM);
				expect(dep.schedules?.webhook_1?.cron).toBe('0 * * * *');
				expect(dep.schedules?.webhook_1?.paused).toBe(false);

				// null clears the schedule row entirely.
				dep = await client.deploy.setSchedule(project, 'webhook_1', null, TEAM);
				expect(dep.schedules?.webhook_1).toBeUndefined();
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'pauseSchedule/resumeSchedule flip one schedule, preserving cron/ttl',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				await client.deploy.setSchedule(project, 'webhook_1', '0 * * * *', TEAM, { ttl: 600 });

				// Pause keeps cron/ttl; a cron edit must not unpause it.
				let dep = await client.deploy.pauseSchedule(project, 'webhook_1', TEAM);
				expect(dep.schedules?.webhook_1?.paused).toBe(true);
				expect(dep.schedules?.webhook_1?.cron).toBe('0 * * * *');
				expect(dep.schedules?.webhook_1?.ttl).toBe(600);
				dep = await client.deploy.setSchedule(project, 'webhook_1', '30 * * * *', TEAM);
				expect(dep.schedules?.webhook_1?.paused).toBe(true);

				dep = await client.deploy.resumeSchedule(project, 'webhook_1', TEAM);
				expect(dep.schedules?.webhook_1?.paused).toBe(false);

				// Pausing a source with no schedule is an explicit error.
				await expect(client.deploy.pauseSchedule(project, 'ghost_1', TEAM)).rejects.toThrow();
			} finally {
				await cleanup(project);
			}
		},
		TEST_CONFIG.timeout
	);

	it(
		'invalid cron is rejected by setSchedule and reported by preview',
		async () => {
			const project = freshProject();
			try {
				await client.deploy.add({ pipeline: makePipeline(project), deployTo: TEAM });
				await expect(client.deploy.setSchedule(project, 'webhook_1', 'not-a-cron', TEAM)).rejects.toThrow();
			} finally {
				await cleanup(project);
			}

			const ok = await client.deploy.preview('*/15 * * * *', 3);
			expect(ok.valid).toBe(true);
			expect(ok.next?.length).toBe(3);

			const bad = await client.deploy.preview('not-a-cron');
			expect(bad.valid).toBe(false);
			expect(bad.error).toBeTruthy();
		},
		TEST_CONFIG.timeout
	);
});
