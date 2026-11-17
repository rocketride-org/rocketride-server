// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================
// RESOLVER — saved connection -> endpoint (plan 3.6)
//
// A PIPELINE-BOUND connection already is its endpoint: the address and the
// node it saved. A DIRECT connection has no pipe of its own, so this module
// starts one for it — a two-node spec (a `tools` source hosting the
// configured database node) through `client.use()`, which answers the
// address the caller's @dev control took. That address is what every tool
// call on the direct endpoint is made on; it is remembered per endpoint key
// along with the start procedure (revival) and a holder count, so the temp
// pipeline is torn down when its last document closes and revived if its
// idle ttl ended it between two statements.
// =============================================================================

import type { RocketRideClient } from 'rocketride';
import type { SqlEndpoint } from './types';
import type { DirectConnection, SavedSqlConnection } from './savedConnections';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Idle ttl of a direct connection's temp pipeline (seconds). */
const DIRECT_TTL_SECONDS = 15 * 60;
/** The source that hosts tool nodes without moving data. */
const TOOLS_PROVIDER = 'tools';
/** The source component id of a direct connection's temp pipeline. */
const TOOLS_SOURCE_ID = 'tools_1';
/** Project-id prefix of the temp pipelines (also what discovery skips). */
const DIRECT_PROJECT_PREFIX = 'sqlconn-';

// =============================================================================
// KEYS
// =============================================================================

/**
 * The temp pipeline's project id for a direct connection.
 *
 * @param conn - The direct connection.
 * @returns `sqlconn-<id>`.
 */
function directProjectId(conn: DirectConnection): string {
	return `${DIRECT_PROJECT_PREFIX}${conn.id}`;
}

/**
 * The database node id inside a direct connection's temp pipeline.
 *
 * @param conn - The direct connection.
 * @returns `<provider>_1`.
 */
function directNodeId(conn: DirectConnection): string {
	return `${conn.provider}_1`;
}

/**
 * The endpoint key a saved connection resolves to — derivable BEFORE anything
 * starts, so documents and history can be keyed by it.
 *
 * @param conn - The saved connection.
 * @returns `${address}:${nodeId}` for a pipeline-bound connection,
 *          `sqlconn-<id>:<provider>_1` for a direct one.
 */
export function endpointKeyForConnection(conn: SavedSqlConnection): string {
	if (conn.mode === 'pipeline') return `${conn.address}:${conn.nodeId}`;
	return `${directProjectId(conn)}:${directNodeId(conn)}`;
}

/**
 * Whether an endpoint key names a direct connection's temp pipeline.
 *
 * @param key - An endpoint key.
 * @returns True for a direct connection.
 */
export function isDirectEndpointKey(key: string): boolean {
	return key.startsWith(DIRECT_PROJECT_PREFIX);
}

// =============================================================================
// DIRECT CONNECTION STATE (per realm)
// =============================================================================

/** Direct endpoint key -> the address its temp pipeline answers on. */
const addresses = new Map<string, string>();
/** Direct endpoint key -> how to start the temp pipeline again. */
const revivals = new Map<string, () => Promise<void>>();
/** Direct endpoint key -> open documents holding it. */
const holders = new Map<string, number>();

/**
 * The revival procedure of a direct endpoint, when one is registered.
 *
 * @param key - The endpoint key.
 * @returns The start procedure, or undefined for a pipeline-bound endpoint.
 */
export function revivalFor(key: string): (() => Promise<void>) | undefined {
	return revivals.get(key);
}

// =============================================================================
// RESOLUTION
// =============================================================================

/**
 * The endpoint of a saved connection, without starting anything.
 *
 * @param conn - The saved connection.
 * @returns The endpoint; a direct connection's `address` is the one its
 *          temp pipeline last answered on, or '' before it was started.
 */
export function endpointForConnection(conn: SavedSqlConnection): SqlEndpoint {
	if (conn.mode === 'pipeline') {
		return {
			key: endpointKeyForConnection(conn),
			address: conn.address,
			pipelineName: conn.pipelineName,
			nodeId: conn.nodeId,
			nodeName: conn.name,
			...(conn.provider ? { provider: conn.provider } : {}),
		};
	}
	const key = endpointKeyForConnection(conn);
	return {
		key,
		address: addresses.get(key) ?? '',
		pipelineName: `SQL: ${conn.name}`,
		nodeId: directNodeId(conn),
		nodeName: conn.name,
		provider: conn.provider,
	};
}

/**
 * Resolve a saved connection to a usable endpoint. A direct connection's
 * temp pipeline is started here (or re-attached with `useExisting`), and
 * the address it answers on becomes the endpoint's address.
 *
 * @param client - The realm's client.
 * @param conn - The saved connection.
 * @returns The endpoint.
 * @throws When the temp pipeline cannot start.
 */
export async function resolveEndpoint(client: RocketRideClient, conn: SavedSqlConnection): Promise<SqlEndpoint> {
	if (conn.mode === 'pipeline') {
		return endpointForConnection(conn);
	}
	const key = endpointKeyForConnection(conn);
	const projectId = directProjectId(conn);
	const nodeId = directNodeId(conn);
	const start = async (): Promise<void> => {
		const started = await client.use({
			pipeline: {
				project_id: projectId,
				source: TOOLS_SOURCE_ID,
				components: [
					{ id: TOOLS_SOURCE_ID, provider: TOOLS_PROVIDER, config: {} },
					{ id: nodeId, provider: conn.provider, config: conn.config, control: [{ classType: 'tool', from: TOOLS_SOURCE_ID }] },
				],
			},
			useExisting: true,
			ttl: DIRECT_TTL_SECONDS,
			name: `SQL: ${conn.name}`,
		});
		// The token slot carries the address the control took
		addresses.set(key, started.token);
	};
	await start();
	revivals.set(key, start);
	holders.set(key, (holders.get(key) ?? 0) + 1);
	return endpointForConnection(conn);
}

/**
 * Release one holder of a direct endpoint; the last one terminates its temp
 * pipeline. Pipeline-bound endpoints have nothing to release.
 *
 * @param client - The realm's client.
 * @param endpointKey - The endpoint key.
 */
export async function releaseDirectEndpoint(client: RocketRideClient, endpointKey: string): Promise<void> {
	if (!isDirectEndpointKey(endpointKey)) return;
	const remaining = (holders.get(endpointKey) ?? 1) - 1;
	if (remaining > 0) {
		holders.set(endpointKey, remaining);
		return;
	}
	holders.delete(endpointKey);
	revivals.delete(endpointKey);
	const address = addresses.get(endpointKey);
	addresses.delete(endpointKey);
	if (!address) return;
	try {
		await client.terminate(address);
	} catch (err) {
		console.log('[sql-ui] releaseDirectEndpoint failed', endpointKey, err);
	}
}
