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
// ADAPTER - ACTIONS ON A CONNECTION (schema load, Ask) (pure: no shell values)
// =============================================================================
//
// The two calls the workbench and the sidebar make outside a statement run. Both go
// through the endpoint store's session, so the token never leaves the store, and
// both return outcomes instead of throwing.
//
//   - Schema: the first load reads `get_schema` (the snapshot the node took when its
//     pipeline started). Refresh asks `refresh_schema` when the node can. A refresh
//     that fails (including "this node cannot") keeps the snapshot on screen and
//     records why; an old node's snapshot is labelled as one it cannot refresh. A
//     Refresh while the connection has not answered its check sends nothing and
//     records that, rather than quietly re-reading `get_schema`; one asked for
//     while the first load runs is sent after it.
//   - Ask: `get_query` returns Cypher the node already vetted (a PREVIEW, never run
//     here), prose, or a failure. See ask.ts.
// =============================================================================

import type { IEndpointStore, IExplorerClient, IExplorerEndpoint } from 'shared/explorer';
import { askQuestion } from '../graph/ask';
import type { AskOutcome } from '../graph/ask';
import { canWrite, parseDialect, supportsRefresh } from '../graph/dialect';
import { describeFailureOf } from '../graph/failures';
import type { IFailureNotice } from '../graph/failures';
import type { ISchemaStore } from '../graph/schemaStore';
import { ASK_UNAVAILABLE } from '../graph/wording';
import { TOOL, graphEndpoints, schemas } from './explorer';

/** The stores the actions work on (the app's own by default; tests pass theirs). */
export interface IActionStores {
	endpoints: IEndpointStore;
	schemas: ISchemaStore;
}

const APP_STORES: IActionStores = { endpoints: graphEndpoints, schemas };

/**
 * Turn a thrown value into the notice the sidebar shows.
 *
 * @param error - What the session threw.
 * @param writable - Whether this endpoint has a write console.
 * @returns The notice.
 */
function describe(error: unknown, writable: boolean): IFailureNotice {
	return describeFailureOf(error instanceof Error ? error.message : String(error), error, writable);
}

/**
 * Load or refresh a connection's schema into the schema store.
 *
 * @param client - The shell's client.
 * @param endpoint - The connection.
 * @param options - `fresh` asks the node to re-read the database (when it can).
 * @param stores - The stores to use.
 * @returns A promise that settles when the load does; never rejects.
 */
export function loadConnectionSchema(client: IExplorerClient, endpoint: IExplorerEndpoint, options: { fresh?: boolean } = {}, stores: IActionStores = APP_STORES): Promise<void> {
	const session = stores.endpoints.session(client, endpoint);
	const fresh = options.fresh === true;
	// Decided when the load RUNS (a refresh may wait for the first load to end): what the node can do is read then.
	const fetch = (): Promise<unknown> => {
		const dialect = parseDialect(session.info());
		if (fresh && dialect === null) return Promise.reject(NOT_CHECKED);
		return session.invoke(fresh && supportsRefresh(dialect) ? TOOL.refreshSchema : TOOL.getSchema, {});
	};
	return stores.schemas.load(endpoint.key, fetch, (error) => (error === NOT_CHECKED ? NOT_CHECKED_NOTICE : describe(error, canWrite(parseDialect(session.info())))), { refresh: fresh });
}

/** Why a Refresh sent nothing: the connection has not answered its check, so what it can do is unknown. */
const NOT_CHECKED = new Error('not checked');

/** The notice for {@link NOT_CHECKED}. */
const NOT_CHECKED_NOTICE: IFailureNotice = {
	variant: 'warning',
	headline: 'The schema was not refreshed: this connection has not answered its check yet. Try again in a moment.',
	detail: '',
	verbatim: '',
	generic: false,
	hint: null,
	ignore: false,
};

/**
 * Ask a connection's model a question.
 *
 * @param client - The shell's client.
 * @param endpoint - The connection.
 * @param question - The user's question.
 * @param stores - The stores to use.
 * @returns The outcome (a Cypher preview, prose, unavailable, a failure, refused or ignored).
 */
export function askConnection(client: IExplorerClient, endpoint: IExplorerEndpoint, question: string, stores: IActionStores = APP_STORES): Promise<AskOutcome> {
	const session = stores.endpoints.session(client, endpoint);
	return askQuestion(question, (text) => session.invoke(TOOL.getQuery, { question: text }), ASK_UNAVAILABLE);
}
