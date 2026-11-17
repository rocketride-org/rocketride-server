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
// DISCOVERY — database nodes by pipe address and node id (plan 3.6)
//
// A connection needs two facts: the ADDRESS to call and the NODE to call on
// it. Both come from the server's `interfaces(address)` — the publication (or
// the caller's own dev run) that answers that address, projected through the
// node catalog's classType words. Nothing is read from running tasks'
// specs, no provider list lives here, and a pipe nobody has used recently
// is found exactly like a busy one: the first statement starts its engine.
//
// Two entry points:
//   - describeSqlAddress(client, address)  one address, typed or linked
//   - discoverSqlEndpoints(client)         every address the caller's own
//     controls currently name (the task list), as a convenience list until
//     the publication picker lands (plan C.16c)
// =============================================================================

import type { RocketRideClient } from 'rocketride';
import type { SqlEndpoint } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The catalog classType that marks a node with the shared database tool
 * surface (execute / get_schema / refresh_schema / dialect). Whether a node
 * under it really answers those tools is learned on connect, by `dialect`.
 */
export const DATABASE_CLASS_TYPE = 'database';

/** Project ids of sql-ui's own direct connections, which discovery never lists. */
const DIRECT_PROJECT_PREFIX = 'sqlconn-';

// =============================================================================
// TYPES
// =============================================================================

/** The subset of a task row discovery reads (loose adapter result). */
interface TaskRow {
	/** The control's address, when the server reports one. */
	address?: string;
	/** Project id — used only to skip sql-ui's own direct connections. */
	projectId?: string;
	/** Task display name. */
	name?: string;
	/** Completion flag. */
	completed?: boolean;
	/** Task state (>= 4 is stopping / finished). */
	state?: number;
}

/** The subset of the `interfaces()` answer discovery reads. */
interface InterfacesAnswer {
	/** address -> classType -> nodes */
	interfaces?: Record<string, Record<string, { nodeId: string; name: string }[]>>;
}

/** The `interfaces` verb, as discovery needs it (keeps the client loosely typed). */
type InterfacesClient = Pick<RocketRideClient, 'interfaces'>;

// =============================================================================
// ONE ADDRESS
// =============================================================================

/**
 * The pipe id of an address: the second dot-free segment.
 *
 * @param address - `developerId.pipelineId[.source]`.
 * @returns The pipe id, or the whole string when it does not parse.
 */
function pipeIdOf(address: string): string {
	const parts = address.split('.');
	return parts.length >= 2 ? parts[1]! : address;
}

/**
 * The database nodes the pipe at `address` offers, as endpoints.
 *
 * Every entry under the `database` classType of every address in the
 * answer becomes one endpoint: the source addresses carry nodes reachable
 * through that source, the pipe address carries the rest. Each endpoint's
 * `address` is the key it sat under, so a tool call lands on the right
 * control.
 *
 * @param client - A connected client (only `interfaces` is used).
 * @param address - The address to describe.
 * @param pipelineName - Display name to stamp on the endpoints; defaults to the pipe id.
 * @returns The endpoints, in the server's order; empty when the pipe has no database node.
 * @throws When the address resolves to nothing the caller may use (the server's error).
 */
export async function describeSqlAddress(client: InterfacesClient, address: string, pipelineName?: string): Promise<SqlEndpoint[]> {
	const answer = (await client.interfaces(address)) as InterfacesAnswer;
	const label = pipelineName ?? pipeIdOf(address);
	const endpoints: SqlEndpoint[] = [];
	for (const [pipeAddress, byClass] of Object.entries(answer.interfaces ?? {})) {
		for (const node of byClass[DATABASE_CLASS_TYPE] ?? []) {
			if (!node?.nodeId) continue;
			endpoints.push({
				key: `${pipeAddress}:${node.nodeId}`,
				address: pipeAddress,
				pipelineName: label,
				nodeId: node.nodeId,
				nodeName: node.name || node.nodeId,
			});
		}
	}
	return endpoints;
}

// =============================================================================
// THE CALLER'S CURRENT ADDRESSES
// =============================================================================

/**
 * Discover every database node reachable through the addresses the caller's
 * controls currently name. Tasks that fail to describe are skipped (a run can
 * end between listing and describing) — discovery never throws for a single
 * bad address, only for the initial task listing itself.
 *
 * @param client - The shell's RocketRide client.
 * @returns Endpoints sorted by pipeline name, then node id.
 */
export async function discoverSqlEndpoints(client: RocketRideClient): Promise<SqlEndpoint[]> {
	// Step 1: the addresses the caller can see, each once, with a display name
	const tasks = await client.listTasks({ page_size: 100 });
	const rows = (tasks.rows ?? []) as TaskRow[];
	const names = new Map<string, string>();
	for (const row of rows) {
		if (!row.address) continue;
		if (row.projectId && row.projectId.startsWith(DIRECT_PROJECT_PREFIX)) continue;
		if (row.completed || (row.state ?? 0) >= 4) continue;
		if (!names.has(row.address)) names.set(row.address, row.name ?? pipeIdOf(row.address));
	}

	// Step 2: describe each address; one failure never hides the others
	const seen = new Set<string>();
	const endpoints: SqlEndpoint[] = [];
	for (const [address, name] of names) {
		try {
			for (const endpoint of await describeSqlAddress(client, address, name)) {
				if (seen.has(endpoint.key)) continue;
				seen.add(endpoint.key);
				endpoints.push(endpoint);
			}
		} catch (err) {
			console.log('[sql-ui] discovery skipped address', address, err);
		}
	}

	// Step 3: stable ordering for the landing grid
	endpoints.sort((a, b) => a.pipelineName.localeCompare(b.pipelineName) || a.nodeId.localeCompare(b.nodeId));
	return endpoints;
}
