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
// ID TESTS — T110, T112-T115 (real ids by command, the API key, inbound free strings,
// the rrapp. pattern, and per-realm identity aliases)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, frameFor, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { FORBIDDEN_KEYS, assertNoReal, call, clientEvents, engineErrorText, expectDenied, expectOk, lastRun } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { assertNotForwarded, brief, startRun } from './__test__/util';

const SRC = 'chat_1';
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });
const hex32 = (): string => randomBytes(16).toString('hex');
const USER = 'u-1234567890abcdef';

// ─────────────────────────────────────────────────────────────────────────────
// T110 — real ids by command
// ─────────────────────────────────────────────────────────────────────────────

test('T110 every command that returns ids carries only aliases and no team, run-kind, owner-kind or org keys', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	const engine = t.cm.engine;
	const stamps = { project_id: real.projectId, projectId: real.projectId, id: real.id, userId: engine.userId, teamId: 'local', team_id: 'local', devTeam: 'local', runKind: 'dev', run_kind: 'dev', ownerKind: 'team', owner_kind: 'team', orgId: 'org-1', org_id: 'org-1' };
	engine.setStatus({ ...stamps });
	engine.extendBody('restart', { ...stamps });
	engine.extendBody('rrext_get_token', { ...stamps });
	engine.extendBody('rrext_monitor', { ...stamps });
	engine.extendBody('rrext_get_pipeline', { teamId: 'local', run_kind: 'dev', orgId: 'org-1' });

	/** Every project id field and the task id of a body are the realm's aliases. */
	const onlyAliases = (body: Record<string, unknown>, what: string): void => {
		for (const key of ['project_id', 'projectId']) if (key in body) assert.equal(body[key], run.projectId, `${what}: ${key} must be the realm's alias, got ${brief(body[key])}`);
		if ('id' in body) assert.equal(body.id, run.id, `${what}: id must be the task-id alias, got ${brief(body.id)}`);
		for (const key of FORBIDDEN_KEYS) assert.ok(!(key in body), `${what}: the body must not carry ${key}`);
	};

	await tt.test('rrext_get_task_status', async () => {
		const body = expectOk(await status(A, run.token), 'status');
		assert.ok('project_id' in body && 'id' in body, 'the body carries project_id and id');
		onlyAliases(body, 'status');
	});
	await tt.test('rrext_get_pipeline (pipeline.project_id)', async () => {
		const body = expectOk(await call(A, 'rrext_get_pipeline', { token: run.token }), 'pipeline');
		const pipeline = body.pipeline as Record<string, unknown>;
		assert.equal(pipeline.project_id, run.projectId, `pipeline.project_id must be the alias, got ${brief(pipeline.project_id)}`);
		onlyAliases(body, 'pipeline');
	});
	await tt.test('restart', async () => {
		const body = expectOk(await call(A, 'restart', { token: run.token, projectId: run.projectId, source: SRC, pipeline: { components: [], source: SRC } }), 'restart');
		assert.equal(body.projectId, run.projectId);
		assert.equal(body.id, run.id);
		onlyAliases(body, 'restart');
	});
	await tt.test('rrext_get_token', async () => {
		const body = expectOk(await call(A, 'rrext_get_token', { projectId: run.projectId, source: SRC }), 'get_token');
		assert.equal(body.token, run.token);
		onlyAliases(body, 'get_token');
	});
	await tt.test('rrext_monitor', async () => {
		const body = expectOk(await call(A, 'rrext_monitor', { token: run.token, types: ['summary'] }), 'monitor');
		onlyAliases(body, 'monitor');
	});
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T112 — the shell API key
// ─────────────────────────────────────────────────────────────────────────────

const newKey = (): string => `rr_${randomBytes(20).toString('hex')}`;

test('T112 the shell API key is in the backstop: denied, redacted in notes and errors, and refused inbound', async (tt) => {
	await tt.test('all four paths, both sources on', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.apiKey = newKey();
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const key = t.cm.apiKey;
		t.cm.engine.setStatus({ name: `key ${key}` });
		expectDenied(await status(A, run.token), 'credential', 'the API key in a status field');
		t.cm.engine.setStatus({ notes: ['fine', `export KEY=${key}`] });
		assert.deepEqual(expectOk(await status(A, run.token), 'status with the key in a note').notes, ['fine', '[redacted]'], 'a note holding the key is redacted');
		t.cm.engine.failWith('terminate', { message: `rejected key ${key}` });
		const message = engineErrorText(await call(A, 'terminate', { token: run.token }), 'terminate failure naming the key');
		assert.ok(!message.includes(key), `the engine error must not carry the key, got ${JSON.stringify(message)}`);
		assert.ok(message.includes('[redacted]'), `the key is redacted in the message, got ${JSON.stringify(message)}`);
		const before = t.cm.engine.received.length;
		expectDenied(await call(A, 'execute', { pipeline: { components: [], source: SRC, config: { header: `Bearer ${key}` } }, args: [], ttl: 60 }), 'credential', 'the key in a pipeline config');
		assertNotForwarded(t.cm.engine, before, 'a pipeline holding the API key');
	});

	for (const [label, sources] of [
		['getClient().getApiKey() only', { client: true, host: false }],
		['the host.apiKey op only', { client: false, host: true }],
	] as const) {
		await tt.test(`${label}, fetched at attach`, async () => {
			const t = makeRoot();
			tt.after(() => t.cleanup());
			t.cm.apiKey = newKey();
			Object.assign(t.cm.apiKeySources, sources);
			const A = t.open(ENTRY_A, { grant: GRANT_A });
			const run = await startRun(A);
			t.cm.engine.setStatus({ name: `key ${t.cm.apiKey}` });
			expectDenied(await status(A, run.token), 'credential', `the API key from ${label}`);
		});
		await tt.test(`${label}, re-fetched on shell:login`, async () => {
			const t = makeRoot();
			tt.after(() => t.cleanup());
			Object.assign(t.cm.apiKeySources, sources);
			const A = t.open(ENTRY_A, { grant: GRANT_A });
			const run = await startRun(A);
			t.cm.apiKey = newKey();
			t.cm.emit('shell:login', { user: {} });
			await settle();
			t.cm.engine.setStatus({ name: `key ${t.cm.apiKey}` });
			expectDenied(await status(A, run.token), 'credential', `the key of a new session from ${label}`);
		});
	}
});

test('T112b a host.apiKey answer that arrives after logout does not re-add the previous session key', async () => {
	const t = makeRoot();
	try {
		Object.assign(t.cm.apiKeySources, { client: false, host: true });
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		const oldKey = newKey();
		t.cm.apiKey = oldKey;
		const release = t.cm.holdApiKey();
		t.cm.emit('shell:login', { user: {} });
		t.cm.emit('shell:logout', {});
		release();
		await settle();
		t.cm.apiKey = newKey();
		t.cm.emit('shell:login', { user: {} });
		await settle();
		const run = await startRun(A);
		t.cm.engine.setStatus({ name: `old ${oldKey}` });
		assert.equal(expectOk(await status(A, run.token), 'status naming the old key').name, `old ${oldKey}`, 'the previous session key is no longer in the backstop');
		t.cm.engine.setStatus({ name: `new ${t.cm.apiKey}` });
		expectDenied(await status(A, run.token), 'credential', 'the new session key is');
	} finally {
		t.cleanup();
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// T113 — inbound free strings (N1-f)
// ─────────────────────────────────────────────────────────────────────────────

test('T113 inbound: credentials and real ids inside any free string are refused; Stripe-style keys and short ids are forwarded', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const engine = t.cm.engine;
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const B = t.open(ENTRY_B, { grant: GRANT_B });
	await startRun(A);
	const realA = lastRun(t.cm);
	await startRun(B);
	const realB = lastRun(t.cm);
	const foreign = randomUUID();
	t.cm.emitEngineEvent(engine.event('status', { project_id: foreign, source: SRC }));
	await settle();

	const refused: Array<[string, string]> = [
		["the own run's real tk_", realA.token],
		["the own run's real pk_", realA.publicToken],
		["another realm's real tk_", realB.token],
		['an engine-format tk_ the root never saw', `tk_${hex32()}`],
		['an engine-format pk_ the root never saw', `pk_${hex32()}`],
		['the session token', t.cm.sessionToken],
		['the API key', t.cm.apiKey],
		["the own run's real project id", realA.projectId],
		["the own run's real task id", realA.id],
		['a foreign project id the root saw', foreign],
	];
	for (const [what, value] of refused) {
		await tt.test(`refused: ${what}`, async () => {
			const before = engine.received.length;
			const result = await call(A, 'execute', { pipeline: { components: [], source: SRC, config: { deep: [{ text: `x (${value}) y` }] } }, args: [], ttl: 60 });
			// A run that was wrongly started is ended, so it does not use up the run quota of the cases after it.
			if (result.kind === 'ok') await call(A, 'terminate', { token: String(result.body.token) });
			expectDenied(result, 'credential', `execute whose pipeline config holds ${what}`);
			assertNotForwarded(engine, before, `execute holding ${what}`);
		});
	}

	await tt.test('allowed and forwarded unchanged: Stripe-style keys, a short tk_, a short project id', async () => {
		const config = { live: 'pk_live_51HabcDEFghiJKLmnoPQRstuVwx', test: 'pk_test_4eC39HqLyjWDarjtT1zdp7dc', short: 'tk_0123456789abcdef0123456789abcde', project: 'rag-example' };
		const before = engine.received.length;
		expectOk(await call(A, 'execute', { pipeline: { components: [], source: SRC, config }, args: [], ttl: 60 }), 'execute with Stripe-style keys');
		const forwarded = engine.messagesFor('execute', before);
		assert.equal(forwarded.length, 1, 'the execute reaches the engine');
		const sent = (forwarded[0].message.arguments as { pipeline: { config: unknown } }).pipeline.config;
		assert.deepEqual(sent, config, 'the strings are forwarded unchanged');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T114 — the rrapp. pattern
// ─────────────────────────────────────────────────────────────────────────────

test("T114 another app's rrapp. id is redacted in errors and notes and denied elsewhere; the realm's own aliases never trigger it", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	const foreignRr = `rrapp.${refAppKey(ENTRY_B.id)}.${randomUUID()}`;

	await tt.test('inside an engine error: redacted in the message', async () => {
		t.cm.engine.failWith('terminate', { message: `conflicts with ${foreignRr}` });
		const message = engineErrorText(await call(A, 'terminate', { token: run.token }), "terminate failure naming another app's project");
		assert.ok(!message.includes(foreignRr), `the other app's minted id must not reach the realm, got ${JSON.stringify(message)}`);
		assert.ok(message.includes('[redacted]'), `it is redacted in the message, got ${JSON.stringify(message)}`);
	});
	await tt.test('inside a status note: [redacted]', async () => {
		t.cm.engine.setStatus({ notes: ['ok', `see ${foreignRr}`] });
		assert.deepEqual(expectOk(await status(A, run.token), 'status with the id in a note').notes, ['ok', '[redacted]']);
	});
	await tt.test('in a non-note field: denied', async () => {
		t.cm.engine.setStatus({ name: foreignRr });
		expectDenied(await status(A, run.token), 'credential', 'the id in status.name');
	});
	await tt.test("the realm's own aliased ids never trigger it", async () => {
		t.cm.engine.setStatus({ notes: [`project ${real.projectId}`] });
		const body = expectOk(await status(A, run.token), 'an ordinary status read');
		assert.equal(body.project_id, run.projectId, 'the own project id is the alias');
		assert.deepEqual(body.notes, [`project ${run.projectId}`], 'the own real project id in a note is replaced by its alias');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T115 — per-realm identity aliases
// ─────────────────────────────────────────────────────────────────────────────

/** The identity-bearing fields every body carries in these tests, at three depths. */
const identityFields = (): Record<string, unknown> => ({ userId: USER, user_id: USER, client_id: USER, teamId: 'local', team_id: 'local', devTeam: 'local', runKind: 'dev', run_kind: 'dev', ownerKind: 'user', owner_kind: 'user', orgId: 'org-1', org_id: 'org-1', meta: { list: [{ userId: USER, teamId: 'local' }] } });

/** The identity fields of a body, all of them. */
const userFields = (body: Record<string, unknown>): unknown[] => {
	const meta = body.meta as { list: Array<Record<string, unknown>> };
	return [body.userId, body.user_id, body.client_id, meta.list[0].userId];
};

test('T115 per-realm identity aliases: copied from the grant, key-scoped, team fields removed, anonymous grants lose userId fields', async (tt) => {
	const open = (t: ITestRoot) => ({ A: t.open(ENTRY_A, { grant: GRANT_A }), B: t.open(ENTRY_B, { grant: GRANT_B }) });

	await tt.test("each realm sees its own grant's alias in status bodies and events, at any depth", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		const { A, B } = open(t);
		const runA = await startRun(A);
		const realA = lastRun(t.cm);
		const runB = await startRun(B);
		t.cm.engine.setStatus(identityFields());
		const a = expectOk(await status(A, runA.token), 'status for A');
		const b = expectOk(await status(B, runB.token), 'status for B');
		const idA = GRANT_A.frame!.identity!.userId;
		const idB = GRANT_B.frame!.identity!.userId;
		assert.deepEqual(userFields(a), [idA, idA, idA, idA], `A: every user field is GRANT_A's alias, got ${brief(userFields(a))}`);
		assert.deepEqual(userFields(b), [idB, idB, idB, idB], `B: every user field is GRANT_B's alias, got ${brief(userFields(b))}`);
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: realA.projectId, source: SRC, meta: { list: [{ userId: USER }] } }));
		await settle();
		const ev = clientEvents(A)[0]?.body as Record<string, unknown> | undefined;
		assert.equal(ev?.userId, idA, 'the event body userId is the alias');
		assert.equal(((ev?.meta as { list: Array<{ userId: string }> } | undefined)?.list ?? [])[0]?.userId, idA, 'and so is a nested one');
		assertNoReal(A, t.cm);
		assertNoReal(B, t.cm);
	});

	await tt.test('team, run-kind, owner-kind and org keys are removed', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus(identityFields());
		const body = expectOk(await status(A, run.token), 'status with identity fields');
		for (const key of FORBIDDEN_KEYS) assert.ok(!(key in body), `${key} must be removed, got ${brief(body[key])}`);
		assert.ok(!('teamId' in (body.meta as { list: object[] }).list[0]), 'also at depth');
	});

	// G4 round 1 F1: the real user id is a high-entropy identity value, so free text now carries the
	// grant's alias in its place. 'local' (low entropy) is still never rewritten.
	await tt.test("'local' inside a note text is unchanged; the real user id there becomes the grant's alias", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus({ notes: [`user local ran it for ${USER}`] });
		const body = expectOk(await status(A, run.token), 'status with a note naming local and the user id');
		assert.deepEqual(body.notes, [`user local ran it for ${GRANT_A.frame!.identity!.userId}`], "'local' is untouched; the real user id is replaced by the alias");
	});

	await tt.test('an anonymous grant (identity: null) loses userId fields', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		const A = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, null) } });
		const run = await startRun(A);
		t.cm.engine.setStatus(identityFields());
		const body = expectOk(await status(A, run.token), 'status for an anonymous realm');
		for (const key of ['userId', 'user_id', 'client_id']) assert.ok(!(key in body), `${key} must be removed for an anonymous grant, got ${brief(body[key])}`);
		assert.ok(!('userId' in (body.meta as { list: object[] }).list[0]), 'also at depth');
		assertNoReal(A, t.cm);
	});

	await tt.test("the root copies the grant's alias verbatim: it never computes one", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		const sentinel = 'ru_not-derivable-from-anything';
		const A = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, { userId: sentinel, organizations: [] }) } });
		const run = await startRun(A);
		t.cm.engine.setStatus({ userId: USER });
		assert.equal(expectOk(await status(A, run.token), 'status').userId, sentinel, "the alias is exactly the grant's string");
	});
});
