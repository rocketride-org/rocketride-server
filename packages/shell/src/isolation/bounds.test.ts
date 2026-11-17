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
// BOUNDS TESTS — G4 round 1 (DA F1, F2, F3, F5, M1–M4; security M1–M3, L4, L6, L8)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { appKeyOf } from './appKey';
import { ENTRY_A, makeRoot, refAppKey } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, assertDeniedOp, assertNotForwarded, brief, denialOf, openFs, outcome, startRun } from './__test__/util';
import type { IsolatedEntry } from './types';

const key = refAppKey(ENTRY_A.id);
const KIB = 1024;
const b64 = (bytes: number): string => Buffer.alloc(bytes).toString('base64');
const execMsg = (): DAPMessage => dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 });

// =============================================================================
// F1 — binary-shaped members outside a bytes slot
// =============================================================================

test('G4-F1 a binary-shaped member outside a bytes slot counts as JSON', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;
	const members: Array<[string, unknown]> = [
		['valid base64', { __rrbin: true, b64: b64(300 * KIB) }],
		['invalid base64', { __rrbin: true, b64: '!'.repeat(300 * KIB) }],
	];
	for (const [name, member] of members) {
		let before = engine.received.length;
		assertDenied(await clientRequest(A, dap('execute', { pipeline: { components: [], source: 'chat_1', x: member }, args: [], ttl: 60 })), 'too_large', `execute.pipeline.x (${name})`);
		assertNotForwarded(engine, before, `execute.pipeline.x (${name})`);
		before = engine.received.length;
		assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_put_json', path: `apps/${key}/j.json`, value: { x: member } })), 'too_large', `fs_put_json.value (${name})`);
		assertNotForwarded(engine, before, `fs_put_json.value (${name})`);
	}
	const prior = t.cm.opsEmitted.length;
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'k', value: { x: { __rrbin: true, b64: b64(300 * KIB) } } });
	A.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'k2', value: { x: { __rrbin: true, b64: b64(20 * KIB) } } });
	await settle();
	assert.equal(t.cm.opsEmitted.length, prior, 'pref values hidden in binary-shaped members are measured and dropped');
});

test('G4-F1 a string over the ceiling is refused (guard)', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const before = t.cm.engine.received.length;
	assertDenied(await clientRequest(A, dap('rrext_ping', { s: 'x'.repeat(12 * 1024 * 1024) })), 'too_large', 'a 12 MiB string');
	assertNotForwarded(t.cm.engine, before, 'a 12 MiB string');
});

test('G4-F1 the outbound backstop reads extra keys of a binary-shaped member', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	t.cm.engine.setStatus({ blob: { __rrbin: true, b64: 'AAAA', leak: t.cm.sessionToken } });
	await assertDeniedOp(A.request('client.request', { message: dap('rrext_get_task_status', { token: run.token }) }), 'credential', 'a session token beside a binary member');
});

// =============================================================================
// F2 — quotas reserved at the gate
// =============================================================================

test('G4-F2 quotas hold under concurrency', async (tt) => {
	await tt.test('runs', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const engine = t.cm.engine;
		const release = engine.hold('execute');
		const calls = Array.from({ length: 32 }, () => clientRequest(A, execMsg()));
		await settle();
		const reached = engine.messagesFor('execute').length;
		release();
		const results = await Promise.all(calls);
		assert.ok(reached <= 8, `at most 8 executes may reach the engine at once, ${reached} did`);
		assert.ok(results.filter((r) => r.ok).length <= 8, 'at most 8 runs start');
		assert.ok(results.filter((r) => denialOf(r)?.code === 'quota').length >= 24, `the rest are quota denials, got ${brief(results.map((r) => denialOf(r)?.code ?? 'ok'))}`);
	});
	await tt.test('pipes', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const engine = t.cm.engine;
		const run = await startRun(A);
		const release = engine.hold('rrext_process');
		const calls = Array.from({ length: 20 }, () => clientRequest(A, dap('rrext_process', { subcommand: 'open', object: {}, mimeType: 'text/plain', token: run.token })));
		await settle();
		const reached = engine.messagesFor('rrext_process').length;
		release();
		await Promise.all(calls);
		assert.ok(reached <= 16, `at most 16 pipe opens may reach the engine, ${reached} did`);
	});
	await tt.test('store handles', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const engine = t.cm.engine;
		for (let i = 0; i < 20; i++) await openFs(A, `apps/${key}/f${i}`);
		const since = engine.received.length;
		const release = engine.hold('rrext_store');
		const calls = Array.from({ length: 20 }, (_, i) => clientRequest(A, dap('rrext_store', { subcommand: 'fs_open', path: `apps/${key}/g${i}`, mode: 'r' })));
		await settle();
		const reached = engine.messagesFor('rrext_store', since).length;
		release();
		await Promise.all(calls);
		assert.ok(reached <= 12, `at most 12 more store handles may reach the engine, ${reached} did`);
	});
	await tt.test('monitor keys', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		const client = t.cm.engine.client as { addMonitor: (k: unknown, ty: string[]) => Promise<void> };
		const original = client.addMonitor;
		let reached = 0;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		client.addMonitor = async (k, ty) => {
			reached++;
			await gate;
			return original(k, ty);
		};
		const calls = Array.from({ length: 20 }, (_, i) => outcome(A.request('client.addMonitor', { key: { token: run.token }, types: [`t${i}`] })));
		await settle();
		open();
		await Promise.all(calls);
		assert.ok(reached <= 16, `at most 16 monitor keys may reach the engine, ${reached} did`);
	});
});

// =============================================================================
// F3 — the app.<appKey>.* lane and private topics
// =============================================================================

test('G4-F3 app-lane requests are rate-limited and bounded in flight', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const O = t.open(ENTRY_A);
	const C = t.open(ENTRY_A);
	const op = `app.${key}.never`;
	O.bus.handle(op, () => new Promise(() => {}));
	await settle();
	const calls = Array.from({ length: 1000 }, () => outcome(C.request(op, {}, 5000)));
	await settle(30);
	const hops = O.received.filter((m) => (m as { __rrbus?: string; op?: string }).__rrbus === 'request' && (m as { op?: string }).op === op).length;
	t.root.detach(O.realmId);
	const results = await Promise.all(calls);
	assert.ok(hops <= 32, `at most 32 app-lane requests may be in flight, the owner saw ${hops}`);
	const rate = results.filter((r) => !r.ok && r.message.startsWith('RR_DENIED:') && JSON.parse(r.message.slice(10)).code === 'rate').length;
	assert.ok(rate >= 968, `the rest are rate denials, got ${rate}`);
});

test('G4-F3 private snapshots are walked and size-capped; the registry empties with the app', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const errors: unknown[] = [];
	const onError = (err: unknown): void => void errors.push(err);
	// The shell's global.d.ts narrows `process` to `{env}`; the runtime object is Node's.
	const proc = process as unknown as NodeJS.EventEmitter;
	proc.on('uncaughtException', onError);
	tt.after(() => void proc.off('uncaughtException', onError));
	const A = t.open(ENTRY_A);
	const A2 = t.open(ENTRY_A);
	const R = t.open(ENTRY_A, { raw: true });
	const seen: unknown[] = [];
	A2.retained.subscribe(`app.${key}.big`, (s) => seen.push(s));
	A2.retained.subscribe(`app.${key}.port`, (s) => seen.push(s));
	await settle();
	A.retained.publish(`app.${key}.big`, { s: 'x'.repeat(1024 * 1024) });
	const { port1 } = new MessageChannel();
	R.post({ __rrbus: 'publish', topic: `app.${key}.port`, snapshot: { p: port1 } }, [port1]);
	await settle();
	assert.equal(errors.length, 0, `no exception may escape, got ${brief(errors.map(String))}`);
	assert.deepEqual(seen, [], 'neither snapshot is stored or delivered');
	assert.equal(await A2.request('bus.topic.read', { topic: `app.${key}.big` }), undefined);

	const keep = `app.${key}.keep`;
	A.retained.publish(keep, { n: 1 });
	await settle();
	assert.deepEqual(await A2.request('bus.topic.read', { topic: keep }), { n: 1 });
	for (const r of [A, A2, R]) r.detach();
	const A3 = t.open(ENTRY_A);
	assert.equal(await A3.request('bus.topic.read', { topic: keep }), undefined, "the app's private topics are dropped when its last realm detaches");
});

// =============================================================================
// F5 — argument keys are own keys of the row
// =============================================================================

test('G4-F5 prototype-named argument keys are unknown keys', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
		const before = t.cm.engine.received.length;
		assertDenied(await clientRequest(A, dap('rrext_ping', { [name]: 1 })), 'schema', `rrext_ping {${name}}`);
		assertNotForwarded(t.cm.engine, before, `rrext_ping {${name}}`);
	}
});

// =============================================================================
// Minors
// =============================================================================

test('G4-M1 rrext_monitor through client.request counts against the monitor quota and is torn down', async (tt) => {
	await tt.test('quota', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		for (let i = 0; i < 16; i++) await A.request('client.addMonitor', { key: { token: run.token }, types: [`t${i}`] });
		assertDenied(await clientRequest(A, dap('rrext_monitor', { types: ['summary'], token: run.token })), 'quota', 'a 17th monitor key through rrext_monitor');
	});
	await tt.test('teardown', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		const run = await startRun(A);
		assert.equal((await clientRequest(A, dap('rrext_monitor', { types: ['summary'], token: run.token }))).ok, true);
		const since = t.cm.engine.received.length;
		await t.root.teardownAll(3000);
		const cleared = t.cm.engine.messagesFor('rrext_monitor', since).filter((r) => (r.message.arguments as { token?: string }).token === t.cm.engine.runs[0].token && Array.isArray(r.message.arguments?.types) && (r.message.arguments.types as unknown[]).length === 0);
		assert.equal(cleared.length, 1, 'teardown unsubscribes the direct monitor (types: [])');
	});
});

test('G4-M3 openExternal refuses trailing-dot hosts of the shell and the app suffix', async (tt) => {
	const t = makeRoot({ shellOrigins: ['https://shell.example.com'], originTemplate: 'https://{label}.apps.example.com' });
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	for (const url of [`https://${key}.apps.example.com./x`, 'https://zzz.apps.example.com../x', 'https://shell.example.com./apps', 'https://apps.example.com./x']) {
		t.clock.advance(5000);
		await assertDeniedOp(A.request('shell.openExternal', { url }), ['schema', 'capability', 'namespace'], url);
	}
	assert.equal(t.confirms.length, 0, 'none reaches the confirmation chip');
});

test('G4-M4 fs_read.length is bounded at the gate', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const handle = await openFs(A, `apps/${key}/r`);
	const before = t.cm.engine.received.length;
	assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_read', handle, offset: 0, length: 4 * 1024 * 1024 + 1 })), 'schema', 'fs_read of 4 MiB + 1');
	assertNotForwarded(t.cm.engine, before, 'an oversized fs_read');
	assert.equal((await clientRequest(A, dap('rrext_store', { subcommand: 'fs_read', handle, offset: 0, length: 4 * 1024 * 1024 }))).ok, true, 'the SDK default (4 MiB) is allowed');
});

test('G4-M2 the pref-key cap is per app and survives reattach; the partition fits a 128-char id', async (tt) => {
	await tt.test('reattach', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A);
		for (let i = 0; i < 256; i++) {
			if (i % 50 === 0) t.clock.advance(60_000);
			A.emit('shell.setPref', { partition: 'app:acme.alpha', key: `key${i}`, value: i });
			if (i % 50 === 49) await settle();
		}
		await settle();
		A.detach();
		const A2 = t.open(ENTRY_A);
		const count = t.cm.opsEmitted.length;
		A2.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'one-more', value: 1 });
		await settle();
		assert.equal(t.cm.opsEmitted.length, count, 'the 257th key of the app is dropped after a reattach');
		A2.emit('shell.setPref', { partition: 'app:acme.alpha', key: 'key0', value: 2 });
		await settle();
		assert.equal(t.cm.opsEmitted.length, count + 1, 'an existing key can still be written');
	});
	await tt.test('long id', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const LONG: IsolatedEntry = { id: 'a'.repeat(128), moduleId: 'm_long', name: 'Long', registryVersion: 1, isolated: true };
		const L = t.open(LONG);
		L.emit('shell.setPref', { partition: `app:${LONG.id}`, key: 'k', value: 1 });
		await settle();
		assert.equal(t.cm.opsEmitted.filter((o) => o.op === 'shell.setPref').length, 1, 'a 128-char id has a usable prefs partition');
	});
});

test('G4-L4 rrext_get_token never returns a publicToken', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const run = await startRun(A);
	const client = t.cm.engine.client as { request: (m: DAPMessage, timeout?: number) => Promise<DAPMessage> };
	const original = client.request;
	client.request = async (m, timeout) => {
		const r = await original(m, timeout);
		if (m.command === 'rrext_get_token') return { ...r, body: { ...(r.body ?? {}), publicToken: t.cm.engine.runs[0].publicToken } } as DAPMessage;
		return r;
	};
	const envelope = await clientRequest(A, dap('rrext_get_token', { projectId: run.projectId, source: run.source }));
	assert.equal(envelope.ok, true, `rrext_get_token must answer, got ${brief(envelope)}`);
	const body = (envelope as { value: { body: Record<string, unknown> } }).value.body;
	assert.ok(!('publicToken' in body), 'publicToken must be stripped');
	assert.equal(body.token, run.token);
});

test('G4-L6 repeatedly percent-encoded segments are refused', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	for (const path of [`apps/${key}/%252e%252e/y`, `apps/${key}/a%252fb`, `apps/${key}/%25252e%25252e/y`]) {
		const before = t.cm.engine.received.length;
		assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_stat', path })), 'schema', path);
		assertNotForwarded(t.cm.engine, before, path);
	}
});

test('G4-L8 appKeyOf refuses non-canonical ids', () => {
	for (const id of ['', 'a\uD800', 'x'.repeat(129), 'a..b', '.a', 'a b']) {
		assert.throws(() => appKeyOf(id), `appKeyOf(${JSON.stringify(id).slice(0, 20)}) must throw`);
	}
	assert.equal(appKeyOf('x'.repeat(128)), refAppKey('x'.repeat(128)));
});
