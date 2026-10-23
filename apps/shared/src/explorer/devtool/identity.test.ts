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
// EXPLORER DEV TOOL — IDENTITY TRACKER (R9 fails closed; T7 base sequences)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionManager } from 'shell';
import { identityFingerprint, identityFromConnectResult } from '../connect/identity';
import { createIdentityTracker } from './identity';
import type { IIdentityBus, IIdentityTracker } from './identity';
import { account, assertJsonSafe, createFakeClientRealm, createFakeSocketlessRealm, settle } from './testing';

const fp = (value: unknown): string | null => identityFingerprint(identityFromConnectResult(value));

/**
 * Record every fingerprint the tracker announces.
 *
 * @param tracker - The tracker.
 * @returns The log (starts with the current fingerprint).
 */
function record(tracker: IIdentityTracker): Array<string | null> {
	const seen: Array<string | null> = [tracker.get().fingerprint];
	tracker.subscribe((snapshot) => seen.push(snapshot.fingerprint));
	return seen;
}

describe('the ConnectionManager satisfies the structural identity bus', () => {
	it('compiles: a realm ConnectionManager is an IIdentityBus', () => {
		const check = (cm: ConnectionManager): IIdentityBus => cm;
		assert.equal(typeof check, 'function');
	});
});

describe('socketless realm (VS Code webview): the root account topic is the authority', () => {
	const A = account('user-a', 'org-1');
	const B = account('user-b', 'org-2');

	it('starts unknown and becomes known once the root account is read', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const tracker = createIdentityTracker({ cm: realm.cm });
		assert.equal(tracker.get().known, false, 'nothing is trusted before the root answers');
		await settle();
		assert.deepEqual(tracker.get(), { known: true, identity: identityFromConnectResult(A), fingerprint: fp(A) });
		assert.equal(tracker.known, true);
		assert.equal(tracker.fingerprint, fp(A));
		assert.deepEqual(tracker.identity, identityFromConnectResult(A));
		assertJsonSafe(tracker.get());
		tracker.dispose();
	});

	it('T7: account A -> disconnect -> reconnect -> account B after shell:connected ends with B, never A after the drop', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		const seen = record(tracker);

		realm.root.disconnect();
		await settle();
		assert.equal(tracker.get().known, false, 'a drop makes identity unknown');

		realm.root.connect(B);
		await settle();
		// Fidelity: the realm really saw the account AFTER the connection came back.
		const connectedAt = realm.events.lastIndexOf('shell:connected');
		const updateAt = realm.events.lastIndexOf('shell:accountUpdate');
		assert.ok(connectedAt >= 0 && updateAt > connectedAt, `events: ${realm.events.join(', ')}`);

		assert.equal(tracker.get().fingerprint, fp(B));
		assert.deepEqual(seen, [fp(A), null, fp(B)]);
		tracker.dispose();
	});

	it('does not get stuck when the root kept the same account and so never re-published it', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		realm.root.dropStatusOnly();
		await settle();
		assert.equal(tracker.get().known, false);
		const before = realm.events.filter((e) => e === 'shell:accountUpdate').length;
		realm.root.connect(A);
		await settle();
		assert.equal(realm.events.filter((e) => e === 'shell:accountUpdate').length, before, 'no fresh account event arrived');
		assert.equal(tracker.get().fingerprint, fp(A), 'the root topic still holds A, so A is current');
		tracker.dispose();
	});

	it('fails closed on a sign-out the realm mirror swallows (a null account while still connected)', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		realm.root.accountChanged(null);
		await settle();
		assert.equal(realm.cm.isConnected(), true);
		assert.equal(fp(realm.cm.getAccountInfo()), fp(A), 'the realm mirror still answers A (connection.ts ignores a falsy snapshot)');
		assert.deepEqual(tracker.get(), { known: false, identity: null, fingerprint: null });
		tracker.dispose();
	});

	it('never derives an identity from a snapshot without a user', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect({ organization: { id: 'org-1' } });
		await settle();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		assert.equal(tracker.get().known, false);
		tracker.dispose();
	});

	it('a topic push newer than an in-flight root read wins (the late read is ignored)', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const releases: Array<(value: unknown) => void> = [];
		const cm: IIdentityBus = { ...realm.cm, read: () => new Promise<unknown>((resolve) => { releases.push(resolve); }) };
		const tracker = createIdentityTracker({ cm });
		await settle();
		assert.equal(releases.length, 1, 'the mount read is in flight');
		realm.root.accountChanged(B);
		await settle();
		assert.equal(tracker.get().fingerprint, fp(B));
		releases[0](A);
		await settle();
		assert.equal(tracker.get().fingerprint, fp(B), 'the older read must not override the newer push');
		tracker.dispose();
	});

	it('mounted while disconnected: unknown until the root connects', async () => {
		const realm = createFakeSocketlessRealm();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		assert.equal(tracker.get().known, false);
		realm.root.connect(A);
		await settle();
		assert.equal(tracker.get().fingerprint, fp(A));
		tracker.dispose();
	});

	it('a bus without read/subscribe falls back to strict events: after a reconnect it waits for a fresh account', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(A);
		await settle();
		const bare: IIdentityBus = {
			on: (event, handler) => realm.cm.on(event, handler),
			isConnected: () => realm.cm.isConnected(),
			getAccountInfo: () => realm.cm.getAccountInfo(),
			getClient: () => realm.cm.getClient(),
		};
		const tracker = createIdentityTracker({ cm: bare });
		assert.equal(tracker.get().fingerprint, fp(A), 'the mount-time snapshot is all a bare bus has');
		realm.root.dropStatusOnly();
		await settle();
		realm.root.connect(A);
		await settle();
		assert.equal(tracker.get().known, false, 'no stale re-derivation from the mirror');
		realm.root.accountChanged(B);
		await settle();
		assert.equal(tracker.get().fingerprint, fp(B));
		tracker.dispose();
	});
});

describe('client realm (rocket-ui): the SDK client account is the authority', () => {
	const A1 = account('user-a', 'org-1');
	const A2 = account('user-a', 'org-2');
	const B = account('user-b', 'org-1');

	it('login makes the identity known', () => {
		const realm = createFakeClientRealm();
		const tracker = createIdentityTracker({ cm: realm.cm });
		assert.equal(tracker.get().known, false);
		realm.login(A1);
		assert.equal(tracker.get().fingerprint, fp(A1));
		tracker.dispose();
	});

	it('a drop makes it unknown; a background reconnect (no shell:login) brings it back from the handshake', () => {
		const realm = createFakeClientRealm();
		realm.login(A1);
		const tracker = createIdentityTracker({ cm: realm.cm });
		const seen = record(tracker);
		realm.drop();
		assert.equal(tracker.get().known, false);
		realm.reconnect(A1);
		assert.equal(tracker.get().fingerprint, fp(A1));
		assert.deepEqual(seen, [fp(A1), null, fp(A1)]);
		assert.equal(realm.events.filter((e) => e === 'shell:login').length, 1, 'the reconnect emitted no login');
		tracker.dispose();
	});

	it('follows an account update through the SDK client account', () => {
		const realm = createFakeClientRealm();
		realm.login(A1);
		const tracker = createIdentityTracker({ cm: realm.cm });
		realm.accountUpdate(A2);
		assert.equal(tracker.get().fingerprint, fp(A2));
		realm.drop();
		realm.reconnect(A2);
		assert.equal(fp(realm.cm.getAccountInfo()), fp(A1), 'the fake manager keeps its own copy');
		assert.equal(tracker.get().fingerprint, fp(A2));
		tracker.dispose();
	});

	it('logout: unknown, reconnects do not resurrect it, the next login does', () => {
		const realm = createFakeClientRealm();
		realm.login(A1);
		const tracker = createIdentityTracker({ cm: realm.cm });
		realm.logout();
		assert.equal(tracker.get().known, false);
		realm.reconnect(undefined);
		assert.equal(tracker.get().known, false);
		realm.login(B);
		assert.equal(tracker.get().fingerprint, fp(B));
		tracker.dispose();
	});

	it('orgChanged: unknown until a truthy account arrives, even across a reconnect', () => {
		const realm = createFakeClientRealm();
		realm.login(A1);
		const tracker = createIdentityTracker({ cm: realm.cm });
		realm.orgChanged('org-2');
		assert.equal(tracker.get().known, false);
		realm.drop();
		realm.reconnect(A1);
		assert.equal(tracker.get().known, false, 'the old organization is not trusted again');
		realm.accountUpdate(A2);
		assert.equal(tracker.get().fingerprint, fp(A2));
		tracker.dispose();
	});

	it('fails closed on a connection whose client is not authenticated (an anonymous attach), whatever account it reports', () => {
		const realm = createFakeClientRealm();
		realm.anonymousConnect(A1);
		assert.equal(realm.cm.isConnected(), true);
		const tracker = createIdentityTracker({ cm: realm.cm });
		assert.equal(tracker.get().known, false);
		realm.login(B);
		assert.equal(tracker.get().fingerprint, fp(B), 'an authenticated login is trusted');
		tracker.dispose();
	});

	it('an account update without a usable user makes the identity unknown', () => {
		const realm = createFakeClientRealm();
		realm.login(A1);
		const tracker = createIdentityTracker({ cm: realm.cm });
		realm.accountUpdate({});
		assert.equal(tracker.get().known, false);
		tracker.dispose();
	});
});

describe('tracker lifecycle', () => {
	it('notifies only on change, and dispose removes every listener and subscription', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(account('user-a'));
		await settle();
		const listenersBefore = realm.cm.listenerCount();
		const tracker = createIdentityTracker({ cm: realm.cm });
		await settle();
		let calls = 0;
		tracker.subscribe(() => { calls += 1; });
		realm.emit('shell:accountUpdate', account('user-a'));
		await settle();
		assert.equal(calls, 0, 'the same account announces nothing');
		realm.root.accountChanged(account('user-a', 'org-1', 'team-1', { permissions: ['task.data'] }));
		await settle();
		assert.equal(calls, 1, 'a change in the permission hints is announced (the store keeps hints current)');
		assert.equal(tracker.get().fingerprint, fp(account('user-a')), 'with the same fingerprint');
		const callsBeforeDispose = calls;
		tracker.dispose();
		assert.equal(realm.cm.listenerCount(), listenersBefore);
		realm.root.disconnect();
		await settle();
		assert.equal(calls, callsBeforeDispose, 'nothing after dispose');
	});
});

describe('tracker settling (the first answer it can vouch for, or not)', () => {
	it('a client realm settles at once; a socketless realm when its root read answers', async () => {
		const client = createFakeClientRealm();
		const t1 = createIdentityTracker({ cm: client.cm });
		assert.equal(t1.settled(), true);
		const realm = createFakeSocketlessRealm();
		realm.root.connect(account('user-a'));
		await settle();
		const t2 = createIdentityTracker({ cm: realm.cm });
		assert.equal(t2.settled(), false);
		const order: string[] = [];
		t2.whenSettled(() => order.push(`settled:${t2.get().fingerprint}`));
		await settle();
		assert.equal(t2.settled(), true);
		assert.deepEqual(order, ['settled:user-a|org-1|team-1']);
		let late = 0;
		t2.whenSettled(() => { late += 1; });
		assert.equal(late, 1, 'a late listener hears it at once');
		t1.dispose();
		t2.dispose();
	});
});

