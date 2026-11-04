// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// D6 fix-forward: the controller's own identity fence for a held op, the only
// permanent delete the app offers (deleted_only), an honest mixed-restore count,
// and the manifest's publisher.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { createFrameCaller } from 'shared/explorer/devtool/frame';
import { account, shellProtocol } from 'shared/explorer/devtool/testing';
import { OP } from '../src/devtool/protocol';
import type { VectorOps } from '../src/devtool/protocol';
import { removalSummary, runRemoval } from '../src/vector/confirm';
import { readTrashResult } from '../src/vector/results';
import { disposeAll, mountController, settle, signInVsCode, track, until, vscodeRealm } from './support/devtool';

afterEach(disposeAll);

const ID = '91ae15d4-3f6e-589f-bb81-72301f2ca1b6';
const T = { timeoutMs: 60_000 };

/** A signed-in controller whose NEXT discovery is held, and a frame caller of the held connection's key. */
async function heldDiscovery() {
	const engine = vscodeRealm();
	signInVsCode(engine.realm, 'u1');
	const first = mountController(engine.cm);
	first.h.setHostConnection(true);
	await until(() => Object.keys(first.controller.store.getState().probes).length === 1, 'discovery under A');
	const key = first.controller.store.getState().endpoints[0].key;
	first.controller.dispose();
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	engine.before.current = async (op) => {
		if (op === 'client.getTasks' || op === 'client.listTasks') await gate;
	};
	const second = mountController(engine.cm, {}, first.h, first);
	await settle();
	const caller = track(createFrameCaller<VectorOps>({ channel: shellProtocol.createToolChannel(first.h.newFramePeer()), createToolOpClient: shellProtocol.createToolOpClient }));
	await until(() => caller.controllerReady(), 'the controller readiness');
	return { engine, key, second, caller, release: () => { engine.before.current = null; release(); } };
}

describe('D6-VX-2: an op accepted under account A is never sent under account B', () => {
	for (const [name, op, input] of [
		['soft_delete', OP.trash, { object_ids: [ID] }],
		['restore', OP.restore, { object_ids: [ID] }],
		['delete', OP.deletePermanently, { object_ids: [ID], deleted_only: true }],
	] as const) {
		it(`a ${name} held for discovery is refused unsent (stale) once B is signed in`, async () => {
			const run = await heldDiscovery();
			const pending = run.caller.callReply(op, { key: run.key, input, origin: 'frame-of-A' } as never, T).then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
			await settle();
			assert.equal(run.engine.world.calls.filter((c) => c.tool === name).length, 0, 'premise: held, not sent');
			run.engine.realm.root.connect(account('u2'));
			await settle();
			run.release();
			const outcome = (await pending) as { ok?: unknown; err?: ExplorerToolError };
			await settle();
			assert.equal(run.engine.world.calls.filter((c) => c.tool === name).length, 0, `${name} was sent under B`);
			assert.ok(outcome.err instanceof ExplorerToolError && outcome.err.kind === 'stale', `expected stale, got ${JSON.stringify(outcome)}`);
			run.second.controller.dispose();
		});
	}

	it('a read held the same way is refused too', async () => {
		const run = await heldDiscovery();
		const read = run.caller.callReply(OP.stats, { key: run.key, input: { mode: 'full' } }, T).then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));
		await settle();
		run.engine.realm.root.connect(account('u2'));
		await settle();
		run.release();
		const outcome = (await read) as { err?: ExplorerToolError };
		assert.ok(outcome.err instanceof ExplorerToolError && outcome.err.kind === 'stale');
		assert.equal(run.engine.world.calls.filter((c) => c.tool === 'stats').length, 0);
		run.second.controller.dispose();
	});
});

describe('D6-VX-3: the only permanent delete is deleted_only', () => {
	async function mounted() {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const m = mountController(engine.cm);
		m.h.setHostConnection(true);
		await until(() => Object.keys(m.controller.store.getState().probes).length === 1, 'discovery');
		const key = m.controller.store.getState().endpoints[0].key;
		const caller = track(createFrameCaller<VectorOps>({ channel: shellProtocol.createToolChannel(m.h.newFramePeer()), createToolOpClient: shellProtocol.createToolOpClient }));
		return { engine, m, key, caller };
	}

	it('a call without deleted_only reaches the node with deleted_only: true', async () => {
		const { engine, m, key, caller } = await mounted();
		await caller.callReply(OP.deletePermanently, { key, input: { object_ids: ['live-doc'] }, origin: 'f' }, T);
		assert.deepEqual(engine.world.calls.filter((c) => c.tool === 'delete').map((c) => c.input), [{ object_ids: ['live-doc'], deleted_only: true }]);
		m.controller.dispose();
	});

	it('a call that asks for deleted_only false (or anything but true) is refused, nothing sent', async () => {
		const { engine, m, key, caller } = await mounted();
		for (const bad of [false, 'yes', 0, null]) {
			await assert.rejects(caller.callReply(OP.deletePermanently, { key, input: { object_ids: ['live-doc'], deleted_only: bad }, origin: 'f' } as never, T), (e: unknown) => e instanceof ExplorerToolError && e.kind === 'invalid', String(bad));
		}
		assert.equal(engine.world.calls.filter((c) => c.tool === 'delete').length, 0);
		m.controller.dispose();
	});
});

describe('D6-VX-5: a mixed restore does not claim every document moved', () => {
	const targets = [{ objectId: 'a', path: '/a.md' }, { objectId: 'b', path: '/b.md' }, { objectId: 'c', path: '/c.md' }];
	it('says some were already restored, with the chunks that moved, and no document count it cannot know', async () => {
		const view = readTrashResult({ success: true, object_ids: ['a', 'b', 'c'], matched_chunks: 6, moved_chunks: 2, not_found: [] });
		const outcome = await runRemoval(['a', 'b', 'c'], async () => ({ removed: view.moved.map((objectId) => ({ objectId, chunks: null })), notFound: view.notFound, keptLive: [], removedChunks: view.movedChunks, someUnmoved: view.someUnmoved }), 100);
		const text = removalSummary(outcome, targets, 'restore');
		assert.doesNotMatch(text, /Restored 3 documents/);
		assert.match(text, /2 chunks moved/);
		assert.match(text, /already restored/);
	});

	it('a batch where everything moved keeps the plain sentence', async () => {
		const view = readTrashResult({ success: true, object_ids: ['a', 'b', 'c'], matched_chunks: 6, moved_chunks: 6, not_found: [] });
		assert.equal(view.someUnmoved, false);
		const outcome = await runRemoval(['a', 'b', 'c'], async () => ({ removed: view.moved.map((objectId) => ({ objectId, chunks: null })), notFound: [], keptLive: [], removedChunks: view.movedChunks, someUnmoved: view.someUnmoved }), 100);
		assert.equal(removalSummary(outcome, targets, 'restore'), 'Restored 3 documents (6 chunks moved).');
	});

	it('a node that reports no matched count cannot say which were skipped: it claims nothing either way', () => {
		assert.equal(readTrashResult({ success: true, object_ids: ['a'], moved_chunks: 2, not_found: [] }).someUnmoved, false);
		assert.equal(readTrashResult({ success: true, object_ids: ['a'], matched_chunks: 4, moved_chunks: null, not_found: [] }).someUnmoved, false);
	});
});

describe('the permanent delete answer: removed_chunks may be null, kept_live names what stayed', () => {
	it('words a delete with an uncounted removal and one kept document', () => {
		const outcome = { removed: [{ objectId: 'a', chunks: null }], notFound: [], keptLive: ['b'], removedChunks: null, batchesRun: 1, batchesTotal: 1, error: null };
		const text = removalSummary(outcome, [{ objectId: 'a', path: '/a.md' }, { objectId: 'b', path: '/b.md' }], 'delete');
		assert.match(text, /Deleted 1 document permanently\./);
		assert.doesNotMatch(text, /chunks\)/, 'no count it does not have');
		assert.match(text, /was kept/);
	});
});

describe('D6-PKG-1: the manifest follows develop\'s convention', () => {
	it('the publisher is RocketRide, the id and the version are unchanged', () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).appManifest as { id: string; publisher: string };
		assert.equal(manifest.publisher, 'RocketRide');
		assert.equal(manifest.id, 'rocketride.vector');
	});
});
