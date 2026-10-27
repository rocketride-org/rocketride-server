// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL PROTOCOL: every op, its timeouts, the write gate, sizes, deadlines
// (T3, T4, T10, T11, T13) over the REAL shell modules, JSON wire on
// =============================================================================
//
// The controller is driven by a frame's caller (the base's createFrameCaller
// over a real frame peer), exactly as a frame calls it.
// =============================================================================

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { ToolOpMap } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import { codedError } from 'shared/explorer/connect/testing';
import type { IToolCall } from 'shared/explorer/connect/testing';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { MAX_RETAINED_STATE_BYTES, MAX_RETAINED_TOTAL_BYTES, jsonByteLength } from 'shared/explorer/devtool/state';
import { assertJsonSafe, createDevToolHarness, manualNow } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness } from 'shared/explorer/devtool/testing';
import { BUS_TOOL_MARGIN_MS, FRAME_OP_MARGIN_MS, SDK_TIMEOUT_SLACK_MS } from 'shared/explorer/devtool/timeouts';
import { WRITE_REFUSED_TEXT } from '../src/devtool/controller';
import { CONTROLLER_LOCAL_OP_MS, ENDPOINTS_STATE_BYTES, EVENT, OP, RELAY_OP_MS, RESULT_CAPS, SAMPLE_BUDGET_CAP_MS, STATE, VECTOR_APP_ID, VERSIONS_STATE_BYTES, endpointsSnapshot, frameTimeoutFor, versionsSnapshot, waitFor } from '../src/devtool/protocol';
import type { IDocVersion, VectorOps } from '../src/devtool/protocol';
import { documentUri } from '../src/vector/addresses';
import { CODE_SENTENCES } from '../src/vector/wording';
import { fixture } from './support/fixtures';
import { account, disposeAll, latestStateMap, mountController, publishedStates, rocketRealm, settle, shellProtocol, signInVsCode, until, vscodeRealm } from './support/devtool';
import type { ToolBehaviour } from './support/vectorWorld';

afterEach(disposeAll);

/** A frame's raw caller over a real frame peer of the harness. */
function frameCaller(h: IDevToolHarness, now?: () => number, spy?: Array<{ op: string; timeoutMs: number | undefined; deadlineAt: number | undefined }>): IFrameCaller<VectorOps> {
	const peer = h.newFramePeer();
	const createToolController = spy
		? <O extends ToolOpMap>(p: DevToolPeer) => {
				const fn = shellProtocol.createToolController<O>(p);
				return ((op: string, params: unknown, options?: { timeoutMs?: number }) => {
					spy.push({ op, timeoutMs: options?.timeoutMs, deadlineAt: (params as { deadlineAt?: number })?.deadlineAt });
					return (fn as unknown as (o: string, pp: unknown, oo?: unknown) => Promise<unknown>)(op, params, options);
				}) as unknown as ReturnType<typeof shellProtocol.createToolController<O>>;
			}
		: shellProtocol.createToolController;
	return createFrameCaller<VectorOps>({ peer, channel: shellProtocol.createToolChannel(peer), createToolController, createToolChannel: shellProtocol.createToolChannel, ...(now ? { now } : {}) });
}

/** A signed-in VS Code realm, its controller and a frame's caller, with the first discovery and probe done. */
async function connected(over: Partial<Record<string, ToolBehaviour>> = {}, opts: Parameters<typeof mountController>[1] = {}) {
	const engine = vscodeRealm(over);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm, opts);
	mounted.h.setHostConnection(true);
	await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'discovery and the probe');
	const endpoint = mounted.controller.store.getState().endpoints[0];
	const caller = frameCaller(mounted.h);
	return { engine, ...mounted, endpoint, key: endpoint.key, caller };
}

/** A stored document of the fixtures (the write tests move it to the trash). */
const DOC_ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';

/** A generous frame timeout for calls whose timeout is not under test. */
const T = { timeoutMs: 30_000 };

/** The tool ops and an input each accepts (the frame passes the tool's own input). */
const TOOL_CALLS: Array<{ op: keyof VectorOps & string; tool: string; input: Record<string, unknown>; answer: string }> = [
	{ op: OP.stats, tool: 'stats', input: { mode: 'full' }, answer: 'stats_pgvector' },
	{ op: OP.list, tool: 'list_documents', input: { cursor: null, limit: 500, deleted: 'active', sort: 'path' }, answer: 'list_documents_page1' },
	{ op: OP.chunks, tool: 'chunks', input: { object_id: 'doc-1', after_chunk: -1, limit: 100, deleted: 'active' }, answer: 'chunks_page' },
	{ op: OP.sample, tool: 'sample', input: { n: 1000, mode: 'detailed', k: 15, seed: 7 }, answer: 'sample_demo_1000' },
	{ op: OP.project, tool: 'project', input: { sample_id: 's-1', vectors: [[0.1, 0.2]] }, answer: 'project_vector' },
	{ op: OP.neighbors, tool: 'neighbors', input: { key: ['doc-1', 0], k: 10 }, answer: 'neighbors_key' },
	{ op: OP.search, tool: 'search', input: { vector: [0.1, 0.2], top_k: 10 }, answer: 'search_vector' },
	{ op: OP.embed, tool: 'embed', input: { texts: ['where does the water come from?'], kind: 'query' }, answer: 'embed_ok' },
	{ op: OP.recommend, tool: 'recommend', input: { positive: [['doc-1', 0]], limit: 10 }, answer: 'recommend_ok' },
	{ op: OP.similarityMatrix, tool: 'similarity_matrix', input: { keys: [['doc-1', 0], ['doc-2', 0]] }, answer: 'similarity_matrix_ok' },
];

/** Every read tool answers its fixture. */
const READS: Partial<Record<string, ToolBehaviour>> = Object.fromEntries(TOOL_CALLS.map((c) => [c.tool, () => fixture(c.answer)]));

describe('T3 - every Vector op round-trips JSON-safe; failures come back as equal ExplorerToolErrors', () => {
	it('each tool op calls its tool once, on the right node, and answers the raw value; refresh, probe and the relays answer too', async () => {
		const run = await connected(READS);
		for (const call of TOOL_CALLS) {
			const before = run.engine.world.calls.length;
			const value = await run.caller.callReply(call.op, { key: run.key, input: call.input }, T);
			assert.deepEqual(value, fixture(call.answer), `${call.op} answers the tool's raw value`);
			const sent = run.engine.world.calls.slice(before);
			assert.deepEqual(sent.map((c) => c.tool), [call.tool], `${call.op} calls ${call.tool} once`);
			assert.deepEqual(sent[0].input, call.input, `${call.op} passes the frame's input as it is`);
			assert.equal(sent[0].nodeId, call.tool === 'embed' ? 'embed_1' : 'store_1', `${call.op} targets the node the controller resolves`);
			assert.match(sent[0].token, /_tools_1$/, 'through the anchor token');
		}
		assert.equal(await run.caller.callReply(OP.refresh, {}, T), null);
		const probe = await run.caller.callReply(OP.probe, { key: run.key }, T);
		assert.equal(probe?.ok, true);
		assert.deepEqual(probe?.info, fixture('dialect_pgvector'));
		assert.equal(await run.caller.callReply(OP.requestFocus, { key: run.key, docKey: documentUri(run.key, 'doc-1'), chunkId: 3 }, T), null);
		assert.equal(await run.caller.callReply(OP.showOnMap, { key: run.key, keys: [['doc-1', 0]], source: 'document' }, T), null);
		for (const [i, entry] of run.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		assert.deepEqual(run.h.violations, [], 'nothing JSON would change crossed the wire');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('a failure envelope is a VALUE (the frame unwraps it with its code); a raised failure is a Reply error the frame rebuilds', async () => {
		const run = await connected({ chunks: () => fixture('chunks_in_trash'), stats: () => Promise.reject(codedError('Task is stopping', 'TASK_STOPPED')) });
		const envelope = await run.caller.callReply(OP.chunks, { key: run.key, input: { object_id: 'doc-1', after_chunk: -1, limit: 100, deleted: 'active' } }, T);
		assert.deepEqual(envelope, fixture('chunks_in_trash'), 'IN_TRASH arrives as the envelope itself');
		await assert.rejects(run.caller.callReply(OP.stats, { key: run.key, input: { mode: 'full' } }, T), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'raised');
			assert.equal(error.code, 'TASK_STOPPED');
			assert.equal(error.tool, 'stats');
			assert.equal(error.message, 'Task is stopping');
			return true;
		});
		assert.deepEqual(run.h.violations, []);
		run.caller.dispose();
		run.controller.dispose();
	});

	it('an unknown or missing key, or a missing input, is refused as data and nothing is sent', async () => {
		const run = await connected();
		const calls = run.engine.world.calls.length;
		await assert.rejects(run.caller.callReply(OP.stats, { key: 'k1|nope', input: { mode: 'full' } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'unavailable');
		await assert.rejects(run.caller.callReply(OP.stats, { key: '', input: { mode: 'full' } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.stats, { key: run.key } as never, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		assert.equal(run.engine.world.calls.length, calls);
		run.caller.dispose();
		run.controller.dispose();
	});

	it('op and event names are disjoint (the op server would run an event named like an op), and every op is vector.*', () => {
		for (const name of Object.values(EVENT)) assert.ok(!(Object.values(OP) as string[]).includes(name), name);
		for (const op of Object.values(OP)) assert.match(op, /^vector\.[a-zA-Z]+$/);
		assert.deepEqual(Object.values(STATE).sort(), ['consoleSummary', 'docVersions', 'endpoints', 'focusRequests', 'identity', 'mapRequests', 'queries']);
	});
});

describe('T3 in one realm (rocket-ui: the bus carries values in process, no JSON image)', () => {
	it('a read, a write and a relay answer the same as over the JSON wire', async () => {
		const engine = rocketRealm(READS);
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm, {}, createDevToolHarness(VECTOR_APP_ID, { json: false }));
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'discovery and the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const caller = frameCaller(mounted.h);
		assert.deepEqual(await caller.callReply(OP.stats, { key, input: { mode: 'full' } }, T), fixture('stats_pgvector'));
		assert.deepEqual(await caller.callReply(OP.trash, { key, input: { object_ids: ['91ae15d4-3f6e-589f-bb81-72301f2ca1b6'] }, origin: 'f' }, T), fixture('soft_delete_ok'));
		assert.equal(await caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 0]], source: 'search' }, T), null);
		await assert.rejects(caller.callReply(OP.stats, { key: 'k1|nope', input: {} }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'unavailable');
		caller.dispose();
		mounted.controller.dispose();
	});
});

describe('T4 - timeouts: the frame always waits longer than the controller\'s own bus request', () => {
	it('each tool op: the controller asks the session for the protocol\'s wait, the bus for that + 6 s, and the frame passes that + 5 s', async () => {
		const clock = manualNow(1_700_000_000_000);
		const sent: Array<{ op: string; timeoutMs: number | undefined; deadlineAt: number | undefined }> = [];
		const engine = vscodeRealm(READS);
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { now: clock.now });
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'the probe');
		const endpoint = mounted.controller.store.getState().endpoints[0];
		const info = mounted.controller.store.getState().probes[endpoint.key]?.info ?? null;
		const caller = frameCaller(mounted.h, clock.now, sent);
		const before = engine.requests.length;
		for (const call of TOOL_CALLS) await caller.callReply(call.op, { key: endpoint.key, input: call.input }, { timeoutMs: frameTimeoutFor(call.op, info) });
		await caller.callReply(OP.probe, { key: endpoint.key }, { timeoutMs: frameTimeoutFor(OP.probe, info) });
		await caller.callReply(OP.refresh, {}, { timeoutMs: frameTimeoutFor(OP.refresh, info) });
		await caller.callReply(OP.requestFocus, { key: endpoint.key, docKey: documentUri(endpoint.key, 'doc-1'), chunkId: 1 }, { timeoutMs: frameTimeoutFor(OP.requestFocus, info) });

		const tools = engine.requests.slice(before).filter((r) => r.op === 'client.tool');
		const busOf = (tool: string): number => tools.find((r) => (r.params as { tool: string }).tool === tool)?.timeoutMs as number;
		const frameOf = (op: string): number => {
			const call = sent.find((s) => s.op === op);
			assert.ok(call, `${op} was sent`);
			assert.equal((call.deadlineAt as number) - clock.now(), call.timeoutMs, `${op}: the stamped deadline is exactly its timeout from now`);
			return call.timeoutMs as number;
		};
		const limits = (fixture('dialect_pgvector') as { limits: { statement_timeout_ms: number; sample_budget_ms: number } }).limits;
		const statement = limits.statement_timeout_ms + 10_000;
		const expected: Record<string, number> = { stats: statement, list_documents: statement, chunks: statement, project: statement, neighbors: statement, recommend: statement, similarity_matrix: statement, sample: limits.sample_budget_ms + 30_000, search: 60_000, embed: 60_000 };
		for (const call of TOOL_CALLS) {
			assert.equal(waitFor(call.op, info), expected[call.tool], `${call.op}: the session wait`);
			assert.equal(busOf(call.tool), expected[call.tool] + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, `${call.op}: the bus waits the session wait + SDK slack + bus margin`);
			assert.equal(frameOf(call.op), busOf(call.tool) + FRAME_OP_MARGIN_MS, `${call.op}: the frame waits the bus timeout + its margin`);
		}
		assert.equal(busOf('dialect'), 15_000 + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
		assert.equal(frameOf(OP.probe), busOf('dialect') + FRAME_OP_MARGIN_MS);
		assert.equal(frameOf(OP.refresh), CONTROLLER_LOCAL_OP_MS + FRAME_OP_MARGIN_MS, 'refresh STARTS discovery; its results arrive as state');
		assert.equal(frameOf(OP.requestFocus), RELAY_OP_MS + FRAME_OP_MARGIN_MS, 'a relay is answered from memory');
		for (const request of engine.requests) assert.ok(typeof request.timeoutMs === 'number' && request.timeoutMs > 0 && request.timeoutMs !== 120_000, `${request.op} names its own bus timeout, never the 120 s default`);
		caller.dispose();
		mounted.controller.dispose();
	});

	it('the sample wait follows the node\'s budget, capped at 300 s; without a published deadline a read waits 40 s', () => {
		const dialect = fixture('dialect_pgvector') as Record<string, unknown> & { limits: Record<string, unknown> };
		const withBudget = (ms: number) => ({ ...dialect, limits: { ...dialect.limits, sample_budget_ms: ms } });
		assert.equal(waitFor(OP.sample, withBudget(90_000)), 120_000);
		assert.equal(waitFor(OP.sample, withBudget(600_000)), SAMPLE_BUDGET_CAP_MS + 30_000, 'a budget above 300 s is capped');
		assert.equal(SAMPLE_BUDGET_CAP_MS, 300_000);
		const noDeadline = { ...dialect, limits: { ...dialect.limits, statement_timeout_ms: null } };
		assert.equal(waitFor(OP.stats, noDeadline), 40_000);
		assert.equal(waitFor(OP.stats, null), 40_000, 'no probe yet: the session default');
		assert.equal(waitFor(OP.sample, null), 60_000 + 30_000, 'the documented budget when none is published');
	});
});

describe('T10 - the write gate is the controller\'s, even when a frame calls the write ops directly', () => {
	const ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';
	const closed = (over: Record<string, unknown>): ToolBehaviour => () => ({ ...fixture<Record<string, unknown>>('dialect_pgvector'), ...over });

	it('allow_writes off: Move to trash, Restore and Delete permanently are refused with the rule\'s own code; nothing is sent and no version moves', async () => {
		const run = await connected({ dialect: closed({ allow_writes: false }) });
		for (const op of [OP.trash, OP.restore, OP.deletePermanently] as const) {
			await assert.rejects(run.caller.callReply(op, { key: run.key, input: { object_ids: [ID] }, origin: 'frame-a' }, T), (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError, op);
				assert.equal(error.kind, 'store');
				assert.equal(error.code, 'WRITES_DISABLED');
				assert.equal(error.message, CODE_SENTENCES.WRITES_DISABLED);
				return true;
			});
		}
		assert.ok(!run.engine.world.calls.some((c) => ['soft_delete', 'restore', 'delete'].includes(c.tool)), 'no write reached the node');
		await settle();
		assert.deepEqual(latestStateMap(run.h)[STATE.docVersions]?.snapshot ?? {}, {}, 'no version moved');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('a node that cannot soft-delete, or a store whose Tools source is not a tools node, is refused too', async () => {
		const noTrash = await connected({ dialect: closed({ capabilities: { ...(fixture('dialect_pgvector') as { capabilities: Record<string, unknown> }).capabilities, soft_delete: false } }) });
		await assert.rejects(noTrash.caller.callReply(OP.trash, { key: noTrash.key, input: { object_ids: [ID] }, origin: 'f' }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'unavailable' && /cannot move documents to the trash/.test(e.message));
		assert.ok(!noTrash.engine.world.calls.some((c) => c.tool === 'soft_delete'));
		noTrash.caller.dispose();
		noTrash.controller.dispose();
	});

	it('with the gate open: one soft_delete per call, never retried, and a version bump that names the write, what left and who asked', async () => {
		const run = await connected();
		const answer = await run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: 'frame-a' }, T);
		assert.deepEqual(answer, fixture('soft_delete_ok'), 'the raw answer');
		const sent = run.engine.world.calls.filter((c) => c.tool === 'soft_delete');
		assert.deepEqual(sent.map((c) => c.input), [{ object_ids: [ID] }]);
		await until(() => Boolean((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[run.key]), 'the version bump');
		const first = (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key];
		assert.deepEqual({ action: first.action, gone: first.gone, origin: first.origin }, { action: 'trash', gone: [ID], origin: 'frame-a' });
		await run.caller.callReply(OP.restore, { key: run.key, input: { object_ids: [ID] }, origin: 'frame-b' }, T);
		await until(() => (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].action === 'restore', 'the restore bump');
		const second = (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key];
		assert.notEqual(second.version, first.version);
		assert.deepEqual(second.gone, [], 'a restore takes nothing away');
		await run.caller.callReply(OP.deletePermanently, { key: run.key, input: { object_ids: [ID, '2c4e8a10-7b1d-5f3a-9e6c-0d8b4a2f1e57'], deleted_only: true }, origin: 'frame-a' }, T);
		const deleted = run.engine.world.calls.filter((c) => c.tool === 'delete');
		assert.deepEqual(deleted.map((c) => c.input), [{ object_ids: [ID, '2c4e8a10-7b1d-5f3a-9e6c-0d8b4a2f1e57'], deleted_only: true }], 'Empty trash sends deleted_only');
		await until(() => (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].action === 'empty', 'the empty bump');
		assert.deepEqual((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].gone, [ID], 'what Empty trash kept is not gone');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('a batch that is empty, above write_ids_max or not ids is refused before anything is sent; extra fields never reach a write tool', async () => {
		const run = await connected();
		const tooMany = Array.from({ length: 101 }, (_, i) => `doc-${i}`);
		for (const ids of [[], tooMany, [3], ['']]) {
			await assert.rejects(run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: ids }, origin: 'f' }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid', JSON.stringify(ids).slice(0, 40));
		}
		assert.ok(!run.engine.world.calls.some((c) => c.tool === 'soft_delete'));
		await run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID], filter: { everything: true } }, origin: 'f' }, T);
		assert.deepEqual(run.engine.world.calls.filter((c) => c.tool === 'soft_delete').map((c) => c.input), [{ object_ids: [ID] }]);
		run.caller.dispose();
		run.controller.dispose();
	});

	it('a write the controller stopped waiting for still bumps the version (it may have run); WRITE_REFUSED_TEXT names nothing internal', async () => {
		let release: (() => void) | null = null;
		const run = await connected({ soft_delete: () => new Promise((resolve) => { release = () => resolve(fixture('soft_delete_ok')); }) }, { waits: { [OP.trash]: 50 } });
		await assert.rejects(run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: 'f' }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'timeout');
		await until(() => Boolean((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[run.key]), 'a bump for a write that may have run');
		// The frame that asked ran no batch (it heard a timeout), so it must relist too: the bump names no frame.
		assert.equal((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].origin, '');
		(release as unknown as () => void)?.();
		assert.doesNotMatch(WRITE_REFUSED_TEXT, /vector\.|soft_delete|op\b/);
		run.caller.dispose();
		run.controller.dispose();
	});
});

describe('T10 - a write that ran is never reported as failed for its size', () => {
	it('an answer over the write cap is cut to what a frame reads, and the write stays the frame\'s own', async () => {
		const run = await connected({}, { resultCaps: { [OP.trash]: 256 } });
		assert.ok(JSON.stringify(fixture('soft_delete_ok')).length > 256, 'the premise: the node\'s answer is over the cap');
		const answer = await run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [DOC_ID] }, origin: 'frame-a' }, T);
		assert.deepEqual(answer, { success: true, object_ids: [DOC_ID], matched_chunks: 12, not_found: [] }, 'the fields the frame reads, without the audit block');
		await until(() => Boolean((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[run.key]), 'the bump');
		assert.equal((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].origin, 'frame-a', 'the frame relists itself, as for any write that answered');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('an answer still over the cap once cut is refused with its reason, and the bump names no frame (the asking one relists too)', async () => {
		const run = await connected({}, { resultCaps: { [OP.trash]: 16 } });
		await assert.rejects(run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [DOC_ID] }, origin: 'frame-a' }, T), (e: unknown) => e instanceof ExplorerToolError && e.code === 'RESULT_TOO_LARGE');
		assert.equal(run.engine.world.calls.filter((c) => c.tool === 'soft_delete').length, 1, 'the premise: the write ran');
		await until(() => Boolean((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[run.key]), 'the bump');
		assert.equal((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].origin, '');
		run.caller.dispose();
		run.controller.dispose();
	});
});

describe('T11 - no bulk result is retained state, and sizes are guarded', () => {
	it('after samples, listings, chunks, a removal, a focus and a map request, no snapshot holds a result, each is under 64 KiB and the map under 128 KiB', async () => {
		const run = await connected({ ...READS, sample: (call: IToolCall) => fixture(call.input?.mode === 'light' ? 'sample_light_5000' : 'sample_demo_1000') });
		const light = await run.caller.callReply(OP.sample, { key: run.key, input: { n: 5000, mode: 'light', k: 10 } }, T);
		assert.ok(jsonByteLength(light) > 500_000, 'the premise: a light sample of 5,000 points is large');
		await run.caller.callReply(OP.sample, { key: run.key, input: { n: 1000, mode: 'detailed', k: 15 } }, T);
		await run.caller.callReply(OP.list, { key: run.key, input: { cursor: null, limit: 500, deleted: 'active', sort: 'path' } }, T);
		await run.caller.callReply(OP.chunks, { key: run.key, input: { object_id: 'doc-1', after_chunk: -1, limit: 100, deleted: 'active' } }, T);
		await run.caller.callReply(OP.trash, { key: run.key, input: { object_ids: ['91ae15d4-3f6e-589f-bb81-72301f2ca1b6'] }, origin: 'f' }, T);
		await run.caller.callReply(OP.requestFocus, { key: run.key, docKey: documentUri(run.key, 'doc-1'), chunkId: 2 }, T);
		await run.caller.callReply(OP.showOnMap, { key: run.key, keys: Array.from({ length: 200 }, (_, i) => [`doc-${i}`, i] as [string, number]), source: 'document' }, T);
		await settle();
		const states = publishedStates(run.h);
		assert.ok(states.length > 0, 'the premise: state was published');
		const sampleMarkers = JSON.stringify(fixture('sample_demo_1000')).slice(200, 260);
		for (const { topic, snapshot } of states) {
			const text = JSON.stringify(snapshot);
			assert.ok(jsonByteLength(snapshot) <= MAX_RETAINED_STATE_BYTES, `${topic} is under the cap`);
			assert.doesNotMatch(text, /"knn"|"positions"|"chunks":\[\{|"content"/, `${topic} carries no result`);
			assert.ok(!text.includes(sampleMarkers), `${topic} carries no sample`);
		}
		const map = latestStateMap(run.h);
		assert.ok(jsonByteLength(map) <= MAX_RETAINED_TOTAL_BYTES, `the whole map is ${jsonByteLength(map)} bytes`);
		assert.deepEqual(run.errors.filter((e) => e.where === 'state'), [], 'the guard never had to degrade or withhold anything');
		// The snapshots are JSON images of the store's state (toWire), so check the source too: a Map or a Set in it would
		// be dropped silently on the way.
		assertJsonSafe(run.controller.store.getState(), 'the endpoint store\'s state');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('a result over its cap is refused as RESULT_TOO_LARGE with a reason, and not sent', async () => {
		const run = await connected(READS, { resultCaps: { [OP.sample]: 64 * 1024 } });
		await assert.rejects(run.caller.callReply(OP.sample, { key: run.key, input: { n: 1000 } }, T), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'invalid');
			assert.equal(error.code, 'RESULT_TOO_LARGE');
			assert.match(error.message, /too large to send to this window/);
			return true;
		});
		assert.ok(RESULT_CAPS[OP.sample] >= 1_500_000, 'the sample cap holds a 5,000-point light sample');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('argument caps refuse before any engine call: embed > 8 texts, neighbours scope > scope_keys_max, a matrix > matrix_keys_max, a map request > project_keys_max', async () => {
		const run = await connected(READS);
		const before = run.engine.requests.filter((r) => r.op === 'client.tool').length;
		const keys = (n: number) => Array.from({ length: n }, (_, i) => [`doc-${i}`, 0] as [string, number]);
		await assert.rejects(run.caller.callReply(OP.embed, { key: run.key, input: { texts: Array.from({ length: 9 }, () => 'q'), kind: 'query' } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.embed, { key: run.key, input: { texts: [], kind: 'query' } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.neighbors, { key: run.key, input: { vector: [0.1], scope_keys: keys(2001) } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.similarityMatrix, { key: run.key, input: { keys: keys(101) } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.showOnMap, { key: run.key, keys: keys(201), source: 'document' }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(run.caller.callReply(OP.list, { key: run.key, input: { cursor: null, limit: 501 } }, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		assert.equal(run.engine.requests.filter((r) => r.op === 'client.tool').length, before, 'nothing reached the bus');
		run.caller.dispose();
		run.controller.dispose();
	});

	it('the docVersions snapshot keeps every stamp before any `gone`, and gives `gone` back to the newest writes that fit', () => {
		const ids = (i: number) => Array.from({ length: 100 }, (_, n) => `${String(i).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`);
		const version = (i: number, gone: string[]): IDocVersion => ({ version: i + 1, epoch: 'e-1', action: 'trash', gone, origin: `f-${i}` });
		const all = new Map<string, IDocVersion>(Array.from({ length: 8 }, (_, i) => [`k1|proj-${i}|store_1`, version(i, ids(i))] as const));
		const shown = new Set(all.keys());
		const stamp = (v: IDocVersion | undefined) => v && { version: v.version, epoch: v.epoch, action: v.action, origin: v.origin };
		const small = new Map([['k1|a', version(0, ['x'])]]);
		assert.deepEqual(versionsSnapshot(small, shown, VERSIONS_STATE_BYTES), { 'k1|a': version(0, ['x']) }, 'under the budget: whole');

		const cut = versionsSnapshot(all, shown, VERSIONS_STATE_BYTES);
		assert.ok(jsonByteLength(cut) <= VERSIONS_STATE_BYTES, `${jsonByteLength(cut)} bytes`);
		for (const [key, v] of all) assert.deepEqual(stamp(cut[key]), stamp(v), `${key} keeps its stamp`);
		assert.deepEqual(cut['k1|proj-7|store_1'].gone, ids(7), 'the newest write keeps what it moved');
		assert.deepEqual(cut['k1|proj-0|store_1'].gone, [], 'the oldest gives its list up first');
		const withGone = [...all.keys()].filter((key) => cut[key].gone.length > 0);
		assert.deepEqual(withGone, [...all.keys()].slice(-withGone.length), 'the lists kept are the newest ones');

		// A budget too small for every stamp (the guard's shrink): the newest stamps that fit, still under the budget.
		const tight = versionsSnapshot(all, shown, 600);
		assert.ok(jsonByteLength(tight) <= 600, `${jsonByteLength(tight)} bytes`);
		const keptKeys = Object.keys(tight);
		assert.ok(keptKeys.length > 0 && keptKeys.includes('k1|proj-7|store_1'), 'the newest stamp is kept');
		for (const key of keptKeys) assert.deepEqual(stamp(tight[key]), stamp(all.get(key)));
		assert.ok(all.get('k1|proj-7|store_1') !== undefined && all.get('k1|proj-7|store_1')?.gone.length === 100, 'the controller\'s own entries are not changed');
	});

	it('the endpoints snapshot stays under its budget however many connections there are, and counts what it leaves out', () => {
		const endpoint = (i: number) => ({ key: `k1|dev|user|u1|team-1|proj-${i}|tools=tools_1|store_1`, legacyKey: null, projectId: `proj-${i}`, pipelineName: `Pipeline ${i}`, runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 'team-1', roles: { tools: { source: 'tools_1', nodeId: 'store_1' } }, missingRoles: [], source: 'tools_1', nodeId: 'store_1', nodeName: `Store ${i}`, provider: 'postgres', state: 'ready', running: true }) as never;
		const endpoints = Array.from({ length: 300 }, (_, i) => endpoint(i));
		const probes = Object.fromEntries(endpoints.map((e: { key: string }) => [e.key, { ok: true, info: fixture('dialect_pgvector'), dialect: 'vector' }]));
		const snap = endpointsSnapshot({ status: 'ready', endpoints, probes, error: null, refreshedAt: 1 });
		assert.ok(jsonByteLength(snap) <= ENDPOINTS_STATE_BYTES);
		assert.ok(snap.omitted > 0 && snap.omitted + snap.endpoints.length === 300, `${snap.omitted} left out and counted`);
		for (const e of snap.endpoints) assert.ok(snap.probes[e.key], 'every kept endpoint keeps its probe');
	});
});

describe('T4 / T13 on the wait path: a call that waited for discovery runs only inside what is left of its deadline', () => {
	/** A frame call held across a remount (the controller unmounts while it is on the bus), then a fresh controller. */
	async function heldAcrossRemount(op: 'vector.stats' | 'vector.trash', timeoutMs: number) {
		const clock = manualNow(2_000_000);
		const engine = vscodeRealm(READS);
		signInVsCode(engine.realm);
		const first = mountController(engine.cm, { now: clock.now });
		first.h.setHostConnection(true);
		await until(() => Object.keys(first.controller.store.getState().probes).length === 1, 'the probe');
		const key = first.controller.store.getState().endpoints[0].key;
		const caller = frameCaller(first.h, clock.now);
		await until(() => caller.controllerReady(), 'the readiness');
		const input = op === OP.trash ? { object_ids: [DOC_ID] } : { mode: 'full' };
		const call = caller.callReply(op, (op === OP.trash ? { key, input, origin: 'f' } : { key, input }) as never, { timeoutMs });
		first.controller.dispose();
		await settle();
		const before = engine.requests.length;
		// The fresh controller has discovered nothing: the held call waits for its discovery, inside the deadline.
		const again = mountController(engine.cm, { now: clock.now }, first.h, first);
		return { engine, caller, call, again, before };
	}

	it('a read: the session is asked for what is left of the deadline (less a margin), never the full wait', async () => {
		const run = await heldAcrossRemount(OP.stats, 20_000);
		assert.deepEqual(await run.call, fixture('stats_pgvector'));
		const stats = run.engine.requests.slice(run.before).find((r) => r.op === 'client.tool' && (r.params as { tool?: string }).tool === 'stats');
		assert.ok(stats, 'the read ran');
		// The deadline is 20 s from the (frozen) clock; the session gets 20 s less the 1 s margin, the bus 6 s more.
		assert.equal(stats.timeoutMs, 20_000 - 1_000 + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, 'bounded by the deadline, not the 40 s statement wait');
		run.caller.dispose();
		run.again.controller.dispose();
	});

	it('a write: sent with what is left of its deadline, so its answer (or "stopped waiting") reaches the frame before it gives up', async () => {
		const run = await heldAcrossRemount(OP.trash, 20_000);
		assert.deepEqual(await run.call, fixture('soft_delete_ok'));
		const trash = run.engine.requests.slice(run.before).find((r) => r.op === 'client.tool' && (r.params as { tool?: string }).tool === 'soft_delete');
		assert.equal(trash?.timeoutMs, 20_000 - 1_000 + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS, 'bounded by the deadline, not the 40 s write wait');
		run.caller.dispose();
		run.again.controller.dispose();
	});

	it('a write with less than a second of its deadline left is refused before anything is sent', async () => {
		const run = await heldAcrossRemount(OP.trash, 1_500);
		await assert.rejects(run.call, (e: unknown) => e instanceof ExplorerToolError && e.kind === 'unavailable' && /Nothing was sent/.test(e.message));
		assert.ok(!run.engine.world.calls.some((c) => c.tool === 'soft_delete'), 'the write never reached the node');
		run.caller.dispose();
		run.again.controller.dispose();
	});
});

describe('T13 - deadlines: an expired call never runs; an on-time one does', () => {
	it('a Delete permanently and a sample the PEER holds past their deadlines reach a remounted controller, which refuses them; an on-time held sample runs', async () => {
		const clock = manualNow(1_000_000);
		const engine = vscodeRealm(READS);
		signInVsCode(engine.realm);
		const first = mountController(engine.cm, { now: clock.now });
		first.h.setHostConnection(true);
		await until(() => Object.keys(first.controller.store.getState().probes).length === 1, 'the probe');
		const key = first.controller.store.getState().endpoints[0].key;
		const caller = frameCaller(first.h, clock.now);
		await until(() => caller.controllerReady(), 'the readiness');

		// The frame calls while the controller is ready; the controller unmounts while both calls are on the bus (a VS
		// Code disconnect): the real busPeer HOLDS them, and the frame gives up.
		const lateDelete = caller.callReply(OP.deletePermanently, { key, input: { object_ids: ['91ae15d4-3f6e-589f-bb81-72301f2ca1b6'] }, origin: 'f' }, { timeoutMs: 40 });
		const lateSample = caller.callReply(OP.sample, { key, input: { n: 1000 } }, { timeoutMs: 40 });
		first.controller.dispose();
		await assert.rejects(lateDelete, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		await assert.rejects(lateSample, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		assert.equal(caller.pending(), 0, 'the frame gave up on both');

		// Minutes pass, then the controller remounts (the host's channel and peer live on) and receives the held calls.
		clock.advance(5 * 60_000);
		const refused: string[] = [];
		const again = mountController(engine.cm, { now: clock.now, onError: (error, where) => refused.push(`${where}:${(error as { reason?: string }).reason ?? ''}`) }, first.h, first);
		await settle();
		assert.ok(!engine.world.calls.some((c) => c.tool === 'delete'), 'the expired delete never reached the node');
		assert.ok(!engine.world.calls.some((c) => c.tool === 'sample'), 'the expired sample never reached the node');
		assert.equal(refused.filter((r) => r === 'refused:expired').length, 2, 'both DID reach the controller, which refused them');

		// Control: the same race, with the remount inside the deadline: the held sample runs.
		await until(() => caller.controllerReady(), 'the remounted readiness');
		const onTime = caller.callReply(OP.sample, { key, input: { n: 1000 } }, { timeoutMs: 60_000 });
		again.controller.dispose();
		await settle();
		const third = mountController(engine.cm, { now: clock.now }, first.h, first);
		await until(() => Object.keys(third.controller.store.getState().probes).length === 1, 'the third controller\'s probe');
		assert.deepEqual(await onTime, fixture('sample_demo_1000'), 'the on-time held sample ran on the remounted controller');
		assert.equal(engine.world.calls.filter((c) => c.tool === 'sample').length, 1);
		caller.dispose();
		third.controller.dispose();
	});
});
