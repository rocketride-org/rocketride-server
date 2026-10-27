// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL FRAMES: the REMOTE env, the console and document frames' wiring
// across realms, identity close-out and host:connection (T2, T3, T7, T8, R8,
// R9, R11) over the REAL shell modules, as plain functions (R15)
// =============================================================================

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { codedError, projectRows, vectorComponents } from 'shared/explorer/connect/testing';
import type { IExplorerEndpoint } from 'shared/explorer';
import { jsonByteLength } from 'shared/explorer/devtool/state';
import { SUMMON_EVENT, SUMMON_GRACE_MS, SUMMON_SETTLE_MS } from 'shared/explorer/devtool/summon';
import { createDevToolHarness, shellProtocol } from 'shared/explorer/devtool/testing';
import type { ToolChannel } from 'shell';
import { callVector, fetchChunks, fetchDocument, fetchStats, scoreChunks } from '../src/adapters/actions';
import { connectionCaches, vectorEndpoints } from '../src/adapters/explorer';
import { connectionEntry, existingEntry, recommendExamples, reviewedDocuments, savedFilters, savedViews } from '../src/adapters/connections';
import { chatSessionFor, heldConnections, ingestQueueFor } from '../src/chat/registry';
import { CHAT_AND_INGEST_CACHE } from '../src/ingest/useIngest';
import type { IConnectionEntry } from '../src/adapters/connections';
import { remoteChannel } from '../src/devtool/frame';
import { CONTROLLER_NOT_READY_TEXT } from '../src/devtool/frameText';
import { EVENT, OP, STATE, VECTOR_APP_ID, VERSIONS_STATE_BYTES, field } from '../src/devtool/protocol';
import type { IDocVersion, IQueryHint } from '../src/devtool/protocol';
import { DEVTOOL_CHAT_NOTE, DEVTOOL_UPLOADS_NOTE, NO_CHANNELS } from '../src/env';
import { buildConsoleModel } from '../src/vector/consoleModel';
import { consoleUri, documentUri } from '../src/vector/addresses';
import { chunkTextScope, createChunkTextCache } from '../src/components/ChunkTextPanel';
import { createCacheRegistry } from '../src/vector/identityChange';
import { DEFAULT_LIMITS, readDialect } from '../src/vector/results';
import { NO_STAGED, stage } from '../src/vector/staged';
import { fixture } from './support/fixtures';
import { account, disposeAll, latestStateMap, mountController, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import { mountFrame } from './support/devtoolFrame';
import type { ToolBehaviour } from './support/vectorWorld';

afterEach(disposeAll);

const ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';

/** A signed-in VS Code realm, its controller and one frame of `docKey`, with discovery and the probe seen by the frame. */
async function connected(docKey: string | ((key: string) => string) | undefined, over: Partial<Record<string, ToolBehaviour>> = {}) {
	const engine = vscodeRealm(over);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm);
	mounted.h.setHostConnection(true);
	await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'discovery and the probe');
	const key = mounted.controller.store.getState().endpoints[0].key;
	const resolved = typeof docKey === 'function' ? docKey(key) : docKey;
	const framed = mountFrame(mounted.h, resolved, { hintDelayMs: 0 });
	await until(() => framed.frame.endpoints.get().endpoints.length === 1 && Object.keys(framed.frame.endpoints.get().probes).length === 1 && framed.frame.controllerReady.get(), 'the frame to see the connection');
	const endpoint = framed.frame.endpoints.get().endpoints[0];
	return { engine, mounted, ...mounted, ...framed, key, endpoint };
}

/** One connection's objects in a frame, as its view would make them. */
function entryOf(run: Awaited<ReturnType<typeof connected>>): IConnectionEntry {
	const probe = run.frame.endpoints.get().probes[run.key];
	const limits = (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS;
	return run.frame.env(true).connection(run.endpoint, limits);
}

describe('T3 / T2 - a frame\'s REMOTE env calls every tool through the controller, holding no client', () => {
	it('the console controller of a frame reads the store through ops: stats, the listing, the chunks; the engine call is the controller realm\'s', async () => {
		const run = await connected((key) => consoleUri(key));
		// The store singleton of the full app is never touched by a frame.
		const real = { session: vectorEndpoints.session, probe: vectorEndpoints.probe, refresh: vectorEndpoints.refresh, channel: vectorEndpoints.channel };
		const touched: string[] = [];
		vectorEndpoints.session = () => { touched.push('session'); throw new Error('the app store'); };
		vectorEndpoints.probe = async () => { touched.push('probe'); return null; };
		vectorEndpoints.refresh = async () => { touched.push('refresh'); };
		vectorEndpoints.channel = () => { touched.push('channel'); throw new Error('the app store'); };
		try {
			const entry = entryOf(run);
			const before = run.engine.requests.length;
			entry.controller.open();
			await until(() => entry.controller.getState().stats.status === 'ready' && entry.controller.getState().directory.rows.length > 0, 'stats and the first page');
			entry.selection.selectDocument({ objectId: 'doc-1', path: 'a.md' });
			entry.controller.selectDocument('doc-1');
			await until(() => entry.controller.getState().chunks.status === 'ready', 'the chunks');
			const tools = run.engine.requests.slice(before).filter((r) => r.op === 'client.tool').map((r) => (r.params as { tool: string }).tool);
			assert.ok(tools.includes('stats') && tools.includes('list_documents') && tools.includes('chunks'), tools.join(', '));
			assert.deepEqual(touched, [], 'nothing in the frame reached the full app\'s store');
			entry.controller.dispose();
		} finally {
			Object.assign(vectorEndpoints, real);
		}
		assert.deepEqual(run.h.violations, []);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a failure envelope is unwrapped in the frame with its code; a raised failure is an equal ExplorerToolError; a stale ticket drops the answer', async () => {
		const run = await connected((key) => consoleUri(key), { chunks: () => fixture('chunks_in_trash'), stats: () => Promise.reject(codedError('Task is stopping', 'TASK_STOPPED')) });
		const caller = run.frame.env(true).session(run.endpoint);
		assert.ok(caller, 'a ready frame has a caller');
		await assert.rejects(fetchChunks(caller, run.endpoint.nodeId, { objectId: 'doc-1', afterChunk: -1, limit: 100 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'store' && error.code === 'IN_TRASH');
		await assert.rejects(fetchStats(caller, run.endpoint.nodeId, 'full'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'raised' && error.code === 'TASK_STOPPED' && error.tool === 'stats' && error.message === 'Task is stopping');
		let current = true;
		const pending = callVector(caller, run.endpoint.nodeId, 'list_documents', { cursor: null, limit: 10 }, { generation: { isCurrent: () => current } as never });
		current = false;
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(caller.invoke('stats', { mode: 'full' }, { nodeId: 'store_2' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', 'a frame cannot aim a call at another node');
		await assert.rejects(caller.invoke('upsert', {}, { nodeId: run.endpoint.nodeId }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade', 'a tool the protocol does not carry');
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the heat strip scores over the remote channel (embed on the embedding node, then neighbors); fetchDocument reads one row', async () => {
		const run = await connected((key) => documentUri(key, ID), { neighbors: () => fixture('neighbors_scope_scores') });
		const channels = run.frame.env(true).channels(run.endpoint);
		assert.ok(channels.tools, 'the remote tools channel');
		assert.equal(channels.chat, null, 'no chat in a dev-tool mount');
		assert.equal(channels.ingest, null, 'no uploads either');
		assert.equal(run.frame.env(true).channels(run.endpoint).tools, channels.tools, 'stable per connection');
		const scores = await scoreChunks({ caller: channels.tools, nodeId: 'store_1' }, { caller: channels.tools, nodeId: 'embed_1' }, [[ID, 0], [ID, 1]], 'where does the water come from?');
		assert.ok(Array.isArray(scores));
		const embed = run.engine.world.calls.filter((c) => c.tool === 'embed');
		assert.equal(embed.at(-1)?.nodeId, 'embed_1');
		const row = await fetchDocument(channels.tools, 'store_1', ID);
		assert.ok(row === null || typeof row.objectId === 'string');
		await assert.rejects(channels.tools.ask({}), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade' && error.message === DEVTOOL_CHAT_NOTE);
		await assert.rejects(channels.tools.sendFiles([]), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'upgrade' && error.message === DEVTOOL_UPLOADS_NOTE);
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the frame env is REMOTE: the console model loses chat and uploads with the notes; documents open through the host', async () => {
		const run = await connected((key) => consoleUri(key));
		const env = run.frame.env(true);
		assert.equal(env.kind, 'remote');
		assert.ok(env.degraded);
		const model = env.consoleModel(buildConsoleModel(run.endpoint, run.frame.endpoints.get().probes[run.key], null));
		assert.deepEqual(model.chat, { enabled: false, reason: DEVTOOL_CHAT_NOTE });
		assert.deepEqual(model.ingest, { enabled: false, reason: DEVTOOL_UPLOADS_NOTE });
		env.openConsole(run.endpoint);
		env.openDocument(run.endpoint, ID, 'docs/water.md', 7);
		assert.deepEqual(run.docs.opened, [{ key: consoleUri(run.key), title: 'Store' }, { key: documentUri(run.key, ID), title: 'water.md' }]);
		await until(() => (latestStateMap(run.h)[STATE.focusRequests]?.snapshot as Record<string, { chunkId: number }> | undefined)?.[run.key]?.chunkId === 7, 'the focus request');
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('the console frame: hints out, other frames\' writes and map requests in', () => {
	it('its query and median reach the controller as hints, and are sent again to a controller that remounted without them', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		entry.selection.setQuery('where does the water come from?');
		await until(() => (latestStateMap(run.h)[STATE.queries]?.snapshot as Record<string, IQueryHint> | undefined)?.[run.key]?.text === 'where does the water come from?', 'the query hint');
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		await until(() => typeof (latestStateMap(run.h)[STATE.consoleSummary]?.snapshot as Record<string, { medianChunks: number | null }> | undefined)?.[run.key]?.medianChunks === 'number', 'the median hint');

		// The controller remounts (a VS Code reconnect): it starts without the hints, and the console sends them again,
		// once (the retained map still shows the old controller's topics until the new one publishes, so the signals
		// on the wire are counted, and the map is read once everything settled).
		const signals = (name: string): number => run.h.wire.filter((e) => e.transient && e.topic === `tool:${VECTOR_APP_ID}:toSidebar` && (e.value as { name?: unknown } | null)?.name === name).length;
		assert.equal(signals('queryChanged'), 1, 'the premise: one hint so far');
		run.controller.dispose();
		const again = mountController(run.engine.cm, {}, run.h, run.mounted);
		await until(() => signals('queryChanged') === 2, 'the hint again, for the new controller');
		for (let i = 0; i < 4; i += 1) await settle();
		assert.equal(signals('queryChanged'), 2, 'once per controller, never a loop');
		assert.equal((latestStateMap(run.h)[STATE.queries]?.snapshot as Record<string, IQueryHint> | undefined)?.[run.key]?.text, 'where does the water come from?', 'the new controller holds it');
		unbind();
		entry.controller.dispose();
		run.frame.dispose();
		again.controller.dispose();
	});

	it('another frame\'s write makes it relist, refresh its figures, probe again, redraw the map and forget what left; its own write does not', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		// As the console view opens it (views/ConsoleView.tsx): the flag, then the first load.
		entry.opened = true;
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		entry.selection.selectDocument({ objectId: ID, path: 'a.md' });
		const writesBefore = entry.writes.get();

		// Another frame (a document frame) moves a document to the trash.
		const other = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => other.frame.controllerReady.get(), 'the other frame');
		const before = run.engine.requests.length;
		await other.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: other.frame.origin }, { timeoutMs: 30_000 });
		await until(() => entry.writes.get() === writesBefore + 1, 'the map to be told to draw again');
		await until(() => run.engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'the relist');
		const tools = run.engine.requests.slice(before).map((r) => (r.params as { tool?: string }).tool);
		assert.ok(tools.includes('stats') && tools.includes('dialect'), `full figures and a probe (${tools.join(', ')})`);
		assert.equal(entry.selection.getState().document, null, 'the trashed document is forgotten');

		// Its own write: the controller already relists (consoleStore); the bump with its origin changes nothing more.
		const own = entry.writes.get();
		entry.controller.setWritesEnabled(true);
		entry.controller.requestRemove([{ objectId: ID, path: 'a.md', chunks: 12 }]);
		assert.ok(entry.controller.getState().confirm, 'a confirmation, nothing sent');
		await entry.controller.confirmRemove();
		await until(() => (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key]?.origin === run.frame.origin, 'its own bump');
		await settle();
		assert.equal(entry.writes.get(), own + 1, 'one redraw: the controller\'s own (onWritten), none for its own bump');
		unbind();
		entry.controller.dispose();
		other.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a console that has not opened yet (its store has not answered as a vector store) lists nothing for another frame\'s write', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		assert.equal(entry.opened, false, 'the premise: the console has not opened');
		const other = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => other.frame.controllerReady.get(), 'the other frame');
		const before = run.engine.requests.length;
		await other.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: other.frame.origin }, { timeoutMs: 30_000 });
		await until(() => entry.writes.get() === 1, 'the map is still told');
		for (let i = 0; i < 4; i += 1) await settle();
		const tools = run.engine.requests.slice(before).map((r) => (r.params as { tool?: string }).tool).filter((t) => t !== 'soft_delete');
		assert.deepEqual(tools, [], `nothing listed or counted for a console that never opened (${tools.join(', ')})`);
		unbind();
		other.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('a map request (from a document frame) lands on its map once: highlight and the Map tab; a console mounted later finds nothing', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		const doc = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => doc.frame.endpoints.get().endpoints.length === 1 && doc.frame.controllerReady.get(), 'the document frame');
		const docEntry = doc.frame.env(true).connection(doc.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const actions = doc.frame.documentActions(docEntry);
		actions.showOnMap([[ID, 0], [ID, 1]], 'document');
		assert.deepEqual(doc.docs.opened.map((o) => o.key), [consoleUri(run.key)], 'the console is opened (or fronted)');
		await until(() => entry.tab.get() === 'map', 'the console to switch to its map');
		assert.deepEqual(entry.selection.getState().highlight, { source: 'document', keys: [[ID, 0], [ID, 1]] });
		await until(() => (latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, unknown> | undefined)?.[run.key] === undefined, 'taken, so the controller ends it');
		const later = mountFrame(run.h, consoleUri(run.key), { hintDelayMs: 0 });
		await until(() => later.frame.endpoints.get().endpoints.length === 1, 'a later console');
		const laterEntry = later.frame.env(true).connection(later.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const unbindLater = later.frame.bindConsole(laterEntry);
		await settle();
		assert.equal(laterEntry.tab.get(), 'overview', 'nothing to take: it stays on the tab a connection opens on');
		unbindLater();
		unbind();
		for (const f of [later, doc, run]) f.frame.dispose();
		run.controller.dispose();
	});

	it('a document frame caps a map request at the node\'s project_keys_max and says so', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const said: string[] = [];
		const actions = run.frame.documentActions(entry, (text) => said.push(text));
		actions.showOnMap(Array.from({ length: 250 }, (_, i) => [ID, i] as const), 'document');
		await until(() => Boolean((latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, { keys: unknown[] }> | undefined)?.[run.key]), 'the map request');
		assert.equal((latestStateMap(run.h)[STATE.mapRequests]?.snapshot as Record<string, { keys: unknown[] }>)[run.key].keys.length, 200);
		assert.ok(said.some((s) => /first 200/.test(s)), said.join(' / '));
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('a frame created while the controller is already ready (its retained state replayed synchronously on subscribe)', () => {
	it('does not read its state before it exists: it is created, says which document it is, and its hints flush', async () => {
		const run = await connected((key) => consoleUri(key));
		// rocket-ui's channel replays every retained topic SYNCHRONOUSLY inside onState (the ToolChannel contract), so a
		// frame opened after the controller is ready hears `ready` while createVectorFrame is still running. The
		// harness's fresh channel holds nothing yet; this one replays what the realm already retained, as rocket-ui's does.
		const inner = shellProtocol.createToolChannel(run.h.newFramePeer());
		const sent: Array<[string, unknown]> = [];
		const replayed: string[] = [];
		const channel: ToolChannel = {
			publishState: (topic, snapshot) => inner.publishState(topic, snapshot),
			onState: (topic, cb) => {
				let retained: { snapshot: unknown } | null = null;
				run.frame.channel.onState(topic, (snapshot) => {
					retained = { snapshot };
				})();
				if (retained !== null) {
					replayed.push(topic);
					cb((retained as { snapshot: unknown }).snapshot);
				}
				return inner.onState(topic, cb);
			},
			sendEvent: (name, payload) => {
				sent.push([name, payload]);
				inner.sendEvent(name, payload);
			},
			onEvent: (name, cb) => inner.onEvent(name, cb),
		};
		let second: ReturnType<typeof mountFrame> | null = null;
		assert.doesNotThrow(() => {
			second = mountFrame(run.h, consoleUri(run.key), { channel, hintDelayMs: 0 });
		}, 'creating the frame reads no state before it exists');
		const frame = (second as unknown as ReturnType<typeof mountFrame>).frame;
		assert.ok(replayed.length >= 3, `the premise: retained topics were replayed during creation (${replayed.join(', ')})`);
		assert.equal(frame.controllerReady.get(), true, 'ready at once, from the replay');
		assert.ok(
			sent.some(([name, payload]) => name === EVENT.active && field(payload, 'docKey') === consoleUri(run.key)),
			'it told the ready controller which document it is'
		);
		// Its hints flush once its console binds: the query the console shows goes to the controller.
		const probe = frame.endpoints.get().probes[run.key];
		const entry = frame.env(true).connection(run.endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
		const unbind = frame.bindConsole(entry);
		entry.selection.setQuery('falcon water');
		assert.ok(
			sent.some(([name, payload]) => name === EVENT.queryChanged && field(payload, 'text') === 'falcon water'),
			'the hint is sent'
		);
		unbind();
	});
});

describe('the document frame: its focus, the console\'s query and median, and writes from anywhere', () => {
	it('a chunk focus for its document is taken once; one for another document is not; the console\'s query becomes its own', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const focused: Array<number | null> = [];
		const versions: IDocVersion[] = [];
		const unbind = run.frame.bindDocument(entry, ID, { focus: (chunkId) => focused.push(chunkId), version: (v) => versions.push(v) });
		const console = mountFrame(run.h, consoleUri(run.key), { hintDelayMs: 0 });
		await until(() => console.frame.endpoints.get().endpoints.length === 1 && console.frame.controllerReady.get(), 'the console frame');
		const consoleEntry = console.frame.env(true).connection(console.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const unbindConsole = console.frame.bindConsole(consoleEntry);
		console.frame.env(true).openDocument(run.endpoint, ID, 'a.md', 3);
		await until(() => focused.length === 1, 'the focus');
		assert.deepEqual(focused, [3]);
		assert.deepEqual(entry.selection.getState().chunk, [ID, 3]);
		console.frame.env(true).openDocument(run.endpoint, 'another-doc', 'b.md', 5);
		await settle();
		await settle();
		assert.deepEqual(focused, [3], 'a focus for another document is not taken');
		// B5: a row's "open" (no chunk) is the press's arrival: taken once, with no chunk, and the chunk shown stays.
		console.frame.env(true).openDocument(run.endpoint, ID, 'a.md');
		await until(() => focused.length === 2, 'the arrival');
		assert.deepEqual(focused, [3, null]);
		assert.deepEqual(entry.selection.getState().chunk, [ID, 3]);
		consoleEntry.selection.setQuery('radio check-in');
		await until(() => entry.selection.getState().query === 'radio check-in', 'the console\'s query, for the heat strip');
		assert.equal(run.frame.summaries.get()[run.key]?.medianChunks, undefined, 'no summary until the console listed');

		// A write from the console reaches the document frame as a version to read again.
		await console.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: console.frame.origin }, { timeoutMs: 30_000 });
		await until(() => versions.length === 1, 'the version');
		assert.equal(versions[0].action, 'trash');
		assert.deepEqual(versions[0].gone, [ID]);
		unbindConsole();
		unbind();
		console.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('another frame\'s write takes the documents it moved out of the console\'s staged set; a document frame stages nothing and switches no tab', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		entry.staged.set(stage(NO_STAGED, [{ objectId: ID, path: 'a.md', chunks: 2 }, { objectId: 'kept', path: 'b.md', chunks: 1 }]));
		const doc = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => doc.frame.endpoints.get().endpoints.length === 1 && doc.frame.controllerReady.get(), 'the document frame');
		const docEntry = doc.frame.env(true).connection(doc.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const actions = doc.frame.documentActions(docEntry);
		assert.equal(actions.stageRemove, undefined, 'its Move to trash confirms in the document (D9)');
		assert.equal(actions.openTab, undefined, "the console's tabs are another frame's");
		assert.equal(actions.useAsQuery, undefined, 'and so is its Query tab (D9b)');
		await doc.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: doc.frame.origin }, { timeoutMs: 30_000 });
		await until(() => !entry.staged.get().has(ID), 'the moved document to leave the staged set');
		assert.deepEqual([...entry.staged.get().keys()], ['kept']);
		unbind();
		doc.frame.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('its own Move to trash goes through its own controller (an inline confirmation, then one op) and is a version it reads again too', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const versions: IDocVersion[] = [];
		const unbind = run.frame.bindDocument(entry, ID, { focus: () => undefined, version: (v) => versions.push(v) });
		entry.controller.setWritesEnabled(true);
		const actions = run.frame.documentActions(entry);
		actions.requestRemove([ID]);
		assert.equal(entry.controller.getState().confirm?.action, 'trash', 'the confirmation is the frame\'s own');
		assert.ok(!run.engine.world.calls.some((c) => c.tool === 'soft_delete'), 'nothing sent before Confirm');
		const before = run.engine.requests.length;
		await entry.controller.confirmRemove();
		assert.equal(run.engine.world.calls.filter((c) => c.tool === 'soft_delete').length, 1);
		await until(() => versions.length === 1, 'its own version');
		await settle();
		assert.ok(!run.engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'a document frame never lists the directory');
		unbind();
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('docVersions keeps every connection\'s stamp, however many documents its writes moved', () => {
	it('8 connections each trashing a full batch keep all 8 stamps under the budget, and a frame relists only for its own connection\'s write', async () => {
		const PROJECTS = 8;
		const rows = Array.from({ length: PROJECTS }, (_, i) => projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres'), { projectId: `vp-${i}` })).flat();
		const echo = (call: { input?: Record<string, unknown> }) => ({ success: true, object_ids: call.input?.object_ids, matched_chunks: 1, not_found: [] });
		const engine = vscodeRealm({ soft_delete: echo }, rows);
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === PROJECTS, 'discovery and the probes');
		const keys = mounted.controller.store.getState().endpoints.map((e) => e.key);
		const framed = mountFrame(mounted.h, documentUri(keys[0], ID), { hintDelayMs: 0 });
		await until(() => framed.frame.endpoints.get().endpoints.length === PROJECTS && Object.keys(framed.frame.endpoints.get().probes).length === PROJECTS && framed.frame.controllerReady.get(), 'the frame to see every connection');
		const endpoint = framed.frame.endpoints.get().endpoints.find((e) => e.key === keys[0]) as IExplorerEndpoint;
		const probe = framed.frame.endpoints.get().probes[keys[0]];
		const limits = (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS;
		const entry = framed.frame.env(true).connection(endpoint, limits);
		const relists: IDocVersion[] = [];
		const unbind = framed.frame.bindDocument(entry, ID, { focus: () => undefined, version: (v) => relists.push(v) });
		const batch = (i: number) => Array.from({ length: limits.write_ids_max }, (_, n) => `${String(i).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`);
		const snapshot = () => (latestStateMap(mounted.h)[STATE.docVersions]?.snapshot ?? {}) as Record<string, IDocVersion>;
		const kept: number[] = [];
		const write = async (op: typeof OP.trash | typeof OP.restore, i: number, ids: string[]) => {
			await framed.frame.caller.callReply(op, { key: keys[i], input: { object_ids: ids }, origin: 'frame-x' }, { timeoutMs: 30_000 });
			await settle();
			kept.push(Object.keys(snapshot()).length);
		};

		for (let i = 0; i < PROJECTS; i += 1) await write(OP.trash, i, batch(i));
		const full = snapshot();
		assert.ok(jsonByteLength(full) <= VERSIONS_STATE_BYTES, `the snapshot is ${jsonByteLength(full)} bytes`);
		assert.deepEqual(full[keys[PROJECTS - 1]]?.gone, batch(PROJECTS - 1), 'the newest write keeps every document it moved');
		// Restores on the other connections: each a real write there; none is one on the frame's connection.
		for (let i = PROJECTS - 1; i >= 1; i -= 1) await write(OP.restore, i, [batch(i)[0]]);
		const last = snapshot();
		assert.deepEqual({ kept, relists: relists.length, stamps: keys.map((k) => last[k]?.version ?? null) }, {
			kept: [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 8, 8],
			relists: 1,
			stamps: [1, 2, 2, 2, 2, 2, 2, 2],
		}, 'every stamp stays in every snapshot; the frame relists once, for its own connection\'s trash');
		assert.deepEqual(relists[0].gone, batch(0), 'and learns what left from it');
		unbind();
		framed.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('docVersions across a controller remount: a new controller starts its counters again', () => {
	const ID2 = '2c4e8a10-7b1d-5f3a-9e6c-0d8b4a2f1e57';

	it('VS Code order (the host drops, the console rebinds while the old map is retained, the controller remounts): another frame\'s write still relists it and redraws its map', async () => {
		const run = await connected((key) => consoleUri(key));
		const entry = entryOf(run);
		const unbind = run.frame.bindConsole(entry);
		entry.opened = true;
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		const other = mountFrame(run.h, documentUri(run.key, ID), { hintDelayMs: 0 });
		await until(() => other.frame.controllerReady.get(), 'the other frame');
		await other.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: other.frame.origin }, { timeoutMs: 30_000 });
		await until(() => entry.writes.get() === 1, 'the first relist');
		assert.equal((latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key].version, 1, 'the premise: version 1');

		run.controller.dispose();
		run.h.setHostConnection(false);
		await settle();
		const entry2 = run.frame.env(true).connection(run.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		assert.notEqual(entry2, entry, 'the premise: the drop rebuilt the connection objects');
		assert.equal(run.frame.docVersions.get()[run.key]?.version, 1, 'the premise: the old controller\'s version is still retained when the console binds again');
		unbind();
		const unbind2 = run.frame.bindConsole(entry2);
		run.h.setHostConnection(true);
		const again = mountController(run.engine.cm, {}, run.h, run.mounted);
		await until(() => Object.keys(again.controller.store.getState().probes).length === 1, 'the remounted discovery');
		await until(() => other.frame.controllerReady.get() && run.frame.controllerReady.get(), 'readiness again');
		await until(() => Object.keys(run.frame.docVersions.get()).length === 0, 'the new controller\'s empty map');
		entry2.opened = true;
		entry2.controller.open();
		await until(() => entry2.controller.getState().directory.rows.length > 0, 'the listing again');
		for (let i = 0; i < 4; i += 1) await settle();
		const before = run.engine.requests.length;
		const writesBefore = entry2.writes.get();
		await other.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID2] }, origin: other.frame.origin }, { timeoutMs: 30_000 });
		await until(() => (latestStateMap(run.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[run.key]?.version === 1, 'the remounted controller\'s version 1');
		await until(() => entry2.writes.get() === writesBefore + 1, 'the console to redraw its map for the other frame\'s write');
		await until(() => run.engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'and to relist');
		unbind2();
		entry2.controller.dispose();
		other.frame.dispose();
		run.frame.dispose();
		again.controller.dispose();
	});

	it('with no host drop (a sidebar remount, a webview reload): a document frame is still told of the write after the remount', async () => {
		const run = await connected((key) => documentUri(key, ID));
		const entry = entryOf(run);
		const versions: IDocVersion[] = [];
		const unbind = run.frame.bindDocument(entry, ID, { focus: () => undefined, version: (v) => versions.push(v) });
		const console = mountFrame(run.h, consoleUri(run.key), { hintDelayMs: 0 });
		await until(() => console.frame.controllerReady.get(), 'the console frame');
		await console.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID2] }, origin: console.frame.origin }, { timeoutMs: 30_000 });
		await until(() => versions.length === 1, 'the first version');

		run.controller.dispose();
		await settle();
		const again = mountController(run.engine.cm, {}, run.h, run.mounted);
		await until(() => Object.keys(again.controller.store.getState().probes).length === 1, 'the remounted discovery');
		await until(() => console.frame.controllerReady.get() && run.frame.controllerReady.get(), 'readiness again');
		await until(() => Object.keys(run.frame.docVersions.get()).length === 0, 'the new controller\'s empty map');
		const seenBefore = versions.length;
		await console.frame.caller.callReply(OP.trash, { key: run.key, input: { object_ids: [ID] }, origin: console.frame.origin }, { timeoutMs: 30_000 });
		await until(() => versions.some((v, i) => i >= seenBefore && v.gone.includes(ID)), 'the document to be told of the write after the remount');
		unbind();
		console.frame.dispose();
		run.frame.dispose();
		again.controller.dispose();
	});
});

describe('a write the controller stopped waiting for (it may have run)', () => {
	it('the console that asked relists too: the bump names no frame, so no frame skips it as its own', async () => {
		let release: (() => void) | null = null;
		const engine = vscodeRealm({ soft_delete: () => new Promise((resolve) => { release = () => resolve(fixture('soft_delete_ok')); }) });
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { waits: { [OP.trash]: 50 } });
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'discovery and the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const framed = mountFrame(mounted.h, consoleUri(key), { hintDelayMs: 0 });
		await until(() => framed.frame.endpoints.get().endpoints.length === 1 && Object.keys(framed.frame.endpoints.get().probes).length === 1 && framed.frame.controllerReady.get(), 'the frame');
		const entry = framed.frame.env(true).connection(framed.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		const unbind = framed.frame.bindConsole(entry);
		entry.opened = true;
		entry.controller.open();
		await until(() => entry.controller.getState().directory.rows.length > 0, 'the listing');
		entry.controller.setWritesEnabled(true);
		entry.controller.requestRemove([{ objectId: ID, path: 'a.md', chunks: 12 }]);
		const before = engine.requests.length;
		const writesBefore = entry.writes.get();
		await entry.controller.confirmRemove();
		assert.equal(entry.controller.getState().removal.status, 'error', 'the premise: the frame heard a timeout');
		await until(() => (latestStateMap(mounted.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[key] !== undefined, 'the bump');
		assert.equal((latestStateMap(mounted.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>)[key].origin, '', 'no frame\'s origin');
		(release as unknown as () => void)();
		await until(() => engine.requests.slice(before).some((r) => (r.params as { tool?: string }).tool === 'list_documents'), 'the asking console to relist');
		assert.equal(entry.writes.get(), writesBefore + 1, 'and redraw its map');
		unbind();
		entry.controller.dispose();
		framed.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('a frame\'s reset clears its own objects; only an identity reset forgets its connection in the realm\'s caches', () => {
	it('rocket-ui (one realm): the full app\'s state for the SAME connection, and another connection\'s, survive a frame\'s host drop and unknown reset; an identity reset forgets the frame\'s connection only', async () => {
		const run = await connected((key) => consoleUri(key));
		const key = run.key;
		// The full app, in the same realm: its console objects, chat, uploads and per-connection caches for the frame's
		// connection, and another connection's saved filters. A frame never populates chat or uploads.
		const appEntry = connectionEntry(run.endpoint, null);
		appEntry.selection.selectDocument({ objectId: 'doc-app', path: 'app.md' });
		chatSessionFor(key, { ask: async () => ({}), makeQuestion: () => ({}), now: () => 0, announce: () => undefined } as never);
		ingestQueueFor(key, { canProbe: false, canCount: false, callTool: async () => ({}), sendFiles: async () => ({}), onDocumentsChanged: () => undefined, announce: () => undefined } as never);
		const appState = () => ({
			entry: existingEntry(key) === appEntry,
			document: appEntry.selection.getState().document?.objectId ?? null,
			chatAndUploads: heldConnections().includes(key),
			filters: savedFilters.has(key),
			views: savedViews.has(key),
			reviewed: reviewedDocuments.has(key),
			examples: recommendExamples.has(key),
			other: savedFilters.has('k1|app-only'),
		});
		const ALL_KEPT = { entry: true, document: 'doc-app', chatAndUploads: true, filters: true, views: true, reviewed: true, examples: true, other: true };
		savedFilters.set(key, [{ id: 'f-app', name: 'app', filter: {} } as never]);
		savedViews.set(key, [{ id: 'v-app', name: 'app' } as never]);
		reviewedDocuments.set(key, new Set(['doc-app']));
		recommendExamples.set(key, { positive: [], negative: [] } as never);
		savedFilters.set('k1|app-only', [{ id: 'f-other', name: 'other', filter: {} } as never]);
		assert.deepEqual(appState(), ALL_KEPT, 'the premise');
		const frameObjects = () => {
			const entry = entryOf(run);
			assert.equal(run.frame.connections.count(), 1);
			return entry;
		};

		let entry = frameObjects();
		const history = run.frame.env(true).queryHistory;
		assert.equal(history.persisted, false, 'a frame stores no history');
		history.record(key, { question: 'q', kind: 'semantic', at: 1, ms: 1, topK: 10, results: 1, outcome: 'rows' });
		assert.equal(history.entries(key).get().length, 1, 'recorded at once, in memory');
		entry.staged.set(stage(NO_STAGED, [{ objectId: 'doc-staged', path: 'a.md', chunks: 1 }]));
		run.h.setHostConnection(false);
		await until(() => run.frame.lastReset() === 'disconnected', 'the frame\'s host-drop reset');
		assert.equal(run.frame.connections.count(), 0, 'the frame\'s own objects are gone');
		assert.equal(history.entries(key).get().length, 1, 'a host drop keeps the Query history');
		assert.equal(entry.selection.getState().connectionKey, null, 'and reset');
		assert.deepEqual(appState(), ALL_KEPT, 'a host drop leaves the full app\'s state for the same connection alone');

		run.h.setHostConnection(true);
		await until(() => run.frame.connected.get() === true, 'the host back');
		entry = frameObjects();
		assert.deepEqual([...entry.staged.get().keys()], ['doc-staged'], "and the connection's new objects take back what was staged");
		run.engine.realm.root.disconnect();
		await until(() => run.frame.lastReset() === 'unknown', 'the frame\'s unknown reset');
		assert.equal(run.frame.connections.count(), 0, 'the frame\'s own objects are gone');
		assert.equal(entry.selection.getState().connectionKey, null, 'and reset');
		assert.deepEqual(appState(), ALL_KEPT, 'an unknown identity leaves the full app\'s state for the same connection alone');

		run.engine.realm.root.connect(account('u1'));
		await settle();
		entry = frameObjects();
		entry.staged.set(stage(NO_STAGED, [{ objectId: 'doc-staged', path: 'a.md', chunks: 1 }]));
		run.engine.realm.root.connect(account('u2'));
		await until(() => run.frame.lastReset() === 'identity', 'the frame\'s identity reset');
		assert.equal(run.frame.connections.count(), 0, 'the frame\'s own objects are gone');
		assert.equal(history.entries(key).get().length, 0, 'another identity: the Query history goes');
		assert.equal(entryOf(run).staged.get().size, 0, 'and so does what was staged');
		assert.deepEqual(appState(), { ...ALL_KEPT, filters: false, views: false, reviewed: false, examples: false },
			'an identity reset forgets the frame\'s connection in the per-connection caches; the app\'s registry, chat and uploads are the app\'s to clear, another connection is untouched');
		assert.ok(!connectionCaches.forgetKey('k1|nothing').includes(CHAT_AND_INGEST_CACHE), 'chat and uploads have no per-connection forget');
		connectionCaches.clearAll();
		run.frame.dispose();
		run.controller.dispose();
	});

	it('the chunk text cache forgets one connection\'s texts and keeps the others\'', async () => {
		const cache = createChunkTextCache();
		const text = (key: readonly [string, number]) => Promise.resolve({ ok: true as const, value: { key, text: 'chunk', length: 5 } as never });
		await cache.load(chunkTextScope('k1|a', 's-1'), ['doc', 0], text);
		await cache.load(chunkTextScope('k1|b', 's-1'), ['doc', 0], text);
		cache.forget('k1|a');
		assert.equal(cache.peek(chunkTextScope('k1|a', 's-1'), ['doc', 0]), undefined);
		assert.ok(cache.peek(chunkTextScope('k1|b', 's-1'), ['doc', 0]), 'another connection\'s text stays');
	});

	it('the chunk text cache drops a load in flight for the connection it forgets (or for every one, on clear) and keeps the others\' (NIT-5)', async () => {
		const cache = createChunkTextCache();
		const held = () => {
			let release: () => void = () => undefined;
			const fetch = (key: readonly [string, number]) => new Promise<never>((resolve) => { release = () => resolve({ ok: true, value: { key, text: 'chunk', length: 5 } } as never); });
			return { fetch, release: () => release() };
		};
		const a = held();
		const b = held();
		const loadA = cache.load(chunkTextScope('k1|a', 's-1'), ['doc', 0], a.fetch);
		const loadB = cache.load(chunkTextScope('k1|b', 's-1'), ['doc', 0], b.fetch);
		cache.forget('k1|a');
		a.release();
		b.release();
		await Promise.all([loadA, loadB]);
		assert.equal(cache.peek(chunkTextScope('k1|a', 's-1'), ['doc', 0]), undefined, 'the forgotten connection\'s answer is not kept');
		assert.ok(cache.peek(chunkTextScope('k1|b', 's-1'), ['doc', 0]), 'another connection\'s load in flight is kept');
		const c = held();
		const loadC = cache.load(chunkTextScope('k1|b', 's-2'), ['doc', 1], c.fetch);
		cache.clear();
		c.release();
		await loadC;
		assert.equal(cache.peek(chunkTextScope('k1|b', 's-2'), ['doc', 1]), undefined, 'a clear drops every load in flight');
	});

	it('the cache registry forgets one connection on request; a cache without a per-connection forget is left alone', () => {
		const caches = createCacheRegistry();
		const kept = new Map([['a', 1], ['b', 2]]);
		let cleared = 0;
		caches.register('keyed', () => kept.clear(), (key) => kept.delete(key));
		caches.register('whole only', () => { cleared += 1; });
		assert.deepEqual(caches.forgetKey('a'), ['keyed']);
		assert.deepEqual([...kept.keys()], ['b']);
		assert.equal(cleared, 0, 'a cache that can only clear everything is not cleared for one connection');
		assert.deepEqual(caches.names(), ['keyed', 'whole only']);
	});
});

describe('T7 - identity fails closed in every frame', () => {
	it('VS Code: account A -> disconnect -> reconnect -> account B closes the console and document frames and clears their caches; the landing only resets', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'discovery');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const consoleFrame = mountFrame(mounted.h, consoleUri(key));
		const docFrame = mountFrame(mounted.h, documentUri(key, ID));
		const landing = mountFrame(mounted.h, undefined);
		await until(() => [consoleFrame, docFrame, landing].every((f) => f.frame.guard.first() !== null), 'the frames to learn account A');
		const entry = consoleFrame.frame.env(true).connection(consoleFrame.frame.endpoints.get().endpoints[0], DEFAULT_LIMITS);
		assert.equal(consoleFrame.frame.connections.count(), 1);

		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		assert.deepEqual(consoleFrame.docs.closed, [], 'a drop alone closes nothing');
		mounted.h.setHostConnection(true);
		engine.realm.root.connect(account('u2'));
		await until(() => consoleFrame.docs.closed.length > 0 && docFrame.docs.closed.length > 0, 'the documents to close for account B');
		assert.deepEqual(consoleFrame.docs.closed, [consoleUri(key)]);
		assert.deepEqual(docFrame.docs.closed, [documentUri(key, ID)]);
		assert.equal(consoleFrame.frame.lastReset(), 'identity');
		assert.equal(consoleFrame.frame.connections.count(), 0, 'its connection objects are gone');
		assert.equal(entry.selection.getState().connectionKey, null, 'and their selection reset');
		assert.deepEqual(landing.docs.closed, [], 'the landing is never closed');
		assert.equal(landing.frame.lastReset(), 'identity');
		for (const f of [consoleFrame, docFrame, landing]) f.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T8 - host:connection false: frames send nothing and drop what they wait for', () => {
	it('pending calls reject, new calls are refused before sending, the env is not ready, has no caller, and the console says it is offline', async () => {
		let release: (() => void) | null = null;
		const run = await connected((key) => consoleUri(key), { sample: () => new Promise((resolve) => { release = () => resolve(fixture('sample_demo_1000')); }) });
		const caller = run.frame.env(true).session(run.endpoint);
		assert.ok(caller);
		const running = caller.invoke('sample', { n: 1000 }, { nodeId: run.endpoint.nodeId });
		await until(() => release !== null, 'the sample to reach the node');
		run.h.setHostConnection(false);
		await assert.rejects(running, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /may still have run/.test(error.message));
		await settle();
		assert.equal(run.frame.connected.get(), false);
		const env = run.frame.env(run.frame.connected.get() === true);
		assert.equal(env.ready, false, 'nothing may be sent');
		assert.equal(env.session(run.endpoint), null);
		assert.deepEqual(env.channels(run.endpoint), NO_CHANNELS);
		assert.equal(run.frame.lastReset(), 'disconnected', 'the frame cleared its caches');
		const posted = run.h.wire.length;
		await assert.rejects(run.frame.caller.callReply(OP.probe, { key: run.key }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(run.h.wire.length, posted, 'refused before anything was posted');
		const entry = env.connection(run.endpoint, DEFAULT_LIMITS);
		entry.controller.refresh();
		await settle();
		assert.match(entry.controller.getState().stats.error?.headline ?? '', /Not connected to the server/, 'a console call made offline says so');
		(release as unknown as () => void)();
		assert.equal(run.controller.env(false).ready, false, 'the sidebar follows the realm\'s isConnected');
		assert.equal(run.controller.env(false).session(run.endpoint), null);
		entry.controller.dispose();
		run.frame.dispose();
		run.controller.dispose();
	});
});

describe('F11/F12 - a frame summons a missing controller on purpose, and follows the sign-in', () => {
	it('one reserved, non-op summon event after the settle; "unanswered" only after the grace; a call never sent says to open the sidebar', async () => {
		const h = createDevToolHarness(VECTOR_APP_ID, { json: true });
		h.setHostConnection(true);
		const { frame, timers } = mountFrame(h, consoleUri('k1|a'));
		const signalled = (name: string): number => h.wire.filter((e) => e.transient && e.topic === `tool:${VECTOR_APP_ID}:toSidebar` && (e.value as { name?: unknown } | null)?.name === name).length;
		await settle();
		assert.equal(frame.summon.get(), 'summoning');
		assert.equal(signalled(SUMMON_EVENT), 0);
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(signalled(SUMMON_EVENT), 1, 'the summon event, not a call and not an op name');
		assert.deepEqual(h.emitted.filter((e) => e.op === 'host.mountToolSidebar'), [{ op: 'host.mountToolSidebar', params: { appId: VECTOR_APP_ID } }]);
		timers.advance(SUMMON_GRACE_MS);
		assert.equal(frame.summon.get(), 'unanswered');
		assert.equal(frame.signIn.get(), 'pending', 'no controller has said anything about the account');
		frame.dispose();
	});

	it('a call the base caller never sent (no controller became ready) reads as "open the sidebar" and as unavailable; one that was sent keeps its own failure', async () => {
		const h = createDevToolHarness(VECTOR_APP_ID, { json: true });
		h.setHostConnection(true);
		const { frame } = mountFrame(h, consoleUri('k1|a'));
		await until(() => frame.connected.get() === true, 'the host connection');
		const notSent = await frame.caller.callReply(OP.probe, { key: 'k1|a' }, { timeoutMs: 30 }).then(() => null, (error: unknown) => error);
		assert.ok(notSent instanceof ExplorerToolError && / was not sent: /.test(notSent.message), `the premise: the base's own failure (${String((notSent as Error)?.message)})`);
		const endpoint = { key: 'k1|a', nodeId: 'store_1', components: [], roles: {} } as never;
		const noController = remoteChannel({ callReply: () => Promise.reject(notSent), controllerReady: () => false } as never, endpoint, () => null, 'f');
		await assert.rejects(noController.invoke('stats', { mode: 'full' }, { nodeId: 'store_1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.message === CONTROLLER_NOT_READY_TEXT && error.tool === 'stats', 'never sent, so it cannot have run');
		const lost = new ExplorerToolError({ kind: 'timeout', tool: 'vector.trash', message: "Lost the connection while 'vector.trash' was running. It may still have run; there is no way to cancel it from here." });
		const sent = remoteChannel({ callReply: () => Promise.reject(lost), controllerReady: () => false } as never, endpoint, () => null, 'f');
		await assert.rejects(sent.invoke('soft_delete', { object_ids: ['x'] }, { nodeId: 'store_1' }), (error: unknown) => error === lost, 'a write that was sent keeps "may still have run"');
		frame.dispose();
	});
});
