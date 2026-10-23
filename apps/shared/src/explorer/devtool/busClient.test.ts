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
// EXPLORER DEV TOOL — BUS CLIENT + TIMEOUTS (T4: explicit waits on both lanes)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionManager } from 'shell';
import { createToolSession, DEFAULT_TOOL_TIMEOUTS } from '../connect/session';
import { TASK_NAMES_REQUEST, TASK_NAMES_TIMEOUT_MS } from '../connect/discovery';
import { codedError } from '../connect/testing';
import type { IExplorerEndpoint } from '../types';
import { busRequest, createBusExplorerClient, getBusExplorerClient } from './busClient';
import type { IExplorerBus } from './busClient';
import {
	BUS_TOOL_MARGIN_MS,
	FRAME_OP_MARGIN_MS,
	GET_TASK_PIPELINE_TIMEOUT_MS,
	GET_TASKS_TIMEOUT_MS,
	LIST_TASKS_TIMEOUT_MS,
	MAX_TIMER_MS,
	MONITOR_TIMEOUT_MS,
	SDK_TIMEOUT_SLACK_MS,
	UNBOUNDED_TOOL_TIMEOUT_MS,
	frameOpTimeoutMs,
	toolCallBudgetMs,
} from './timeouts';

/** One recorded `cm.request`. */
interface IRequest {
	op: string;
	params: unknown;
	opts: { timeoutMs?: number } | undefined;
}

/**
 * A structural bus whose `request` records every call and answers per op.
 *
 * @param answer - What each op resolves with (throw to reject).
 * @returns The bus and its log.
 */
function spyBus(answer: (op: string, params: unknown) => unknown = () => undefined): { cm: IExplorerBus; requests: IRequest[] } {
	const requests: IRequest[] = [];
	const cm: IExplorerBus = {
		request: async (op, params, opts) => {
			requests.push({ op, params, opts });
			return answer(op, params);
		},
	};
	return { cm, requests };
}

const ENDPOINT: IExplorerEndpoint = {
	key: 'k1|dev|user|u1|team-1|proj-1|tools=tools_1|db_1',
	legacyKey: 'proj-1:tools_1:db_1',
	projectId: 'proj-1',
	pipelineName: 'Pipeline A',
	runKind: 'dev',
	ownerKind: 'user',
	ownerId: 'u1',
	teamId: 'team-1',
	roles: { tools: { source: 'tools_1' } },
	missingRoles: [],
	source: 'tools_1',
	nodeId: 'db_1',
	nodeName: 'Orders DB',
	provider: 'db_postgres',
	state: 'ready',
	running: true,
};

describe('the ConnectionManager satisfies the structural bus', () => {
	it('compiles: a realm ConnectionManager is an IExplorerBus', () => {
		const check = (cm: ConnectionManager): IExplorerBus => cm;
		assert.equal(typeof check, 'function');
	});
});

describe('createBusExplorerClient — every request carries an explicit timeoutMs (R5)', () => {
	it('tool with a numeric timeout asks the bus for timeout + BUS_TOOL_MARGIN_MS', async () => {
		const { cm, requests } = spyBus(() => ({ rows: [] }));
		const client = createBusExplorerClient(cm);
		await client.tool({ token: 'tk', tool: 'get_data', nodeId: 'db_1', input: { sql: 'select 1' }, timeout: 121_000 });
		assert.deepEqual(requests, [{
			op: 'client.tool',
			params: { token: 'tk', tool: 'get_data', nodeId: 'db_1', input: { sql: 'select 1' }, timeout: 121_000 },
			opts: { timeoutMs: 121_000 + BUS_TOOL_MARGIN_MS },
		}]);
	});

	it('tool with no timeout (the session left it unbounded on purpose) gets the documented finite cap, under the timer limit', async () => {
		const { cm, requests } = spyBus();
		await createBusExplorerClient(cm).tool({ token: 'tk', tool: 'execute' });
		assert.equal(requests[0].opts?.timeoutMs, UNBOUNDED_TOOL_TIMEOUT_MS);
		assert.deepEqual(requests[0].params, { token: 'tk', tool: 'execute' }, 'no timeout key is invented for the SDK');
		assert.ok(UNBOUNDED_TOOL_TIMEOUT_MS + BUS_TOOL_MARGIN_MS + FRAME_OP_MARGIN_MS <= MAX_TIMER_MS, 'even with every margin added it stays a real timer');
		assert.ok(UNBOUNDED_TOOL_TIMEOUT_MS >= 60 * 60 * 1000, 'generous: at least an hour');
	});

	it('discovery and monitors pass their own named timeouts', async () => {
		const { cm, requests } = spyBus((op) => (op === 'client.getTasks' ? [] : { components: [] }));
		const client = createBusExplorerClient(cm);
		await client.getTasks();
		await client.listTasks?.(TASK_NAMES_REQUEST);
		await client.getTaskPipeline('tk');
		await client.addMonitor?.({ token: '*' }, ['task']);
		await client.removeMonitor?.({ token: '*' }, ['task']);
		assert.deepEqual(requests.map((r) => [r.op, r.params, r.opts?.timeoutMs]), [
			['client.getTasks', {}, GET_TASKS_TIMEOUT_MS],
			['client.listTasks', TASK_NAMES_REQUEST, LIST_TASKS_TIMEOUT_MS],
			['client.getTaskPipeline', { token: 'tk' }, GET_TASK_PIPELINE_TIMEOUT_MS],
			['client.addMonitor', { key: { token: '*' }, types: ['task'] }, MONITOR_TIMEOUT_MS],
			['client.removeMonitor', { key: { token: '*' }, types: ['task'] }, MONITOR_TIMEOUT_MS],
		]);
	});

	it('every timeout it passes is a finite number at most 2^31-1 (a larger setTimeout fires at once)', async () => {
		const { cm, requests } = spyBus((op) => (op === 'client.getTasks' ? [] : undefined));
		const client = createBusExplorerClient(cm);
		await client.getTasks();
		await client.getTaskPipeline('tk');
		await client.tool({ token: 'tk', tool: 'a' });
		await client.tool({ token: 'tk', tool: 'b', timeout: 1 });
		await client.addMonitor?.({ token: '*' }, ['task']);
		for (const r of requests) {
			const ms = r.opts?.timeoutMs;
			assert.ok(typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS, `${r.op}: ${ms}`);
		}
	});

	it('listTasks goes over the bus\'s existing client.listTasks op, and the bus gives up when discovery stops waiting for names', () => {
		assert.equal(LIST_TASKS_TIMEOUT_MS, TASK_NAMES_TIMEOUT_MS);
	});

	it('getTasks refuses an answer that is not a list (a protocol error, not an empty discovery)', async () => {
		const { cm } = spyBus(() => ({ rows: [] }));
		await assert.rejects(createBusExplorerClient(cm).getTasks(), /client\.getTasks/);
	});

	it('getTaskPipeline answers undefined for anything that is not an object', async () => {
		const { cm } = spyBus(() => 'nope');
		assert.equal(await createBusExplorerClient(cm).getTaskPipeline('tk'), undefined);
	});

	it('passes failures through untouched: a code the SDK kept stays, none is invented (R10)', async () => {
		const sdk = codedError('Task is not running', 'TASK_STOPPED');
		const { cm } = spyBus((op) => {
			if (op === 'client.tool') throw sdk;
			throw new Error('TASK_STOPPED: bridged text only');
		});
		const client = createBusExplorerClient(cm);
		await assert.rejects(client.tool({ token: 'tk', tool: 'get_data' }), (error: unknown) => error === sdk);
		await assert.rejects(client.getTaskPipeline('tk'), (error: unknown) => (error as { code?: unknown }).code === undefined);
	});

	it('getBusExplorerClient is one stable instance per bus', () => {
		const a = spyBus().cm;
		const b = spyBus().cm;
		assert.equal(getBusExplorerClient(a), getBusExplorerClient(a));
		assert.notEqual(getBusExplorerClient(a), getBusExplorerClient(b));
	});
});

describe('busRequest — the helper for the other client.* ops', () => {
	it('passes the timeout it is given', async () => {
		const { cm, requests } = spyBus(() => ['A_KEY']);
		const keys = await busRequest(cm, 'client.getEnvironmentKeys', {}, 10_000);
		assert.deepEqual(keys, ['A_KEY']);
		assert.deepEqual(requests, [{ op: 'client.getEnvironmentKeys', params: {}, opts: { timeoutMs: 10_000 } }]);
	});

	it('requires an explicit, valid timeout', async () => {
		const { cm, requests } = spyBus();
		for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_MS + 1]) {
			assert.throws(() => busRequest(cm, 'client.fsReadJson', { path: '.workspace/x.json' }, bad as unknown as number), RangeError, String(bad));
		}
		assert.equal(requests.length, 0);
	});
});

describe('T4 end to end — session wait < SDK timeout < bus timeout < frame timeout', () => {
	it('a bounded session call: the SDK gets wait + slack, the bus gets that + margin, the frame waits longer still', async () => {
		const { cm, requests } = spyBus(() => ({ tables: [] }));
		const client = getBusExplorerClient(cm);
		const session = createToolSession(client, ENDPOINT, { token: () => 'tk', info: () => null }, {
			tools: { get_schema: { idempotent: true, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_schema } },
		});
		await session.invoke('get_schema', {});
		const wait = DEFAULT_TOOL_TIMEOUTS.get_schema;
		const sdkTimeout = (requests[0].params as { timeout?: number }).timeout;
		assert.equal(sdkTimeout, wait + SDK_TIMEOUT_SLACK_MS, 'session.ts adds its SDK slack (pins SDK_TIMEOUT_SLACK_MS to the session)');
		const busTimeout = requests[0].opts?.timeoutMs as number;
		assert.equal(busTimeout, toolCallBudgetMs(wait));
		assert.ok(busTimeout > (sdkTimeout as number), 'the bus outlives the SDK');
		assert.ok(frameOpTimeoutMs(busTimeout) >= busTimeout + FRAME_OP_MARGIN_MS, 'the frame outlives the controller');
	});

	it('an unbounded session call (timeoutMs: null) is not capped by an adapter default', async () => {
		const { cm, requests } = spyBus(() => ({ rows: [] }));
		const session = createToolSession(getBusExplorerClient(cm), ENDPOINT, { token: () => 'tk', info: () => null }, { tools: { execute: { timeoutMs: null } } });
		await session.invoke('execute', { sql: 'vacuum' });
		assert.equal((requests[0].params as { timeout?: number }).timeout, undefined);
		assert.equal(requests[0].opts?.timeoutMs, UNBOUNDED_TOOL_TIMEOUT_MS);
		assert.equal(toolCallBudgetMs(null), UNBOUNDED_TOOL_TIMEOUT_MS);
		assert.ok(frameOpTimeoutMs(toolCallBudgetMs(null)) <= MAX_TIMER_MS);
	});

	it('frameOpTimeoutMs refuses a controller budget it cannot exceed with a real timer', () => {
		assert.throws(() => frameOpTimeoutMs(MAX_TIMER_MS), RangeError);
		assert.throws(() => frameOpTimeoutMs(Number.NaN), RangeError);
	});
});
