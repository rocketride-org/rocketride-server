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
 * End-to-end smoke test for `client.database.sequelize()` against a live engine
 * with a real Postgres database node.
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
 *   ROCKETRIDE_E2E=1 ./builder client-typescript:test --jest='sequelize-e2e.test.ts'
 *
 * Two scenarios are verified:
 *  1. Rollback — two INSERTs inside a transaction that throws: NEITHER row persists.
 *  2. Commit  — two INSERTs inside a committed transaction: BOTH rows persist.
 */

import { RocketRideClient } from '../src/client';
import { Sequelize, DataTypes, Transaction } from 'sequelize';
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
const TEST_TABLE = 'rr_sequelize_e2e_tx_smoke';

/** Node ID for the db_postgres node in the pipeline below. */
const DB_NODE_ID = 'db_postgres_1';

/** Pipeline token used throughout this suite. */
const E2E_TOKEN = 'TS-SQ-E2E';

// ---------------------------------------------------------------------------
// Pipeline definition — minimal webhook → db_postgres → response
// ---------------------------------------------------------------------------

function getPostgresPipeline(projectId = 'a1b2c3d4-seq-e2e-0000-000000000001') {
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

(RUN ? describe : describe.skip)('sequelize live e2e', () => {
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

	// -----------------------------------------------------------------------
	// Scenario 1: rollback — neither row must persist
	// -----------------------------------------------------------------------

	it(
		'rollback: neither row persists after forced rollback',
		async () => {
			const sq = client.database.sequelize({ Sequelize, token: pipelineToken, nodeId: DB_NODE_ID });
			try {
				interface Row {
					id: number;
					label: string;
				}
				const M = sq.define<import('sequelize').Model<Row, Omit<Row, 'id'>>>(
					'RrE2eRow',
					{
						id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
						label: DataTypes.TEXT,
					},
					{ tableName: TEST_TABLE, timestamps: false }
				);

				// Snapshot count before any writes.
				const beforeCount = await M.count();

				// Open a transaction, insert two rows, then force a rollback.
				let txError: Error | null = null;
				try {
					await sq.transaction(async (t: Transaction) => {
						await M.create({ label: 'row-rollback-1' } as Omit<Row, 'id'>, { transaction: t });
						await M.create({ label: 'row-rollback-2' } as Omit<Row, 'id'>, { transaction: t });
						throw new Error('force rollback');
					});
				} catch (err) {
					txError = err as Error;
				}

				expect(txError).not.toBeNull();
				expect(txError!.message).toBe('force rollback');

				// Neither row must be visible via a stateless query.
				const afterCount = await M.count();
				expect(afterCount).toBe(beforeCount);
			} finally {
				// Release the RocketRide session/connection even if an assertion throws.
				await sq.close();
			}
		},
		TEST_CONFIG.timeout
	);

	// -----------------------------------------------------------------------
	// Scenario 2: commit — both rows must persist
	// -----------------------------------------------------------------------

	it(
		'commit: both rows persist after committed transaction',
		async () => {
			const sq = client.database.sequelize({ Sequelize, token: pipelineToken, nodeId: DB_NODE_ID });
			try {
				interface Row {
					id: number;
					label: string;
				}
				const M = sq.define<import('sequelize').Model<Row, Omit<Row, 'id'>>>(
					'RrE2eRow',
					{
						id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
						label: DataTypes.TEXT,
					},
					{ tableName: TEST_TABLE, timestamps: false }
				);

				const beforeCount = await M.count();

				// Commit a transaction containing two rows.
				await sq.transaction(async (t: Transaction) => {
					await M.create({ label: 'row-commit-1' } as Omit<Row, 'id'>, { transaction: t });
					await M.create({ label: 'row-commit-2' } as Omit<Row, 'id'>, { transaction: t });
				});

				// Both rows must now be visible.
				const afterCount = await M.count();
				expect(afterCount).toBe(beforeCount + 2);

				// Verify the exact labels persisted.
				const rows = await M.findAll({ where: { label: ['row-commit-1', 'row-commit-2'] }, order: [['label', 'ASC']] });
				expect(rows).toHaveLength(2);
				expect((rows[0] as unknown as Row).label).toBe('row-commit-1');
				expect((rows[1] as unknown as Row).label).toBe('row-commit-2');
			} finally {
				// Release the RocketRide session/connection even if an assertion throws.
				await sq.close();
			}
		},
		TEST_CONFIG.timeout
	);
});
