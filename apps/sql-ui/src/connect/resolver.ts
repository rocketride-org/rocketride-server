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
// CONNECT — RESOLVER (saved connection → endpoint description)
// =============================================================================
//
// The PURE half of resolution: what a saved connection's endpoint is called
// and looks like, and the temporary pipeline a direct connection runs as. The
// half that talks to the server (starting that pipeline, finding the running
// endpoint, stopping it again) lives in the engine core (sqlCore.ts), where
// the endpoint store is.
//
//  - 'pipeline': the stored (projectId, source, nodeId) of a database node in
//    one of the user's pipelines. It is found among the discovered endpoints
//    by the store's `legacyKey`, which is exactly `projectId:source:nodeId`
//    for the caller's OWN development run and null for anything else.
//  - 'direct': a REAL two-component pipeline started with `client.use`: a
//    `tools` endpoint source (the webhook-family invoke host — no data lane,
//    it keeps the task alive for direct tool calls) with the database node
//    attached through the control-plane invoke channel. `useExisting`
//    reattaches within the TTL instead of spawning a second task, and the
//    standard 15-minute idle TTL reaps it. It is found the same way, by the
//    legacyKey `sqlconn-<id>:tools_1:<provider>_1`.
// =============================================================================

import type { SqlEndpoint } from './types';
import type { DirectConnection, SavedSqlConnection } from './savedConnections';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Idle time-to-live for direct-mode temp pipelines (the standard default). */
export const DIRECT_TTL_SECONDS = 15 * 60;

/** The invoke-host endpoint service (webhook family, `tools://`). */
const TOOLS_PROVIDER = 'tools';

/** The tools source COMPONENT id inside a direct temp pipeline — also the
 *  `source` the task is addressed by (getTaskToken / endpoint keys). */
export const TOOLS_SOURCE_ID = 'tools_1';

/** Prefix of direct-mode project ids (colon-free: endpoint keys split on ':'). */
const DIRECT_PROJECT_PREFIX = 'sqlconn-';

// =============================================================================
// KEYS
// =============================================================================

/**
 * The temp pipeline's project id for one direct connection.
 *
 * @param conn - The direct connection.
 * @returns `sqlconn-<id>`.
 */
export function directProjectId(conn: Pick<DirectConnection, 'id'>): string {
	return `${DIRECT_PROJECT_PREFIX}${conn.id}`;
}

/** The single database component's id inside a direct temp pipeline. */
function directNodeId(conn: DirectConnection): string {
	return `${conn.provider}_1`;
}

/**
 * The endpoint key a saved connection resolves to — DETERMINISTIC, no server
 * round trip, so the sidebar can match rows against the active document
 * without resolving anything. It is also the store's `legacyKey` of the
 * endpoint it resolves to, and the key its history is kept under.
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

/**
 * The saved connection id a direct endpoint key belongs to.
 *
 * @param key - An endpoint key.
 * @returns The connection id, or null for a key that is not a direct one.
 */
export function connIdFromDirectKey(key: string): string | null {
	if (!isDirectEndpointKey(key)) return null;
	const projectId = key.split(':')[0] ?? '';
	const id = projectId.slice(DIRECT_PROJECT_PREFIX.length);
	return id === '' ? null : id;
}

// =============================================================================
// DESCRIPTIONS
// =============================================================================

/**
 * The endpoint a saved connection maps to — a PURE mapping (no server round
 * trip), so any mount can compute it for highlights, schema reads, and keys.
 * It carries the connection id, which is how every engine call names it. For
 * a direct connection the endpoint is only USABLE while its temp pipeline
 * runs (see sqlCore.ts).
 *
 * @param conn - The saved connection.
 * @returns The endpoint description (token-free, JSON-safe).
 */
export function endpointForConnection(conn: SavedSqlConnection): SqlEndpoint {
	if (conn.mode === 'pipeline') {
		return {
			key: endpointKeyForConnection(conn),
			connId: conn.id,
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
		connId: conn.id,
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
 * The `client.use` options that start (or reattach to) a direct connection's
 * temp tool pipeline.
 *
 * @param conn - The direct connection.
 * @returns The options.
 */
export function directUseOptions(conn: DirectConnection): Record<string, unknown> {
	const nodeId = directNodeId(conn);
	return {
		pipeline: {
			project_id: directProjectId(conn),
			source: TOOLS_SOURCE_ID,
			components: [
				{ id: TOOLS_SOURCE_ID, provider: TOOLS_PROVIDER, config: {} },
				{ id: nodeId, provider: conn.provider, config: conn.config, control: [{ classType: 'tool', from: TOOLS_SOURCE_ID }] },
			],
		},
		useExisting: true,
		ttl: DIRECT_TTL_SECONDS,
		name: `SQL: ${conn.name}`,
	};
}
