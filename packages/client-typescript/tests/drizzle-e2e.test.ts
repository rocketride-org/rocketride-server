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
 * End-to-end smoke test for `rocketride/drizzle` against a live engine with a
 * real Postgres database node.
 *
 * Gate: only runs when `ROCKETRIDE_E2E=1` is set in the environment.
 *
 * Required environment variables (when running with ROCKETRIDE_E2E=1):
 *   ROCKETRIDE_URI         - Engine WebSocket URI (default: http://localhost:5565)
 *   ROCKETRIDE_APIKEY      - Engine API key (default: MYAPIKEY)
 *   ROCKETRIDE_PG_HOST     - Postgres host (default: localhost)
 *   ROCKETRIDE_PG_PORT     - Postgres port (default: 5432)
 *   ROCKETRIDE_PG_USER     - Postgres username (default: postgres)
 *   ROCKETRIDE_PG_PASSWORD - Postgres password (default: '')
 *   ROCKETRIDE_PG_DATABASE - Postgres database name (default: postgres)
 *
 * Run command (requires live engine + Postgres):
 *   ROCKETRIDE_E2E=1 ./builder client-typescript:test --jest='drizzle-e2e.test.ts'
 *
 * Scenarios verified:
 *  1. Rollback — inserts inside a transaction that throws: NO row persists.
 *  2. Commit  — inserts inside a committed transaction: rows persist.
 *  3. Nested savepoint — inner transaction rolls back alone; outer commits.
 *  4. Serialization — dates/numerics survive the JSON transport.
 */

import { RocketRideClient } from '../src/client';
import { drizzle } from '../src/client/drizzle/index';
import { inArray, sql } from 'drizzle-orm';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// ---------------------------------------------------------------------------
// Gate: skip the entire suite unless ROCKETRIDE_E2E=1
// ---------------------------------------------------------------------------

const RUN = process.env.ROCKETRIDE_E2E === '1';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
	uri: process.env.ROCKETRIDE_URI || 'http://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'MYAPIKEY',
	timeout: 120000,
};

const PG_CONFIG = {
	host: process.env.ROCKETRIDE_PG_HOST || 'localhost',
	port: parseInt(process.env.ROCKETRIDE_PG_PORT || '5432', 10),
	user: process.env.ROCKETRIDE_PG_USER || 'postgres',
	password: process.env.ROCKETRIDE_PG_PASSWORD || '',
	database: process.env.ROCKETRIDE_PG_DATABASE || 'postgres',
};

/** Stable isolation table name — separate from other suites to avoid collisions. */
const TEST_TABLE = 'rr_drizzle_e2e_tx_smoke';

/** Node ID for the db_postgres node in the pipeline below. */
const DB_NODE_ID = 'db_postgres_1';

/** Pipeline token used throughout this suite. */
const E2E_TOKEN = 'TS-DZ-E2E';

/** Drizzle schema for the isolation table. */
const rows = pgTable(TEST_TABLE, {
	id: serial('id').primaryKey(),
	label: text('label').notNull(),
});

// ---------------------------------------------------------------------------
// Pipeline definition — minimal webhook → db_postgres → response
// ---------------------------------------------------------------------------

function getPostgresPipeline(projectId = 'a1b2c3d4-drz-e2e-0000-000000000001') {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: DB_NODE_ID,
				provider: 'db_postgres',
				config: {
					// The db_postgres node reads UNPREFIXED keys from a profile/default
					// block (see tests/db-execute/pipes/postgres-execute.pipe). A flat,
					// prefixed-only config leaves allow_execute + connection at defaults.
					profile: 'default',
					default: {
						host: PG_CONFIG.host,
						user: PG_CONFIG.user,
						password: PG_CONFIG.password,
						database: PG_CONFIG.database,
						table: TEST_TABLE,
						allow_execute: true,
						'postgresdb.host': PG_CONFIG.host,
						'postgresdb.user': PG_CONFIG.user,
						'postgresdb.password': PG_CONFIG.password,
						'postgresdb.database': PG_CONFIG.database,
						'postgresdb.table': TEST_TABLE,
						'postgresdb.allow_execute': true,
					},
				},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
		],
		source: 'webhook_1',
		project_id: projectId,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureCleanPipeline(client: RocketRideClient, token: string): Promise<void> {
	try {
		await client.terminate(token);
	} catch {
		// Ignore — pipeline may not be running
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

(RUN ? describe : describe.skip)('drizzle live e2e', () => {
	let client: RocketRideClient;
	let pipelineToken: string;

	beforeAll(async () => {
		client = new RocketRideClient({
			auth: TEST_CONFIG.auth,
			uri: TEST_CONFIG.uri,
		});

		await client.connect();
		await ensureCleanPipeline(client, E2E_TOKEN);

		const result = await client.use({
			pipeline: getPostgresPipeline(),
			token: E2E_TOKEN,
		});
		pipelineToken = result.token;

		// Ensure the isolation table exists and is empty before the suite runs.
		await client.database.query({
			token: pipelineToken,
			nodeId: DB_NODE_ID,
			sql: `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`,
		});
		await client.database.query({
			token: pipelineToken,
			nodeId: DB_NODE_ID,
			sql: `TRUNCATE ${TEST_TABLE}`,
		});
	}, TEST_CONFIG.timeout);

	afterAll(async () => {
		// Drop the isolation table and clean up the pipeline.
		try {
			await client.database.query({
				token: pipelineToken,
				nodeId: DB_NODE_ID,
				sql: `DROP TABLE IF EXISTS ${TEST_TABLE}`,
			});
		} catch {
			// Best-effort cleanup
		}
		await ensureCleanPipeline(client, E2E_TOKEN);
		if (client.isConnected()) {
			await Promise.race([client.disconnect(), new Promise<void>((resolve) => setTimeout(resolve, 10000))]);
		}
	}, TEST_CONFIG.timeout);

	it(
		'rollback: no row persists after forced rollback',
		async () => {
			const db = drizzle({ client: client.database, token: pipelineToken, nodeId: DB_NODE_ID });
			const before = (await db.select().from(rows)).length;

			let txError: Error | null = null;
			try {
				await db.transaction(async (tx) => {
					await tx.insert(rows).values({ label: 'row-rollback-1' });
					await tx.insert(rows).values({ label: 'row-rollback-2' });
					throw new Error('force rollback');
				});
			} catch (err) {
				txError = err as Error;
			}

			expect(txError).not.toBeNull();
			expect(txError!.message).toBe('force rollback');
			expect((await db.select().from(rows)).length).toBe(before);
		},
		TEST_CONFIG.timeout
	);

	it(
		'commit: both rows persist after committed transaction',
		async () => {
			const db = drizzle({ client: client.database, token: pipelineToken, nodeId: DB_NODE_ID });
			const before = (await db.select().from(rows)).length;

			await db.transaction(async (tx) => {
				await tx.insert(rows).values({ label: 'row-commit-1' });
				await tx.insert(rows).values({ label: 'row-commit-2' });
			});

			expect((await db.select().from(rows)).length).toBe(before + 2);

			const committed = await db
				.select()
				.from(rows)
				.where(inArray(rows.label, ['row-commit-1', 'row-commit-2']))
				.orderBy(rows.label);
			expect(committed).toHaveLength(2);
			expect(committed[0].label).toBe('row-commit-1');
			expect(committed[1].label).toBe('row-commit-2');
		},
		TEST_CONFIG.timeout
	);

	it(
		'nested savepoint: inner rolls back alone, outer commits',
		async () => {
			const db = drizzle({ client: client.database, token: pipelineToken, nodeId: DB_NODE_ID });

			await db.transaction(async (tx) => {
				await tx.insert(rows).values({ label: 'row-outer' });
				let innerError: Error | null = null;
				try {
					await tx.transaction(async (tx2) => {
						await tx2.insert(rows).values({ label: 'row-inner' });
						throw new Error('inner fails');
					});
				} catch (err) {
					innerError = err as Error;
				}
				expect(innerError!.message).toBe('inner fails');
			});

			const outer = await db.select().from(rows).where(inArray(rows.label, ['row-outer']));
			const inner = await db.select().from(rows).where(inArray(rows.label, ['row-inner']));
			expect(outer).toHaveLength(1);
			expect(inner).toHaveLength(0);
		},
		TEST_CONFIG.timeout
	);

	it(
		'serialization: dates and numerics survive the JSON transport',
		async () => {
			const db = drizzle({ client: client.database, token: pipelineToken, nodeId: DB_NODE_ID });
			const result = (await db.execute(sql`SELECT now() AS ts, 1.5::numeric AS num`)) as unknown as { rows: Array<Record<string, unknown>>; rowCount: number };
			expect(result.rows).toHaveLength(1);
			// _sanitize_value: datetimes arrive as ISO strings, numerics as floats.
			expect(typeof result.rows[0].ts).toBe('string');
			expect(Number(result.rows[0].num)).toBeCloseTo(1.5);
		},
		TEST_CONFIG.timeout
	);
});
