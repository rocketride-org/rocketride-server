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
// CONNECTION STATUS — the word each sidebar row carries
// =============================================================================
//
// Read from what the realm that holds the engine core already knows, so
// nothing is asked of the engine and nothing is published for it:
//
//   discovery      the endpoint store's endpoints (refreshed on task events,
//                  focus and reconnects). A connection's endpoint is the one
//                  whose `legacyKey` is the connection's key, exactly as
//                  opening it finds it (sqlCore.ts resolution).
//   open failures  the last failure opening each connection, until it next
//                  opens (sqlCore.ts `resolve`).
//
// The words: a pipeline connection is Running or Stopped; a direct one is
// Direct, or Open while its temporary pipeline runs; either is Unreachable
// after an open failure, or while its node does not answer, and No access
// while it runs but the signed-in role may not call it. Before the first
// discovery has finished the row says nothing rather than guess.
// =============================================================================

import type { IExplorerEndpoint } from 'shared/explorer/types';
import { endpointKeyForConnection } from './connect';
import type { SavedSqlConnection } from './connect';

/** What a row can say. */
export type ConnectionStatusKind = 'running' | 'stopped' | 'direct' | 'open' | 'unreachable' | 'noaccess' | 'unknown';

/** One row's status. */
export interface ConnectionStatus {
	/** Which. */
	kind: ConnectionStatusKind;
	/** The word on the row ('' when there is nothing to say yet). */
	label: string;
	/** One sentence saying why (the row's tooltip). */
	detail: string;
}

/** A discovered endpoint, as far as status reads it. */
export type DiscoveredStatus = Pick<IExplorerEndpoint, 'legacyKey' | 'state'> & Partial<Pick<IExplorerEndpoint, 'stateDetail'>>;

/** What every row's status is made from (the sidebar bridge's `subscribeStatus`). */
export interface ConnectionStatusSource {
	/** The discovered endpoints, or null until the first discovery has finished. */
	discovered: ReadonlyArray<DiscoveredStatus> | null;
	/** The last failure opening each connection (by id), until it next opens. */
	openErrors: Readonly<Record<string, string>>;
}

/** Endpoint states that mean the run is up. */
const LIVE: ReadonlyArray<DiscoveredStatus['state']> = ['ready', 'probing'];

/** Endpoint states that mean the run is up but its node does not answer. */
const TROUBLED: ReadonlyArray<DiscoveredStatus['state']> = ['unreachable', 'inaccessible'];

/** What the store's `inaccessible` means: running, but this role may not call it (shared/explorer/types.ts). */
const NO_ACCESS_DETAIL = 'The pipeline is running, but your role may not call its database node.';

/** A direct connection whose temporary pipeline is not running. */
const DIRECT: ConnectionStatus = { kind: 'direct', label: 'Direct', detail: 'Opening it starts a temporary pipeline holding just this database node.' };

/**
 * The status of one saved connection.
 *
 * @param conn - The saved connection.
 * @param discovered - The discovered endpoints, or null before the first discovery finished.
 * @param openErrors - The last failure opening each connection, by id.
 * @returns What its row says.
 */
export function connectionStatus(conn: SavedSqlConnection, discovered: ReadonlyArray<DiscoveredStatus> | null, openErrors: Readonly<Record<string, string>>): ConnectionStatus {
	const failure = openErrors[conn.id];
	if (failure !== undefined) return { kind: 'unreachable', label: 'Unreachable', detail: failure };
	if (discovered === null) return conn.mode === 'direct' ? DIRECT : { kind: 'unknown', label: '', detail: '' };
	const key = endpointKeyForConnection(conn);
	const runs = discovered.filter((endpoint) => endpoint.legacyKey === key);
	if (runs.some((endpoint) => LIVE.includes(endpoint.state))) {
		return conn.mode === 'direct'
			? { kind: 'open', label: 'Open', detail: 'Its temporary pipeline is running.' }
			: { kind: 'running', label: 'Running', detail: `The pipeline '${conn.pipelineName}' is running.` };
	}
	const troubled = runs.find((endpoint) => TROUBLED.includes(endpoint.state));
	if (troubled?.state === 'inaccessible') return { kind: 'noaccess', label: 'No access', detail: troubled.stateDetail ?? NO_ACCESS_DETAIL };
	if (troubled) return { kind: 'unreachable', label: 'Unreachable', detail: troubled.stateDetail ?? 'The pipeline is running, but its database node did not answer.' };
	return conn.mode === 'direct'
		? DIRECT
		: { kind: 'stopped', label: 'Stopped', detail: `The pipeline '${conn.pipelineName}' is not running in your workspace.` };
}
