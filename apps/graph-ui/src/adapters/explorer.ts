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
// ADAPTER - THE ONE SEAM TO THE SHARED EXPLORER LIBRARY (pure, no shell values)
// =============================================================================
//
// Everything Graph Explorer takes from `shared/explorer` is created or named
// here, so a change to the library's surface touches one file. Nothing here is
// copied from SQL Explorer: the endpoint store, tool session, result checks and
// history are the shared ones, configured for graphs.
//
//   - Providers are the exact Cypher set {rocketride_graph, graph_neo4j,
//     graph_falkordb}, pinned by a test: Arango and HydraDB declare the `graph`
//     class but do not speak Cypher, and two provider ids differ from their
//     folder names, so the set is never derived from either.
//   - One `tools` role (SINGLE_TOOLS_ROLE): a graph connection is one tools source.
//   - Every tool has its OWN result check (failure arrives differently per tool):
//     read_query / execute raise on failure and are validated as row envelopes,
//     get_query returns {valid:false, error} for a failure but {valid:false,
//     answer} for a prose answer (not an error), get_schema / refresh_schema are
//     read through the schema model, never as "an empty graph".
//   - `read_query` and `refresh_schema` carry a capability: a node whose dialect
//     does not advertise it gets the kind `upgrade` WITHOUT anything being sent.
//     There is deliberately no fallback to `execute` (or FalkorDB's writable
//     `query`) for reads.
//   - Only `read_query`, `get_schema`, `refresh_schema`, `dialect` and `get_query`
//     are idempotent (a lost TASK_STOPPED may be retried once for them).
//     `execute` never is, so it is never replayed.
//   - History lives under graph.history / graph.historyRecording, persisted
//     text field `cypher`; SQL's keys and `sql` field are untouched. Tokens
//     never enter an entry: an entry holds only the statement text, timings,
//     counts, an outcome and the user's note. There is no pattern-check switch:
//     the write console always confirms what the text check flags.
//
// The stores are created once, at module level, and are per-app instances: the
// shared library holds no state of its own.
// =============================================================================

import {
	DEFAULT_TOOL_TIMEOUTS,
	SINGLE_TOOLS_ROLE,
	checkGetQuery,
	checkObject,
	checkRowEnvelope,
	createActiveKeyStore,
	createAnnouncer,
	createEndpointStore,
	createHistoryStore,
	createLiveRegion,
} from 'shared/explorer';
import type { IEndpointStore, IEndpointStoreOptions, IHistoryStore, IToolSpec } from 'shared/explorer';
import type { GraphDialect } from '../cypher/quote';
import { createDataVersions } from '../graph/dataVersion';
import type { IDataVersions } from '../graph/dataVersion';
import { createPreviewStore } from '../graph/previews';
import type { IPreviewStore } from '../graph/previews';
import { createSchemaStore } from '../graph/schemaStore';
import type { ISchemaStore } from '../graph/schemaStore';

// =============================================================================
// PROVIDERS, TOOLS
// =============================================================================

/** The node providers Graph Explorer opens. Exactly these three, pinned by a test. */
export const GRAPH_PROVIDERS: ReadonlySet<string> = new Set(['rocketride_graph', 'graph_neo4j', 'graph_falkordb']);

/** Tool names Graph Explorer calls. */
export const TOOL = {
	dialect: 'dialect',
	getSchema: 'get_schema',
	refreshSchema: 'refresh_schema',
	readQuery: 'read_query',
	execute: 'execute',
	getQuery: 'get_query',
} as const;

/**
 * Per-tool specs: idempotency, result check, budget and capability.
 *
 * A tool a node does not advertise is refused locally as `upgrade` and nothing is
 * sent. There is no fallback to another tool: not `execute`, and not FalkorDB's
 * writable `query`, for a read.
 *
 * @returns The table.
 */
export function makeGraphTools(): Readonly<Record<string, IToolSpec>> {
	return {
		[TOOL.dialect]: { idempotent: true, check: checkObject, timeoutMs: DEFAULT_TOOL_TIMEOUTS.dialect },
		[TOOL.getSchema]: { idempotent: true, check: checkObject, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_schema },
		[TOOL.refreshSchema]: { idempotent: true, check: checkObject, timeoutMs: DEFAULT_TOOL_TIMEOUTS.refresh_schema, capability: 'refresh_schema' },
		// The wait derives from the node's published statement deadline (+ pad), so the node's own error arrives first.
		[TOOL.readQuery]: { idempotent: true, check: checkRowEnvelope, capability: 'read_query' },
		// Writes: never idempotent, never replayed. Always called with shape 'graph', hence the same envelope.
		[TOOL.execute]: { idempotent: false, check: checkRowEnvelope, capability: 'execute_shape_graph' },
		// A question to the node's model: {query, valid:true} | {answer, valid:false} (prose) | {error, valid:false}.
		[TOOL.getQuery]: { idempotent: true, check: checkGetQuery, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_query },
	};
}

/** The tool table the app uses. */
export const GRAPH_TOOLS: Readonly<Record<string, IToolSpec>> = makeGraphTools();

// =============================================================================
// STORES (one per app, module level)
// =============================================================================

/**
 * Make a Graph Explorer endpoint store. The app uses one (below); tests make
 * their own with an injected clock.
 *
 * @param overrides - Options that replace the defaults (clock, concurrency, ...).
 * @returns The store.
 */
export function makeGraphEndpointStore(overrides: Partial<IEndpointStoreOptions> = {}): IEndpointStore {
	return createEndpointStore({ providers: GRAPH_PROVIDERS, roles: SINGLE_TOOLS_ROLE, tools: GRAPH_TOOLS, ...overrides });
}

/** Graph Explorer's endpoint store: one `tools` role, the three Cypher providers. */
export const graphEndpoints: IEndpointStore = makeGraphEndpointStore();

/**
 * Make a Graph history store (`graph.history`, text field `cypher`).
 *
 * @param persistDelayMs - Debounce before a write (tests shorten it).
 * @returns The store.
 */
export function makeGraphHistory(persistDelayMs?: number): IHistoryStore<'cypher'> {
	return createHistoryStore({ historyKey: 'graph.history', recordingKey: 'graph.historyRecording', textField: 'cypher', ...(persistDelayMs === undefined ? {} : { persistDelayMs }) });
}

/** Graph history: `graph.history` / `graph.historyRecording`, entry text field `cypher`. */
export const graphHistory: IHistoryStore<'cypher'> = makeGraphHistory();

/** Per-connection caption choices and similar view state live in their own bag. */
export const CAPTIONS_PREF_KEY = 'graph.captions';

/** Per-connection editor drafts. Text only, never a token or a result. */
export const DRAFTS_PREF_KEY = 'graph.drafts';

/** Per connection: has something that can change data run there? (drawn graphs go out of date) */
export const dataVersions: IDataVersions = createDataVersions();

/** The app's schema snapshots, one per connection. */
export const schemas: ISchemaStore = createSchemaStore();

/** The one announcement channel and its live region. */
export const announcer = createAnnouncer();
export const LiveRegion = createLiveRegion(announcer);

/** Which connection document is active (the sidebar follows it). */
export const activeConnection = createActiveKeyStore();

/** The full app's sidebar-to-workbench preview request (taken once by nonce; see graph/previews.ts). */
export const appPreviews: IPreviewStore = createPreviewStore();

/** The documents' URI schemes, for the shared "key from any URI" rule. */
export const DOC_SCHEMES = { bare: ['workbench', 'write'], suffixed: [] as string[] } as const;

/**
 * The dialect a probe answered with, when it is one Graph Explorer speaks.
 *
 * @param info - The probe's `info`.
 * @returns The dialect name, or null.
 */
export function dialectName(info: Record<string, unknown> | null): GraphDialect | null {
	const value = info?.dialect;
	return value === 'age' || value === 'neo4j' || value === 'falkordb' ? value : null;
}
