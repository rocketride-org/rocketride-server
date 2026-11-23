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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// PR2b G4 ROUND 2 — the root (DA 2, DA LOW 2/3, security LOW-4)
// =============================================================================
//
//   * the user recorded at attach is kept apart from an adopted one: a realm
//     attached with no account info is detached at the next shell:login,
//     whatever user it names (lead answer 2), and every engine op is refused
//     when the session token differs from the one at attach;
//   * a same-user account arrival with no shell:login keeps serving (PR2a-2);
//   * the final-teardown seal is lifted only by shell:logout: a shell:login
//     (same-user reconnect, an org-change rescope) during the logout clear
//     does not let an execute through.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAppRoot, IRealmGrant } from './types';
import { ENTRY_A, GRANT_A, makeRoot } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { call, expectDenied, expectOk } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';

const SRC = 'chat_1';
const execute = (realm: IOpenedRealm): ReturnType<typeof call> => call(realm, 'execute', { pipeline: { components: [], source: SRC }, args: [], ttl: 60 });
const INIT = { displayName: '', theme: {}, props: { isConnected: true, activeView: '', activeActivity: null, sidePanelOpen: false, theme: '' }, engineHttpUrl: 'http://localhost:5565', proto: 1 };
const detached = (t: ITestRoot, realm: IOpenedRealm): boolean => {
	try {
		(t.root as IAppRoot).bridgeInit(realm.realmId, INIT);
		return false;
	} catch (err) {
		return !(err as { name?: string }).name?.includes('CapabilityDenied');
	}
};
type G4Root = IAppRoot & { teardownAll(ms: number, o?: { final?: boolean }): Promise<void>; sessionStamp(): unknown };

/** A realm attached signed in (token present) before the account info exists. */
function accountLess(t: ITestRoot): { realm: IOpenedRealm; restore(info?: unknown): void } {
	const original = t.cm.engine.client.getAccountInfo;
	t.cm.engine.client.getAccountInfo = () => undefined;
	const realm = t.open(ENTRY_A, { grant: GRANT_A });
	return {
		realm,
		restore(info?: unknown) {
			t.cm.engine.client.getAccountInfo = info === undefined ? original : () => info;
		},
	};
}

test("G4r2 (a) attached under A's token with no account info; the tab switches to B: refused by the token check, then detached by shell:login(B)", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const { realm, restore } = accountLess(t);
	t.cm.setSessionToken('sess-user-b-0123456789abcdef0123');
	restore({ userId: 'user-b-0123456789', devTeam: 'tb', organization: null });
	const before = t.cm.engine.received.length;
	expectDenied(await execute(realm), 'capability', 'a request under another session token');
	assert.equal(t.cm.engine.received.length, before, 'nothing forwarded');
	t.cm.emit('shell:login', { user: { userId: 'user-b-0123456789' } });
	await settle();
	assert.equal(detached(t, realm), true, 'detached at shell:login: its attach-time user was unknown');
});

test("G4r2 (b) attached signed in with no account info; the same user's account info arrives with no shell:login: still served (PR2a-2)", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const { realm, restore } = accountLess(t);
	restore();
	expectOk(await execute(realm), 'served once the account info exists');
	expectOk(await execute(realm), 'and again');
});

test('G4r2 (c) attached with no account info, then shell:login as the same user: detached (lead answer 2: an unknown attach user detaches)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const { realm, restore } = accountLess(t);
	restore();
	expectOk(await execute(realm), 'adopted and served before the login event');
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	assert.equal(detached(t, realm), true, 'adoption does not change the attach-time user');
});

test('G4r2 the seal survives a shell:login: a same-user reconnect during the logout clear does not let an execute through', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	await (t.root as G4Root).teardownAll(1500, { final: true });
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	const before = t.cm.engine.received.length;
	expectDenied(await execute(A), 'capability', 'the same-user reconnect did not reopen the root');
	const fresh = t.open(ENTRY_A, { grant: { ...GRANT_A, session: (t.root as G4Root).sessionStamp() } as IRealmGrant });
	expectDenied(await execute(fresh), 'capability', 'nor does a realm attached after it');
	assert.equal(t.cm.engine.received.length, before, 'nothing forwarded');
});

test("G4r2 the seal survives an org-change rescope (shell:orgChanged, then the reconnect's shell:login) during the logout clear", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	t.open(ENTRY_A, { grant: GRANT_A });
	await (t.root as G4Root).teardownAll(1500, { final: true });
	t.cm.emit('shell:orgChanged', { orgId: 'org-b' });
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	const remounted = t.open(ENTRY_A, { grant: { ...GRANT_A, session: (t.root as G4Root).sessionStamp() } as IRealmGrant });
	const before = t.cm.engine.received.length;
	expectDenied(await execute(remounted), 'capability', 'a frame remounted by the rescope is not served');
	assert.equal(t.cm.engine.received.length, before);
	t.cm.emit('shell:logout', {});
	await settle();
	const next = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(next), 'shell:logout lifts the seal (the next session works)');
});
