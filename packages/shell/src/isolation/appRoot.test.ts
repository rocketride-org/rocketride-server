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
// APP ROOT TESTS — T20, T30 to T35, T39, T40, T45 to T47, T107
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { IBusEndpoint } from '../ops/busBridge';
import { ENTRY_A, ENTRY_B, ENTRY_FIRST_PARTY, makeRoot, refAppKey, RE } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, assertDeniedOp, assertNotForwarded, bodyOfResponse, brief, outcome, startRun } from './__test__/util';

const keyA = refAppKey(ENTRY_A.id);

test('T20 realms of one app and of two apps share nothing', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const B = t.open(ENTRY_B);
	const A2 = t.open(ENTRY_A);
	const [ra, rb, ra2] = [await startRun(A), await startRun(B), await startRun(A2)];
	const engine = t.cm.engine;

	for (const [who, realm] of [
		['another app', B],
		['a second frame of the same app', A2],
	] as const) {
		const before = engine.received.length;
		assertDenied(await clientRequest(realm, dap('rrext_get_task_status', { token: ra.token })), 'ownership', `a handle used from ${who}`);
		assertNotForwarded(engine, before, `a handle used from ${who}`);
	}
	const refresh = (await outcome(A2.request('shell.frameToken.refresh', {}))) as { ok: boolean; value?: { entryPrefix?: string } };
	assert.ok(refresh.ok && refresh.value?.entryPrefix, `refresh must answer, got ${brief(refresh)}`);
	assert.deepEqual(t.fetches, [{ appId: 'acme.alpha', version: 1 }], 'refresh calls fetchFrame once, for the caller');
	for (const [realm, run] of [
		[A, ra],
		[B, rb],
		[A2, ra2],
	] as const) {
		assert.equal((await clientRequest(realm, dap('rrext_get_task_status', { token: run.token }))).ok, true, 'each realm keeps its own run');
	}
});

test('T30 the realm op set is exactly the documented one; the root is not imported elsewhere', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	for (const op of ['client.log.openStream', 'client.log.streamCall', 'client.log.streamPlay', 'client.log.streamPause', 'client.log.streamIngest', 'client.log.streamClose', 'host.openExternal', 'shell.updateSetting', 'shell.settings.attach', 'explorer.list']) {
		await assertDeniedOp(A.request(op, { sessionId: 's', projectId: 'p', source: 's' }), 'unknown_op', op);
	}

	// Grep guard: only src/isolation/ imports the root or names the gated router.
	const src = path.join(__dirname, '..');
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.tsx?$/.test(e.name)) {
				const rel = path.relative(src, full);
				if (rel.startsWith(`isolation${path.sep}`) || rel === path.join('ops', 'busBridge.ts')) continue;
				const text = readFileSync(full, 'utf8');
				if (/isolation\/appRoot/.test(text) || /createGatedBusRouter/.test(text)) offenders.push(rel);
			}
		}
	};
	walk(src);
	assert.deepEqual(offenders, [], `nothing outside src/isolation may import appRoot or name createGatedBusRouter: ${offenders.join(', ')}`);

	for (const op of ['client.request', 'client.addMonitor', 'client.removeMonitor', 'shell.frameToken.refresh', 'shell.notify', 'shell.statusMessage', 'shell.loginRequest', 'shell.openExternal', 'bus.topic.read']) {
		const r = await outcome(A.request(op, {}));
		if (!r.ok) assert.ok(!r.message.includes('"code":"unknown_op"'), `${op} must be a resolvable op, got ${r.message}`);
	}
});

test('T31 prefs ops are confined to the app partition and bounded', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const emitted = (): Array<{ op: string; params: unknown }> => t.cm.opsEmitted.filter((o) => o.op.startsWith('shell.'));
	A.emit('shell.prefs.attach', { partition: 'app:acme.alpha' });
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'k', value: 1 });
	await settle();
	assert.deepEqual(
		emitted().map((o) => o.op),
		['shell.prefs.attach', 'shell.setPref'],
		'own-partition prefs ops must be re-emitted on the root bus'
	);

	const before = emitted().length;
	t.clock.advance(60_000);
	A.emit('shell.setPref', { partition: 'app:other', key: 'k', value: 1 });
	A.emit('shell.setPref', { partition: 'shell', key: 'k', value: 1 });
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'k'.repeat(65), value: 1 });
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'big', value: 'x'.repeat(16 * 1024 + 1) });
	await settle();
	assert.equal(emitted().length, before, 'foreign partitions, long keys and oversize values are dropped');
	assert.ok(t.logs.length > 0, 'drops are logged');

	for (let i = 0; i < 256; i++) {
		if (i % 50 === 0) t.clock.advance(60_000);
		A.emit('shell.setPref', { partition: 'app:acme.alpha', key: `key${i}`, value: i });
		if (i % 50 === 49) await settle();
	}
	await settle();
	t.clock.advance(60_000);
	const count = emitted().length;
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'key-257', value: 1 });
	await settle();
	assert.equal(emitted().length, count, 'the 257th key is dropped');
});

test('T32 shell.openExternal is https only, never the shell or the app suffix, confirmed by the user', async (tt) => {
	const t = makeRoot({ shellOrigins: ['https://shell.example.com'], originTemplate: 'https://{label}.apps.example.com' });
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	for (const url of ['http://ex.com/a', 'javascript:alert(1)', 'blob:https://ex.com/x', 'data:text/html,x', 'https://shell.example.com/apps', `https://${keyA}.apps.example.com/x`, 'https://zzz.apps.example.com/x']) {
		t.clock.advance(5000);
		await assertDeniedOp(A.request('shell.openExternal', { url }), ['schema', 'capability', 'namespace'], url);
	}
	assert.equal(t.confirms.length, 0, 'a denied URL never reaches the confirmation chip');

	t.clock.advance(5000);
	t.confirmAnswer.value = false;
	assert.ok((await outcome(A.request('shell.openExternal', { url: 'https://ex.com/a' }))).ok, 'a valid URL resolves');
	await settle();
	assert.equal(t.confirms.length, 1, 'confirmOpen is called');
	assert.equal(t.confirms[0].url, 'https://ex.com/a');
	assert.equal(t.opened.length, 0, 'nothing opens when the user declines');

	t.clock.advance(2000);
	t.confirmAnswer.value = true;
	await outcome(A.request('shell.openExternal', { url: 'https://ex.com/a' }));
	await settle();
	assert.deepEqual(t.opened, [{ url: 'https://ex.com/a', target: '_blank', features: 'noopener,noreferrer' }]);
	await assertDeniedOp(A.request('shell.openExternal', { url: 'https://ex.com/b' }), 'rate', 'a second request within 2 s');
});

test('T33 notify, status and login requests go to the strip and the root, never the shell status', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	assert.ok((await outcome(A.request('shell.notify', { message: 'hello' }))).ok, 'notify resolves');
	assert.deepEqual(
		t.strips.map((s) => s.item),
		[{ kind: 'notify', text: 'hello' }],
		'notify goes to the strip'
	);
	t.clock.advance(5000);
	await assertDeniedOp(A.request('shell.notify', { message: 'x'.repeat(201) }), 'schema', 'a 201-char notify');
	assert.ok((await outcome(A.request('shell.statusMessage', { message: 'working' }))).ok, 'status resolves');
	assert.deepEqual(t.strips.at(-1)?.item, { kind: 'status', text: 'working' });
	t.clock.advance(5000);
	await assertDeniedOp(A.request('shell.statusMessage', { message: 'x'.repeat(121) }), 'schema', 'a 121-char status');
	assert.ok(!t.cm.emitted.some((e) => e.event === 'shell:statusChange'), 'the shell status area is untouched');

	await assertDeniedOp(A.request('shell.loginRequest', {}), ['capability', 'schema', 'namespace'], 'a login request while signed in');
	t.cm.setSignedIn(false);
	t.clock.advance(20_000);
	assert.ok((await outcome(A.request('shell.loginRequest', {}))).ok, 'signed out: allowed');
	assert.deepEqual(
		t.cm.emitted.filter((e) => e.event === 'shell:loginRequest').map((e) => e.payload),
		[{ appId: 'acme.alpha' }]
	);
	await assertDeniedOp(A.request('shell.loginRequest', {}), 'rate', 'a second login request within 10 s');
});

test('T34 viewActivated reaches only the realm showing that view', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { viewId: 'v-A' });
	const B = t.open(ENTRY_B, { viewId: 'v-B' });
	const gotA: unknown[] = [];
	const gotB: unknown[] = [];
	A.bus.handle('shell.event.viewActivated', (p) => void gotA.push(p));
	B.bus.handle('shell.event.viewActivated', (p) => void gotB.push(p));
	await settle();
	t.cm.emit('shell:viewActivated', { viewId: 'v-A' });
	await settle();
	assert.deepEqual(gotA, [{ viewId: 'v-A' }], 'the matching realm receives it');
	assert.deepEqual(gotB, [], 'no other realm does');
});

test('T35 first-party and non-isolated entries are refused', () => {
	const t = makeRoot();
	let subscribed = 0;
	const ep: IBusEndpoint = { post() {}, subscribe: () => (subscribed++, () => {}) };
	assert.throws(() => t.root.attach(ENTRY_FIRST_PARTY, ep), 'a first-party entry must be refused');
	assert.throws(() => t.root.attach({ ...ENTRY_A, isolated: false } as never, ep), 'an entry that is not isolated must be refused');
	assert.equal(subscribed, 0, 'no realm is added');
});

test('T39 execute returns a handle and a project alias, no public token', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	assert.match(run.token, RE.handle, `token must be a run handle, got ${run.token}`);
	assert.match(run.projectId, RE.projectAlias, `projectId must be an alias, got ${run.projectId}`);
	assert.ok(!('publicToken' in run.body), 'publicToken must not be returned');
	const again = bodyOfResponse(await clientRequest(A, dap('rrext_get_token', { projectId: run.projectId, source: run.source })));
	assert.equal(again.token, run.token, 'rrext_get_token returns the same handle');
});

test('T40 the real token is sent to the engine and never to the realm', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	await clientRequest(A, dap('terminate', { token: run.token }));
	await settle();
	const engine = t.cm.engine;
	const term = engine.messagesFor('terminate')[0];
	assert.equal((term.message.arguments as { token?: string }).token, engine.runs[0].token, 'the engine gets the real tk_');
	const seen = JSON.stringify(A.received);
	assert.ok(!RE.realToken.test(seen) && !seen.includes(engine.runs[0].token), 'the realm received the real tk_');
	assert.ok(!RE.realPublic.test(seen) && !seen.includes(engine.runs[0].publicToken), 'the realm received the real pk_');
});

test('T45 a completed run stays addressable for 120 s, then is no longer owned', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	const status = (): Promise<unknown> => clientRequest(A, dap('rrext_get_task_status', { token: run.token }));
	t.cm.engine.setStatus({ completed: true });
	assert.equal(((await status()) as { ok: boolean }).ok, true, 'the completing status is delivered');
	t.clock.advance(119_000);
	assert.equal(((await status()) as { ok: boolean }).ok, true, 'still owned at +119 s');
	t.clock.advance(2000);
	assertDenied(await status(), 'ownership', 'at +121 s');

	const B = t.open(ENTRY_B);
	const other = await startRun(B);
	assert.equal(bodyOfResponse(await clientRequest(B, dap('terminate', { token: other.token }))) !== undefined, true);
	assertDenied(await clientRequest(B, dap('rrext_get_task_status', { token: other.token })), 'ownership', 'after a successful terminate');
});

test('T46 teardown ends runs, closes handles, removes monitors, clears ledgers', async (tt) => {
	await tt.test('teardownAll', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const r1 = await startRun(A);
		const r2 = await startRun(A);
		const fs = bodyOfResponse(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_open', path: `apps/${keyA}/f`, mode: 'w' })));
		await A.request('client.addMonitor', { key: { token: r1.token }, types: ['summary'] });
		await A.request('client.addMonitor', { key: { token: r2.token }, types: ['summary'] });
		await t.root.teardownAll(3000);
		const engine = t.cm.engine;
		const real = engine.runs.map((r) => r.token).sort();
		assert.deepEqual(
			engine
				.messagesFor('terminate')
				.map((m) => (m.message.arguments as { token: string }).token)
				.sort(),
			real,
			'terminate for each live run'
		);
		assert.ok(
			engine.messagesFor('rrext_store').some((m) => m.message.arguments?.subcommand === 'fs_close' && m.message.arguments?.handle === engine.fsHandles[0]),
			'fs_close for the open handle'
		);
		assert.deepEqual(
			engine.monitorCalls
				.filter((c) => c.kind === 'remove')
				.map((c) => c.key.token)
				.sort(),
			real,
			'removeMonitor for each key'
		);
		void fs;
		assertDenied(await clientRequest(A, dap('rrext_get_task_status', { token: r1.token })), 'ownership', 'an old handle after teardown');
	});
	await tt.test('a failing terminate still finishes in time and logs once', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		t.cm.engine.fail('terminate', 'x');
		const done = await Promise.race([t.root.teardownAll(3000).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3500))]);
		assert.equal(done, true, 'teardownAll must resolve within its timeout');
		assert.equal(t.logs.filter((l) => /terminate/i.test(l)).length, 1, `one log line about the failed terminate, got ${brief(t.logs)}`);
		assertDenied(await clientRequest(A, dap('rrext_get_task_status', { token: run.token })), 'ownership', 'the ledger is cleared after a failed terminate');
	});
	await tt.test('a logout that bypasses teardownAll clears the ledgers', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		t.cm.emit('shell:logout', {});
		await settle();
		assertDenied(await clientRequest(A, dap('rrext_get_task_status', { token: run.token })), 'ownership', 'a handle after shell:logout');
	});
});

test('T47 monitor keys are handles only and refcounted per realm', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	const run = await startRun(A);
	const engine = t.cm.engine;
	const before = engine.monitorCalls.length;
	await assertDeniedOp(A.request('client.addMonitor', { key: { token: '*' }, types: ['summary'] }), ['credential', 'ownership', 'schema'], "key token '*'");
	await assertDeniedOp(A.request('client.addMonitor', { key: { token: engine.runs[0].token }, types: ['summary'] }), 'credential', 'a raw tk_ key');
	await assertDeniedOp(A.request('client.addMonitor', { key: { projectId: run.projectId, source: run.source }, types: ['summary'] }), ['schema', 'capability'], 'a project/source key');
	assert.equal(engine.monitorCalls.length, before, 'no denied key reaches the engine');

	const run2 = await startRun(A2);
	const key = (token: string): string => JSON.stringify({ token });
	await A.request('client.addMonitor', { key: { token: run.token }, types: ['summary'] });
	await A2.request('client.addMonitor', { key: { token: run2.token }, types: ['summary'] });
	await A.request('client.removeMonitor', { key: { token: run.token }, types: ['summary'] });
	assert.ok(!engine.monitors.has(key(engine.runs[0].token)), "A's monitor is removed");
	assert.ok(engine.monitors.has(key(engine.runs[1].token)), "A's removal does not touch A2's monitor");
});

test('T107 shell events reach every realm as allowlisted payloads', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const realms = [t.open(ENTRY_A), t.open(ENTRY_B)];
	const got = realms.map(() => ({}) as Record<string, unknown[]>);
	const OPS = ['connected', 'disconnected', 'statusChange', 'themeChange'];
	realms.forEach((r, i) => OPS.forEach((n) => r.bus.handle(`shell.event.${n}`, (p) => void (got[i][n] ??= []).push(p))));
	await settle();
	const status = { state: 'connected', connectionMode: 'cloud', authPhase: 'signed_in', lastError: 'secret', lastFailure: 'secret2', retryAttempt: 3 };
	t.cm.setConnectionStatus(status as never);
	t.cm.emit('shell:connected', {});
	t.cm.emit('shell:disconnected', { reason: 'net down', hasError: true });
	t.cm.emit('shell:statusChange', status as never);
	t.cm.emit('shell:themeChange', { tokens: { '--a': 'b' } });
	await settle();
	for (const g of got) {
		assert.deepEqual(g.connected, [{}]);
		assert.deepEqual(g.disconnected, [{ reason: 'root disconnected', hasError: false }]);
		assert.deepEqual(g.statusChange, [{ state: 'connected', connectionMode: 'cloud', authPhase: 'signed_in' }]);
		assert.deepEqual(g.themeChange, [{ tokens: { '--a': 'b' } }]);
	}
});
