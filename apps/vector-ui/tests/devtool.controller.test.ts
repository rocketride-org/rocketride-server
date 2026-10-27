// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL CONTROLLER: one op server, a quiet sidebar, identity, the frames'
// hints and relays, and the sidebar's rows (T5, T6, T7, R6-R9, S1-S9) over the
// REAL shell modules
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { ExplorerToolError } from 'shared/explorer';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import { assertSidebarSubscribers, findToolFactoryImports } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness } from 'shared/explorer/devtool/testing';
import { NOT_DISCOVERED_TEXT, NOT_LISTED_TEXT } from '../src/devtool/controller';
import { FOCUS_MAX_AGE_MS, OP, QUERY_TEXT_MAX, STATE, VECTOR_APP_ID } from '../src/devtool/protocol';
import type { IFocusRequest, IMapRequest, IQueryHint, VectorOps } from '../src/devtool/protocol';
import { consoleUri, documentUri } from '../src/vector/addresses';
import { connectionRow, rowStatusText, sidebarListLine } from '../src/vector/connections';
import { fixture } from './support/fixtures';
import { account, disposeAll, latestStateMap, manualTimers, mountController, nonStatePosts, publishedStates, recordingDocuments, rocketRealm, settle, shellProtocol, signInVsCode, track, until, vscodeRealm } from './support/devtool';
import { createVectorController } from '../src/devtool/controller';
import { makeVectorEndpointStore } from '../src/adapters/explorer';
import { createDevToolHarness } from 'shared/explorer/devtool/testing';

afterEach(disposeAll);

const SRC = path.resolve(__dirname, '..', 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source without comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/** Every .ts/.tsx file under src. */
function allSources(): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) out.push({ path: path.relative(SRC, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
		}
	};
	walk(SRC);
	return out;
}

/** A frame's channel and caller over a new frame peer (what a frame mount builds). */
function frameSide(h: IDevToolHarness) {
	const peer = h.newFramePeer();
	const channel = shellProtocol.createToolChannel(peer);
	const caller = createFrameCaller<VectorOps>({ peer, channel, createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
	return { peer, channel, caller };
}

/** The snapshot of a topic in the latest republished map. */
function stateOf<T>(h: IDevToolHarness, topic: string): T | undefined {
	return latestStateMap(h)[topic]?.snapshot as T | undefined;
}

describe('T5 - mount -> dispose -> mount leaves one live op server; ops answered, events delivered, replays run nothing', () => {
	it('the remounted controller has exactly two live subscriptions, serves ops, follows the frames\' events, and a replayed hint executes nothing', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const first = mountController(engine.cm);
		assertSidebarSubscribers(first.spy, 'first vector controller');
		// StrictMode: mount, cleanup, mount (the host's channel lives on).
		first.controller.dispose();
		const second = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(second.spy, 'remounted vector controller');
		first.h.setHostConnection(true);
		await until(() => Object.keys(second.controller.store.getState().probes).length === 1, 'discovery and the probe');
		const key = second.controller.store.getState().endpoints[0].key;

		const frame = frameSide(first.h);
		await until(() => frame.caller.controllerReady(), 'the readiness');
		assert.equal((await frame.caller.callReply(OP.probe, { key }, { timeoutMs: 30_000 }))?.ok, true, 'an op is answered');
		frame.channel.sendEvent('active', { docKey: consoleUri(key) });
		await until(() => second.controller.activeConnection.get() === key, 'the frame\'s active event (activeDocKey is undefined in VS Code)');

		frame.channel.sendEvent('queryChanged', { key, nonce: 'q-1', text: 'where does the water come from?' });
		await until(() => stateOf<Record<string, IQueryHint>>(first.h, STATE.queries)?.[key]?.nonce === 'q-1', 'the query hint');
		await settle();
		const calls = engine.world.calls.length;
		const queryPublishes = publishedStates(first.h).filter((s) => s.topic === STATE.queries && (s.snapshot as Record<string, IQueryHint>)[key]?.nonce === 'q-1').length;

		// The REAL VS Code order: the controller unmounts on the disconnect, the host publishes host:connection true at
		// once on the reconnect, and only then does the controller remount (and is replayed the last frame event).
		second.controller.dispose();
		first.h.setHostConnection(false);
		first.h.setHostConnection(true);
		await settle();
		const third = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(third.spy, 'third vector controller');
		await until(() => Object.keys(third.controller.store.getState().probes).length === 1, 'the third controller\'s discovery');
		await settle();
		const afterReplay = engine.world.calls.filter((c, i) => i >= calls && c.tool !== 'dialect');
		assert.deepEqual(afterReplay, [], 'nothing the frame sent before ran again (only discovery probes)');
		assert.equal(stateOf<Record<string, IQueryHint>>(first.h, STATE.queries)?.[key], undefined, 'the replayed hint went to the op server, which drops events: the new controller starts without it');
		const second2 = publishedStates(first.h).filter((s) => s.topic === STATE.queries && (s.snapshot as Record<string, IQueryHint>)[key]?.nonce === 'q-1').length;
		assert.ok(second2 >= queryPublishes, 'the hint was published while it was live');
		assert.deepEqual(first.h.violations, []);
		frame.caller.dispose();
		third.controller.dispose();
	});

	it('a hint delivered twice (busPeer\'s signal and its retained slot) changes the state once; a repeated nonce or value is a no-op', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const frame = frameSide(mounted.h);
		await until(() => frame.caller.controllerReady(), 'the readiness');
		const changes = (topic: string): number => publishedStates(mounted.h).filter((s) => s.topic === topic).length;
		const beforeQueries = changes(STATE.queries);
		frame.channel.sendEvent('queryChanged', { key: 'k1|a', nonce: 'n-1', text: 'radio check-in' });
		frame.channel.sendEvent('queryChanged', { key: 'k1|a', nonce: 'n-1', text: 'radio check-in' });
		await settle();
		assert.equal(changes(STATE.queries) - beforeQueries, 1, 'one publish for one nonce');
		frame.channel.sendEvent('queryChanged', { key: 'k1|a', nonce: 'n-1', text: 'something else' });
		await settle();
		assert.equal(stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.text, 'radio check-in', 'a hint whose nonce was seen changes nothing');
		const beforeSummary = changes(STATE.consoleSummary);
		frame.channel.sendEvent('consoleSummary', { key: 'k1|a', medianChunks: 12 });
		frame.channel.sendEvent('consoleSummary', { key: 'k1|a', medianChunks: 12 });
		await settle();
		assert.equal(changes(STATE.consoleSummary) - beforeSummary, 1);
		assert.deepEqual(stateOf(mounted.h, STATE.consoleSummary), { 'k1|a': { medianChunks: 12 } });
		frame.channel.sendEvent('queryChanged', { key: 'k1|a', nonce: 'n-2', text: 'x'.repeat(QUERY_TEXT_MAX + 500) });
		await until(() => stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.nonce === 'n-2', 'the next query');
		assert.equal(stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.text?.length, QUERY_TEXT_MAX, 'a query text is capped');
		frame.channel.sendEvent('queryChanged', { key: 'k1|a', nonce: 'n-3', text: null });
		await until(() => stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.nonce === 'n-3', 'a cleared query');
		assert.equal(stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.text, null);
		frame.channel.sendEvent('queryChanged', { key: 7, nonce: 'n-4' });
		frame.channel.sendEvent('consoleSummary', { key: 'k1|a', medianChunks: 'many' });
		await settle();
		assert.equal(stateOf<Record<string, IQueryHint>>(mounted.h, STATE.queries)?.['k1|a']?.nonce, 'n-3', 'a malformed hint is ignored');
		assert.deepEqual(stateOf(mounted.h, STATE.consoleSummary), { 'k1|a': { medianChunks: 12 } });
		frame.caller.dispose();
		mounted.controller.dispose();
	});
});

describe('T5 - after a remount the controller\'s own events reach the frames too', () => {
	it('a relay served by a remounted controller (the host channel kept) is heard by a frame mounted before the remount', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const first = mountController(engine.cm);
		first.h.setHostConnection(true);
		await until(() => first.controller.store.getState().endpoints.length === 1, 'discovery');
		const key = first.controller.store.getState().endpoints[0].key;
		const frame = frameSide(first.h);
		const heard: unknown[] = [];
		frame.channel.onEvent('focusChunk', (payload) => heard.push(payload));
		await until(() => frame.caller.controllerReady(), 'the readiness');
		first.controller.dispose();
		const again = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(again.spy, 'remounted vector controller');
		await until(() => again.controller.store.getState().endpoints.length === 1, 'the remounted discovery');
		await until(() => frame.caller.controllerReady(), 'the new readiness');
		const docKey = documentUri(key, 'doc-1');
		await frame.caller.callReply(OP.requestFocus, { key, docKey, chunkId: 6 }, { timeoutMs: 10_000 });
		await until(() => heard.length === 1, 'the focusChunk event from the remounted controller');
		assert.equal((heard[0] as { chunkId?: number }).chunkId, 6);
		frame.caller.dispose();
		again.controller.dispose();
	});
});

describe('the relays: a document focus and a map request cross as ops, are retained with a nonce, and end once taken', () => {
	it('requestFocus publishes the request for its document and tells the frames; taking it (the active event) ends it', async () => {
		const timers = manualTimers();
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { schedule: timers.schedule });
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'discovery');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const frame = frameSide(mounted.h);
		const heard: unknown[] = [];
		frame.channel.onEvent('focusChunk', (payload) => heard.push(payload));
		await until(() => frame.caller.controllerReady(), 'the readiness');
		const docKey = documentUri(key, 'doc-1');
		await frame.caller.callReply(OP.requestFocus, { key, docKey, chunkId: 4 }, { timeoutMs: 10_000 });
		await until(() => Boolean(stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key]), 'the retained request');
		const request = stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)![key];
		assert.deepEqual({ docKey: request.docKey, chunkId: request.chunkId }, { docKey, chunkId: 4 });
		assert.equal(typeof request.nonce, 'string');
		await until(() => heard.length === 1, 'the focusChunk event');
		assert.deepEqual(heard[0], { docKey, chunkId: 4, nonce: request.nonce });
		frame.channel.sendEvent('active', { docKey, consumed: [request.nonce] });
		await until(() => stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key] === undefined, 'the request to end once taken');

		// One nobody takes ends at the age limit.
		await frame.caller.callReply(OP.requestFocus, { key, docKey, chunkId: 5 }, { timeoutMs: 10_000 });
		await until(() => stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key]?.chunkId === 5, 'a second request');
		timers.advance(FOCUS_MAX_AGE_MS);
		await until(() => stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key] === undefined, 'the age limit');
		await assert.rejects(frame.caller.callReply(OP.requestFocus, { key, docKey: documentUri('k1|another', 'doc-1'), chunkId: 1 }, { timeoutMs: 10_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid', 'a focus for another connection\'s document is refused');
		// B5: a press's arrival with no chunk (a row's "open") is a request too, retained and dropped at the same age.
		await frame.caller.callReply(OP.requestFocus, { key, docKey, chunkId: null }, { timeoutMs: 10_000 });
		await until(() => stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key]?.chunkId === null, 'the arrival');
		await until(() => heard.some((event) => (event as { chunkId?: unknown }).chunkId === null), 'its event');
		timers.advance(FOCUS_MAX_AGE_MS);
		await until(() => stateOf<Record<string, IFocusRequest>>(mounted.h, STATE.focusRequests)?.[key] === undefined, 'a short life: a frame restored later finds none');
		await assert.rejects(frame.caller.callReply(OP.requestFocus, { key, docKey, chunkId: 1.5 }, { timeoutMs: 10_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid', 'a chunk is still a whole number');
		frame.caller.dispose();
		mounted.controller.dispose();
	});

	it('showOnMap publishes the keys for the connection\'s console and tells it; taking it ends it', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'discovery');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const frame = frameSide(mounted.h);
		const heard: unknown[] = [];
		frame.channel.onEvent('showOnMap', (payload) => heard.push(payload));
		await until(() => frame.caller.controllerReady(), 'the readiness');
		await frame.caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 0], ['doc-1', 1]], source: 'document' }, { timeoutMs: 10_000 });
		await until(() => Boolean(stateOf<Record<string, IMapRequest>>(mounted.h, STATE.mapRequests)?.[key]), 'the retained map request');
		const request = stateOf<Record<string, IMapRequest>>(mounted.h, STATE.mapRequests)![key];
		assert.deepEqual({ keys: request.keys, source: request.source }, { keys: [['doc-1', 0], ['doc-1', 1]], source: 'document' });
		await until(() => heard.length === 1, 'the showOnMap event');
		assert.deepEqual(heard[0], { docKey: consoleUri(key), keys: [['doc-1', 0], ['doc-1', 1]], source: 'document', nonce: request.nonce });
		frame.channel.sendEvent('active', { docKey: consoleUri(key), consumed: [request.nonce] });
		await until(() => stateOf<Record<string, IMapRequest>>(mounted.h, STATE.mapRequests)?.[key] === undefined, 'taken');
		await assert.rejects(frame.caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 'x']] as never, source: 'document' }, { timeoutMs: 10_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		await assert.rejects(frame.caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 0]], source: 'anywhere' } as never, { timeoutMs: 10_000 }), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid');
		frame.caller.dispose();
		mounted.controller.dispose();
	});
});

describe('calls held for the sidebar controller before it mounts', () => {
	it('a held requestFocus and a held showOnMap are answered ok once it mounts, and both requests are published', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const h = createDevToolHarness(VECTOR_APP_ID);
		// A frame that calls without waiting for readiness: with no subscriber on the sidebar peer, the peer holds the
		// calls and hands them over synchronously when the controller subscribes, inside attachController, before
		// createVectorController has its result, its channel or its publisher.
		const caller = createFrameCaller<VectorOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel, waitForController: false });
		await settle();
		const key = 'k1|held';
		const docKey = documentUri(key, 'doc-1');
		const focus = caller.callReply(OP.requestFocus, { key, docKey, chunkId: 3 }, { timeoutMs: 10_000 });
		const map = caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 0]], source: 'document' }, { timeoutMs: 10_000 });
		await settle();
		// No host channel: the fallback channel catches the held burst and attachController releases it at its end.
		const errors: unknown[] = [];
		const controller = track(createVectorController({
			cm: engine.cm,
			peer: h.sidebarPeer,
			documents: recordingDocuments().documents,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			focusTarget: null,
			store: makeVectorEndpointStore({ debounceMs: 0 }),
			onError: (error) => errors.push(error),
		}));
		assert.equal(await focus, null, 'the held focus is answered ok');
		assert.equal(await map, null, 'the held map request is answered ok');
		await until(() => stateOf<Record<string, IFocusRequest>>(h, STATE.focusRequests)?.[key]?.chunkId === 3, 'the focus request published');
		await until(() => stateOf<Record<string, IMapRequest>>(h, STATE.mapRequests)?.[key]?.keys?.[0]?.[0] === 'doc-1', 'the map request published');
		assert.deepEqual(errors, []);
		caller.dispose();
		controller.dispose();
	});
});

describe('T6 - a quiet sidebar: no event, call or document at mount; the mount is the activation, and discovery waits for a known identity', () => {
	it('rocket-ui: state publishes only, then the first discovery with no activation event; a later selection starts nothing more', async () => {
		const engine = rocketRealm();
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm);
		await settle();
		assert.deepEqual(nonStatePosts(mounted.spy.posts), [], 'no event or call posts at mount');
		assert.ok(mounted.spy.posts.length > 0, 'the premise: retained state was published');
		assert.deepEqual(mounted.docs.opened, [], 'no documents.open at mount');
		assert.deepEqual(mounted.h.emitted, [], 'nothing summoned a frame');
		assert.equal(mounted.controller.activation.reason(), 'lazyMount', 'the mount is the activation');
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'the first discovery');
		const discoveries = engine.requests.filter((r) => r.op === 'client.getTasks').length;
		engine.realm.activate(VECTOR_APP_ID);
		await settle();
		assert.equal(engine.requests.filter((r) => r.op === 'client.getTasks').length, discoveries);
		assert.deepEqual(nonStatePosts(mounted.spy.posts), [], 'still no event or call posts');
		assert.deepEqual(mounted.docs.opened, []);
		mounted.controller.dispose();
	});

	it('rocket-ui: a sidebar mounted before sign-in sends nothing until the identity is known', async () => {
		const engine = rocketRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.deepEqual(engine.requests, [], 'no discovery while nobody is signed in');
		engine.realm.login(account('u1'));
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery once signed in');
		mounted.controller.dispose();
	});

	it('VS Code (the sidebar mounts lazily) still waits for a known identity; a click in the sidebar opens the console it names', async () => {
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.deepEqual(engine.requests, []);
		signInVsCode(engine.realm);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'discovery once signed in');
		assert.deepEqual(nonStatePosts(mounted.spy.posts), []);
		const endpoint = mounted.controller.store.getState().endpoints[0];
		mounted.controller.env(true).openConsole(endpoint);
		assert.deepEqual(mounted.docs.opened, [{ key: consoleUri(endpoint.key), title: endpoint.nodeName }], 'the console, titled with the store node\'s name');
		mounted.controller.dispose();
	});
});

describe('T7 - identity fails closed (the controller side)', () => {
	it('a call for a connection while nothing was discovered says so (not "not listed any more"), once its deadline is near', async () => {
		const engine = vscodeRealm();
		engine.realm.root.connect(null);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const frame = frameSide(mounted.h);
		await until(() => frame.caller.controllerReady(), 'the readiness');
		await assert.rejects(frame.caller.callReply(OP.stats, { key: 'k1|any', input: { mode: 'full' } }, { timeoutMs: 1_500 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.message === NOT_DISCOVERED_TEXT);
		assert.notEqual(NOT_DISCOVERED_TEXT, NOT_LISTED_TEXT);
		assert.ok(!engine.world.calls.some((c) => c.tool === 'stats'));
		frame.caller.dispose();
		mounted.controller.dispose();
	});

	it('a connected realm with no account discovers nothing, and a frame\'s refresh is refused as data', async () => {
		const engine = vscodeRealm();
		engine.realm.root.connect(null);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const frame = frameSide(mounted.h);
		await settle();
		await assert.rejects(frame.caller.callReply(OP.refresh, {}, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		await settle();
		assert.ok(!engine.requests.some((r) => r.op === 'client.getTasks'), 'no discovery call without an identity');
		frame.caller.dispose();
		mounted.controller.dispose();
	});

	it('a switch from account A to B clears what A\'s frames left: queries, summaries, focus and map requests, versions', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 1, 'A\'s discovery');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const frame = frameSide(mounted.h);
		await until(() => frame.caller.controllerReady(), 'the readiness');
		frame.channel.sendEvent('queryChanged', { key, nonce: 'a-1', text: 'A\'s question' });
		frame.channel.sendEvent('consoleSummary', { key, medianChunks: 3 });
		await frame.caller.callReply(OP.showOnMap, { key, keys: [['doc-1', 0]], source: 'document' }, { timeoutMs: 10_000 });
		await frame.caller.callReply(OP.trash, { key, input: { object_ids: ['91ae15d4-3f6e-589f-bb81-72301f2ca1b6'] }, origin: 'f' }, { timeoutMs: 30_000 });
		await until(() => Object.keys(stateOf<Record<string, unknown>>(mounted.h, STATE.queries) ?? {}).length === 1 && Object.keys(stateOf<Record<string, unknown>>(mounted.h, STATE.docVersions) ?? {}).length === 1, 'A\'s state');
		engine.realm.root.connect(account('u2'));
		await until(() => Object.keys(stateOf<Record<string, unknown>>(mounted.h, STATE.queries) ?? {}).length === 0, 'A\'s queries to go');
		for (const topic of [STATE.consoleSummary, STATE.mapRequests, STATE.focusRequests, STATE.docVersions]) assert.deepEqual(stateOf(mounted.h, topic), {}, `${topic} cleared`);
		frame.caller.dispose();
		mounted.controller.dispose();
	});
});

describe('R8 - the sidebar highlights from activeDocKey, else the frames\' active event', () => {
	it('a string names the fronted document and wins over the event; null clears it; undefined falls back to the event', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const frame = frameSide(mounted.h);
		await until(() => frame.caller.controllerReady(), 'the readiness');
		frame.channel.sendEvent('active', { docKey: consoleUri('k1|from-event') });
		await until(() => mounted.controller.activeConnection.get() === 'k1|from-event', 'the event');
		mounted.controller.noteActiveDocKey(documentUri('k1|from-host', 'doc-1'));
		assert.equal(mounted.controller.activeConnection.get(), 'k1|from-host', 'a document of a connection names its connection');
		frame.channel.sendEvent('active', { docKey: consoleUri('k1|other') });
		await settle();
		assert.equal(mounted.controller.activeConnection.get(), 'k1|from-host', 'the host wins while it says something');
		mounted.controller.noteActiveDocKey(null);
		assert.equal(mounted.controller.activeConnection.get(), null);
		mounted.controller.noteActiveDocKey(undefined);
		assert.equal(mounted.controller.activeConnection.get(), 'k1|other', 'undefined (VS Code before it knows) falls back to the event');
		frame.caller.dispose();
		mounted.controller.dispose();
	});
});

describe('docVersions is cut by its own snapshot, so the stamps outlast the lists of what left', () => {
	it('the controller publishes and shrinks docVersions with versionsSnapshot, never with the generic keyed cut', () => {
		const text = code(read('devtool/controller.ts'));
		assert.match(text, /publish\(STATE\.docVersions, versionsSnapshot\(versions, shownKeys, VERSIONS_STATE_BYTES\)\)/);
		assert.match(text, /if \(topic === STATE\.docVersions\) return versionsSnapshot\(versions, shownKeys, info\.budgetBytes\);/);
		assert.doesNotMatch(text, /keyedSnapshot\(versions\b/);
	});
});

describe('R6 - one wiring module; the controller is built in an effect', () => {
	it('createToolChannel, createToolOpServer and createToolController are imported from shell in ONE module', () => {
		assert.deepEqual(findToolFactoryImports(allSources()), ['devtool/wiring.ts']);
	});

	it('the sidebar mount builds its controller in an effect with a disposing cleanup, never in a memo, and never subscribes the peer', () => {
		const sidebar = code(read('VectorDevToolSidebar.tsx'));
		assert.match(sidebar, /useEffect\(\(\) => \{[\s\S]*?const created = createVectorController\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(sidebar, /useMemo\(\(\) => createVectorController|peer\.subscribe/);
		assert.match(sidebar, /useEffect\(\(\) => \{\s*controller\?\.noteActiveDocKey\(activeDocKey\);\s*\}, \[controller, activeDocKey\]\);/);
		assert.match(sidebar, /if \(!env\) return null;/, 'nothing until the controller exists (the host shows the load state)');
	});
});

describe('S1-S9 - the dev-tool sidebar is Rod\'s list: rows with a state, a Refresh header action, the list line', () => {
	const ready = { key: 'k1|a', nodeId: 'store_1', nodeName: 'Docs store', provider: 'postgres', pipelineName: 'Vector docs', runKind: 'dev', state: 'ready', roles: { tools: { source: 'tools_1' }, chat: null, ingest: null }, readOnly: false, components: [] } as unknown as IExplorerEndpoint;
	const probe: IProbeResult = { ok: true, info: fixture('dialect_pgvector'), dialect: 'vector' };

	it('a row: the store node\'s name, no suffix while running, the badge in words otherwise, Read-only for a read-only store, a tooltip with the address and the state', () => {
		const row = connectionRow(ready, probe);
		assert.equal(row.label, 'Docs store');
		assert.equal(row.status, null);
		assert.equal(row.variant, 'success');
		assert.match(row.tooltip, /^Docs store — PostgreSQL \(pgvector\) · [^\n]+ · Running\nSources: ingest – · chat – · tools ✓/);
		assert.equal(row.ariaLabel, 'Docs store, Running');
		assert.equal(rowStatusText({ ...ready, state: 'stopped' }, probe), 'Stopped');
		assert.equal(rowStatusText({ ...ready, state: 'unreachable' }, undefined), 'Unreachable');
		assert.equal(rowStatusText({ ...ready, readOnly: true }, probe), 'Read-only');
		assert.equal(connectionRow({ ...ready, state: 'probing' }, undefined).variant, 'muted');
		assert.match(connectionRow({ ...ready, state: 'stopped', stateDetail: 'The pipeline is stopped.' }, probe).tooltip, /\nThe pipeline is stopped\.$/);
	});

	it('the list line: discovering, failed, nothing running (the long text in the tooltip), none usable; nothing while idle or when the rows say it', () => {
		assert.equal(sidebarListLine('idle', [], null), null, 'discovery has not started: claim nothing');
		assert.deepEqual(sidebarListLine('loading', [], null), { tone: 'muted', text: 'Discovering vector stores…', detail: null });
		assert.equal(sidebarListLine('error', [], 'boom')?.tone, 'error');
		assert.match(sidebarListLine('error', [], 'boom')?.text ?? '', /^Discovery failed: boom/);
		const none = sidebarListLine('ready', [], null);
		assert.equal(none?.text, 'No running vector store found');
		assert.match(none?.detail ?? '', /Elasticsearch and OpenSearch/);
		assert.equal(sidebarListLine('ready', [{ ...ready, state: 'stopped' }], null)?.text, 'Vector stores found, but none can be used');
		assert.equal(sidebarListLine('ready', [ready], null), null);
		assert.match(sidebarListLine('error', [ready], 'boom')?.text ?? '', /^Refresh failed: boom/);
	});

	it('the component: an uppercase "Connections" label with a Refresh header action, hand-built rows, the line; no SidebarMenu, no tool name, no modal', () => {
		const list = code(read('components/DevToolConnectionList.tsx'));
		assert.match(list, /<span style=\{styles\.sectionLabel\}>Connections<\/span>/);
		assert.match(list, /const refreshBlocked = !env\.ready \|\| status === 'loading';/);
		assert.match(list, /<button type="button" style=\{refreshBlocked \? styles\.headerActionBlocked : styles\.headerAction\} title="Refresh connections" aria-label="Refresh connections" aria-disabled=\{refreshBlocked\} onClick=\{\(\) => \{ if \(!refreshBlocked\) void env\.refresh\(\); \}\}>\s*<BxRefresh size=\{18\} \/>/);
		assert.doesNotMatch(list, /\sdisabled=\{/, 'focus stays on the action while discovery runs');
		assert.match(list, /<div style=\{styles\.headerActions\(paneHovered \|\| paneFocused\)\}>/);
		for (const attr of [/role="button"/, /tabIndex=\{0\}/, /title=\{row\.tooltip\}/, /aria-label=\{row\.ariaLabel\}/, /onClick=\{\(\) => env\.openConsole\(e\)\}/, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter' \|\| event\.key === ' '\) \{ event\.preventDefault\(\); env\.openConsole\(e\); \} \}\}/]) assert.match(list, attr);
		assert.match(list, /<span style=\{styles\.rowIcon\(active\)\}><VectorIcon \/><\/span>/);
		assert.match(list, /\{row\.status !== null && <span style=\{styles\.rowStatus\}>\{row\.status\}<\/span>\}/, 'the state in words, not colour alone');
		assert.match(list, /<span style=\{styles\.dot\(row\.variant\)\} aria-hidden="true" \/>/);
		assert.match(list, /\{line && <div style=\{line\.tone === 'error' \? styles\.error : styles\.empty\} title=\{line\.detail \?\? undefined\}>\{line\.text\}<\/div>\}/);
		assert.match(list, /const active = e\.key === activeKey;/);
		assert.doesNotMatch(list, /SidebarMenu|sectionLabel=|Vector Explorer|Modal|ConfirmDialog|DetailPanel|style=\{\{/, 'S2, S7, S9; styles in `styles`');
		const effects = [...list.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
		for (const effect of effects) assert.doesNotMatch(effect, /openConsole|openDocument/, 'documents open only on a click (R7)');
	});

	it('the full app keeps its own sidebar unchanged', () => {
		const full = code(read('VectorSidebar.tsx'));
		assert.match(full, /SidebarMenu/);
		assert.match(full, /openConsole\(endpoint\)/);
	});
});
