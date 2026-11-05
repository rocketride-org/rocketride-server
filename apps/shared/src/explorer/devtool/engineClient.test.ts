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

// =============================================================================
// EXPLORER DEV TOOL — ENGINE CLIENT + TIMEOUTS (R5: explicit waits on every request)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'rocketride';
import { createToolSession, DEFAULT_TOOL_TIMEOUTS } from '../connect/session';
import { TASK_NAMES_REQUEST, TASK_NAMES_TIMEOUT_MS } from '../connect/discovery';
import { codedError } from '../connect/testing';
import { ExplorerToolError } from '../errors';
import type { IExplorerEndpoint } from '../types';
import { createExplorerAdmin, createExplorerClient, createPrefsFs, requireRealmClient, withDeadline } from './engineClient';
import type { IRealmClient } from './engineClient';
import {
	FRAME_OP_MARGIN_MS,
	LIST_TASKS_TIMEOUT_MS,
	MAX_TIMER_MS,
	PROXY_BUS_SLACK_MS,
	SDK_TIMEOUT_SLACK_MS,
	UNBOUNDED_TOOL_TIMEOUT_MS,
	USE_DEADLINE_MS,
	frameOpTimeoutMs,
	toolCallBudgetMs,
	toolSdkTimeoutMs,
	toolTransportTimeoutMs,
} from './timeouts';

// Compile-time drift guard: the SDK's client is an IRealmClient. When a method
// this library calls changes shape in the SDK, `tsc -p tsconfig.test.json` fails here.
const _sdkFits = (client: RocketRideClient): IRealmClient => client;
void _sdkFits;

/** A client whose every method records its call and answers per method. */
function spyClient(answer: (method: string, args: unknown[]) => unknown = () => undefined): { client: IRealmClient; calls: Array<{ method: string; args: unknown[] }> } {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const make = (method: string) => async (...args: unknown[]): Promise<unknown> => {
		calls.push({ method, args });
		return answer(method, args);
	};
	const client = {
		getTasks: make('getTasks'),
		listTasks: make('listTasks'),
		getTaskPipeline: make('getTaskPipeline'),
		tool: make('tool'),
		addMonitor: make('addMonitor'),
		removeMonitor: make('removeMonitor'),
		fsStat: make('fsStat'),
		fsReadJson: make('fsReadJson'),
		fsMkdir: make('fsMkdir'),
		fsWriteJson: make('fsWriteJson'),
		use: make('use'),
		getTaskToken: make('getTaskToken'),
		terminate: make('terminate'),
		getService: make('getService'),
		validate: make('validate'),
		account: { getEnvironmentKeys: make('getEnvironmentKeys') },
	} as unknown as IRealmClient;
	return { client, calls };
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

describe('createExplorerClient — the SDK client, called directly', () => {
	it('tool passes its numeric timeout to the SDK untouched', async () => {
		const { client, calls } = spyClient(() => ({ rows: [] }));
		await createExplorerClient(() => client).tool({ token: 'tk', tool: 'get_data', nodeId: 'db_1', input: { sql: 'select 1' }, timeout: 121_000 });
		assert.deepEqual(calls, [{ method: 'tool', args: [{ token: 'tk', tool: 'get_data', nodeId: 'db_1', input: { sql: 'select 1' }, timeout: 121_000 }] }]);
	});

	it('tool with no timeout (unbounded on purpose) is given the documented finite cap, under the timer limit', async () => {
		const { client, calls } = spyClient();
		await createExplorerClient(() => client).tool({ token: 'tk', tool: 'execute' });
		assert.deepEqual(calls[0].args, [{ token: 'tk', tool: 'execute', timeout: UNBOUNDED_TOOL_TIMEOUT_MS }]);
		assert.ok(UNBOUNDED_TOOL_TIMEOUT_MS + PROXY_BUS_SLACK_MS + FRAME_OP_MARGIN_MS <= MAX_TIMER_MS, 'even with every margin added it stays a real timer');
		assert.ok(UNBOUNDED_TOOL_TIMEOUT_MS >= 60 * 60 * 1000, 'generous: at least an hour');
	});

	it('a tool timeout the transport could not honour is a programming error (RangeError), not a silent default', async () => {
		const { client, calls } = spyClient();
		await assert.rejects(Promise.resolve().then(() => createExplorerClient(() => client).tool({ token: 'tk', tool: 'x', timeout: MAX_TIMER_MS })), RangeError);
		assert.throws(() => toolSdkTimeoutMs(0), RangeError);
		assert.equal(calls.length, 0);
	});

	it('discovery and monitors call the SDK methods with their own arguments', async () => {
		const { client, calls } = spyClient((method) => (method === 'getTasks' ? [] : { components: [] }));
		const explorer = createExplorerClient(() => client);
		await explorer.getTasks();
		await explorer.listTasks?.(TASK_NAMES_REQUEST);
		await explorer.getTaskPipeline('tk');
		await explorer.addMonitor?.({ token: '*' }, ['task']);
		await explorer.removeMonitor?.({ token: '*' }, ['task']);
		assert.deepEqual(calls.map((c) => [c.method, ...c.args]), [
			['getTasks'],
			['listTasks', TASK_NAMES_REQUEST],
			['getTaskPipeline', 'tk'],
			['addMonitor', { token: '*' }, ['task']],
			['removeMonitor', { token: '*' }, ['task']],
		]);
	});

	it('the bounds are named: discovery gives up on names when the request does', () => {
		assert.equal(LIST_TASKS_TIMEOUT_MS, TASK_NAMES_TIMEOUT_MS);
	});

	it('getTasks refuses an answer that is not a list; getTaskPipeline answers undefined for a non-object', async () => {
		await assert.rejects(createExplorerClient(() => spyClient(() => ({ rows: [] })).client).getTasks(), /getTasks/);
		assert.equal(await createExplorerClient(() => spyClient(() => 'nope').client).getTaskPipeline('tk'), undefined);
	});

	it('SDK failures pass through untouched: the same object, a code only if the SDK kept one (R10)', async () => {
		const sdk = codedError('Task is not running', 'TASK_STOPPED');
		const { client } = spyClient((method) => {
			if (method === 'tool') throw sdk;
			throw new Error('TASK_STOPPED: text only');
		});
		const explorer = createExplorerClient(() => client);
		await assert.rejects(explorer.tool({ token: 'tk', tool: 'get_data' }), (error: unknown) => error === sdk);
		await assert.rejects(explorer.getTaskPipeline('tk'), (error: unknown) => (error as { code?: unknown }).code === undefined);
	});

	it('reads the getter on every call: no client yet rejects as unavailable (nothing sent); a later client is used', async () => {
		let current: IRealmClient | null = null;
		const explorer = createExplorerClient(() => current);
		await assert.rejects(explorer.getTasks(), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		await assert.rejects(explorer.tool({ token: 'tk', tool: 'x' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		const { client, calls } = spyClient(() => []);
		current = client;
		await explorer.getTasks();
		assert.equal(calls.length, 1);
	});
});

describe('withDeadline — an application deadline that does not pretend to cancel', () => {
	it('rejects with kind timeout, says the request was not cancelled, and swallows the late answer and the late failure', async () => {
		let release!: (value: string) => void;
		const late = new Promise<string>((resolve) => { release = resolve; });
		await assert.rejects(withDeadline(() => late, 20, 'getTasks'), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.match(error.message, /not cancelled and may still complete/);
			return true;
		});
		release('too late');
		await assert.rejects(withDeadline(() => Promise.reject(new Error('boom')), 20, 'x'), /boom/);
		let fail!: (error: Error) => void;
		const lateFail = new Promise<string>((_resolve, reject) => { fail = reject; });
		await assert.rejects(withDeadline(() => lateFail, 10, 'y'), ExplorerToolError);
		fail(new Error('late')); // must not become an unhandled rejection
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	it('a synchronous throw inside the request is the request\'s failure, not a hang', async () => {
		await assert.rejects(withDeadline(() => { throw new TypeError('bad'); }, 1_000, 'z'), TypeError);
	});

	it('refuses an unusable deadline synchronously', () => {
		for (const bad of [undefined, 0, -1, Number.NaN, MAX_TIMER_MS + 1]) assert.throws(() => withDeadline(async () => 1, bad as number, 'w'), RangeError, String(bad));
	});

	it('every discovery and file-store request is bounded by one (a hung client rejects, it does not wait forever)', async () => {
		const hung = new Promise<never>(() => undefined);
		const fs = createPrefsFs(() => ({ fsStat: () => hung, fsReadJson: () => hung, fsMkdir: () => hung, fsWriteJson: () => hung }), 15);
		for (const run of [() => fs.fsStat('p'), () => fs.fsReadJson('p'), () => fs.fsMkdir('p'), () => fs.fsWriteJson('p', {})]) {
			await assert.rejects(run(), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		}
		await assert.rejects(createPrefsFs(() => null).fsStat('p'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
	});
});

describe('T4 end to end — session wait < SDK timeout < transport timeout < frame timeout', () => {
	it('a bounded session call: the SDK gets wait + slack, a proxy transport that + its slack, the frame waits longer still', async () => {
		const { client, calls } = spyClient(() => ({ tables: [] }));
		const session = createToolSession(createExplorerClient(() => client), ENDPOINT, { token: () => 'tk', info: () => null }, {
			tools: { get_schema: { idempotent: true, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_schema } },
		});
		await session.invoke('get_schema', {});
		const wait = DEFAULT_TOOL_TIMEOUTS.get_schema;
		const sdkTimeout = (calls[0].args[0] as { timeout?: number }).timeout as number;
		assert.equal(sdkTimeout, wait + SDK_TIMEOUT_SLACK_MS, 'session.ts adds its SDK slack (pins SDK_TIMEOUT_SLACK_MS to the session)');
		const transport = toolTransportTimeoutMs(sdkTimeout);
		assert.equal(transport, toolCallBudgetMs(wait));
		assert.ok(transport > sdkTimeout, 'the transport outlives the SDK');
		assert.ok(frameOpTimeoutMs(transport) >= transport + FRAME_OP_MARGIN_MS, 'the frame outlives the controller');
	});

	it('an unbounded session call (timeoutMs: null) is bounded only by the 24 h cap, and its frame wait is still a real timer', async () => {
		const { client, calls } = spyClient(() => ({ rows: [] }));
		const session = createToolSession(createExplorerClient(() => client), ENDPOINT, { token: () => 'tk', info: () => null }, { tools: { execute: { timeoutMs: null } } });
		await session.invoke('execute', { sql: 'vacuum' });
		assert.equal((calls[0].args[0] as { timeout?: number }).timeout, UNBOUNDED_TOOL_TIMEOUT_MS);
		assert.equal(toolCallBudgetMs(null), UNBOUNDED_TOOL_TIMEOUT_MS + PROXY_BUS_SLACK_MS);
		assert.ok(frameOpTimeoutMs(toolCallBudgetMs(null)) <= MAX_TIMER_MS);
	});

	it('frameOpTimeoutMs refuses a controller budget it cannot exceed with a real timer', () => {
		assert.throws(() => frameOpTimeoutMs(MAX_TIMER_MS), RangeError);
		assert.throws(() => frameOpTimeoutMs(Number.NaN), RangeError);
	});
});

describe('requireRealmClient — the one guard', () => {
	it('returns the client, or rejects as unavailable naming the request', () => {
		const { client } = spyClient();
		assert.equal(requireRealmClient(() => client, 'x'), client);
		assert.throws(() => requireRealmClient(() => null, 'getFoo'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && /getFoo/.test(error.message));
		assert.throws(() => requireRealmClient(() => undefined, 'y'), ExplorerToolError);
	});
});

describe('createExplorerAdmin — generic SDK calls with a deadline, no retries', () => {
	it('each call reaches the SDK method with its own arguments and returns its answer', async () => {
		const { client, calls } = spyClient((method) => (method === 'getEnvironmentKeys' ? ['ROCKETRIDE_A'] : method === 'getTaskToken' ? 'tk' : { token: 'tk' }));
		const admin = createExplorerAdmin(() => client);
		assert.deepEqual(await admin.use({ pipeline: { components: [] } as never, source: 's', ttl: 60 }), { token: 'tk' });
		assert.equal(await admin.getTaskToken({ projectId: 'p', source: 's' }), 'tk');
		await admin.terminate('tk');
		await admin.getService('db_postgres');
		await admin.validate({ pipeline: { components: [] } });
		assert.deepEqual(await admin.getEnvironmentKeys(), ['ROCKETRIDE_A']);
		assert.deepEqual(calls.map((c) => c.method), ['use', 'getTaskToken', 'terminate', 'getService', 'validate', 'getEnvironmentKeys']);
		assert.deepEqual(calls[0].args, [{ pipeline: { components: [] }, source: 's', ttl: 60 }]);
		assert.deepEqual(calls[2].args, ['tk']);
	});

	it('SDK errors are the same object; no client is unavailable and nothing is called', async () => {
		const sdk = codedError('nope', 'TASK_STOPPED');
		const { client } = spyClient(() => { throw sdk; });
		await assert.rejects(createExplorerAdmin(() => client).terminate('tk'), (error: unknown) => error === sdk);
		await assert.rejects(createExplorerAdmin(() => null).use({ filepath: 'x.pipe' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		await assert.rejects(createExplorerAdmin(() => null).getEnvironmentKeys(), ExplorerToolError);
	});

	it('an expired deadline says it was not cancelled, and nothing retries: use and terminate are called exactly once', async () => {
		const { client, calls } = spyClient(() => new Promise(() => undefined));
		const admin = createExplorerAdmin(() => client, { use: 20, terminate: 20 });
		for (const run of [() => admin.use({ filepath: 'x.pipe' }), () => admin.terminate('tk')]) {
			await assert.rejects(run(), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /not cancelled and may still complete/.test(error.message));
		}
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.deepEqual(calls.map((c) => c.method), ['use', 'terminate'], 'one call each, no automatic retry');
	});
});

describe('USE_DEADLINE_MS (DA-R2-06)', () => {
	it('is below the 120 s bus default, so the application deadline\'s message wins through a proxy', () => {
		assert.ok(USE_DEADLINE_MS < 120_000);
	});
});
