// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL ROBUSTNESS: two stores and several frames on one mirrored realm, an
// outage then a retry, a stale dialect after a refresh, the identity fence, and
// a mutating op's own authority checks, all over the REAL shell modules.
// =============================================================================

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { projectRows, vectorComponents } from 'shared/explorer/connect/testing';
import type { IFakeRow } from 'shared/explorer/connect/testing';
import { consoleUri } from '../src/vector/addresses';
import { connectionDocState } from '../src/devtool/frameText';
import { STATE } from '../src/devtool/protocol';
import { DISCONNECTED_FROM_SERVER_TEXT, WAITING_FOR_SERVER_TEXT, sidebarListLine } from '../src/vector/connections';
import { frameStatus } from 'shared/explorer/devtool/readiness';
import type { IDocVersion } from '../src/devtool/protocol';
import { fixture } from './support/fixtures';
import { account, disposeAll, latestStateMap, mountController, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import { mountFrame } from './support/devtoolFrame';
import type { IMountedFrame } from './support/devtoolFrame';
import type { IExplorerEndpoint } from 'shared/explorer';

afterEach(disposeAll);

const DOC_ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';

/** One tool call the way a frame's view makes it: through the env's session (a remote channel that maps the tool to its op). */
function tool(framed: IMountedFrame, endpoint: IExplorerEndpoint, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
	const session = framed.frame.env(true).session(endpoint);
	assert.ok(session, 'a ready frame has a session');
	return session.invoke(name, input, { nodeId: endpoint.nodeId });
}

/** The endpoint a frame lists for a key. */
function endpointOf(framed: IMountedFrame, key: string): IExplorerEndpoint {
	const found = framed.frame.endpoints.get().endpoints.find((e) => e.key === key);
	assert.ok(found, `the frame lists ${key}`);
	return found;
}

/** Two running projects (two stores): each with its own tokens, so a call that rode the wrong token is visible. */
function twoStores(): IFakeRow[] {
	const make = (projectId: string, prefix: string) =>
		projectRows(['ingest_1', 'chat_1', 'tools_1'], vectorComponents('postgres'), { projectId }).map((r, i) => ({ ...r, token: `${prefix}-${i}`, name: `Store ${projectId}` }));
	return [...make('pA', 'tkA'), ...make('pB', 'tkB')];
}

describe('two stores and several frames on one realm', () => {
	it('each frame\'s calls ride its own connection\'s token, and a write on one connection bumps only that connection\'s version', async () => {
		const engine = vscodeRealm({}, twoStores());
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.store.getState().endpoints.length === 2 && Object.keys(mounted.controller.store.getState().probes).length === 2, 'both stores discovered and probed');
		const [a, b] = mounted.controller.store.getState().endpoints;
		assert.notEqual(a.key, b.key, 'two projects are two connections');
		const fa = mountFrame(mounted.h, consoleUri(a.key), { hintDelayMs: 0 });
		const fb = mountFrame(mounted.h, consoleUri(b.key), { hintDelayMs: 0 });
		await until(() => fa.frame.controllerReady.get() && fb.frame.controllerReady.get(), 'both frames to see the controller');
		const before = engine.world.calls.length;
		await until(() => fa.frame.endpoints.get().endpoints.length === 2 && fb.frame.endpoints.get().endpoints.length === 2, 'both frames list both stores');
		await tool(fa, endpointOf(fa, a.key), 'stats', { mode: 'full' });
		await tool(fb, endpointOf(fb, b.key), 'stats', { mode: 'full' });
		const stats = engine.world.calls.slice(before).filter((c) => c.tool === 'stats');
		assert.equal(stats.length, 2);
		assert.ok(stats[0].token.startsWith('tkA') && stats[1].token.startsWith('tkB'), `each call rode its own connection's token: ${stats.map((c) => c.token).join(', ')}`);

		await tool(fa, endpointOf(fa, a.key), 'soft_delete', { object_ids: [DOC_ID] });
		await until(() => Boolean((latestStateMap(mounted.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion> | undefined)?.[a.key]), 'the bump');
		const versions = latestStateMap(mounted.h)[STATE.docVersions]?.snapshot as Record<string, IDocVersion>;
		assert.equal(versions[a.key].action, 'trash');
		assert.equal(versions[b.key], undefined, 'the other store\'s version did not move');
		mounted.controller.dispose();
	});
});

describe('an outage, then a retry', () => {
	it('a call while the host connection is down is refused unsent; once it is back the same call runs, and a Refresh rediscovers', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const framed = mountFrame(mounted.h, consoleUri(key), { hintDelayMs: 0 });
		await until(() => framed.frame.controllerReady.get(), 'the readiness');
		mounted.h.setHostConnection(false);
		await settle();
		const down = engine.world.calls.length;
		await assert.rejects(tool(framed, endpointOf(framed, key), 'stats', { mode: 'full' }), (e: unknown) => e instanceof ExplorerToolError && (e.kind === 'unavailable' || e.kind === 'timeout'));
		assert.equal(engine.world.calls.length, down, 'nothing reached the engine while the connection was down');
		mounted.h.setHostConnection(true);
		await settle();
		assert.deepEqual(await tool(framed, endpointOf(framed, key), 'stats', { mode: 'full' }), fixture('stats_pgvector'), 'the retry runs');
		const tasks = engine.requests.filter((r) => r.op === 'client.getTasks').length;
		await framed.frame.env(true).refresh({ reprobe: false });
		await until(() => engine.requests.filter((r) => r.op === 'client.getTasks').length > tasks, 'the rediscovery');
		mounted.controller.dispose();
	});
});

describe('a stale dialect after a refresh', () => {
	it('the probe a Refresh re-runs replaces the older dialect: the frame never keeps the capabilities the store has since lost', async () => {
		let sampleCapable = true;
		const engine = vscodeRealm({
			dialect: (call) => {
				const dialect = fixture('dialect_pgvector') as Record<string, unknown> & { capabilities: Record<string, unknown> };
				void call;
				return { ...dialect, capabilities: { ...dialect.capabilities, sample: sampleCapable } };
			},
		});
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const framed = mountFrame(mounted.h, consoleUri(key), { hintDelayMs: 0 });
		await until(() => framed.frame.endpoints.get().probes[key]?.ok === true, 'the frame sees the dialect');
		const sampleOf = (): unknown => ((framed.frame.endpoints.get().probes[key]?.info ?? {}) as { capabilities?: Record<string, unknown> }).capabilities?.sample;
		assert.equal(sampleOf(), true);
		sampleCapable = false;
		await framed.frame.env(true).refresh({ reprobe: true });
		await until(() => sampleOf() === false, 'the new dialect to reach the frame');
		assert.equal(sampleOf(), false, 'the old capability is gone');
		mounted.controller.dispose();
	});
});

describe('the identity fence', () => {
	it('an answer that arrives after the account changed is discarded as stale, never shown to the next account', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const framed = mountFrame(mounted.h, consoleUri(key), { hintDelayMs: 0 });
		await until(() => framed.frame.controllerReady.get(), 'the readiness');
		await until(() => framed.frame.signIn.get() === 'signed-in', 'the frame knows the account');
		// Hold the engine's answer, change the account, then release it.
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		engine.before.current = async (op) => {
			if (op === 'client.tool') await gate;
		};
		const call = tool(framed, endpointOf(framed, key), 'stats', { mode: 'full' });
		void call.catch(() => undefined);
		await settle();
		engine.realm.root.connect(account('u2'));
		await until(() => mounted.controller.identity.get().fingerprint?.includes('u2') === true, 'the controller adopts u2');
		await settle();
		engine.before.current = null;
		release();
		await assert.rejects(call, (e: unknown) => e instanceof ExplorerToolError && e.kind === 'stale');
		mounted.controller.dispose();
	});
});

describe('mutating ops enforce their own checks, whatever the frame believed', () => {
	it('a write for a connection whose node does not allow writes is refused by the controller; nothing reaches the engine', async () => {
		const engine = vscodeRealm({ dialect: () => ({ ...(fixture('dialect_pgvector') as Record<string, unknown>), allow_writes: false }) });
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => Object.keys(mounted.controller.store.getState().probes).length === 1, 'the probe');
		const key = mounted.controller.store.getState().endpoints[0].key;
		const framed = mountFrame(mounted.h, consoleUri(key), { hintDelayMs: 0 });
		await until(() => framed.frame.controllerReady.get(), 'the readiness');
		for (const name of ['soft_delete', 'restore', 'delete']) {
			const before = engine.world.calls.length;
			await assert.rejects(tool(framed, endpointOf(framed, key), name, { object_ids: [DOC_ID] }), (e: unknown) => e instanceof ExplorerToolError, name);
			assert.equal(engine.world.calls.length, before, `${name}: nothing was sent`);
		}
		mounted.controller.dispose();
	});
});

describe('readiness is a tri-state: waiting for the server, disconnected, ready', () => {
	it('the sidebar\'s engine status follows the realm\'s facts: no client is waiting, a client that is not connected is disconnected, then ready', async () => {
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		const { controller } = mounted;
		controller.engine.set({ client: null, isConnected: false });
		assert.equal(controller.engineStatus.get(), 'waiting');
		assert.equal(controller.env(controller.engineStatus.get()).engine, 'waiting');
		assert.equal(controller.env('waiting').ready, false);
		controller.engine.set({ client: {}, isConnected: false });
		assert.equal(controller.engineStatus.get(), 'disconnected');
		assert.equal(controller.env('disconnected').engine, 'disconnected');
		controller.engine.set({ client: {}, isConnected: true });
		assert.equal(controller.engineStatus.get(), 'ready');
		assert.equal(controller.env('ready').engine, 'ready');
		assert.equal(controller.env('ready').ready, true);
		// The old boolean question still means connected or not.
		assert.equal(controller.env(false).engine, 'disconnected');
		controller.dispose();
	});

	it('the sidebar list says which: "Waiting for the server connection…", "Not connected to the server.", nothing once rows say it all', () => {
		assert.deepEqual(sidebarListLine('idle', [], null, 'waiting'), { tone: 'muted', text: WAITING_FOR_SERVER_TEXT, detail: null });
		assert.deepEqual(sidebarListLine('idle', [], null, 'disconnected'), { tone: 'muted', text: DISCONNECTED_FROM_SERVER_TEXT, detail: null });
		assert.notEqual(WAITING_FOR_SERVER_TEXT, DISCONNECTED_FROM_SERVER_TEXT);
		assert.equal(sidebarListLine('idle', [], null, 'ready'), null, 'ready: discovery has not started, claim nothing');
		assert.equal(sidebarListLine('idle', [], null), null, 'the default is ready');
	});

	it('a frame\'s env and its document states tell waiting (the host has not said), disconnected and connected apart', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		const framed = mountFrame(mounted.h, undefined, { hintDelayMs: 0 });
		assert.equal(framed.frame.env(false, true).engine, 'waiting');
		assert.equal(framed.frame.env(false).engine, 'disconnected');
		assert.equal(framed.frame.env(true).engine, 'ready');
		assert.notEqual(framed.frame.env(false, true), framed.frame.env(false), 'the two not-ready envs are not one object');
		assert.equal(frameStatus(undefined, 'ready'), 'waiting');
		assert.equal(frameStatus(false, 'ready'), 'disconnected');
		assert.equal(frameStatus(true, 'ready'), 'connected');
		const gates = { summon: 'ready' as const, signIn: 'signed-in' as const, found: true, opened: false };
		assert.equal(connectionDocState({ host: undefined, ...gates }), 'waiting');
		assert.equal(connectionDocState({ host: false, ...gates }), 'not-connected');
		assert.equal(connectionDocState({ host: true, ...gates }), 'open');
		mounted.controller.dispose();
	});
});
