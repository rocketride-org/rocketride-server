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
// GATE TESTS — T4 to T7, T9 to T15, T17, T19
// =============================================================================
//
// Everything drives the app root through a real structured-clone channel
// (`openRealm`), with a fake engine behind it. "Denied" is a `client.request`
// resolving to an `ok: false` envelope named `CapabilityDeniedError` with
// `fields.code`; "forwarded" is the message appearing in `engine.received`.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DAPMessage } from 'rocketride';
import type { DenyCode } from './capabilityDenied';
import { CASES, dummyCtx, prepareCtx } from './__test__/catalogue';
import type { ICase } from './__test__/catalogue';
import { ENTRY_A, ENTRY_B, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import type { IFakeEngine } from './__test__/fakeEngine';
import { clientRequest, dap, settle } from './__test__/realm';
import type { IOpenedRealm, IOpenRealmOptions } from './__test__/realm';
import { assertDenied, assertDeniedOp, assertNotForwarded, brief, outcome, openFs, openPipe, readCapabilityJson, startRun } from './__test__/util';
import type { IsolatedEntry } from './types';

interface IFixture {
	t: ITestRoot;
	A: IOpenedRealm;
	engine: IFakeEngine;
	key: string;
}

/** A fresh root with one realm open; cleaned up when the test ends. */
function fixture(tt: TestContext, entry: IsolatedEntry = ENTRY_A, options?: IOpenRealmOptions, extra: Parameters<typeof makeRoot>[0] = {}): IFixture {
	const t = makeRoot(extra);
	tt.after(() => t.cleanup());
	return { t, A: t.open(entry, options), engine: t.cm.engine, key: refAppKey(entry.id) };
}

/** Sends one case: a DAP envelope for `client.request`, an outcome for other request ops. */
async function send(realm: IOpenedRealm, c: ICase, built: ReturnType<ICase['build']>): Promise<unknown> {
	if (c.op === 'client.request') return clientRequest(realm, built.message!);
	return outcome(realm.request(c.op, built.params));
}

/** Everything the engine (and its monitor surface) has been asked to do so far. */
const engineWork = (engine: IFakeEngine): number => engine.received.length + engine.monitorCalls.length;

const rrbin = (bytes: number): { __rrbin: true; b64: string } => ({ __rrbin: true, b64: Buffer.alloc(bytes).toString('base64') });

// =============================================================================
// T4 — everything design section 8 denies
// =============================================================================

test('T4 each denied command or family is refused and never forwarded', async (tt) => {
	const { t, A, engine } = fixture(tt);
	const run = await startRun(A);

	const REFUSED: DenyCode[] = ['capability', 'unknown_op'];
	const PARTIAL: DenyCode[] = ['capability', 'unknown_op', 'schema'];
	const cases: Array<{ name: string; message: DAPMessage; codes: DenyCode[] }> = [
		{ name: 'rrext_process tool', message: dap('rrext_process', { subcommand: 'tool', tool: 'x', nodeId: '', input: {}, token: run.token }), codes: PARTIAL },
		{ name: 'rrext_log', message: dap('rrext_log', { subcommand: 'open', projectId: 'p', source: 's' }), codes: REFUSED },
		{ name: 'rrext_list_tasks', message: dap('rrext_list_tasks', {}), codes: REFUSED },
		{ name: 'rrext_get_tasks', message: dap('rrext_get_tasks', {}), codes: REFUSED },
		{ name: 'rrext_dashboard', message: dap('rrext_dashboard', {}), codes: REFUSED },
		{ name: 'rrext_list_connections', message: dap('rrext_list_connections', {}), codes: REFUSED },
		{ name: 'rrext_services', message: dap('rrext_services', {}), codes: REFUSED },
		{ name: 'rrext_validate', message: dap('rrext_validate', { pipeline: {} }), codes: REFUSED },
		{ name: 'rrext_resolve_config', message: dap('rrext_resolve_config', {}), codes: REFUSED },
		{ name: 'rrext_app admin_approve', message: dap('rrext_app', { subcommand: 'admin_approve', appId: 'acme.alpha', version: 1, capabilities: ['core'] }), codes: REFUSED },
		{ name: 'rrext_app list', message: dap('rrext_app', { subcommand: 'list' }), codes: REFUSED },
		{ name: 'rrext_store get (non-fs)', message: dap('rrext_store', { subcommand: 'get', path: 'x' }), codes: PARTIAL },
		{ name: 'rrext_account_me', message: dap('rrext_account_me', {}), codes: REFUSED },
		{ name: 'rrext_account_keys', message: dap('rrext_account_keys', {}), codes: REFUSED },
		{ name: 'rrext_saas', message: dap('rrext_saas', {}), codes: REFUSED },
		{ name: 'rrext_billing_rates', message: dap('rrext_billing_rates', {}), codes: REFUSED },
		{ name: 'rrext_public_probe', message: dap('rrext_public_probe', {}), codes: REFUSED },
		{ name: 'rrext_deploy', message: dap('rrext_deploy', { subcommand: 'x' }), codes: REFUSED },
		{ name: 'rrext_deploy_app', message: dap('rrext_deploy_app', { subcommand: 'versions', appId: 'acme.alpha' }), codes: REFUSED },
		{ name: 'rrext_cprofile_get', message: dap('rrext_cprofile_get', {}), codes: REFUSED },
		{ name: 'auth', message: dap('auth', { apikey: 'x' }), codes: REFUSED },
		{ name: 'deauth', message: dap('deauth', {}), codes: REFUSED },
		{ name: 'rrext_identify', message: dap('rrext_identify', { name: 'x' }), codes: REFUSED },
	];
	for (const c of cases) {
		await tt.test(c.name, async () => {
			const before = engine.received.length;
			const envelope = await clientRequest(A, c.message);
			assertDenied(envelope, c.codes, c.name);
			assertNotForwarded(engine, before, c.name);
		});
	}

	// Root ops that are never an app's: host verbs and a shell setting.
	for (const op of ['host.openExternal', 'shell.updateSetting']) {
		await tt.test(op, async () => {
			let called = 0;
			t.cm.ops().handle(op, () => {
				called++;
			});
			await assertDeniedOp(A.request(op, { url: 'https://ex.com', partition: 'app:acme.alpha', key: 'k', value: 1 }), ['unknown_op', 'capability', 'namespace'], op);
			assert.equal(called, 0, `${op}: the root's handler must not be reached`);
		});
	}
});

// =============================================================================
// T5 — every capability-gated row needs its capability
// =============================================================================

test('T5 each pipelines.run and fs.app row is allowed with its capability and denied without', async (tt) => {
	const key = refAppKey(ENTRY_A.id);
	const rows = readCapabilityJson().rows;
	for (const row of rows) {
		assert.ok(
			CASES.some((c) => c.op === row.op && c.command === row.command),
			`the test catalogue has no case for the table row ${row.cap} ${row.op} ${row.command ?? ''}`
		);
	}
	const capOf = (c: ICase): string | undefined => rows.find((r) => r.op === c.op && r.command === c.command)?.cap;

	for (const c of CASES.filter((x) => ['pipelines.run', 'fs.app'].includes(capOf(x) ?? ''))) {
		await tt.test(`${c.name} (${capOf(c)})`, async (st) => {
			const full = fixture(st);
			const ctx = await prepareCtx(full.A, full.key);
			const before = engineWork(full.engine);
			const allowed = await send(full.A, c, c.build(ctx));
			if (c.op === 'client.request') assert.equal((allowed as { ok: boolean }).ok, true, `${c.name} with ${capOf(c)}: expected allowed, got ${brief(allowed)}`);
			else assert.equal((allowed as { ok: boolean }).ok, true, `${c.name} with ${capOf(c)}: expected the op to resolve, got ${brief(allowed)}`);
			assert.ok(engineWork(full.engine) > before, `${c.name} with ${capOf(c)}: expected it to reach the engine`);

			const core = fixture(st, ENTRY_A, { caps: ['core'] });
			const beforeCore = engineWork(core.engine);
			const built = c.build(dummyCtx(key));
			if (c.op === 'client.request') assertDenied(await clientRequest(core.A, built.message!), 'capability', `${c.name} without ${capOf(c)}`);
			else await assertDeniedOp(core.A.request(c.op, built.params), 'capability', `${c.name} without ${capOf(c)}`);
			assert.equal(engineWork(core.engine), beforeCore, `${c.name} without ${capOf(c)}: expected nothing forwarded`);
		});
	}
});

// =============================================================================
// T6 — client.request params, DAP top-level keys, timeouts
// =============================================================================

test('T6 client.request params, DAP top-level keys and timeouts are bounded', async (tt) => {
	const { t, A, engine } = fixture(tt);
	const ping = dap('rrext_ping');

	let before = engine.received.length;
	assertDenied(await A.request('client.request', { message: ping, timeout: 5000, extra: 1 }), 'schema', 'client.request params with an extra key');
	assertNotForwarded(engine, before, 'client.request params with an extra key');

	before = engine.received.length;
	assertDenied(await clientRequest(A, { ...ping, bogus: 1 } as DAPMessage), 'schema', 'a DAP top-level key outside type/seq/command/arguments');
	assertDenied(await clientRequest(A, { ...ping, token: 'x' } as DAPMessage), 'schema', 'a top-level token on a row that does not take one');
	assertDenied(await clientRequest(A, { ...ping, type: 'event' } as DAPMessage), 'schema', 'type: event');
	assertNotForwarded(engine, before, 'bad DAP envelopes');

	assert.equal((await clientRequest(A, ping, 600_000)).ok, true, 'a long timeout is still a valid request');
	assert.equal(engine.received.at(-1)?.timeout, 115_000, `timeout 600000 must reach the engine as 115000, the engine received ${engine.received.at(-1)?.timeout}`);
	assert.equal((await clientRequest(A, ping, 0)).ok, true, 'timeout 0 is still a valid request');
	assert.equal(engine.received.at(-1)?.timeout, 1_000, `timeout 0 must reach the engine as 1000, the engine received ${engine.received.at(-1)?.timeout}`);

	// A bus request's own timeout is clamped to 120 s: a request routed to an owner realm shows the hop budget.
	const owner = t.open(ENTRY_A);
	const caller = t.open(ENTRY_A);
	const op = `app.${refAppKey(ENTRY_A.id)}.slow`;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	owner.bus.handle(op, () => gate.then(() => 'done'));
	await settle();
	const pending = outcome(caller.request(op, {}, 10_000_000));
	await settle();
	try {
		const hop = owner.received.find((m) => (m as { __rrbus?: string; op?: string }).__rrbus === 'request' && (m as { op?: string }).op === op) as { timeoutMs: number } | undefined;
		assert.ok(hop, 'the request to an app-namespace op must be routed to the owner realm');
		assert.ok(hop.timeoutMs <= 120_000, `a bus request with timeoutMs 10000000 must be clamped to 120000, the owner saw ${hop.timeoutMs}`);
	} finally {
		release();
		await pending;
	}
});

// =============================================================================
// T7 — one unknown argument key on every row
// =============================================================================

test('T7 an unknown argument key is refused on every row', async (tt) => {
	const key = refAppKey(ENTRY_A.id);
	for (const row of readCapabilityJson().rows) {
		assert.ok(
			CASES.some((c) => c.op === row.op && c.command === row.command),
			`the test catalogue has no case for the table row ${row.op} ${row.command ?? ''}`
		);
	}
	for (const c of CASES) {
		await tt.test(c.name, async (st) => {
			const { t, A, engine } = fixture(st);
			const ctx = await prepareCtx(A, key);
			const built = c.build(ctx);

			if (c.emit) {
				// The emit lane has no reply: a valid call is re-emitted, a call with an extra key is dropped.
				A.emit(c.op, built.params);
				await settle();
				assert.equal(t.cm.opsEmitted.filter((o) => o.op === c.op).length, 1, `${c.name}: a valid call must be re-emitted on the root bus`);
				A.emit(c.op, { ...built.params, zz_unknown: 1 });
				await settle();
				assert.equal(t.cm.opsEmitted.filter((o) => o.op === c.op).length, 1, `${c.name}: a call with an extra key must be dropped`);
				return;
			}

			const before = engineWork(engine);
			if (c.op === 'client.request') {
				const message = built.message!;
				const extra = { ...message, arguments: { ...(message.arguments ?? {}), zz_unknown: 1 } } as DAPMessage;
				assertDenied(await clientRequest(A, extra), 'schema', `${c.name} with an extra key`);
				assertNotForwarded(engine, before, `${c.name} with an extra key`);
				assert.equal((await clientRequest(A, message)).ok, true, `${c.name}: the unmodified call must be allowed`);
			} else {
				await assertDeniedOp(A.request(c.op, { ...built.params, zz_unknown: 1 }), 'schema', `${c.name} with an extra key`);
				assert.equal(engineWork(engine), before, `${c.name} with an extra key: expected nothing forwarded`);
				assert.equal(t.strips.length + t.confirms.length + t.fetches.length, 0, `${c.name} with an extra key: no side effect expected`);
				assert.ok(!t.cm.emitted.some((e) => e.event === 'shell:loginRequest'), `${c.name} with an extra key: no login request expected`);
			}
		});
	}
});

// =============================================================================
// T9 — execute
// =============================================================================

test('T9 execute denials and bounds; the project id is minted', async (tt) => {
	const { A, engine, key } = fixture(tt);
	const exec = (extra: Record<string, unknown> = {}): DAPMessage => dap('execute', { pipeline: { components: [], source: 'chat_1', project_id: 'caller-chosen' }, args: [], ttl: 60, ...extra });

	const refused: Array<[string, Record<string, unknown>]> = [
		['useExisting: true', { useExisting: true }],
		['token', { token: 'rh_AAAAAAAAAAAAAAAAAAAAAA' }],
		['env with a key', { env: { A: 'b' } }],
		['teamId', { teamId: 't' }],
		['threads', { threads: 2 }],
		['pipelineTraceLevel', { pipelineTraceLevel: 'full' }],
		['args with an element', { args: ['x'] }],
		['ttl 0', { ttl: 0 }],
		['ttl 3601', { ttl: 3601 }],
		['ttl 1.5', { ttl: 1.5 }],
	];
	for (const [name, extra] of refused) {
		const before = engine.received.length;
		assertDenied(await clientRequest(A, exec(extra)), 'schema', `execute with ${name}`);
		assertNotForwarded(engine, before, `execute with ${name}`);
	}

	const minted = new RegExp(`^rrapp\\.${key}\\.[0-9a-f-]{36}$`);
	const allowed: Array<[string, Record<string, unknown>]> = [
		['ttl 3600', { ttl: 3600 }],
		['env: {}', { env: {} }],
		['args: []', { args: [] }],
		['name', { name: 'n' }],
	];
	for (const [name, extra] of allowed) {
		const before = engine.received.length;
		const envelope = await clientRequest(A, exec(extra));
		assert.equal(envelope.ok, true, `execute with ${name} must be allowed, got ${brief(envelope)}`);
		const forwarded = engine.received.slice(before).find((r) => r.message.command === 'execute');
		assert.ok(forwarded, `execute with ${name} must reach the engine`);
		const projectId = (forwarded.message.arguments?.pipeline as { project_id?: string }).project_id;
		assert.match(String(projectId), minted, `execute with ${name}: the forwarded project id must be minted for this app, got ${projectId}`);
	}
});

// =============================================================================
// T10 — rrext_get_token
// =============================================================================

test('T10 rrext_get_token denials and ownership', async (tt) => {
	const { t, A, engine } = fixture(tt);
	const run = await startRun(A);
	const other = t.open(ENTRY_B);
	const otherRun = await startRun(other);
	const call = (args: Record<string, unknown>): DAPMessage => dap('rrext_get_token', args);

	for (const [name, extra] of [
		['teamId', { teamId: 't' }],
		['runKind', { runKind: 'deploy' }],
	] as const) {
		const before = engine.received.length;
		assertDenied(await clientRequest(A, call({ projectId: run.projectId, source: run.source, ...extra })), 'schema', `rrext_get_token with ${name}`);
		assertNotForwarded(engine, before, `rrext_get_token with ${name}`);
	}

	const foreign: Array<[string, string]> = [
		['the real project id', engine.runs[0].projectId],
		['a random rp_ alias', 'rp_AAAAAAAAAAAAAAAAAAAAAA'],
		["another realm's alias", otherRun.projectId],
	];
	// In the pass-through the alias IS the real id; the first two only differ once ids are aliased.
	for (const [name, projectId] of foreign) {
		const before = engine.received.length;
		if (projectId === run.projectId) continue;
		assertDenied(await clientRequest(A, call({ projectId, source: run.source })), 'ownership', `rrext_get_token with ${name}`);
		assertNotForwarded(engine, before, `rrext_get_token with ${name}`);
	}
	assert.equal((await clientRequest(A, call({ projectId: run.projectId, source: run.source }))).ok, true, 'the realm may resolve its own run');
});

// =============================================================================
// T11 — rrext_monitor
// =============================================================================

test('T11 rrext_monitor denials; pipeId must be owned', async (tt) => {
	const { A, engine } = fixture(tt);
	const run = await startRun(A);
	const monitor = (extra: Record<string, unknown>): DAPMessage => dap('rrext_monitor', { types: ['summary'], token: run.token, ...extra });

	const refused: Array<[string, Record<string, unknown>]> = [
		["types: ['*']", { types: ['*'] }],
		['projectId', { projectId: 'p' }],
		['source', { source: 's' }],
		['teamId', { teamId: 't' }],
		['runKind', { runKind: 'dev' }],
		['listenType', { listenType: 'x' }],
	];
	for (const [name, extra] of refused) {
		const before = engine.received.length;
		assertDenied(await clientRequest(A, monitor(extra)), 'schema', `rrext_monitor with ${name}`);
		assertNotForwarded(engine, before, `rrext_monitor with ${name}`);
	}

	const before = engine.received.length;
	assertDenied(await clientRequest(A, monitor({ pipeId: 4242 })), 'ownership', 'rrext_monitor with a pipeId this handle never opened');
	assertNotForwarded(engine, before, 'rrext_monitor with an unowned pipeId');

	const pipeId = await openPipe(A, run.token);
	assert.equal((await clientRequest(A, monitor({ pipeId }))).ok, true, 'a pipeId the handle opened is allowed');
});

// =============================================================================
// T12 — token location
// =============================================================================

test('T12 the run handle is accepted at the top level or in arguments, never both, and forwarded only in arguments', async (tt) => {
	const COMMANDS: Array<{ command: string; args: Record<string, unknown> }> = [
		{ command: 'terminate', args: {} },
		{ command: 'rrext_get_task_status', args: {} },
		{ command: 'rrext_get_pipeline', args: {} },
		{ command: 'rrext_monitor', args: { types: ['summary'] } },
		{ command: 'rrext_process', args: { subcommand: 'open', object: {}, mimeType: 'text/plain' } },
	];
	for (const { command, args } of COMMANDS) {
		await tt.test(command, async (st) => {
			const variants: Array<{ name: string; build: (token: string) => DAPMessage; ok: boolean }> = [
				{ name: 'top level only', build: (token) => dap(command, args, { token }), ok: true },
				{ name: 'arguments only', build: (token) => dap(command, { ...args, token }), ok: true },
				{ name: 'both', build: (token) => dap(command, { ...args, token }, { token }), ok: false },
			];
			for (const v of variants) {
				const { A, engine } = fixture(st);
				const run = await startRun(A);
				const real = engine.runs[0].token;
				const before = engine.received.length;
				const envelope = await clientRequest(A, v.build(run.token));
				if (!v.ok) {
					assertDenied(envelope, 'schema', `${command} with the handle in both places`);
					assertNotForwarded(engine, before, `${command} with the handle in both places`);
					continue;
				}
				assert.equal(envelope.ok, true, `${command} with the handle ${v.name} must be allowed, got ${brief(envelope)}`);
				const forwarded = engine.received.slice(before).find((r) => r.message.command === command);
				assert.ok(forwarded, `${command} (${v.name}) must reach the engine`);
				assert.equal((forwarded.message.arguments as { token?: string }).token, real, `${command} (${v.name}): the real token must be in arguments.token`);
				assert.ok(!('token' in forwarded.message), `${command} (${v.name}): no top-level token may be forwarded, got ${brief((forwarded.message as unknown as { token?: unknown }).token)}`);
			}
		});
	}
});

// =============================================================================
// T13 — raw credentials and foreign handles
// =============================================================================

test("T13 a raw tk_ or pk_ is a credential; another realm's handle is not owned", async (tt) => {
	const { t, A, engine } = fixture(tt);
	const run = await startRun(A);
	const realToken = engine.runs[0].token;
	const realPublic = engine.runs[0].publicToken;
	const before = engine.received.length;

	for (const [name, token] of [
		['a raw tk_', realToken],
		['a raw pk_', realPublic],
		['a made-up pk_', `pk_${'a'.repeat(32)}`],
	] as const) {
		for (const command of ['terminate', 'rrext_get_task_status']) {
			assertDenied(await clientRequest(A, dap(command, { token })), 'credential', `${command} with ${name}`);
		}
	}
	assertNotForwarded(engine, before, 'raw credentials');

	const B = t.open(ENTRY_B);
	for (const command of ['terminate', 'rrext_get_task_status', 'rrext_get_pipeline']) {
		const mark = engine.received.length;
		assertDenied(await clientRequest(B, dap(command, { token: run.token })), 'ownership', `${command} with a handle minted for another realm`);
		assertNotForwarded(engine, mark, `${command} with a foreign handle`);
	}
});

// =============================================================================
// T14 — restart
// =============================================================================

test('T14 restart needs the token, its own projectId and source, and the project id is forced', async (tt) => {
	const { A, engine } = fixture(tt);
	const run = await startRun(A);
	const pipeline = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ components: [], source: run.source, project_id: 'caller-chosen', ...extra });

	let before = engine.received.length;
	assertDenied(await clientRequest(A, dap('restart', { pipeline: pipeline(), projectId: run.projectId, source: run.source })), 'schema', 'restart without a token');
	assertNotForwarded(engine, before, 'restart without a token');

	before = engine.received.length;
	assertDenied(await clientRequest(A, dap('restart', { token: run.token, pipeline: pipeline(), projectId: 'rp_AAAAAAAAAAAAAAAAAAAAAA', source: run.source })), 'ownership', "restart with a projectId that is not the handle's");
	assertDenied(await clientRequest(A, dap('restart', { token: run.token, pipeline: pipeline(), projectId: run.projectId, source: 'other_source' })), 'ownership', "restart with a source that is not the handle's");
	assertNotForwarded(engine, before, 'restart with foreign projectId or source');

	before = engine.received.length;
	const envelope = await clientRequest(A, dap('restart', { token: run.token, pipeline: pipeline(), projectId: run.projectId, source: run.source }));
	assert.equal(envelope.ok, true, `a valid restart must be allowed, got ${brief(envelope)}`);
	const forwarded = engine.received.slice(before).find((r) => r.message.command === 'restart');
	assert.ok(forwarded, 'restart must reach the engine');
	assert.equal((forwarded.message.arguments?.pipeline as { project_id?: string }).project_id, engine.runs[0].projectId, "the forwarded pipeline.project_id must be the handle's real project, whatever the caller sent");
	assert.equal((forwarded.message.arguments as { token?: string }).token, engine.runs[0].token, 'the forwarded token must be the real one');
});

// =============================================================================
// T15 — rrext_process write
// =============================================================================

test('T15 pipe writes need an owned pipe and are capped at 8 MiB decoded', async (tt) => {
	const { A, engine } = fixture(tt);
	const run = await startRun(A);
	const pipeId = await openPipe(A, run.token);
	const write = (id: number, bytes: number): DAPMessage => dap('rrext_process', { subcommand: 'write', pipe_id: id, data: rrbin(bytes), token: run.token });
	const EIGHT_MIB = 8 * 1024 * 1024;

	let before = engine.received.length;
	assertDenied(await clientRequest(A, write(pipeId + 1000, 4)), 'ownership', 'a write to a pipe this handle never opened');
	assertNotForwarded(engine, before, 'a write to an unowned pipe');

	before = engine.received.length;
	assertDenied(await clientRequest(A, write(pipeId, EIGHT_MIB + 1)), 'too_large', 'a write of 8 MiB + 1 bytes');
	assertNotForwarded(engine, before, 'an oversized write');

	const envelope = await clientRequest(A, write(pipeId, EIGHT_MIB));
	assert.equal(envelope.ok, true, `a write of exactly 8 MiB must be allowed, got ${brief(envelope).slice(0, 120)}`);
});

// =============================================================================
// T17 — store handles
// =============================================================================

test('T17 store handles are per realm; fs_read_many and fs_geturl are denied; fs_close mode is a literal', async (tt) => {
	const { t, A, engine, key } = fixture(tt);
	const B = t.open(ENTRY_B);
	const handleB = await openFs(B, `apps/${refAppKey(ENTRY_B.id)}/g.txt`, 'w');
	const handleA = await openFs(A, `apps/${key}/f.txt`, 'w');

	for (const [name, args] of [
		['fs_read', { subcommand: 'fs_read', handle: handleB, offset: 0, length: 4 }],
		['fs_write', { subcommand: 'fs_write', handle: handleB, data: rrbin(4) }],
		['fs_close', { subcommand: 'fs_close', handle: handleB, mode: 'w' }],
	] as const) {
		const before = engine.received.length;
		assertDenied(await clientRequest(A, dap('rrext_store', { ...args })), 'ownership', `${name} with a handle another realm opened`);
		assertNotForwarded(engine, before, `${name} with a foreign handle`);
	}

	const before = engine.received.length;
	assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_read_many', paths: [`apps/${key}/a`] })), ['capability', 'schema'], 'fs_read_many');
	assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_geturl', path: `apps/${key}/a`, expires_in: 3600 })), ['capability', 'schema'], 'fs_geturl');
	assertDenied(await clientRequest(A, dap('rrext_store', { subcommand: 'fs_close', handle: handleA, mode: 'x' })), 'schema', 'fs_close with mode x');
	assertNotForwarded(engine, before, 'denied store commands');
});

// =============================================================================
// T19 — hostile input
// =============================================================================

test('T19 hostile input fails closed and nothing is forwarded', async (tt) => {
	const { A: _unused, engine, t } = fixture(tt);
	void _unused;
	const R = t.open(ENTRY_A, { raw: true });

	const nest = (depth: number): Record<string, unknown> => {
		const root: Record<string, unknown> = {};
		let cursor = root;
		for (let i = 0; i < depth; i++) {
			const next: Record<string, unknown> = {};
			cursor.n = next;
			cursor = next;
		}
		return root;
	};
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const { port1 } = new MessageChannel();
	const hostile: Array<{ name: string; args: Record<string, unknown>; transfer?: unknown[] }> = [
		{ name: 'a cyclic object', args: { cyc: cyclic } },
		{ name: 'depth 65', args: nest(64) },
		{ name: '100,001 nodes', args: { list: new Array(99_999).fill(0) } },
		{ name: 'a Map', args: { m: new Map([[1, 2]]) } },
		{ name: 'a Date', args: { d: new Date(0) } },
		{ name: 'a __proto__ key', args: JSON.parse('{"__proto__": {"x": 1}}') },
		{ name: 'a constructor key', args: JSON.parse('{"constructor": {"x": 1}}') },
		{ name: 'a transferred MessagePort', args: { p: port1 }, transfer: [port1] },
	];
	for (const h of hostile) {
		const before = engine.received.length;
		const response = await R.rawRequest('client.request', { message: dap('rrext_ping', h.args) }, h.transfer);
		assert.ok(response, `${h.name}: the root must answer the request`);
		assert.equal(response.ok, true, `${h.name}: a denial travels as a resolved envelope, got ${brief(response)}`);
		assertDenied(response.result, 'schema', h.name);
		assertNotForwarded(engine, before, h.name);
	}

	// A hook that throws fails closed.
	const throwing = makeRoot({ __throwIn: 'gate' });
	tt.after(() => throwing.cleanup());
	const T = throwing.open(ENTRY_A);
	const before = throwing.cm.engine.received.length;
	assertDenied(await clientRequest(T, dap('rrext_ping')), 'schema', 'a request while the gate hook throws');
	assertNotForwarded(throwing.cm.engine, before, 'a request while the gate hook throws');

	// `undefined`-valued keys (the SDK sends them) are deleted, not rejected.
	const mark = engine.received.length;
	const ok = await clientRequest(t.open(ENTRY_A), dap('rrext_ping', { token: undefined }));
	assert.equal(ok.ok, true, `an undefined-valued key must be deleted, not rejected, got ${brief(ok)}`);
	assert.equal(engine.received.length, mark + 1, 'the request must reach the engine');
	assert.ok(!('token' in (engine.received.at(-1)!.message.arguments ?? {})), 'the undefined key must not be forwarded');
});
