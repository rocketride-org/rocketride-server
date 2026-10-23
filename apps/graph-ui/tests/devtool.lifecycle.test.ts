// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL LIFECYCLE: one op server, a quiet sidebar, identity, host:connection
// and the first click (T5, T6, T7, T8, R8) over the REAL shell modules
// =============================================================================

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_TOOL_TIMEOUTS, ExplorerToolError } from 'shared/explorer';
import { codedError, manualClock } from 'shared/explorer/connect/testing';
import { assertSidebarSubscribers } from 'shared/explorer/devtool/testing';
import { makeGraphEndpointStore, makeGraphHistory } from '../src/adapters/explorer';
import { adoptParkedHistory, hasParkedHistory, parkHistory } from '../src/devtool/owedHistory';
import type { IOwedHistory } from '../src/devtool/owedHistory';
import { OP } from '../src/devtool/protocol';
import { historyPrefsPath } from 'shared/explorer/devtool/prefs';
import { PREVIEW_MAX_AGE_MS, previewFor } from '../src/graph/previews';
import { account, graphRow, mountController, mountFrame, readOnlyNode, rocketRealm, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import { createDevToolHarness } from 'shared/explorer/devtool/testing';
import { SUMMON_EVENT, SUMMON_GRACE_MS, SUMMON_SETTLE_MS } from 'shared/explorer/devtool/summon';

const APP = 'rocketride.graph';

/**
 * The posts a sidebar made that are not retained state (events and calls).
 *
 * @param posts - Everything the spied sidebar peer posted.
 * @returns The non-state posts.
 */
function nonStatePosts(posts: unknown[]): unknown[] {
	return posts.filter((post) => (post as { __rrtool?: string })?.__rrtool !== 'state');
}

describe('T5 - mount -> dispose -> mount leaves one live op server; ops answered, events delivered, replays run nothing', () => {
	it('the remounted controller has exactly two live subscriptions, serves ops, follows the frame\'s active event, and the replayed event executes nothing', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const first = mountController(engine.cm);
		assertSidebarSubscribers(first.spy, 'first graph controller');
		// StrictMode: mount, cleanup, mount (the host's channel lives on).
		first.controller.dispose();
		const second = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(second.spy, 'remounted graph controller');

		first.h.setHostConnection(true);
		const { frame } = mountFrame(first.h, 'workbench:k1|some|key');
		await until(() => second.controller.activeConnection.get() === 'k1|some|key', 'the frame\'s active event (activeDocKey is undefined in VS Code)');
		assert.deepEqual(await frame.caller.callReply(OP.historyList, { key: 'k1|some|key' }, { timeoutMs: 5_000 }), { entries: [], recording: true }, 'an op is answered');

		await until(() => engine.world.calls.length > 0, 'the first discovery and probe');
		await settle();
		const calls = engine.world.calls.length;
		// The REAL VS Code order: the controller unmounts on the disconnect, the host publishes host:connection true at
		// once on the reconnect, and only then (loadRemote, two React commits) does the controller remount.
		second.controller.dispose();
		first.h.setHostConnection(false);
		first.h.setHostConnection(true);
		await settle();
		const third = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(third.spy, 'third graph controller');
		await settle();
		const afterReplay = engine.world.calls.filter((c, i) => i >= calls && c.tool !== 'dialect');
		assert.deepEqual(afterReplay, [], 'nothing the frame sent before ran again (only discovery probes)');
		// The replay of the last frame event reaches the op server (which drops events), not the channel; the frame says
		// again which document it is when it sees the NEW controller's readiness nonce.
		await until(() => third.controller.activeConnection.get() === 'k1|some|key', 'the frame to announce itself to the new controller');
		assert.deepEqual(first.h.violations, []);
		frame.dispose();
		third.controller.dispose();
	});
});

describe('frames say which document they are once per controller, and stay quiet at mount', () => {
	/**
	 * The `active` events a frame signalled (transient bus signals; the retained copy is the replay slot).
	 *
	 * @param wire - The harness's wire log.
	 * @returns How many.
	 */
	const actives = (wire: Array<{ value: unknown; transient: boolean }>): number => wire.filter((e) => e.transient && (e.value as { __rrtool?: string; name?: string })?.__rrtool === 'event' && (e.value as { name?: string }).name === 'active').length;

	it('a frame mounted while the controller is ready sends `active` once, not once per retained topic it replays', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await settle();
		const before = actives(mounted.h.wire);
		const { frame } = mountFrame(mounted.h, 'workbench:k1|x');
		await settle();
		assert.equal(actives(mounted.h.wire) - before, 1);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('a frame that has no controller yet knows it, and announces itself when one becomes ready', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const harness = mountController(engine.cm);
		harness.controller.dispose();
		harness.h.setHostConnection(true);
		const { frame } = mountFrame(harness.h, 'workbench:k1|y');
		await settle();
		assert.equal(frame.controllerReady.get(), false, 'no controller: the frame can say "open the sidebar"');
		const again = mountController(engine.cm, {}, harness.h, harness);
		await until(() => frame.controllerReady.get(), 'the controller\'s readiness');
		await until(() => again.controller.activeConnection.get() === 'k1|y', 'the frame announced itself to it');
		frame.dispose();
		again.controller.dispose();
	});

	it('the automatic first refresh is quiet: a refusal while the identity settles is not announced (an explicit one is)', async () => {
		const engine = vscodeRealm();
		engine.realm.root.connect(null);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame, errors } = mountFrame(mounted.h, undefined);
		await settle();
		await frame.env(true).refresh({ quiet: true });
		assert.deepEqual(errors, [], 'nothing said for the automatic refresh');
		await frame.env(true).refresh();
		assert.equal(errors.length, 1, 'the refresh a person asked for says why it was refused');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('a frame\'s probe that cannot run returns "nothing tested" silently, as the full app\'s does', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(false);
		const { frame, errors } = mountFrame(mounted.h, undefined);
		await settle();
		assert.equal(await frame.env(false).probe('k1|any'), null);
		assert.deepEqual(errors, []);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('a schema load the sidebar starts by itself does not count as the user activating the tool', async () => {
		// A VS Code realm mounted while its root is down cannot be classified,
		// so its gate is still closed (a classified realm's mount IS the activation).
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		assert.equal(mounted.controller.activation.isOpen(), false, 'the premise: the gate is closed');
		await mounted.controller.env(true).loadSchema('k1|unknown');
		assert.equal(mounted.controller.activation.isOpen(), false, 'an effect-driven load opens nothing');
		mounted.controller.env(true).openDocument({ kind: 'connections' });
		assert.equal(mounted.controller.activation.reason(), 'user', 'a click does');
		mounted.controller.dispose();
	});
});

describe('T6 - a quiet sidebar: no event, call or document at mount; the mount is the activation, and discovery waits for a known identity', () => {
	it('rocket-ui (since #2625 9bd5d931f a sidebar mounts only when selected or summoned): state publishes only, then the first discovery and the history read with no activation event', async () => {
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
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'the history read');
		const discoveries = engine.requests.filter((r) => r.op === 'client.getTasks').length;
		engine.realm.activate(APP);
		await settle();
		assert.equal(engine.requests.filter((r) => r.op === 'client.getTasks').length, discoveries, 'a later selection starts nothing more');
		assert.deepEqual(nonStatePosts(mounted.spy.posts), [], 'still no event or call posts');
		assert.deepEqual(mounted.docs.opened, [], 'still no documents.open');
		mounted.controller.dispose();
	});

	it('rocket-ui: a sidebar mounted before sign-in reads nothing (no history file, no discovery) until the identity is known', async () => {
		const engine = rocketRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.equal(mounted.controller.activation.isOpen(), true, 'the premise: the mount activated it');
		assert.deepEqual(engine.requests, [], 'no history read, no discovery, while nobody is signed in');
		engine.realm.login(account('u1'));
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'history read once signed in');
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery once signed in');
		mounted.controller.dispose();
	});

	it('a user action in the sidebar activates it too, and opens the document it names', async () => {
		const engine = rocketRealm();
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm);
		const env = mounted.controller.env(true);
		env.openDocument({ kind: 'connections' });
		assert.deepEqual(mounted.docs.opened, [{ key: '', title: 'Graph Explorer' }]);
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery after the click');
		mounted.controller.dispose();
	});

	it('VS Code (the sidebar mounts lazily: the mount is the activation) still waits for a known identity', async () => {
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.equal(mounted.controller.activation.isOpen(), false, 'not connected yet: the realm cannot be classified');
		assert.deepEqual(engine.requests, []);
		signInVsCode(engine.realm);
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery once signed in');
		assert.equal(mounted.controller.activation.reason(), 'lazyMount');
		assert.deepEqual(nonStatePosts(mounted.spy.posts), []);
		mounted.controller.dispose();
	});
});

describe('T7 - identity fails closed', () => {
	it('a connected realm with no account discovers nothing, and a frame\'s refresh is refused as data', async () => {
		const engine = vscodeRealm();
		engine.realm.root.connect(null);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await settle();
		await assert.rejects(frame.caller.callReply(OP.refreshEndpoints, {}, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		await settle();
		assert.ok(!engine.requests.some((r) => r.op === 'client.getTasks'), 'no discovery call without an identity');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('VS Code: account A -> disconnect -> reconnect -> account B closes every connection document and clears the frames\' caches', async () => {
		const engine = vscodeRealm([graphRow(), graphRow({ ownerId: 'u2', token: 'tk_b' })]);
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const doc = mountFrame(mounted.h, 'workbench:k1|a');
		const landing = mountFrame(mounted.h, undefined);
		await until(() => doc.frame.guard.first() !== null && landing.frame.guard.first() !== null, 'the frames to learn account A');
		const fingerprintA = doc.frame.guard.first();

		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		assert.deepEqual(doc.docs.closed, [], 'a drop alone closes nothing');
		mounted.h.setHostConnection(true);
		engine.realm.root.connect(account('u2'));
		await until(() => doc.docs.closed.length > 0, 'the document to close for account B');
		assert.deepEqual(doc.docs.closed, ['workbench:k1|a']);
		assert.equal(doc.frame.lastReset(), 'identity');
		assert.deepEqual(landing.docs.closed, [], 'the landing is never closed');
		assert.notEqual(landing.frame.guard.first(), fingerprintA, 'the landing adopted account B');
		assert.equal(landing.frame.lastReset(), 'identity', 'and cleared its caches');
		doc.frame.dispose();
		landing.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T7 - history belongs to one identity at a time (the controller side)', () => {
	it('identity B is never served identity A\'s history, not even while B\'s history file is still loading', async () => {
		const engine = vscodeRealm();
		// Hold the history file reads, so the window between B signing in and B's file loading is observable.
		let holdReads = false;
		const releases: Array<() => void> = [];
		const inner = engine.cm.request.bind(engine.cm);
		const cm = Object.assign(Object.create(null), engine.cm, {
			request: async (op: string, params: unknown, opts?: { timeoutMs?: number }) => {
				if (holdReads && (op === 'client.fsStat' || op === 'client.fsReadJson')) await new Promise<void>((resolve) => releases.push(resolve));
				return inner(op, params, opts);
			},
		});
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(cm as never);
		mounted.h.setHostConnection(true);
		const landing = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(landing.frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const key = landing.frame.env(true).endpoints.get().endpoints[0].key;
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'A\'s history file read');
		landing.frame.env(true).history.record(key, { id: 'a1', at: 1, kind: 'read', cypher: 'MATCH (a) RETURN a', ms: 1, outcome: 'rows', rows: 1 } as never);
		await until(() => mounted.controller.stores.history.getHistory(key).length === 1, 'A\'s run recorded');

		holdReads = true;
		engine.realm.root.disconnect();
		engine.realm.root.connect(account('u2'));
		await until(() => mounted.controller.identity.get().known && mounted.controller.identity.get().fingerprint !== null && releases.length > 0, 'B signed in, its file read held');
		const served = await landing.frame.caller.callReply(OP.historyList, { key }, { timeoutMs: 5_000 });
		assert.deepEqual(served.entries.map((e) => e.id), [], 'nothing of A while B\'s file loads');
		assert.deepEqual(mounted.controller.stores.history.getHistory(key), [], 'and nothing of A in the controller\'s memory');
		for (const release of releases.splice(0)) release();
		holdReads = false;
		await settle();
		landing.frame.dispose();
		mounted.controller.dispose();
	});

	it('a run recorded in the last 300 ms before the controller unmounts is still written to the history file', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { stores: { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), history: makeGraphHistory(300) } });
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'the history file read');
		await settle();
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		frame.env(true).history.record(key, { id: 'last', at: 1, kind: 'read', cypher: 'RETURN 1', ms: 1, outcome: 'rows', rows: 1 } as never);
		await until(() => mounted.controller.stores.history.getHistory(key).length === 1, 'the controller recorded it');
		mounted.controller.dispose();
		await until(() => JSON.stringify([...engine.files.values()]).includes('"last"'), 'the last run in the file', 120);
		frame.dispose();
	});
});

describe('T7 - the last history batch in the REAL disconnect, logout and account-switch orders', () => {
	/**
	 * Whether a run's id is in the history file.
	 *
	 * @param engine - The engine realm (its files).
	 * @param id - The run's id.
	 * @returns True when written.
	 */
	const fileHas = (engine: { files: Map<string, unknown> }, id: string): boolean => JSON.stringify([...engine.files.values()]).includes(`"${id}"`);
	/** The production stores: the history store's 300 ms batch is what is at stake. */
	const productionStores = () => ({ endpoints: makeGraphEndpointStore({ debounceMs: 0 }), history: makeGraphHistory(300) });

	/**
	 * A signed-in VS Code realm whose controller recorded one run that is still in the store's 300 ms batch.
	 *
	 * @param id - The run's id.
	 * @returns The pieces.
	 */
	async function recordLast(id: string) {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { stores: productionStores() });
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'the history file read');
		await settle();
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		frame.env(true).history.record(key, { id, at: 1, kind: 'read', cypher: 'RETURN 1', ms: 1, outcome: 'rows', rows: 1 } as never);
		await until(() => mounted.controller.stores.history.getHistory(key).length === 1, 'the controller recorded it');
		return { engine, mounted, frame, key };
	}

	it('VS Code: disconnect (the identity goes unknown first), host flip, controller unmount, then the same account back and the controller remounts: the run reaches the file', async () => {
		const { engine, mounted, frame, key } = await recordLast('kept-remount');
		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		mounted.controller.dispose();
		assert.equal(fileHas(engine, 'kept-remount'), false, 'the premise: nothing could be written while disconnected');
		engine.realm.root.connect(account('u1'));
		mounted.h.setHostConnection(true);
		const again = mountController(engine.cm, { stores: productionStores() }, mounted.h, mounted);
		await until(() => fileHas(engine, 'kept-remount'), 'the run in A\'s file', 200);
		await until(() => again.controller.stores.history.getHistory(key).some((e) => e.id === 'kept-remount'), 'and in the remounted controller\'s history');
		again.controller.dispose();
		frame.dispose();
	});

	it('VS Code: the same, but no controller mounts again: the realm still writes the run once the same account is back', async () => {
		const { engine, mounted, frame } = await recordLast('kept-parked');
		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		mounted.controller.dispose();
		engine.realm.root.connect(account('u1'));
		await until(() => fileHas(engine, 'kept-parked'), 'the run in A\'s file', 200);
		frame.dispose();
	});

	it('rocket-ui (the controller stays mounted): a logout, then the same account again: the run is written', async () => {
		const engine = rocketRealm();
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm, { stores: productionStores() });
		engine.realm.activate(APP);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'the history file read');
		await settle();
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		frame.env(true).history.record(key, { id: 'kept-logout', at: 1, kind: 'read', cypher: 'RETURN 1', ms: 1, outcome: 'rows', rows: 1 } as never);
		await until(() => mounted.controller.stores.history.getHistory(key).length === 1, 'recorded');
		engine.realm.logout();
		await settle();
		assert.equal(fileHas(engine, 'kept-logout'), false, 'the premise: nothing written while signed out');
		engine.realm.login(account('u1'));
		await until(() => fileHas(engine, 'kept-logout'), 'the run in A\'s file', 200);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('VS Code: a disconnect, then a DIFFERENT account in the remounted controller: the parked change is dropped, never written into B\'s session', async () => {
		const { engine, mounted, frame } = await recordLast('a-parked');
		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		mounted.controller.dispose();
		assert.equal(hasParkedHistory(historyPrefsPath('graph')), true, 'the premise: the change was parked');
		const writes = (): number => engine.requests.filter((r) => r.op === 'client.fsWriteJson').length;
		const before = writes();
		engine.realm.root.connect(account('u2'));
		mounted.h.setHostConnection(true);
		const again = mountController(engine.cm, { stores: productionStores() }, mounted.h, mounted);
		await until(() => !hasParkedHistory(historyPrefsPath('graph')), 'the parked accessor settled');
		await new Promise((resolve) => { setTimeout(resolve, 1_600); });
		await settle();
		assert.equal(fileHas(engine, 'a-parked'), false, 'A\'s change is not written while B is signed in');
		assert.equal(writes(), before, 'nothing was written');
		again.controller.dispose();
		frame.dispose();
	});

	it('a direct switch from A to B: A\'s last run is never written (not into B\'s file), and B\'s file is untouched', async () => {
		const { engine, mounted, frame } = await recordLast('a-last');
		const writes = (): number => engine.requests.filter((r) => r.op === 'client.fsWriteJson').length;
		const before = writes();
		engine.realm.root.accountChanged(account('u2'));
		await until(() => mounted.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		await new Promise((resolve) => { setTimeout(resolve, 1_600); });
		await settle();
		assert.equal(fileHas(engine, 'a-last'), false, 'A\'s run never reaches the file B\'s session writes');
		assert.equal(writes(), before, 'nothing was written after the switch');
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('R8/R9 on the controller side: identity clears its caches, and the host\'s activeDocKey wins', () => {
	it('a switch from account A to B clears the controller\'s schemas and A\'s pending preview, which no frame of B can take', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const landingA = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(landingA.frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const key = landingA.frame.env(true).endpoints.get().endpoints[0].key;
		const sidebar = mounted.controller.env(true);
		await sidebar.loadSchema(key);
		await until(() => mounted.controller.stores.schemas.get(key).status === 'ready', 'A\'s schema');
		sidebar.previews.request({ endpointKey: key, action: 'label-preview', name: 'Person' });
		await until(() => landingA.frame.env(true).previews.pending.get() !== null, 'A\'s request reaches the frames');
		const fingerprintA = mounted.controller.identity.get().fingerprint;

		engine.realm.root.accountChanged(account('u2'));
		await until(() => mounted.controller.identity.get().known && mounted.controller.identity.get().fingerprint !== fingerprintA, 'account B');
		assert.deepEqual(mounted.controller.stores.schemas.keys(), [], 'A\'s schema snapshots are gone');
		assert.equal(mounted.controller.stores.previews.get(), null, 'A\'s pending preview is gone');
		const landingB = mountFrame(mounted.h, undefined);
		await settle();
		assert.equal(landingB.frame.env(true).previews.pending.get(), null, 'a frame of B never sees A\'s request');
		await until(() => landingA.frame.env(true).previews.pending.get() === null, 'and an older frame stops seeing it');
		landingA.frame.dispose();
		landingB.frame.dispose();
		mounted.controller.dispose();
	});

	it('noteActiveDocKey drives activeConnection: a string names the fronted document and wins over the frames\' event; null clears it; undefined falls back to the event', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { controller } = mounted;
		controller.noteActiveDocKey('workbench:k1|one');
		assert.equal(controller.activeConnection.get(), 'k1|one');
		const other = mountFrame(mounted.h, 'workbench:k1|two');
		await settle();
		assert.equal(controller.activeConnection.get(), 'k1|one', 'the host\'s key wins over a frame\'s active event');
		controller.noteActiveDocKey(null);
		assert.equal(controller.activeConnection.get(), null, 'null: another tab is fronted');
		controller.noteActiveDocKey(undefined);
		assert.equal(controller.activeConnection.get(), 'k1|two', 'undefined: the host cannot tell, so the frames\' event decides');
		controller.noteActiveDocKey('write:k1|three');
		assert.equal(controller.activeConnection.get(), 'k1|three', 'a write console belongs to its connection too');
		controller.noteActiveDocKey('');
		assert.equal(controller.activeConnection.get(), null, 'the generic frame (the landing) has no connection');
		other.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T8 - host:connection false: frames stop running and drop what they wait for; the sidebar follows isConnected', () => {
	it('pending calls reject, new calls are refused before sending, the frame env is not ready and has no session', async () => {
		let release: (() => void) | null = null;
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'read_query' ? new Promise((resolve) => { release = () => resolve(readOnlyNode(call)); }) : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const endpoint = frame.env(true).endpoints.get().endpoints[0];
		assert.equal(frame.connected.get(), true);
		const session = frame.env(true).session(endpoint);
		assert.ok(session);
		const running = session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 });
		await until(() => release !== null, 'the read to reach the node');

		mounted.h.setHostConnection(false);
		await assert.rejects(running, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /may still have run/.test(error.message));
		await settle();
		assert.equal(frame.connected.get(), false);
		const env = frame.env(frame.connected.get() === true);
		assert.equal(env.ready, false, 'run and apply are disabled');
		assert.equal(env.session(endpoint), null, 'and there is no session to send through');
		assert.equal(frame.lastReset(), 'disconnected', 'the frame cleared its caches');
		const posted = mounted.h.wire.length;
		await assert.rejects(frame.caller.callReply(OP.probe, { key: endpoint.key }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(mounted.h.wire.length, posted, 'refused before anything was posted');
		(release as unknown as () => void)();

		// The sidebar (controller) env follows the realm's own isConnected.
		assert.equal(mounted.controller.env(false).ready, false);
		assert.equal(mounted.controller.env(false).session(endpoint), null);
		assert.equal(mounted.controller.env(true).ready, true);
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('R8 - the schema click that summons a cold frame is not lost, and runs once', () => {
	it('a preview requested before the workbench frame exists is taken by it, once; a later frame finds nothing', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.stores.endpoints.getState().endpoints.length === 1, 'discovery');
		const endpoint = mounted.controller.stores.endpoints.getState().endpoints[0];
		const sidebar = mounted.controller.env(true);

		// The click: open the workbench (a cold webview in VS Code) and leave the request.
		sidebar.openDocument({ kind: 'workbench', endpoint });
		sidebar.previews.request({ endpointKey: endpoint.key, action: 'label-preview', name: 'Person' });
		assert.deepEqual(mounted.docs.opened, [{ key: `workbench:${endpoint.key}`, title: endpoint.nodeName }]);

		// Seconds later the frame boots.
		await settle();
		const cold = mountFrame(mounted.h, `workbench:${endpoint.key}`);
		await until(() => cold.frame.env(true).previews.pending.get() !== null, 'the retained request in the cold frame');
		const request = cold.frame.env(true).previews.pending.get();
		assert.ok(request && previewFor(request, endpoint.key, new Set(), Date.now()), 'it is this connection\'s, and fresh');
		assert.equal(cold.frame.env(true).previews.consume(request.nonce), true, 'taken once');
		assert.equal(cold.frame.env(true).previews.consume(request.nonce), false, 'never twice');
		assert.equal(cold.frame.env(true).previews.pending.get(), null);
		await until(() => mounted.controller.stores.previews.get() === null, 'the controller to clear it');

		const later = mountFrame(mounted.h, `workbench:${endpoint.key}`);
		await settle();
		assert.equal(later.frame.env(true).previews.pending.get(), null, 'a workbench opened later replays nothing');
		cold.frame.dispose();
		later.frame.dispose();
		mounted.controller.dispose();
	});

	it('the age limit is a backstop only: a request nobody took within a minute is not run', () => {
		const request = { nonce: 'n1', endpointKey: 'k', action: 'label-preview' as const, name: 'P', at: 1_000 };
		assert.ok(previewFor(request, 'k', new Set(), 1_000 + 30_000), 'a request from a cold summon seconds ago runs');
		assert.equal(previewFor(request, 'k', new Set(), 1_000 + PREVIEW_MAX_AGE_MS + 1), null);
		assert.equal(previewFor(request, 'other', new Set(), 1_000), null, 'another connection\'s request');
		assert.equal(previewFor(request, 'k', new Set(['n1']), 1_000), null, 'a request this realm already took');
	});
});

describe('history changes are confirmed by the controller before anything says they are done', () => {
	it('a frame\'s setNote resolves once the controller applied it, and rejects with the reason when it could not be sent', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		const env = frame.env(true);
		env.history.record(key, { id: 'e1', at: 1, kind: 'read', cypher: 'MATCH (n) RETURN n', ms: 1, outcome: 'rows', rows: 1 } as never);
		await until(() => mounted.controller.stores.history.getHistory(key).length === 1, 'the recorded run at the controller');

		await env.history.setNote(key, 'e1', 'kept');
		assert.equal(mounted.controller.stores.history.getHistory(key)[0].note, 'kept', 'applied before the promise resolved');

		mounted.h.setHostConnection(false);
		await settle();
		await assert.rejects(env.history.setNote(key, 'e1', 'lost'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(mounted.controller.stores.history.getHistory(key)[0].note, 'kept', 'nothing changed');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('the History panel announces a change only when it resolves, and the failure when it rejects', () => {
		const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'HistoryPanel.tsx'), 'utf8');
		assert.match(panel, /history\.setNote\(endpointKey, entry\.id, note\.trim\(\)\)\.then\(\(\) => announce\('Note saved\.'\), failed\('The note was not saved\.'\)\)/);
		assert.match(panel, /history\.clearForKey\(endpointKey\)\.then\(\(\) => announce\('History cleared\.'\), failed\(/);
		assert.match(panel, /history\.setRecording\(endpointKey, !recording\)\.then\(\(\) => announce\(/);
		assert.match(panel, /history\.togglePin\(endpointKey, entry\.id\)\.catch\(failed\(/);
		assert.match(panel, /history\.removeEntry\(endpointKey, entry\.id\)\.catch\(failed\(/);
		assert.doesNotMatch(panel, /\); announce\('(Note saved|History cleared)/, 'never announced right after the call');
	});
});

describe('a schema load that fails or times out reaches the frames as state, so nothing waits forever', () => {
	it('a failing get_schema: the frame\'s start acknowledgement is prompt, then the summary says error, with the reason', async () => {
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'get_schema' ? Promise.reject(codedError('Neo.ClientError.Security.Forbidden: no access to the schema', 'Forbidden')) : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await frame.env(true).loadSchema(key);
		await until(() => frame.schemas.get()[key]?.status === 'error', 'the failed load in the frame\'s state');
		const summary = frame.schemas.get()[key];
		assert.equal(typeof summary.failure, 'string');
		assert.ok((summary.failure ?? '').length > 0, 'with its reason');
		assert.deepEqual(summary.labels, []);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('a get_schema that never answers: the controller\'s session gives up at its own wait and the summary says error', async () => {
		const clock = manualClock();
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'get_schema' ? new Promise(() => undefined) : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm, { stores: { endpoints: makeGraphEndpointStore({ debounceMs: 0, clock }) } });
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		for (let i = 0; i < 40 && Object.keys(frame.env(true).endpoints.get().probes).length === 0; i += 1) {
			await clock.advance(10);
			await settle();
		}
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await frame.env(true).loadSchema(key);
		await until(() => frame.schemas.get()[key]?.status === 'loading', 'the load in progress');
		await clock.advance(DEFAULT_TOOL_TIMEOUTS.get_schema + 1);
		await until(() => frame.schemas.get()[key]?.status === 'error', 'the timed-out load in the frame\'s state');
		assert.match(frame.schemas.get()[key].failure ?? '', /./, 'with its reason');
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('owedHistory: parking, adoption and the time limit', () => {
	/** A stand-in accessor and tracker that record what happens to them. */
	function stubs(owner: string) {
		const log: string[] = [];
		let known: { known: boolean; fingerprint: string | null } = { known: false, fingerprint: null };
		const listeners = new Set<() => void>();
		const tracker = {
			get: () => ({ ...known, identity: null }),
			subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
			dispose: () => log.push('tracker.dispose'),
		};
		const owed: IOwedHistory = {
			owner,
			vouch: { tracker },
			prefs: { flush: async () => { log.push(`flush as ${String(owed.vouch.tracker.get().fingerprint)}`); }, dispose: () => log.push('prefs.dispose') } as never,
		};
		const set = (fingerprint: string | null): void => { known = { known: fingerprint !== null, fingerprint }; listeners.forEach((cb) => cb()); };
		return { log, tracker: tracker as never, owed, set };
	}

	it('a parked accessor nobody claims is released at the time limit, its change dropped', async () => {
		const s = stubs('A');
		parkHistory('p/ttl', s.owed, s.tracker, { ttlMs: 10 });
		assert.equal(hasParkedHistory('p/ttl'), true);
		await new Promise((resolve) => { setTimeout(resolve, 30); });
		assert.equal(hasParkedHistory('p/ttl'), false);
		assert.deepEqual(s.log, ['prefs.dispose', 'tracker.dispose'], 'released without a write');
	});

	it('the same owner adopts it (the parked tracker goes, the accessor stays); another owner settles it (written as that owner: the base drops it)', async () => {
		const same = stubs('A');
		parkHistory('p/adopt', same.owed, same.tracker);
		const mine = { get: () => ({ known: true, identity: null, fingerprint: 'A' }) };
		assert.equal(adoptParkedHistory('p/adopt', 'A', mine), same.owed);
		assert.equal(same.owed.vouch.tracker, mine, 'it reads the adopting controller\'s identity from now on');
		assert.deepEqual(same.log, ['tracker.dispose']);
		assert.equal(hasParkedHistory('p/adopt'), false);

		const other = stubs('A');
		parkHistory('p/other', other.owed, other.tracker);
		const theirs = { get: () => ({ known: true, identity: null, fingerprint: 'B' }) };
		assert.equal(adoptParkedHistory('p/other', 'B', theirs), null);
		await settle();
		assert.deepEqual(other.log, ['flush as B', 'prefs.dispose', 'tracker.dispose'], 'flushed while B is known (the base drops it), then released');
	});

	it('a parked accessor nobody claims does not keep the process alive for its time limit', () => {
		const script = ["import { parkHistory } from './src/devtool/owedHistory.ts';", 'const tracker = { get: () => ({ known: false, identity: null, fingerprint: null }), subscribe: () => () => undefined, dispose: () => undefined };', "const owed = { owner: 'A', vouch: { tracker }, prefs: { flush: async () => undefined, dispose: () => undefined } };", "parkHistory('p/alive', owed, tracker, { ttlMs: 60000 });"].join('\n');
		// The shell's global typing of `process` names `env` only; this node binary is what runs the test.
		const { execPath } = (globalThis as unknown as { process: { execPath: string } }).process;
		const started = Date.now();
		const child = spawnSync(execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve(__dirname, '..'), timeout: 10_000, encoding: 'utf8' });
		assert.equal(child.error, undefined, `the process exited by itself (${Date.now() - started} ms): ${String(child.error)}`);
		assert.equal(child.status, 0, child.stderr);
	});

	it('with no controller, a parked accessor settles itself when someone is known again', async () => {
		const s = stubs('A');
		parkHistory('p/self', s.owed, s.tracker);
		s.set('A');
		await settle();
		assert.deepEqual(s.log, ['flush as A', 'prefs.dispose', 'tracker.dispose']);
		assert.equal(hasParkedHistory('p/self'), false);
	});
});

describe('a frame whose controller is not mounted summons it (busPeer host.mountToolSidebar, #2625 9bd5d931f)', () => {
	/**
	 * A focus source the test fires by hand.
	 *
	 * @returns The target to inject and its trigger.
	 */
	const focusable = () => {
		const listeners = new Set<() => void>();
		return {
			target: {
				addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
				removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
			},
			fire: () => { for (const listener of [...listeners]) listener(); },
		};
	};
	const summonsOf = (h: ReturnType<typeof createDevToolHarness>): unknown[] => h.emitted.filter((e) => e.op === 'host.mountToolSidebar');
	/** The frame events a harness carried as signals, by name. */
	const signalled = (h: ReturnType<typeof createDevToolHarness>, name: string): number => h.wire.filter((e) => e.transient && e.topic === `tool:${APP}:toSidebar` && (e.value as { name?: unknown } | null)?.name === name).length;
	/** The event busPeer holds in its single retained frame-to-sidebar slot (what a mounting controller is replayed). */
	const retainedSlot = (h: ReturnType<typeof createDevToolHarness>): unknown => {
		const writes = h.wire.filter((e) => !e.transient && e.topic === `tool:${APP}:lastToSidebar`);
		return writes.length > 0 ? (writes[writes.length - 1].value as { name?: unknown } | null)?.name : undefined;
	};

	it('a graph frame summons nothing inside the settle window; its `active` on a window focus summons the controller too, once per hold', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const focus = focusable();
		const { frame } = mountFrame(h, 'workbench:k1|a', { focusTarget: focus.target });
		await settle();
		assert.deepEqual(summonsOf(h), [], 'nothing before the summon\'s settle');
		focus.fire();
		focus.fire();
		await settle();
		assert.deepEqual(summonsOf(h), [{ op: 'host.mountToolSidebar', params: { appId: APP } }], 'two focuses, one summon');
		frame.dispose();
	});

	it('F11: a graph frame with no controller summons it on purpose at mount: ONE reserved, non-op event after the settle; "unanswered" only after the grace; nothing once disposed', async () => {
		const h = createDevToolHarness(APP, { json: true });
		h.setHostConnection(true);
		const { frame, timers } = mountFrame(h, 'workbench:k1|a');
		await settle();
		assert.equal(frame.summon.get(), 'summoning');
		assert.equal(signalled(h, SUMMON_EVENT), 0, 'nothing inside the settle window');
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(signalled(h, SUMMON_EVENT), 1, 'the summon event, not a call and not an op name');
		assert.equal(signalled(h, 'active'), 0, 'not as a side effect of `active`');
		assert.deepEqual(summonsOf(h), [{ op: 'host.mountToolSidebar', params: { appId: APP } }]);
		assert.equal(frame.summon.get(), 'summoning', 'quiet until the grace is over');
		timers.advance(SUMMON_GRACE_MS);
		assert.equal(frame.summon.get(), 'unanswered');
		frame.dispose();
		const sent = signalled(h, SUMMON_EVENT);
		timers.advance(60_000);
		await settle();
		assert.equal(signalled(h, SUMMON_EVENT), sent, 'a disposed frame summons nothing');
		assert.equal(timers.pending(), 0, 'and leaves no timer behind');
	});

	it('F11: a frame whose controller is up summons nothing, and its summon state is ready', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame, timers } = mountFrame(mounted.h, 'workbench:k1|r');
		await until(() => frame.summon.get() === 'ready', 'the retained readiness');
		timers.advance(60_000);
		await settle();
		assert.equal(signalled(mounted.h, SUMMON_EVENT), 0);
		assert.deepEqual(summonsOf(mounted.h), []);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('F11: after a summon the newly ready controller hears the frame\'s `active`: the summon took busPeer\'s retained slot, and the frame re-announces once per readiness nonce', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const absent = mountController(engine.cm);
		absent.controller.dispose();
		absent.h.setHostConnection(true);
		const focus = focusable();
		const { frame, timers } = mountFrame(absent.h, 'workbench:k1|s', { focusTarget: focus.target });
		focus.fire();
		await settle();
		assert.equal(retainedSlot(absent.h), 'active', 'the premise: the frame\'s `active` sits in the retained slot');
		timers.advance(SUMMON_SETTLE_MS);
		await settle();
		assert.equal(retainedSlot(absent.h), SUMMON_EVENT, 'the summon replaced it: a controller mounting now is replayed the summon, not `active`');
		const activesBefore = signalled(absent.h, 'active');

		// The host mounts the controller on the summon, as both hosts do (its channel first, then the controller).
		const summoned = mountController(engine.cm, {}, absent.h, absent);
		await until(() => frame.summon.get() === 'ready', 'the summoned controller\'s readiness');
		await until(() => summoned.controller.activeConnection.get() === 'k1|s', 'the frame to announce itself to the summoned controller');
		assert.equal(signalled(absent.h, 'active') - activesBefore, 1, 'one re-announce for the new nonce');
		assert.deepEqual(summoned.errors, [], 'the replayed summon ran nothing');
		assert.deepEqual(absent.h.violations, []);
		frame.dispose();
		summoned.controller.dispose();
	});
});

describe('F12/F13 inputs: what the frame knows about the host connection and the account', () => {
	it('the host connection is unknown until the host publishes it, then false or true (never false by default)', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const { frame } = mountFrame(h, 'workbench:k1|c');
		await settle();
		assert.equal(frame.connected.get(), undefined, 'not published yet is not "disconnected"');
		h.setHostConnection(false);
		await until(() => frame.connected.get() === false, 'false');
		h.setHostConnection(true);
		await until(() => frame.connected.get() === true, 'true');
		frame.dispose();
	});

	it('F12: the frame follows the sign-in: pending before the controller says anything, nobody without an account, signed-in with one', async () => {
		const h = createDevToolHarness(APP, { json: true });
		const { frame } = mountFrame(h, 'workbench:k1|p');
		await settle();
		assert.equal(frame.signIn.get(), 'pending', 'no controller has said anything about the account');
		frame.dispose();

		const nobody = vscodeRealm();
		nobody.realm.root.connect(null);
		const unsigned = mountController(nobody.cm);
		unsigned.h.setHostConnection(true);
		const left = mountFrame(unsigned.h, 'workbench:k1|n');
		await until(() => left.frame.signIn.get() === 'nobody', 'the controller to vouch for nobody');
		left.frame.dispose();
		unsigned.controller.dispose();

		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const signed = mountController(engine.cm);
		signed.h.setHostConnection(true);
		const right = mountFrame(signed.h, 'workbench:k1|y');
		await until(() => right.frame.signIn.get() === 'signed-in', 'the controller to vouch for the account');
		right.frame.dispose();
		signed.controller.dispose();
	});
});
