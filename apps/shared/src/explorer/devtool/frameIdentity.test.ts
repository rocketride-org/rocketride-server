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
// EXPLORER DEV TOOL — FRAME IDENTITY GUARD (the frame half of R9; T7)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameIdentityGuard, followSignIn, IDENTITY_STATE_TOPIC, publishIdentityState } from './frameIdentity';
import type { FrameResetReason, SignInState } from './frameIdentity';
import { createIdentityTracker } from './identity';
import { account, assertJsonSafe, createDevToolHarness, createFakeClientRealm, createFakeSocketlessRealm, settle, shellProtocol } from './testing';

/**
 * A controller publishing a client realm's identity, and a frame over the same tool.
 *
 * @param docKey - The frame's docKey.
 * @returns The pieces.
 */
async function rig(docKey: string | undefined) {
	const h = createDevToolHarness();
	const realm = createFakeClientRealm();
	realm.login(account('user-a'));
	const tracker = createIdentityTracker({ cm: realm.cm });
	const controllerChannel = shellProtocol.createToolChannel(h.sidebarPeer);
	const stopPublishing = publishIdentityState(controllerChannel, tracker);
	const closed: string[] = [];
	const resets: FrameResetReason[] = [];
	const guard = createFrameIdentityGuard({
		channel: shellProtocol.createToolChannel(h.newFramePeer()),
		docKey,
		documents: { close: (key) => closed.push(key) },
		onReset: (reason) => resets.push(reason),
	});
	await settle();
	return { h, realm, tracker, guard, closed, resets, stop: () => { guard.dispose(); stopPublishing(); tracker.dispose(); } };
}

describe('publishIdentityState — the controller side', () => {
	it('publishes { fingerprint } on the identity topic now and on every fingerprint change, JSON-safe', async () => {
		const h = createDevToolHarness();
		const realm = createFakeClientRealm();
		realm.login(account('user-a'));
		const tracker = createIdentityTracker({ cm: realm.cm });
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		const seen: unknown[] = [];
		channel.onState(IDENTITY_STATE_TOPIC, (snapshot) => seen.push(snapshot));
		const stop = publishIdentityState(channel, tracker);
		realm.accountUpdate(account('user-a', 'org-1', 'team-1', { permissions: ['task.data'] }));
		realm.drop();
		realm.reconnect(account('user-b'));
		assert.deepEqual(seen, [{ fingerprint: 'user-a|org-1|team-1' }, { fingerprint: null }, { fingerprint: 'user-b|org-1|team-1' }]);
		for (const snapshot of seen) assertJsonSafe(snapshot);
		await settle();
		assert.deepEqual(h.violations, []);
		stop();
		tracker.dispose();
	});
});

describe('createFrameIdentityGuard — the frame side', () => {
	it('remembers the first fingerprint; a different one closes the document and resets its caches', async () => {
		const r = await rig('workbench:k1');
		assert.equal(r.guard.first(), 'user-a|org-1|team-1');
		r.realm.accountUpdate(account('user-a', 'org-1', 'team-1', { permissions: ['task.data'] }));
		await settle();
		assert.deepEqual(r.closed, [], 'a permission-hint change is the same identity');
		r.realm.accountUpdate(account('user-b'));
		await settle();
		assert.deepEqual(r.closed, ['workbench:k1']);
		assert.deepEqual(r.resets, ['identity']);
		assert.equal(r.guard.closed(), true);
		r.stop();
	});

	it('an unknown identity (null) clears caches but closes nothing; the same identity coming back changes nothing', async () => {
		const r = await rig('write:k1');
		r.realm.drop();
		await settle();
		assert.deepEqual(r.resets, ['unknown']);
		r.realm.reconnect(account('user-a'));
		await settle();
		assert.deepEqual(r.closed, []);
		assert.deepEqual(r.resets, ['unknown']);
		r.stop();
	});

	it('clears its caches when host:connection turns false, once per drop', async () => {
		const r = await rig('workbench:k1');
		r.h.setHostConnection(true);
		await settle();
		r.h.setHostConnection(false);
		await settle();
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.resets, ['disconnected']);
		r.h.setHostConnection(true);
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.resets, ['disconnected', 'disconnected']);
		assert.deepEqual(r.closed, []);
		r.stop();
	});

	it("a landing frame (docKey undefined or '') resets but is never closed, and adopts the new identity", async () => {
		for (const docKey of [undefined, '']) {
			const r = await rig(docKey);
			r.realm.accountUpdate(account('user-b'));
			await settle();
			assert.deepEqual(r.closed, []);
			assert.deepEqual(r.resets, ['identity']);
			assert.equal(r.guard.first(), 'user-b|org-1|team-1');
			r.realm.accountUpdate(account('user-b', 'org-1', 'team-1', { permissions: [] }));
			await settle();
			assert.deepEqual(r.resets, ['identity'], 'no second reset for the identity it adopted');
			r.stop();
		}
	});

	it('dispose stops it', async () => {
		const r = await rig('workbench:k1');
		r.guard.dispose();
		r.realm.accountUpdate(account('user-b'));
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.closed, []);
		assert.deepEqual(r.resets, []);
		r.stop();
	});
});

describe('round 3 — the guard keeps following (CE-3)', () => {
	/**
	 * A frame guard driven by hand-published identity states.
	 *
	 * @param documents - The frame's documents (or none).
	 * @returns The pieces.
	 */
	async function manual(documents?: { close(docKey: string): void }) {
		const h = createDevToolHarness();
		const controller = shellProtocol.createToolChannel(h.sidebarPeer);
		const resets: FrameResetReason[] = [];
		const guard = createFrameIdentityGuard({ channel: shellProtocol.createToolChannel(h.newFramePeer()), docKey: 'doc-1', documents, onReset: (reason) => resets.push(reason) });
		const publish = async (fingerprint: string | null) => {
			controller.publishState(IDENTITY_STATE_TOPIC, { fingerprint });
			await settle();
		};
		return { guard, resets, publish };
	}

	it('resets on every change after a close, closes at most once, and follows the identity it now vouches for', async () => {
		const closes: string[] = [];
		const r = await manual({ close: (key) => closes.push(key) });
		await r.publish('A');
		await r.publish('B');
		await r.publish(null);
		await r.publish('C');
		assert.deepEqual(r.resets, ['identity', 'unknown', 'identity']);
		assert.deepEqual(closes, ['doc-1'], 'closed once');
		assert.equal(r.guard.closed(), true);
		assert.equal(r.guard.first(), 'C');
	});

	it('does not latch closed without documents, or when the close throws (and tries again on the next change)', async () => {
		const none = await manual(undefined);
		await none.publish('A');
		await none.publish('B');
		assert.equal(none.guard.closed(), false);
		let attempts = 0;
		const flaky = await manual({ close: () => { attempts += 1; if (attempts === 1) throw new Error('webview gone'); } });
		await flaky.publish('A');
		await flaky.publish('B');
		assert.equal(flaky.guard.closed(), false);
		await flaky.publish('C');
		assert.equal(attempts, 2);
		assert.equal(flaky.guard.closed(), true);
		assert.deepEqual(flaky.resets, ['identity', 'identity']);
	});
});

describe('round 3 — a controller mount does not reset live frames for nothing (CE-10)', () => {
	it('a remounted controller publishes nothing until its tracker read settles, so frames see A -> A', async () => {
		const h = createDevToolHarness();
		const realm = createFakeSocketlessRealm();
		realm.root.connect(account('user-a'));
		await settle();
		const controller = shellProtocol.createToolChannel(h.sidebarPeer);
		const resets: FrameResetReason[] = [];
		const guard = createFrameIdentityGuard({ channel: shellProtocol.createToolChannel(h.newFramePeer()), docKey: 'doc-1', documents: { close: () => undefined }, onReset: (reason) => resets.push(reason) });
		const first = createIdentityTracker({ cm: realm.cm });
		const stopFirst = publishIdentityState(controller, first);
		await settle();
		assert.equal(guard.first(), 'user-a|org-1|team-1');
		stopFirst();
		first.dispose();
		// The controller remounts: its new tracker starts unknown and reads A from the root.
		const second = createIdentityTracker({ cm: realm.cm });
		const seen: unknown[] = [];
		controller.onState(IDENTITY_STATE_TOPIC, (snapshot) => seen.push(snapshot));
		const before = seen.length;
		const stopSecond = publishIdentityState(controller, second);
		assert.equal(seen.length, before, 'nothing published before the first read settled');
		await settle();
		assert.deepEqual(resets, [], 'no reset: the identity never changed');
		stopSecond();
		second.dispose();
		guard.dispose();
	});

	it('a tracker that settles unknown (signed out at mount) still publishes null', async () => {
		const h = createDevToolHarness();
		const realm = createFakeClientRealm();
		const tracker = createIdentityTracker({ cm: realm.cm });
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		const seen: unknown[] = [];
		channel.onState(IDENTITY_STATE_TOPIC, (snapshot) => seen.push(snapshot));
		const stop = publishIdentityState(channel, tracker);
		await settle();
		assert.deepEqual(seen, [{ fingerprint: null }]);
		stop();
		tracker.dispose();
	});
});

describe('T7, the frame half, over a socketless realm (review finding 3)', () => {
	it('A, disconnect, reconnect, B after shell:connected: the document closes once and resets [unknown, identity]; a landing frame only resets', async () => {
		for (const docKey of ['workbench:k1', undefined]) {
			const h = createDevToolHarness();
			const realm = createFakeSocketlessRealm();
			realm.root.connect(account('user-a'));
			await settle();
			const tracker = createIdentityTracker({ cm: realm.cm });
			await settle();
			const stop = publishIdentityState(shellProtocol.createToolChannel(h.sidebarPeer), tracker);
			const closed: string[] = [];
			const resets: FrameResetReason[] = [];
			const guard = createFrameIdentityGuard({ channel: shellProtocol.createToolChannel(h.newFramePeer()), docKey, documents: { close: (key) => closed.push(key) }, onReset: (reason) => resets.push(reason) });
			await settle();
			assert.equal(guard.first(), 'user-a|org-1|team-1');
			realm.root.disconnect();
			await settle();
			realm.root.connect(account('user-b'));
			await settle();
			const connectedAt = realm.events.lastIndexOf('shell:connected');
			assert.ok(realm.events.lastIndexOf('shell:accountUpdate') > connectedAt, 'B arrived after shell:connected');
			assert.deepEqual(resets, ['unknown', 'identity'], String(docKey));
			assert.deepEqual(closed, docKey ? ['workbench:k1'] : [], String(docKey));
			assert.equal(guard.first(), 'user-b|org-1|team-1');
			guard.dispose();
			stop();
			tracker.dispose();
		}
	});
});

describe('followSignIn — what a frame may say about the account', () => {
	it("'pending' until the controller publishes, 'nobody' for its settled null, 'signed-in' for a fingerprint", async () => {
		const h = createDevToolHarness('tool.signin', { json: true });
		const frameChannel = shellProtocol.createToolChannel(h.newFramePeer());
		const seen: SignInState[] = [];
		const off = followSignIn(frameChannel, (state) => seen.push(state));
		await settle();
		assert.deepEqual(seen, ['pending'], 'no identity published yet: nothing is known, so nothing is claimed');
		const controller = shellProtocol.createToolChannel(h.sidebarPeer);
		controller.publishState(IDENTITY_STATE_TOPIC, { fingerprint: null });
		await settle();
		controller.publishState(IDENTITY_STATE_TOPIC, { fingerprint: 'u1|o1|t1' });
		await settle();
		controller.publishState(IDENTITY_STATE_TOPIC, { fingerprint: 'u1|o1|t1' });
		await settle();
		assert.deepEqual(seen, ['pending', 'nobody', 'signed-in'], 'told on changes only');
		off();
		controller.publishState(IDENTITY_STATE_TOPIC, { fingerprint: null });
		await settle();
		assert.equal(seen.length, 3, 'nothing after unsubscribe');
	});

	it('a malformed snapshot is not a sign-in', async () => {
		const h = createDevToolHarness('tool.signin2', { json: true });
		const seen: SignInState[] = [];
		const off = followSignIn(shellProtocol.createToolChannel(h.newFramePeer()), (state) => seen.push(state));
		shellProtocol.createToolChannel(h.sidebarPeer).publishState(IDENTITY_STATE_TOPIC, { fingerprint: '' });
		await settle();
		assert.deepEqual(seen, ['pending', 'nobody']);
		off();
	});
});
