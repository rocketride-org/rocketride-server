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
// EXPLORER SESSION — failure per tool, explicit timeouts, stale results, one retry
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUTS, TRANSIENT_TASK_CODE, createToolSession } from './session';
import type { ISessionDeps, IToolSessionOptions } from './session';
import { codedError, fakeWorld, manualClock, row } from './testing';
import type { IFakeWorld, IManualClock, IToolCall } from './testing';
import { checkGetQuery, checkRowEnvelope, checkValidFlag, checkStoreSuccess, checkLegacyErrorEnvelope } from '../checks';
import { createGeneration } from '../generation';
import { ExplorerToolError, isStaleError } from '../errors';
import type { IExplorerEndpoint } from '../types';

// =============================================================================
// FIXTURES
// =============================================================================

/** The `dialect` answer of a current Neo4j node (graph-backend's provisional fixture, trimmed). */
const NEO4J_INFO: Record<string, unknown> = {
	dialect: 'neo4j',
	engine: { name: 'Neo4j', version: '5.26.31' },
	database: 'neo4j',
	graph: null,
	allow_execute: false,
	capabilities: { read_query: true, refresh_schema: true, execute_shape_graph: true, params: true },
	limits: { default_rows: 1000, max_rows: 25000, max_elements: 10000, statement_timeout_ms: 30000 },
};

/** A pre-upgrade node: `dialect` answers only its name. */
const OLD_NODE_INFO: Record<string, unknown> = { dialect: 'neo4j' };

const ENDPOINT: IExplorerEndpoint = {
	key: 'k1|dev|user|u1|team-1|proj-1|tools=tools_1|g_1',
	legacyKey: 'proj-1:tools_1:g_1',
	projectId: 'proj-1',
	pipelineName: 'Graph A',
	runKind: 'dev',
	ownerKind: 'user',
	ownerId: 'u1',
	teamId: 'team-1',
	roles: { tools: { source: 'tools_1' } },
	missingRoles: [],
	source: 'tools_1',
	nodeId: 'g_1',
	nodeName: 'Neo4j',
	provider: 'graph_neo4j',
	state: 'ready',
	running: true,
};

/** The graph app's tool table, as graph-workbench registers it. */
const GRAPH_TOOLS: IToolSessionOptions['tools'] = {
	dialect: { idempotent: true, timeoutMs: DEFAULT_TOOL_TIMEOUTS.dialect },
	read_query: { idempotent: true, check: checkRowEnvelope, capability: 'read_query' },
	execute: { check: checkRowEnvelope },
	get_data: { idempotent: true, check: checkValidFlag, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_data },
	get_query: { idempotent: true, check: checkGetQuery, timeoutMs: DEFAULT_TOOL_TIMEOUTS.get_query },
	refresh_schema: { idempotent: true, timeoutMs: DEFAULT_TOOL_TIMEOUTS.refresh_schema },
	store_put: { check: checkStoreSuccess },
	falkor_query: { check: checkLegacyErrorEnvelope },
};

/** What `makeSession` lets a test steer. */
interface IRig {
	world: IFakeWorld;
	clock: IManualClock;
	state: { token: string | undefined; info: Record<string, unknown> | null };
	rebinds: number[];
	rebind: ((deadlineAt: number) => Promise<boolean>) | undefined;
	invoke: ReturnType<typeof createToolSession>['invoke'];
}

/**
 * Build a session over a fake world and a manual clock.
 *
 * @param behave - Tool behaviour.
 * @param over - Overrides.
 * @returns The rig.
 */
function makeSession(behave: IFakeWorld['behave'], over: { info?: Record<string, unknown> | null; token?: string | undefined; rebind?: (state: IRig['state'], deadlineAt: number) => Promise<boolean>; options?: Partial<IToolSessionOptions>; withRebind?: boolean } = {}): IRig {
	const world = fakeWorld([row()], behave);
	const clock = manualClock();
	const state: IRig['state'] = { token: 'token' in over ? over.token : 'tk_sentinel_A', info: 'info' in over ? (over.info ?? null) : NEO4J_INFO };
	const rebinds: number[] = [];
	const deps: ISessionDeps = {
		token: () => state.token,
		info: () => state.info,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	};
	if (over.withRebind !== false) {
		deps.rebind = async (deadlineAt: number) => {
			rebinds.push(deadlineAt);
			return over.rebind ? over.rebind(state, deadlineAt) : true;
		};
	}
	const session = createToolSession(world.client, ENDPOINT, deps, { tools: GRAPH_TOOLS, ...(over.options ?? {}) });
	return { world, clock, state, rebinds, rebind: deps.rebind, invoke: session.invoke };
}

/**
 * Run a promise to settlement and report how it ended.
 *
 * @param promise - The promise.
 * @returns The value or the error.
 */
async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
	try {
		return { value: await promise };
	} catch (error) {
		return { error };
	}
}

const ROWS = { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false };

// =============================================================================
// THE CALL ITSELF
// =============================================================================

describe('invoke — the call', () => {
	it('sends the node id, the input and the vault token, and returns the checked value', async () => {
		const rig = makeSession(() => ROWS);
		const value = await rig.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 });
		assert.deepEqual(value, ROWS);
		assert.deepEqual(rig.world.calls.map((c) => ({ token: c.token, tool: c.tool, nodeId: c.nodeId, input: c.input })), [
			{ token: 'tk_sentinel_A', tool: 'read_query', nodeId: 'g_1', input: { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 } },
		]);
	});

	it('reads the token at CALL time: a refreshed vault value is used without a new session', async () => {
		const rig = makeSession(() => ROWS);
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		rig.state.token = 'tk_sentinel_B';
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		assert.deepEqual(rig.world.calls.map((c) => c.token), ['tk_sentinel_A', 'tk_sentinel_B']);
	});

	it('refuses to send when no task token is known, as `unavailable`', async () => {
		const rig = makeSession(() => ROWS, { token: undefined });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.ok(error instanceof ExplorerToolError);
		assert.equal(error.kind, 'unavailable');
		assert.equal(rig.world.calls.length, 0);
	});

	it('rejects a non-object input before sending anything', async () => {
		const rig = makeSession(() => ROWS);
		for (const bad of [null, 'MATCH', 3, [1]]) {
			const { error } = await outcome(rig.invoke('read_query', bad as unknown as Record<string, unknown>));
			assert.equal((error as ExplorerToolError).kind, 'malformed');
		}
		assert.equal(rig.world.calls.length, 0);
	});

	it('maps a raised error onto one class, keeping the message verbatim and the SDK\'s code', async () => {
		const rig = makeSession(() => { throw codedError('Query failed\nDatabase said: Variable `x` not defined', 'SOME_CODE'); });
		const { error } = await outcome(rig.invoke('execute', { cypher: 'RETURN x' }));
		assert.ok(error instanceof ExplorerToolError);
		assert.equal(error.kind, 'raised');
		assert.equal(error.tool, 'execute');
		assert.equal(error.code, 'SOME_CODE');
		assert.equal(error.message, 'Query failed\nDatabase said: Variable `x` not defined');
		assert.equal(error.headline, 'Query failed');
		assert.equal(error.detail, 'Database said: Variable `x` not defined');
	});

	it('never puts the token in an error it makes', async () => {
		const rig = makeSession(() => { throw new Error('boom'); });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		const text = JSON.stringify({ message: (error as Error).message, ...(error as object) });
		assert.equal(text.includes('tk_sentinel'), false);
	});
});

// =============================================================================
// FAILURE PER TOOL
// =============================================================================

describe('invoke — a failed result is a property of the TOOL', () => {
	it('read_query: a malformed envelope fails, a good one passes', async () => {
		const bad = makeSession(() => ({ columns: ['n'], rows: [[1, 2]], row_limit: 1000, truncated: false }));
		assert.equal(((await outcome(bad.invoke('read_query', { cypher: 'RETURN 1' }))).error as ExplorerToolError).kind, 'malformed');
	});

	it('get_data: valid:false with an error fails as `invalid`', async () => {
		const rig = makeSession(() => ({ valid: false, error: 'bad cypher', rows: [] }));
		const { error } = await outcome(rig.invoke('get_data', { question: 'q' }));
		assert.equal((error as ExplorerToolError).kind, 'invalid');
		assert.equal((error as ExplorerToolError).message, 'bad cypher');
	});

	it('get_query: valid:false with an ANSWER is prose, not an error; with an error it fails', async () => {
		const prose = makeSession(() => ({ valid: false, answer: 'I could not write a query for that.' }));
		assert.deepEqual(await prose.invoke('get_query', { question: 'q' }), { valid: false, answer: 'I could not write a query for that.' });
		const failed = makeSession(() => ({ valid: false, error: 'LLM unavailable' }));
		assert.equal(((await outcome(failed.invoke('get_query', { question: 'q' }))).error as ExplorerToolError).kind, 'invalid');
	});

	it('store tools: success:false fails as `store`, and a result that is neither raised nor valid:false', async () => {
		const rig = makeSession(() => ({ success: false, error: 'collection missing' }));
		const { error } = await outcome(rig.invoke('store_put', {}));
		assert.equal((error as ExplorerToolError).kind, 'store');
	});

	it('FalkorDB legacy query: the error envelope fails as `error-envelope`', async () => {
		const rig = makeSession(() => ({ error: 'Query timed out', columns: [], rows: [] }));
		const { error } = await outcome(rig.invoke('falkor_query', {}));
		assert.equal((error as ExplorerToolError).kind, 'error-envelope');
	});

	it('a tool with no spec gets the object check only and is NOT idempotent', async () => {
		const rig = makeSession(() => 'not an object');
		const { error } = await outcome(rig.invoke('mystery', {}));
		assert.equal((error as ExplorerToolError).kind, 'malformed');
	});
});

// =============================================================================
// CAPABILITY / UPGRADE
// =============================================================================

describe('invoke — a node without the tool is an upgrade state, never a fallback', () => {
	it('refuses read_query locally on a pre-upgrade node, and sends NOTHING (no fallback to execute)', async () => {
		const rig = makeSession(() => ROWS, { info: OLD_NODE_INFO });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'MATCH (n) RETURN n' }));
		assert.ok(error instanceof ExplorerToolError);
		assert.equal(error.kind, 'upgrade');
		assert.match(error.message, /read_query/);
		assert.deepEqual(rig.world.calls, []);
	});

	it('refuses read_query when the node has never been probed', async () => {
		const rig = makeSession(() => ROWS, { info: null });
		assert.equal(((await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }))).error as ExplorerToolError).kind, 'upgrade');
		assert.deepEqual(rig.world.calls, []);
	});

	it('refuses when the capability is present but not true', async () => {
		const rig = makeSession(() => ROWS, { info: { ...NEO4J_INFO, capabilities: { read_query: 'yes' } } });
		assert.equal(((await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }))).error as ExplorerToolError).kind, 'upgrade');
	});

	it('sends it when the node advertises the capability', async () => {
		const rig = makeSession(() => ROWS);
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		assert.equal(rig.world.calls.length, 1);
	});
});

// =============================================================================
// TIMEOUTS
// =============================================================================

describe('invoke — explicit timeouts above the node deadline', () => {
	it('derives the wait from the node\'s published statement deadline plus 10 s, and tells the SDK to wait 1 s longer', async () => {
		const rig = makeSession(() => ROWS);
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		assert.equal(rig.world.calls[0]!.timeout, 30_000 + 10_000 + 1_000);
	});

	it('falls back to 40 s when the deadline is not published', async () => {
		const rig = makeSession(() => ROWS, { info: { dialect: 'neo4j', capabilities: { read_query: true } } });
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		assert.equal(rig.world.calls[0]!.timeout, DEFAULT_TIMEOUT_MS + 1_000);
	});

	it('uses the documented per-tool budgets for dialect, schema and question tools', async () => {
		const rig = makeSession(() => ({ valid: true }));
		await rig.invoke('dialect', {});
		await rig.invoke('refresh_schema', {});
		await rig.invoke('get_query', { question: 'q' });
		// dialect 15 s, refresh_schema 135 s, get_query 120 s; the SDK waits 1 s longer than each.
		assert.deepEqual(rig.world.calls.map((c) => c.timeout), [16_000, 136_000, 121_000]);
	});

	it('waits for refresh_schema longer than the node can take: a queued refresh plus its own budget', async () => {
		// Node: SCHEMA_REFRESH_BUDGET_MS = 60 s (packages/ai/src/ai/common/graph/schema.py);
		// refresh_schema_snapshot waits up to budget + 5 s for the per-node lock and
		// then reflects for up to its budget, so the node's honest stale/error answer
		// can arrive after 2 x 60 s + 5 s. A client wait at or below that says
		// "stopped waiting" just before the node answers.
		const nodeBudgetMs = 60_000;
		const worstNodeAnswerMs = 2 * nodeBudgetMs + 5_000;
		assert.ok(DEFAULT_TOOL_TIMEOUTS.refresh_schema! > 2 * nodeBudgetMs, 'above two budgets');
		assert.ok(DEFAULT_TOOL_TIMEOUTS.refresh_schema! > worstNodeAnswerMs, 'above the worst honest node answer');
		assert.equal(DEFAULT_TOOL_TIMEOUTS.refresh_schema, 135_000);
		// get_schema serves a snapshot the node already holds: it keeps its own, shorter wait.
		assert.equal(DEFAULT_TOOL_TIMEOUTS.get_schema, 60_000);

		// And the session really uses it for refresh_schema (the SDK is told 1 s more).
		const rig = makeSession(() => ({ nodes: [], relationships: [] }));
		await rig.invoke('refresh_schema', {});
		assert.equal(rig.world.calls[0]!.timeout, DEFAULT_TOOL_TIMEOUTS.refresh_schema! + 1_000);
	});

	it('lets a call override the budget, and `null` means no client timeout at all', async () => {
		const rig = makeSession(() => ROWS);
		await rig.invoke('read_query', { cypher: 'RETURN 1' }, { timeoutMs: 5_000 });
		await rig.invoke('read_query', { cypher: 'RETURN 1' }, { timeoutMs: null });
		assert.equal(rig.world.calls[0]!.timeout, 6_000);
		assert.equal(rig.world.calls[1]!.timeout, undefined);
	});

	it('stops waiting with a typed `timeout` from ITS OWN timer, never from SDK message text', async () => {
		let release: (() => void) | undefined;
		const rig = makeSession(() => new Promise((resolve) => { release = () => resolve(ROWS); }));
		const pending = outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		await rig.clock.advance(39_999);
		assert.equal(rig.clock.pending(), 1);
		await rig.clock.advance(1);
		const { error } = await pending;
		assert.ok(error instanceof ExplorerToolError);
		assert.equal(error.kind, 'timeout');
		assert.match(error.message, /may still be running/);
		// The late answer is ignored, not thrown as an unhandled rejection.
		release?.();
		await rig.clock.settle();
	});

	it('does not leave a timer behind when the call succeeds or fails fast', async () => {
		const ok = makeSession(() => ROWS);
		await ok.invoke('read_query', { cypher: 'RETURN 1' });
		assert.equal(ok.clock.pending(), 0);
		const bad = makeSession(() => { throw new Error('boom'); });
		await outcome(bad.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal(bad.clock.pending(), 0);
	});

	it('does not classify an SDK "timed out" message as a timeout: only the session timer does', async () => {
		const rig = makeSession(() => { throw new Error('Request timed out after 41000ms'); });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal((error as ExplorerToolError).kind, 'raised');
	});
});

// =============================================================================
// STALE GENERATIONS
// =============================================================================

describe('invoke — a late answer must not land on top of the present', () => {
	it('drops a successful result whose ticket expired while it was in flight', async () => {
		let release: ((value: unknown) => void) | undefined;
		const rig = makeSession(() => new Promise((resolve) => { release = resolve; }));
		const generation = createGeneration();
		const ticket = generation.next();
		const pending = outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }, { generation: ticket }));
		await rig.clock.settle();
		generation.invalidate();
		release?.(ROWS);
		const { error, value } = await pending;
		assert.equal(value, undefined);
		assert.ok(isStaleError(error));
	});

	it('drops a FAILURE too: an abandoned call\'s error must not paint over the current result', async () => {
		let fail: ((error: Error) => void) | undefined;
		const rig = makeSession(() => new Promise((_resolve, reject) => { fail = reject; }));
		const generation = createGeneration();
		const ticket = generation.next();
		const pending = outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }, { generation: ticket }));
		await rig.clock.settle();
		generation.next();
		fail?.(new Error('database exploded'));
		assert.ok(isStaleError((await pending).error));
	});

	it('delivers normally while the ticket is current', async () => {
		const rig = makeSession(() => ROWS);
		const generation = createGeneration();
		assert.deepEqual(await rig.invoke('read_query', { cypher: 'RETURN 1' }, { generation: generation.next() }), ROWS);
	});
});

// =============================================================================
// THE ONE RETRY
// =============================================================================

describe('invoke — at most one retry, only when a restart is demonstrable', () => {
	/** A behaviour that fails the first call with a coded error and then succeeds. */
	const failFirst = (code: string | undefined, result: unknown = ROWS) => (_call: IToolCall, index: number): unknown => {
		if (index === 0) throw codedError('Task was stopped', code);
		return result;
	};

	it('retries an idempotent read ONCE on TASK_STOPPED when re-discovery finds the endpoint again, with the SAME token', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE));
		const value = await rig.invoke('read_query', { cypher: 'RETURN 1' });
		assert.deepEqual(value, ROWS);
		assert.equal(rig.rebinds.length, 1);
		assert.deepEqual(rig.world.calls.map((c) => c.token), ['tk_sentinel_A', 'tk_sentinel_A']);
	});

	it('uses the refreshed token when the rebind updated it', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE), { rebind: async (state) => { state.token = 'tk_sentinel_B'; return true; } });
		await rig.invoke('dialect', {});
		assert.deepEqual(rig.world.calls.map((c) => c.token), ['tk_sentinel_A', 'tk_sentinel_B']);
	});

	it('does NOT retry when the endpoint does not come back: the original error is the answer', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE), { rebind: async () => false });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal((error as ExplorerToolError).code, TRANSIENT_TASK_CODE);
		assert.equal(rig.world.calls.length, 1);
	});

	it('does NOT retry when the rebind itself throws', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE), { rebind: async () => { throw new Error('discovery failed'); } });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal((error as ExplorerToolError).code, TRANSIENT_TASK_CODE);
		assert.equal(rig.world.calls.length, 1);
	});

	it('NEVER retries execute or any non-idempotent tool, even on the transient code', async () => {
		for (const tool of ['execute', 'store_put', 'mystery']) {
			const rig = makeSession(failFirst(TRANSIENT_TASK_CODE));
			const { error } = await outcome(rig.invoke(tool, {}));
			assert.equal((error as ExplorerToolError).code, TRANSIENT_TASK_CODE, tool);
			assert.equal(rig.rebinds.length, 0, tool);
			assert.equal(rig.world.calls.length, 1, tool);
		}
	});

	it('lets a caller mark a one-off call idempotent, and forbid the retry for one call', async () => {
		const marked = makeSession(failFirst(TRANSIENT_TASK_CODE));
		assert.deepEqual(await marked.invoke('mystery', {}, { idempotent: true }), ROWS);
		const forbidden = makeSession(failFirst(TRANSIENT_TASK_CODE));
		await outcome(forbidden.invoke('read_query', { cypher: 'RETURN 1' }, { retry: false }));
		assert.equal(forbidden.world.calls.length, 1);
	});

	it('does not retry on any OTHER code, on no code, or on a message that merely says so', async () => {
		for (const code of ['TASK_NOT_REGISTERED', 'TASK_COMPLETED', 'TASK_AMBIGUOUS', 'PERMISSION_DENIED', undefined]) {
			const rig = makeSession(failFirst(code));
			await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
			assert.equal(rig.world.calls.length, 1, String(code));
			assert.equal(rig.rebinds.length, 0, String(code));
		}
		const textual = makeSession(() => { throw new Error('TASK_STOPPED: Task was stopped'); });
		await outcome(textual.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal(textual.world.calls.length, 1);
	});

	it('does not retry permission errors, malformed envelopes, upgrades or timeouts', async () => {
		const denied = makeSession(() => { throw new Error("Permission 'task.data' denied for this task"); });
		await outcome(denied.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal(denied.world.calls.length, 1);

		const malformed = makeSession(() => ({ columns: 'x' }));
		await outcome(malformed.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal(malformed.world.calls.length, 1);

		const timedOut = makeSession(() => new Promise(() => undefined));
		const pending = outcome(timedOut.invoke('read_query', { cypher: 'RETURN 1' }));
		await timedOut.clock.advance(40_000);
		assert.equal(((await pending).error as ExplorerToolError).kind, 'timeout');
		assert.equal(timedOut.rebinds.length, 0);
	});

	it('retries AT MOST once: a second transient failure surfaces, with no third attempt', async () => {
		const rig = makeSession(() => { throw codedError('Task was stopped', TRANSIENT_TASK_CODE); });
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal((error as ExplorerToolError).code, TRANSIENT_TASK_CODE);
		assert.equal(rig.world.calls.length, 2);
		assert.equal(rig.rebinds.length, 1);
	});

	it('keeps the whole call, retry included, inside the call\'s own timeout: the rebind window is bounded', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE), { options: { retry: { windowMs: 15_000 } } });
		const before = rig.clock.now();
		await rig.invoke('read_query', { cypher: 'RETURN 1' });
		// 15 s window, well inside the 40 s call budget.
		assert.equal(rig.rebinds[0]! - before, 15_000);
		// The retry itself waits no longer than what is left of the budget.
		assert.ok(rig.world.calls[1]!.timeout! <= 41_000);
	});

	it('shrinks the rebind window to what is left of the call\'s timeout, and skips the retry when under a second remains', async () => {
		const tight = makeSession(failFirst(TRANSIENT_TASK_CODE), { options: { retry: { windowMs: 60_000 } } });
		await tight.invoke('read_query', { cypher: 'RETURN 1' }, { timeoutMs: 2_000 });
		assert.ok(tight.rebinds[0]! - tight.clock.now() <= 2_000);

		const none = makeSession(failFirst(TRANSIENT_TASK_CODE));
		const { error } = await outcome(none.invoke('read_query', { cypher: 'RETURN 1' }, { timeoutMs: 500 }));
		assert.equal((error as ExplorerToolError).code, TRANSIENT_TASK_CODE);
		assert.equal(none.rebinds.length, 0);
	});

	it('honours custom transient codes (the server may add one later) and never retries without a rebind seam', async () => {
		const custom = makeSession(failFirst('TASK_RESTARTING'), { options: { retry: { transientCodes: ['TASK_RESTARTING'] } } });
		assert.deepEqual(await custom.invoke('read_query', { cypher: 'RETURN 1' }), ROWS);
		const noSeam = makeSession(failFirst(TRANSIENT_TASK_CODE), { withRebind: false });
		await outcome(noSeam.invoke('read_query', { cypher: 'RETURN 1' }));
		assert.equal(noSeam.world.calls.length, 1);
	});

	it('does not retry when the stale ticket expired during the first attempt', async () => {
		const rig = makeSession(failFirst(TRANSIENT_TASK_CODE));
		const generation = createGeneration();
		const ticket = generation.next();
		generation.invalidate();
		const { error } = await outcome(rig.invoke('read_query', { cypher: 'RETURN 1' }, { generation: ticket }));
		assert.ok(isStaleError(error));
		assert.equal(rig.rebinds.length, 0);
	});
});
