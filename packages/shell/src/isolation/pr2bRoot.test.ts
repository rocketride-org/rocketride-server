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
// PR2b ROOT TESTS — the G4 checklist items the root has to close
// =============================================================================
//
//   * the bridge init goes through the scrub choke point (plan section 3.3,
//     PR2b checklist (1)): exact needles inside ANY init field deny the init;
//   * a denied `execute` answer whose buffered events were already delivered
//     ends that run (checklist (2), PR2a-2 G4 round 2, DA F8);
//   * every logout path detaches all realms, and a realm never serves a
//     second user's session (PR2b G4 checklist additions, PR2a-1 G4 DA N4);
//   * a connected shell with no account info fails closed for gated realms
//     (plan section 8, the PR2a-2 residual PR2b is to close);
//   * `entryPrefix` appears only in the init and in refresh replies (T55).
//
// Seam pinned here: `IAppRoot.bridgeInit(realmId, input)` builds the realm's
// `rr:bridge:init` with `buildBridgeInit` from the realm's grant and the
// caller's session view, passes it through the realm's outbound choke point
// (scrub plus the exact-needle backstop) and returns it, or throws a
// `CapabilityDeniedError` (`credential`). `handshake.ts` posts what it returns.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBridgeInit } from './projection';
import type { IBridgeInitInput } from './projection';
import type { IAppRoot } from './types';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, frameFor, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { assertNoReal, call, clientEvents, expectDenied, expectOk, lastRun } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { denialOf } from './__test__/util';

const SRC = 'chat_1';
const execute = (realm: IOpenedRealm): ReturnType<typeof call> => call(realm, 'execute', { pipeline: { components: [], source: SRC }, args: [], ttl: 60 });
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });

async function until(cond: () => boolean, what = 'a condition', ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type BridgeRoot = IAppRoot & { bridgeInit(realmId: string, input: Omit<IBridgeInitInput, 'info' | 'frame'>): unknown };

/** The caller-side inputs of one init (everything the shell contributes besides the grant). */
function initInput(over: Partial<Omit<IBridgeInitInput, 'info' | 'frame'>> = {}): Omit<IBridgeInitInput, 'info' | 'frame'> {
	return {
		displayName: 'Ada Lovelace',
		theme: { '--rr-bg': '#000' },
		props: { isConnected: true, activeView: 'view-1', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
		engineHttpUrl: 'http://localhost:5565',
		proto: 1,
		...over,
	};
}

function bridgeOf(t: ITestRoot): BridgeRoot {
	const root = t.root as BridgeRoot;
	// A missing seam must FAIL the test (not be mistaken for a refusal by an assert.throws).
	assert.equal(typeof root.bridgeInit, 'function', 'IAppRoot.bridgeInit does not exist yet (PR2b)');
	return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checklist (1): the bridge init goes through the choke point
// ─────────────────────────────────────────────────────────────────────────────

test('PR2b init: a clean init is what buildBridgeInit makes, entryPrefix (the frame token) included', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const init = bridgeOf(t).bridgeInit(A.realmId, initInput()) as Record<string, unknown>;
	const expected = buildBridgeInit({
		info: { realmId: A.realmId, label: '', appId: ENTRY_A.id, appKey: refAppKey(ENTRY_A.id), moduleId: ENTRY_A.moduleId, viewId: `view-${ENTRY_A.id}`, version: 1, caps: new Set(['core', 'pipelines.run', 'fs.app']) },
		frame: GRANT_A.frame!,
		...initInput(),
	}) as unknown as Record<string, unknown>;
	assert.equal(init.type, 'rr:bridge:init');
	assert.equal(init.entryPrefix, GRANT_A.frame!.entryPrefix, 'the frame token is the one deliberate exemption');
	assert.deepEqual(Object.keys(init).sort(), Object.keys(expected).sort(), 'exactly the BridgeInit keys');
	assert.deepEqual(init.identity, expected.identity);
	assert.deepEqual(init.props, expected.props);
});

test('PR2b init: the session token or the API key in ANY init field denies the init (exact needles, not only the credential patterns)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await execute(A);
	expectOk(run, 'setup run');
	const real = lastRun(t.cm);
	// None of these is shaped like tk_/pk_/rrapp.: only the exact-match half of the backstop sees them.
	const needles: Array<[string, string]> = [
		['the session token', t.cm.sessionToken],
		['the shell API key', t.cm.apiKey],
		['a real task token', real.token],
		['a real project id', real.projectId],
	];
	const fields: Array<[string, (n: string) => Partial<Omit<IBridgeInitInput, 'info' | 'frame'>>]> = [
		['theme value', (n) => ({ theme: { '--rr-x': `v ${n}` } })],
		['theme key', (n) => ({ theme: { [n]: 'x' } })],
		['displayName', (n) => ({ displayName: `Ada ${n}` })],
		['engineHttpUrl', (n) => ({ engineHttpUrl: `http://localhost:5565/${n}` })],
		['props.activeView', (n) => ({ props: { isConnected: true, activeView: n, activeActivity: null, sidePanelOpen: false, theme: 'dark' } })],
		['props.activeActivity', (n) => ({ props: { isConnected: true, activeView: 'v', activeActivity: n, sidePanelOpen: false, theme: 'dark' } })],
		['props.theme', (n) => ({ props: { isConnected: true, activeView: 'v', activeActivity: null, sidePanelOpen: false, theme: n } })],
	];
	for (const [needleName, needle] of needles) {
		for (const [field, make] of fields) {
			assert.throws(
				() => bridgeOf(t).bridgeInit(A.realmId, initInput(make(needle))),
				(err: unknown) => (err as { name?: string }).name === 'CapabilityDeniedError',
				`${needleName} in ${field} must deny the init`
			);
		}
	}
});

test('PR2b init: a needle in the grant-derived fields (entry moduleId, viewId) denies too; entryPrefix alone is exempt', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const poisonedEntry = { ...ENTRY_B, moduleId: `acme_${t.cm.sessionToken}` };
	const B = t.open(poisonedEntry, { grant: GRANT_B });
	assert.throws(() => bridgeOf(t).bridgeInit(B.realmId, initInput()), (err: unknown) => (err as { name?: string }).name === 'CapabilityDeniedError', 'the session token in moduleId');
	const C = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, GRANT_A.frame!.identity, `ft-${t.cm.apiKey}`) } });
	// The API key as the frame token: it IS a platform credential, so it is not an exemption the choke point may grant.
	assert.throws(() => bridgeOf(t).bridgeInit(C.realmId, initInput()), (err: unknown) => (err as { name?: string }).name === 'CapabilityDeniedError', 'the API key inside entryPrefix');
});

test('PR2b init: an init for a detached or unknown realm is refused', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const root = bridgeOf(t);
	A.detach();
	assert.throws(() => root.bridgeInit(A.realmId, initInput()), Error);
	assert.throws(() => root.bridgeInit('realm-nope', initInput()), Error);
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist (2): a denied execute answer ends its run
// ─────────────────────────────────────────────────────────────────────────────

test('PR2b F8: an execute answer denied at the choke point terminates its run, and no early event of it was delivered', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const release = t.cm.engine.hold('execute');
	// The answer carries the session token: an exact-match backstop hit (credential), not a pattern one.
	t.cm.engine.extendBody('execute', { note: `session ${t.cm.sessionToken}` });
	const before = t.cm.engine.received.length;
	const pending = execute(A);
	await until(() => t.cm.engine.messagesFor('execute', before).length === 1, 'the execute to reach the engine');
	const minted = (t.cm.engine.messagesFor('execute', before)[0].message.arguments as { pipeline: { project_id: string } }).pipeline.project_id;
	// An event that arrives before the answer: buffered (DA F8).
	t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: minted, source: SRC }));
	await settle();
	release();
	expectDenied(await pending, 'credential', 'the execute answer holding the session token');
	await settle();
	const started = t.cm.engine.runs.at(-1);
	assert.ok(started, 'the engine did start the run');
	await until(() => t.cm.engine.messagesFor('terminate', before).some((m) => (m.message.arguments as { token?: string } | undefined)?.token === started.token), 'a terminate of the run whose answer was denied');
	assert.deepEqual(clientEvents(A), [], 'events buffered for an answer that was never delivered are not delivered either');
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// N4: every logout detaches all realms; a realm never serves a second user
// ─────────────────────────────────────────────────────────────────────────────

/** How a realm's request ended within 300 ms. */
async function outcomeOf(promise: Promise<unknown>): Promise<'ok' | 'denied' | 'silent'> {
	const r = await Promise.race([promise.then((v) => ({ v }), () => ({ v: 'rejected' as const })), new Promise<{ v: 'silent' }>((resolve) => setTimeout(() => resolve({ v: 'silent' }), 300))]);
	if (r.v === 'silent') return 'silent';
	if (r.v === 'rejected') return 'denied';
	return denialOf(r.v) ? 'denied' : 'ok';
}

const shellEvents = (realm: IOpenedRealm, from = 0): string[] =>
	(realm.received.slice(from) as Array<Record<string, unknown>>).filter((m) => m?.__rrbus === 'emitOp' && String(m.op).startsWith('shell.event.')).map((m) => String(m.op));

test('PR2b N4: shell:logout (a logout that bypassed both handlers) detaches every realm: handles refused, no shell.event.* delivered', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const B = t.open(ENTRY_B, { grant: GRANT_B });
	const run = expectOk(await execute(A), 'run');
	assert.equal((await status(A, String(run.token))).kind, 'ok', 'control: the handle works before the logout');

	const engineSeen = t.cm.engine.received.length;
	t.cm.emit('shell:logout', {});
	await settle();
	const marks = [A.received.length, B.received.length];

	for (const [name, realm] of [['A', A], ['B', B]] as const) {
		const result = await outcomeOf(call(realm, 'rrext_get_task_status', { token: String(run.token) }));
		assert.notEqual(result, 'ok', `realm ${name} must not be served after a logout`);
	}
	assert.deepEqual(
		t.cm.engine.received.slice(engineSeen).filter((m) => m.message.command === 'rrext_get_task_status').length,
		0,
		'nothing was forwarded to the engine for a detached realm'
	);
	t.cm.emit('shell:connected', {});
	t.cm.emit('shell:themeChange', { tokens: { '--rr-bg': '#fff' } });
	await settle();
	assert.deepEqual(shellEvents(A, marks[0]), [], 'no shell.event.* reaches the detached realm A');
	assert.deepEqual(shellEvents(B, marks[1]), [], 'no shell.event.* reaches the detached realm B');
	// It is gone, not paused: a bridge init for it is refused too.
	const root = bridgeOf(t);
	assert.throws(() => root.bridgeInit(A.realmId, initInput()), Error);
});

test('PR2b N4: handleLogout / handleBackToHome order (teardownAll, then cm.logout) also leaves no realm attached', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = expectOk(await execute(A), 'run');
	await t.root.teardownAll(1500);
	t.cm.emit('shell:logout', {});
	await settle();
	assert.notEqual(await outcomeOf(status(A, String(run.token))), 'ok');
	t.cm.emit('shell:connected', {});
	await settle();
	assert.deepEqual(shellEvents(A), [], 'nothing reaches it');
});

test('PR2b N4: log in as A, open an isolated app, log out, log in as B: the old realm is detached, its handles are refused, no shell.event.* reaches it', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const old = t.open(ENTRY_A, { grant: GRANT_A });
	const run = expectOk(await execute(old), 'run under user A');
	t.cm.emit('shell:logout', {});
	t.cm.setSignedIn(false);
	t.cm.setSignedIn(true);
	t.cm.emit('shell:login', { user: { userId: 'user-b' } });
	await settle();
	const mark = old.received.length;

	const fresh = t.open(ENTRY_A, { grant: GRANT_A });
	assert.equal((await call(fresh, 'rrext_get_task_status', { token: String(run.token) })).kind, 'denied', "the new session's realm cannot use user A's handle");
	assert.notEqual(await outcomeOf(status(old, String(run.token))), 'ok', 'the old realm is not served under user B');
	t.cm.emit('shell:connected', {});
	t.cm.emit('shell:statusChange', {});
	await settle();
	assert.deepEqual(shellEvents(old, mark), [], 'no shell.event.* reaches the old realm');
	assert.ok(shellEvents(fresh).length > 0, 'control: the new realm does get shell events');
});

test('PR2b N4: a sign-in with no logout before it (another tab signed in as someone else) also detaches the realms attached before it', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const old = t.open(ENTRY_A, { grant: GRANT_A });
	const run = expectOk(await execute(old), 'run');
	t.cm.emit('shell:login', { user: { userId: 'someone-else' } });
	await settle();
	assert.notEqual(await outcomeOf(status(old, String(run.token))), 'ok', 'a frame attached before a sign-in does not survive it (a reload needs a fresh /apps/frame grant)');
});

test('PR2b N4: a same-user sign-in (a reconnect re-emits shell:login) keeps the realm, its handles and its shell.event.*', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = expectOk(await execute(A), 'run');
	t.cm.emit('shell:login', { user: { userId: t.cm.engine.userId } });
	await settle();
	assert.equal(await outcomeOf(status(A, String(run.token))), 'ok', 'the same user: the realm still serves');
	const mark = A.received.length;
	t.cm.emit('shell:connected', {});
	await settle();
	assert.deepEqual(shellEvents(A, mark), ['shell.event.connected'], 'and still gets shell events');
});

test('PR2b N4: a sign-in whose user id is unknown detaches (fail closed)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = expectOk(await execute(A), 'run');
	t.cm.emit('shell:login', { user: {} });
	await settle();
	assert.notEqual(await outcomeOf(status(A, String(run.token))), 'ok');
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan section 8, PR2a-2 residual: connected, but no account info
// ─────────────────────────────────────────────────────────────────────────────

test('PR2b residual: a connected shell with no account info fails closed for a gated realm, and serves once it has account info', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const getAccountInfo = t.cm.engine.client.getAccountInfo;
	t.cm.engine.client.getAccountInfo = () => undefined;
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	assert.equal(t.cm.isConnected(), true, 'setup: the shell is connected');
	const before = t.cm.engine.received.length;
	const denied = await execute(A);
	const d = denied.kind === 'denied' ? denied : null;
	assert.ok(d, `without account info the realm is refused, got ${JSON.stringify(denied)}`);
	assert.equal(t.cm.engine.received.length, before, 'nothing was forwarded to the engine');

	t.cm.engine.client.getAccountInfo = getAccountInfo;
	expectOk(await execute(A), 'with account info the same request is served');
});

// ─────────────────────────────────────────────────────────────────────────────
// T55 (root side): entryPrefix only in the init and in refresh replies; a reload remints
// ─────────────────────────────────────────────────────────────────────────────

test('T55 the frame token appears in no realm message but a refresh reply; each refresh and each attach mints a new one', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	expectOk(await execute(A), 'run');
	const token = /\/_t\/([^/]+)\//.exec(GRANT_A.frame!.entryPrefix)![1];
	const first = (await A.request('shell.frameToken.refresh', {})) as { entryPrefix: string };
	t.clock.advance(120_000); // the refresh is rate limited per realm
	const second = (await A.request('shell.frameToken.refresh', {})) as { entryPrefix: string };
	assert.notEqual(first.entryPrefix, second.entryPrefix, 'every refresh is a new /apps/frame answer');
	assert.equal(t.fetches.length, 2);
	const holders = A.received.filter((m) => JSON.stringify(m).includes(token));
	assert.deepEqual(holders, [], "the init's own token never comes back down the bus");
	const refreshHolders = A.received.filter((m) => JSON.stringify(m).includes('/_t/frametoken-'));
	assert.equal(refreshHolders.length, 2, 'exactly the two refresh replies carry a frame token');
	const reloaded = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, GRANT_A.frame!.identity, 'frametoken-reload') } });
	const reloadedInit = bridgeOf(t).bridgeInit(reloaded.realmId, initInput()) as { entryPrefix: string };
	assert.equal(reloadedInit.entryPrefix, '/_t/frametoken-reload/v1/', 'a reload (a new attach with a fresh grant) carries the new token');
	assert.notEqual(reloadedInit.entryPrefix, GRANT_A.frame!.entryPrefix);
});
