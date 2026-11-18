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
// PR2b G4 ROUND 1 — the root fixes (DA must-fix 1, security MEDIUM, DA LOW 1/2/5, security LOW 1)
// =============================================================================
//
//   * a FINAL teardown (`teardownAll(ms, { final: true })`, the logout path)
//     keeps the root closed until the next shell:login or shell:logout: every
//     op is refused, nothing reaches the engine, no event is delivered, also
//     after a delay as long as the logout clear;
//   * every engine op re-checks the account user against the user the realm
//     was attached under (DA LOW 2);
//   * a grant fetched before a logout or under another user is refused at
//     attach (`root.sessionStamp()` taken at fetch time, `grant.session`) (DA LOW 1);
//   * detaching a realm closes the root's end of its port (DA LOW 5);
//   * an in-process org rescope (`shell:orgChanged`) detaches every realm (security LOW 1).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAppRoot, IRealmGrant } from './types';
import { ENTRY_A, GRANT_A, makeRoot } from './__test__/fixtures';
import { call, expectDenied, expectOk } from './__test__/n1';
import { createChannel, settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';

const SRC = 'chat_1';
const execute = (realm: IOpenedRealm): ReturnType<typeof call> => call(realm, 'execute', { pipeline: { components: [], source: SRC }, args: [], ttl: 60 });

type G4Root = IAppRoot & {
	teardownAll(timeoutMs: number, options?: { final?: boolean }): Promise<void>;
	sessionStamp?(): unknown;
};

const shellEvents = (realm: IOpenedRealm, from = 0): string[] =>
	(realm.received.slice(from) as Array<Record<string, unknown>>).filter((m) => m?.__rrbus === 'emitOp' && String(m.op).startsWith('shell.event.')).map((m) => String(m.op));

test('G4 final teardown: every client.request after it is denied and nothing reaches the engine, also after a logout-clear delay', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(A), 'control: served before the logout');
	await (t.root as G4Root).teardownAll(1500, { final: true });
	const before = t.cm.engine.received.length;
	expectDenied(await execute(A), 'capability', 'an execute right after the final teardown');
	// The logout clear (frame navigations, sweeps) can take seconds before cm.logout().
	await new Promise((resolve) => setTimeout(resolve, 250));
	t.clock.advance(5_000);
	expectDenied(await execute(A), 'capability', 'an execute during the logout clear');
	expectDenied(await call(A, 'rrext_get_task_status', { token: 'rh_AAAAAAAAAAAAAAAAAAAAAA' }), 'capability', 'any other client.request');
	assert.equal(t.cm.engine.received.length, before, 'nothing reached the engine after the final teardown');
	const mark = A.received.length;
	t.cm.emit('shell:connected', {});
	await settle();
	assert.deepEqual(shellEvents(A, mark), [], 'no shell.event.* while the root is closed');
});

test('G4 a plain teardownAll (not final) still reopens afterwards (the non-logout callers)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	await t.root.teardownAll(1500);
	expectOk(await execute(A), 'served again after a non-final teardown');
});

test('G4 final teardown, then logout and the next login: a newly attached realm works', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	t.open(ENTRY_A, { grant: GRANT_A });
	await (t.root as G4Root).teardownAll(1500, { final: true });
	t.cm.emit('shell:logout', {});
	t.cm.setSignedIn(false);
	t.cm.setSignedIn(true);
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	const fresh = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(fresh), 'the new session is served');
});

test('G4 every engine op re-checks the account user: a switch the shell:login event has not announced yet is refused', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(A), 'control');
	t.cm.engine.userId = 'someone-else-entirely';
	const before = t.cm.engine.received.length;
	expectDenied(await execute(A), 'capability', 'the account user changed under the realm');
	assert.equal(t.cm.engine.received.length, before, 'nothing forwarded');
});

test('G4 a grant fetched before a logout, or under another user, is refused at attach', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const root = t.root as G4Root;
	assert.equal(typeof root.sessionStamp, 'function', 'IAppRoot.sessionStamp does not exist yet');
	const stamp = root.sessionStamp!();
	t.open(ENTRY_A, { grant: { ...GRANT_A, session: stamp } as IRealmGrant });
	t.cm.emit('shell:logout', {});
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	assert.throws(() => t.open(ENTRY_A, { grant: { ...GRANT_A, session: stamp } as IRealmGrant }), 'a grant from before the logout');
	const fresh = root.sessionStamp!();
	t.cm.engine.userId = 'user-b-is-signed-in-now';
	assert.throws(() => t.open(ENTRY_A, { grant: { ...GRANT_A, session: fresh } as IRealmGrant }), 'a grant fetched under another user');
	t.cm.engine.userId = 'local';
	t.open(ENTRY_A, { grant: { ...GRANT_A, session: root.sessionStamp!() } as IRealmGrant });
});

test('G4 detaching a realm closes the root end of its port', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const channel = createChannel();
	tt.after(() => channel.close());
	let closed = 0;
	const endpoint = { ...channel.a, close: () => void closed++ };
	const realmId = t.root.attach(ENTRY_A, endpoint, GRANT_A);
	t.root.detach(realmId);
	assert.equal(closed, 1, 'endpoint.close() ran once');
	const other = { ...createChannel().a, close: () => void closed++ };
	t.root.attach(ENTRY_A, other, GRANT_A);
	t.cm.emit('shell:logout', {});
	await settle();
	assert.equal(closed, 2, 'a logout detach closes it too');
});

test('G4 an in-process org rescope (shell:orgChanged) detaches every realm', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(A), 'control');
	t.cm.emit('shell:orgChanged', { orgId: 'org-b' });
	await settle();
	const before = t.cm.engine.received.length;
	const outcome = await Promise.race([execute(A).then((r) => r.kind), new Promise<string>((r) => setTimeout(() => r('silent'), 300))]);
	assert.notEqual(outcome, 'ok', 'the realm is not served under the new org');
	assert.equal(t.cm.engine.received.length, before, 'nothing forwarded');
	assert.throws(() => (t.root as IAppRoot).bridgeInit(A.realmId, { displayName: '', theme: {}, props: { isConnected: true, activeView: '', activeActivity: null, sidePanelOpen: false, theme: '' }, engineHttpUrl: 'http://localhost:5565', proto: 1 }), 'detached');
});
