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
// TEST SUPPORT — a registered endpoint without a live platform
// =============================================================================
//
// SQL Explorer's endpoint store owns task tokens in a transient vault, and a
// session can only call a tool for an endpoint the store knows. These helpers
// put an endpoint (and its token) into a REAL SQL Explorer store
// (createSqlEndpoints) by running real discovery over a fake `getTasks`, so
// every suite exercises the same path the app does. Not a test file (the
// runner only collects *.test.ts).
//
// Port of f63da6e22 (tests/support.ts): the store is an instance here, as the
// engine core makes one per owner, instead of a module singleton.
// =============================================================================

import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import { createSqlEndpoints } from '../src/connect';
import type { SqlEndpoint } from '../src/connect';

/** One fake running task, shaped like a `getTasks` row. */
export interface IFakeTaskRow {
	name: string;
	description: string;
	source: string;
	token: string;
	status: string;
	teamId: string;
	runKind: string;
	ownerKind: string;
	ownerId: string;
	pipeline: { project_id: string; name: string; components: { id?: string; provider?: string; name?: string }[] };
}

/** The tasks `getTasks` currently reports. */
const rows: IFakeTaskRow[] = [];

/** The store the suites share (reset with {@link resetEndpoints}). */
export const sqlEndpoints = createSqlEndpoints();

/**
 * Build a running dev task row.
 *
 * @param name - Also the project id, so each test gets its own connection key.
 * @param over - Fields to override.
 * @returns The row.
 */
export function taskRow(name: string, over: Partial<IFakeTaskRow> = {}): IFakeTaskRow {
	return {
		name: 'Pipeline A',
		description: '',
		source: 's1',
		token: `tk_sentinel_${name}`,
		status: 'Tools ready',
		teamId: 'team-1',
		runKind: 'dev',
		ownerKind: 'user',
		ownerId: 'u1',
		pipeline: { project_id: name, name: 'Pipeline A', components: [{ id: 'db_1', provider: 'db_postgres', name: 'Orders DB' }] },
		...over,
	};
}

/**
 * The fake discovery client: `getTasks` reports the registered rows and every
 * tool answers like a postgres node, so the endpoint probes ready.
 *
 * @returns The client.
 */
export function discoveryClient(): IExplorerClient {
	return {
		getTasks: async () => rows.map((row) => ({ ...row })),
		getTaskPipeline: async () => undefined,
		tool: async () => ({ dialect: 'postgres' }) as never,
	};
}

/**
 * Register a running task with the store, and return its endpoint.
 *
 * Earlier registrations stay registered (their tokens are kept) until
 * {@link resetEndpoints}.
 *
 * @param name - The project id; use a distinct name per test.
 * @param over - Task row overrides.
 * @returns The discovered endpoint.
 */
export async function registerEndpoint(name: string, over: Partial<IFakeTaskRow> = {}): Promise<IExplorerEndpoint> {
	rows.push(taskRow(name, over));
	await sqlEndpoints.refresh(discoveryClient());
	const endpoint = sqlEndpoints.getState().endpoints.find((candidate) => candidate.projectId === name && candidate.ownerId === (over.ownerId ?? 'u1') && candidate.runKind === (over.runKind ?? 'dev'));
	if (!endpoint) throw new Error(`support: endpoint ${name} was not discovered`);
	return endpoint;
}

/**
 * The app's token-free description of a discovered endpoint, as a saved
 * connection names it (key = the store's legacyKey).
 *
 * @param endpoint - The discovered endpoint.
 * @param connId - The saved connection's id.
 * @returns The description.
 */
export function describeEndpoint(endpoint: IExplorerEndpoint, connId = 'conn-1'): SqlEndpoint {
	return {
		key: endpoint.legacyKey ?? endpoint.key,
		connId,
		projectId: endpoint.projectId,
		pipelineName: endpoint.pipelineName,
		source: endpoint.source,
		nodeId: endpoint.nodeId,
		nodeName: endpoint.nodeName,
		provider: endpoint.provider,
		running: endpoint.running,
	};
}

/**
 * The rows `getTasks` reports now (for a test client that must answer a
 * re-discovery).
 *
 * @returns Copies of the rows.
 */
export function currentRows(): IFakeTaskRow[] {
	return rows.map((row) => ({ ...row }));
}

/** Forget every registered task and everything the store holds. */
export function resetEndpoints(): void {
	rows.length = 0;
	sqlEndpoints.reset();
}
