// =============================================================================
// MIT License
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
// CONNECT — RESOLVER (saved connection → live endpoint)
// =============================================================================
//
// Attach-mechanics live here on purpose (see types.ts). Both connection modes
// resolve to the same SqlEndpoint the session layer already speaks:
//
//  - 'pipeline': a pure mapping onto the stored (projectId, source, nodeId) —
//    the session resolves the running task's token as it always has.
//  - 'direct': materialises a REAL two-component pipeline over `client.use`:
//    a `tools` endpoint source (the webhook-family invoke host — no data
//    lane, it keeps the task alive for direct tool calls) with the database
//    node attached through the control-plane invoke channel. `useExisting`
//    reattaches within the TTL instead of spawning a second task, and the
//    standard 15-minute idle TTL reaps it. The session then resolves its
//    token by (projectId='sqlconn-<id>', source='tools_1') exactly like any
//    other endpoint.
//
// The TTL means a direct task can idle out mid-session; resolveEndpoint
// registers a REVIVAL for its key, and the session consults it when token
// resolution comes up empty (one re-`use`, then one retry).
// =============================================================================

import type { SqlWireClient } from './busClient';
import type { SqlEndpoint } from './types';
import type { DirectConnection, SavedSqlConnection } from './savedConnections';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Idle time-to-live for direct-mode temp pipelines (the standard default). */
const DIRECT_TTL_SECONDS = 15 * 60;

/** The invoke-host endpoint service (webhook family, `tools://`). */
const TOOLS_PROVIDER = 'tools';

/** The tools source COMPONENT id inside a direct temp pipeline — also the
 *  `source` the task is addressed by (getTaskToken / endpoint keys). */
const TOOLS_SOURCE_ID = 'tools_1';

/** Prefix of direct-mode project ids (colon-free: endpoint keys split on ':'). */
const DIRECT_PROJECT_PREFIX = 'sqlconn-';

// =============================================================================
// KEYS
// =============================================================================

/** The temp pipeline's project id for one direct connection. */
function directProjectId(conn: DirectConnection): string {
	return `${DIRECT_PROJECT_PREFIX}${conn.id}`;
}

/** The single database component's id inside a direct temp pipeline. */
function directNodeId(conn: DirectConnection): string {
	return `${conn.provider}_1`;
}

/**
 * The endpoint key a saved connection resolves to — DETERMINISTIC, no server
 * round trip, so the sidebar can match rows against the active document
 * without resolving anything.
 *
 * @param conn - The saved connection.
 * @returns The endpoint key.
 */
export function endpointKeyForConnection(conn: SavedSqlConnection): string {
	if (conn.mode === 'pipeline') return `${conn.projectId}:${conn.source}:${conn.nodeId}`;
	return `${directProjectId(conn)}:${TOOLS_SOURCE_ID}:${directNodeId(conn)}`;
}

/**
 * Whether an endpoint key names a direct-mode temp pipeline.
 *
 * @param key - An endpoint key.
 * @returns True for direct-mode keys.
 */
export function isDirectEndpointKey(key: string): boolean {
	return key.startsWith(DIRECT_PROJECT_PREFIX);
}

// =============================================================================
// REVIVAL REGISTRY — direct tasks idle out; sessions revive them on demand
// =============================================================================

const revivals = new Map<string, () => Promise<void>>();

/**
 * The revival for an endpoint key, when one is registered (direct endpoints
 * only). The session layer calls it when token resolution finds no task.
 *
 * @param key - The endpoint key.
 * @returns The revival function, or undefined.
 */
export function revivalFor(key: string): (() => Promise<void>) | undefined {
	return revivals.get(key);
}

// =============================================================================
// RESOLVE / RELEASE
// =============================================================================

/**
 * The endpoint a saved connection maps to — a PURE mapping (no server round
 * trip), so any mount can compute it for highlights, schema reads, and keys.
 * For a direct connection the endpoint is only USABLE while its temp
 * pipeline runs (see {@link resolveEndpoint}).
 *
 * @param conn - The saved connection.
 * @returns The endpoint shape.
 */
export function endpointForConnection(conn: SavedSqlConnection): SqlEndpoint {
	if (conn.mode === 'pipeline') {
		return {
			key: endpointKeyForConnection(conn),
			projectId: conn.projectId,
			pipelineName: conn.pipelineName,
			source: conn.source,
			nodeId: conn.nodeId,
			nodeName: conn.name,
			provider: conn.provider,
			running: true,
		};
	}
	return {
		key: endpointKeyForConnection(conn),
		projectId: directProjectId(conn),
		pipelineName: `SQL: ${conn.name}`,
		source: TOOLS_SOURCE_ID,
		nodeId: directNodeId(conn),
		nodeName: conn.name,
		provider: conn.provider,
		running: true,
	};
}

/**
 * Resolves a saved connection to a live endpoint. Direct mode starts (or
 * reattaches to) the connection's temp tool pipeline; pipeline mode is a pure
 * mapping and never touches the server.
 *
 * @param client - The shell's RocketRide client.
 * @param conn - The saved connection.
 * @returns The endpoint to open documents against.
 */
export async function resolveEndpoint(client: SqlWireClient, conn: SavedSqlConnection): Promise<SqlEndpoint> {
	if (conn.mode === 'pipeline') {
		return endpointForConnection(conn);
	}

	// Direct: a real two-component pipeline — the `tools` invoke host as the
	// source, the database node attached through the control-plane invoke
	// channel (the same wiring a tool uses to attach to an agent).
	// useExisting reattaches within the TTL instead of spawning a second task.
	const projectId = directProjectId(conn);
	const nodeId = directNodeId(conn);
	const start = async (): Promise<void> => {
		await client.use({
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
	};
	await start();

	const endpoint = endpointForConnection(conn);
	// The idle TTL can reap the task mid-session: register the re-`use` so
	// the session can revive it when token resolution comes up empty.
	revivals.set(endpoint.key, start);

	return endpoint;
}

/**
 * Stops a direct connection's temp pipeline (best effort) and drops its
 * revival — called when the connection's last document closes, and before
 * deleting a direct connection. A no-op for non-direct keys.
 *
 * @param client - The shell's RocketRide client.
 * @param endpointKey - The endpoint key whose temp pipeline to stop.
 */
export async function releaseDirectEndpoint(client: SqlWireClient, endpointKey: string): Promise<void> {
	if (!isDirectEndpointKey(endpointKey)) return;
	revivals.delete(endpointKey);
	// Key shape `${projectId}:tools_1:${nodeId}` with a colon-free project id.
	const projectId = endpointKey.split(':')[0];
	if (!projectId) return;
	try {
		const token = await client.getTaskToken({ projectId, source: TOOLS_SOURCE_ID });
		if (token) await client.terminate(token);
	} catch (err) {
		// Best effort: the TTL reaps whatever a failed terminate leaves behind.
		console.log('[sql-ui] releaseDirectEndpoint failed', endpointKey, err);
	}
}
