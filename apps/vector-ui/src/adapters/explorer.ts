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
// Everything Vector Explorer takes from `shared/explorer` is created or named
// here, so a change to the library's surface touches one file.
//
//   - Providers are the exact set of vector store nodes, pinned by a test
//     against every node's services.json protocol: the nine store nodes that
//     answer the vector tools. Elasticsearch and OpenSearch also declare the
//     `store` class but do not answer them, so the set is never derived from
//     the class alone.
//   - Roles are VECTOR_ROLES: ingest (dropper or webhook), chat and tools of
//     ONE project. With a Tools source running, only the store nodes it
//     controls become connections (`nodeFilter`), so the chat path's store_2
//     never appears; without one, every store becomes a read-only connection
//     anchored on the chat (then ingest) source.
//   - Every tool answers `{success: true, ...}` or a failure ENVELOPE
//     `{success: false, code, error}` instead of raising. The sessions check
//     only that the answer is an object (`checkObject`), and `unwrapEnvelope`
//     (vector/results.ts) turns a failure envelope into an ExplorerToolError
//     of kind `store` that KEEPS the code, so the console can say which
//     refusal it was. The probe does the same for `dialect`.
//   - Reads are idempotent (a lost TASK_STOPPED may be retried once);
//     the writes (`delete`, `soft_delete`, `restore`, `upsert`) never are.
//   - Budgets derive from the node's published statement deadline (pgvector)
//     plus the session pad; `sample` waits for its own node budget.
//
// The stores are created once, at module level, and are per-app instances:
// the shared library holds no state of its own.
// =============================================================================

import { DEFAULT_TOOL_TIMEOUTS, VECTOR_ROLES, checkObject, createActiveKeyStore, createAnnouncer, createEndpointStore, createHistoryStore, createLiveRegion, createRequestChannel, ExplorerToolError } from 'shared/explorer';
import type { IEndpointStore, IEndpointStoreOptions, IExplorerComponent, IHistoryStore, IProbeResult, IRequestChannel, IToolSession, IToolSpec } from 'shared/explorer';
import { EMBED_TOOL } from '../contract/types';
import type { VectorKey } from '../contract/types';
import { createCacheRegistry } from '../vector/identityChange';
import type { ICacheRegistry } from '../vector/identityChange';

// =============================================================================
// PROVIDERS, TOOLS
// =============================================================================

/**
 * The store node providers Vector Explorer opens: every node whose services.json
 * declares the `store` class and answers the vector tools (protocol without '://').
 * Pinned by tests/templates.test.ts against the nodes' own services.json.
 */
export const VECTOR_PROVIDERS: ReadonlySet<string> = new Set(['postgres', 'rocketride_vector', 'qdrant', 'chroma', 'milvus', 'weaviate', 'pinecone', 'astra_db', 'mongodb+srv']);

/** Tool names Vector Explorer calls (bare names; every call names its node). */
export const TOOL = {
	dialect: 'dialect',
	stats: 'stats',
	// The listing (the tool was `documents`; #2704's name): `deleted: 'deleted'` lists the trash.
	listDocuments: 'list_documents',
	chunks: 'chunks',
	vectors: 'vectors',
	sample: 'sample',
	project: 'project',
	neighbors: 'neighbors',
	search: 'search',
	// The writes: delete is the only permanent delete; soft_delete moves to the trash and restore back out of it.
	delete: 'delete',
	softDelete: 'soft_delete',
	restore: 'restore',
	upsert: 'upsert',
	embed: EMBED_TOOL,
	// Additive tools (contract section 4.4): reads that return keys and scalars, never a stored vector.
	recommend: 'recommend',
	similarityMatrix: 'similarity_matrix',
} as const;

/** The tools that change data. Never idempotent, never replayed, never called without a confirmation. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TOOL.delete, TOOL.softDelete, TOOL.restore, TOOL.upsert]);

/** Client wait for `sample` when the node does not publish its budget: the node's 60 s plus the pad. */
const SAMPLE_TIMEOUT_MS = 70_000;

/** Client wait for `embed` (another node of the task: the store's deadline does not apply). */
const EMBED_TIMEOUT_MS = 30_000;

/**
 * Per-tool specs: idempotency, check, budget and capability.
 *
 * Every check is `checkObject`: a failure ENVELOPE resolves, and the caller
 * unwraps it with its code (see the header). A tool whose capability the node
 * does not advertise is refused locally as `upgrade` and nothing is sent.
 *
 * @returns The table.
 */
export function makeVectorTools(): Readonly<Record<string, IToolSpec>> {
	const read = (capability?: string, timeoutMs?: number): IToolSpec => ({
		idempotent: true,
		check: checkObject,
		...(capability === undefined ? {} : { capability }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	const write = (capability?: string): IToolSpec => ({ idempotent: false, check: checkObject, ...(capability === undefined ? {} : { capability }) });
	return {
		[TOOL.dialect]: read(undefined, DEFAULT_TOOL_TIMEOUTS.dialect),
		// Legacy descriptor: every node answers it, so no capability is required.
		[TOOL.stats]: read(),
		[TOOL.listDocuments]: read('documents'),
		[TOOL.chunks]: read('chunks'),
		[TOOL.vectors]: read('vectors'),
		[TOOL.sample]: read('sample', SAMPLE_TIMEOUT_MS),
		[TOOL.project]: read('project'),
		[TOOL.neighbors]: read('neighbors'),
		[TOOL.search]: read('search_vector'),
		[TOOL.embed]: read(undefined, EMBED_TIMEOUT_MS),
		// Recommend searches the whole collection as `neighbors` does; the matrix reads the vectors of a
		// sample's keys (cached, else from the store). A node older than these tools answers that it has none.
		[TOOL.recommend]: read('neighbors'),
		[TOOL.similarityMatrix]: read('sample'),
		[TOOL.delete]: write(),
		// Moving to the trash and back needs the driver's markDeleted / markActive (dialect.capabilities.soft_delete).
		[TOOL.softDelete]: write('soft_delete'),
		[TOOL.restore]: write('soft_delete'),
		[TOOL.upsert]: write(),
	};
}

/** The tool table the app uses. */
export const VECTOR_TOOLS: Readonly<Record<string, IToolSpec>> = makeVectorTools();

// =============================================================================
// DISCOVERY: which store nodes of a pipeline become connections
// =============================================================================

/**
 * The connection filter. With a Tools source running, a store becomes a
 * connection only when that source controls it (store_1, never the chat path's
 * store_2); without one, every store of the pipeline becomes a read-only one.
 *
 * @param component - A store component of the pipeline (id, provider, name, control edges).
 * @param group - The pipeline's bound roles.
 * @returns Whether it becomes an endpoint.
 */
export function vectorNodeFilter(component: IExplorerComponent, group: { toolsSource: string | null; anchorRole: string; boundRoles: readonly string[] }): boolean {
	if (group.toolsSource === null) return true;
	return (component.control ?? []).some((edge) => edge.from === group.toolsSource);
}

/**
 * The probe: one `dialect` call whose failure ENVELOPE counts as a failure
 * (with its code), not as a node that answered.
 *
 * @param session - A session on the endpoint (the store opens it with retry off).
 * @returns The result; never throws.
 */
export async function vectorProbe(session: IToolSession): Promise<IProbeResult> {
	try {
		const info = await session.invoke<Record<string, unknown>>(TOOL.dialect, {}, { retry: false });
		if (info.success === false) {
			const message = typeof info.error === 'string' && info.error !== '' ? info.error : 'The store node reported a failure without saying why.';
			return { ok: false, info: null, dialect: null, error: { kind: 'store', message, ...(typeof info.code === 'string' ? { code: info.code } : {}) } };
		}
		return { ok: true, info, dialect: typeof info.dialect === 'string' ? info.dialect : null };
	} catch (error) {
		if (error instanceof ExplorerToolError) {
			return { ok: false, info: null, dialect: null, error: { kind: error.kind, message: error.message, ...(error.code ? { code: error.code } : {}) } };
		}
		return { ok: false, info: null, dialect: null, error: { kind: 'raised', message: error instanceof Error ? error.message : String(error) } };
	}
}

// =============================================================================
// STORES (one per app, module level)
// =============================================================================

/**
 * Make a Vector Explorer endpoint store. The app uses one (below); tests make
 * their own with an injected clock.
 *
 * @param overrides - Options that replace the defaults (clock, concurrency, ...).
 * @returns The store.
 */
export function makeVectorEndpointStore(overrides: Partial<IEndpointStoreOptions> = {}): IEndpointStore {
	return createEndpointStore({ providers: VECTOR_PROVIDERS, roles: VECTOR_ROLES, tools: VECTOR_TOOLS, probe: vectorProbe, nodeFilter: vectorNodeFilter, ...overrides });
}

/** Vector Explorer's endpoint store: three roles, the nine store providers. */
export const vectorEndpoints: IEndpointStore = makeVectorEndpointStore();

/**
 * Make the chat history store (`vector.history`, text field `question`):
 * questions only, never answers, documents or tokens.
 *
 * @param persistDelayMs - Debounce before a write (tests shorten it).
 * @returns The store.
 */
export function makeVectorHistory(persistDelayMs?: number): IHistoryStore<'question'> {
	return createHistoryStore({ historyKey: 'vector.history', recordingKey: 'vector.historyRecording', textField: 'question', ...(persistDelayMs === undefined ? {} : { persistDelayMs }) });
}

/** Chat history: `vector.history` / `vector.historyRecording`, entry text field `question`. */
export const vectorHistory: IHistoryStore<'question'> = makeVectorHistory();

/** The one announcement channel and its live region. */
export const announcer = createAnnouncer();
export const LiveRegion = createLiveRegion(announcer);

/** Which connection document is active (the sidebar follows it). */
export const activeConnection = createActiveKeyStore();

/** The documents' URI schemes, for the shared "key from any URI" rule. */
export const DOC_SCHEMES = { bare: ['console'], suffixed: ['document'] } as const;

/**
 * Every per-connection cache (documents, auto-pager, chunks, uploads, chat,
 * sample models, selection, camera, debugger, neighbour queues) registers its
 * `clear` here; a change of identity clears them all (vector/identityChange.ts).
 */
export const connectionCaches: ICacheRegistry = createCacheRegistry();

/** A `neighbors` request: the point the map asks about (newest wins). */
export interface INeighbourRequest {
	/** The key asked about. */
	key: VectorKey;
	/** How many neighbours. */
	k: number;
}

/** One request channel per connection for `neighbors`, so calls go one at a time and the newest wins. */
const neighbourChannels = new Map<string, IRequestChannel<INeighbourRequest>>();

/**
 * The `neighbors` request channel of one connection.
 *
 * @param connectionKey - The endpoint key.
 * @returns The channel (made on first use).
 */
export function neighbourRequests(connectionKey: string): IRequestChannel<INeighbourRequest> {
	let channel = neighbourChannels.get(connectionKey);
	if (!channel) {
		channel = createRequestChannel<INeighbourRequest>();
		neighbourChannels.set(connectionKey, channel);
	}
	return channel;
}

connectionCaches.register('neighbour queues', () => neighbourChannels.clear(), (key) => neighbourChannels.delete(key));
