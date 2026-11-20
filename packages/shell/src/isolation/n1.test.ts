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
// N1 TESTS — T1, T36-T38, T41-T44, T108 (PR2a-2: the scrubber on responses, events and errors)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { createFakeCm } from './__test__/fakeCm';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, makeRoot } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import type { IFakeRun } from './__test__/fakeEngine';
import { GENERATE_TOKEN_VECTORS, assertNoReal, call, clientEvents, engineErrorText, expectDenied, expectOk, generateToken, lastRun, mulberry32, openUngated, reproducePk, transcript } from './__test__/n1';
import { dap, settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { brief, startRun } from './__test__/util';

const SRC = 'chat_1';
const ALIAS_A = GRANT_A.frame!.identity!;

/** The status request every test sends. */
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the harness sees every leak on an ungated router
// ─────────────────────────────────────────────────────────────────────────────

test('T1 harness control: an ungated router leaks on every N1 path and assertNoReal sees each leak', async (tt) => {
	await tt.test('generateToken equals the engine (vectors computed with account/base.py)', () => {
		for (const v of GENERATE_TOKEN_VECTORS) assert.equal(generateToken(v.content, v.prefix), v.token, `vector ${JSON.stringify(v.content)}`);
	});

	const cm = createFakeCm({ userId: 'u-1234567890abcdef' });
	const engine = cm.engine;
	const R = openUngated(cm);
	tt.after(() => R.close());
	cm.on('shell:event', ({ event }: { event: DAPMessage }) => R.router.broadcastEmitOp('client.event', { message: event }));
	let mark = 0;
	/** Asserts that everything the realm received since the last call leaks. */
	const leaks = (what: string): void => {
		assert.throws(() => assertNoReal(R, cm, [], mark), /message \d+ carries/, `${what}: assertNoReal must see the leak`);
		mark = R.received.length;
	};
	const send = async (command: string, args: Record<string, unknown>): Promise<unknown> => (await R.request(dap(command, args))) as unknown;

	await tt.test('every N1 path delivers its secret and assertNoReal throws on it', async () => {
		await send('execute', { pipeline: { components: [], source: SRC }, args: [], ttl: 60 });
		const run = lastRun(cm);
		leaks('execute response (tk_, pk_, real projectId, real id)');

		await send('restart', { token: run.token, projectId: run.projectId, source: SRC, pipeline: { components: [], source: SRC, project_id: run.projectId } });
		leaks('restart response');

		engine.setStatus({ notes: [{ 'token-key': run.token }, `https://h/chat/${run.projectId}/chat_1?auth=${run.publicToken}`] });
		await send('rrext_get_task_status', { token: run.token });
		leaks('status with dict and string notes');

		cm.emitEngineEvent(engine.event('status', { project_id: run.projectId, source: SRC }));
		await settle();
		leaks('a client.event broadcast');

		engine.failWith('terminate', { message: `Task ${run.token} not found` });
		await send('terminate', { token: run.token });
		leaks('an engine error');

		R.channel.a.post({ type: 'rr:bridge:init', identity: { userId: engine.userId } });
		await settle();
		leaks('an init object with the real user id');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T36 — N1 acceptance
// ─────────────────────────────────────────────────────────────────────────────

test('T36 N1 acceptance: chat run notes carry the handle and the alias, never a credential or a real project id', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	t.cm.engine.setStatus({ notes: [{ 'token-key': real.token, 'button-link': `https://h/chat/${real.projectId}/chat_1?auth=${real.publicToken}` }, `open https://h/dropper/${real.projectId}/chat_1?auth=${real.publicToken}`] });
	const body = expectOk(await status(A, run.token), "rrext_get_task_status whose notes hold the run's own tk_ and pk_");
	const notes = body.notes as Array<Record<string, string> | string>;
	assert.equal((notes[0] as Record<string, string>)['token-key'], run.token, 'token-key is the handle');
	assert.equal((notes[0] as Record<string, string>)['button-link'], `https://h/chat/${run.projectId}/chat_1?auth=`, 'button-link: the rp_ alias where the project id was, auth= empty');
	assert.equal(notes[1], `open https://h/dropper/${run.projectId}/chat_1?auth=`, 'the string note likewise');
	assert.equal(body.state, 5, 'state is unchanged');
	assert.equal(body.completed, false, 'completed is unchanged');
	assert.equal(body.source, SRC, 'source is unchanged');
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T37 — monitor events
// ─────────────────────────────────────────────────────────────────────────────

test("T37 a monitored run's event reaches the realm scrubbed: aliases, no team or run-kind keys, the grant's user alias", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	await A.request('client.addMonitor', { key: { token: run.token }, types: ['summary'] });
	t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real.projectId, source: SRC, notes: [{ 'token-key': real.token }] }));
	await settle();
	const events = clientEvents(A);
	assert.equal(events.length, 1, `exactly one client.event must reach the realm, got ${events.length}`);
	const event = events[0];
	const body = event.body as Record<string, unknown>;
	assert.equal(body.project_id, run.projectId, 'body.project_id is the alias');
	assert.equal(event.id, run.id, 'id is the task-id alias');
	assert.ok(!('teamId' in body) && !('runKind' in body), `no teamId or runKind keys, got ${brief(body)}`);
	assert.equal(body.userId, ALIAS_A.userId, "userId is the grant's alias");
	assert.equal(((body.notes as Array<Record<string, string>>)[0] ?? {})['token-key'], run.token, 'token-key is the handle');
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T38 — restart keeps the aliases
// ─────────────────────────────────────────────────────────────────────────────

test('T38 restart returns the same handle and aliases, and later status bodies carry those same aliases', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const restarted = expectOk(await call(A, 'restart', { token: run.token, projectId: run.projectId, source: SRC, pipeline: { components: [], source: SRC } }), 'restart');
	assert.equal(restarted.token, run.token, 'restart returns the same handle');
	assert.equal(restarted.projectId, run.projectId, 'restart returns the same project alias');
	assert.equal(restarted.id, run.id, 'restart returns the same task-id alias');
	const body = expectOk(await status(A, run.token), 'status after restart');
	assert.equal(body.project_id, run.projectId, `status body project_id must be the same alias as execute's, got ${brief(body.project_id)}`);
	assert.equal(body.id, run.id, `status body id must be the same task-id alias, got ${brief(body.id)}`);
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T41 — the backstop
// ─────────────────────────────────────────────────────────────────────────────

test('T41 backstop: a note hit is redacted, any other hit is denied, ids inside URLs are replaced, logs never hold the value', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	const foreignTk = `tk_${randomBytes(16).toString('hex')}`;

	await tt.test('a foreign tk_ in a note: that note becomes [redacted], the rest is intact', async () => {
		t.cm.engine.setStatus({ notes: ['harmless', { 'token-key': foreignTk }, 'also fine'] });
		const body = expectOk(await status(A, run.token), 'status with a foreign tk_ in a note');
		assert.deepEqual(body.notes, ['harmless', '[redacted]', 'also fine']);
	});

	await tt.test('the same string in a non-note field is denied', async () => {
		t.cm.engine.setStatus({ name: foreignTk });
		expectDenied(await status(A, run.token), 'credential', 'foreign tk_ in status.name');
	});

	await tt.test('the session token as an object key is denied', async () => {
		t.cm.engine.setStatus({ [t.cm.sessionToken]: 1 });
		expectDenied(await status(A, run.token), 'credential', 'session token as a key');
	});

	await tt.test("the run's own project id inside a URL (path and query) is replaced by the alias", async () => {
		// A minted id is only unreserved URL characters, so encodeURIComponent returns it unchanged: there is
		// no distinct encoded form to test (a second "encoded" iteration would just rerun the raw one).
		assert.equal(encodeURIComponent(real.projectId), real.projectId, 'a minted project id has no encoded form of its own');
		for (const [label, url, expected] of [
			['path', `https://h/p/${real.projectId}/x`, `https://h/p/${run.projectId}/x`],
			['query', `https://h/p?project=${real.projectId}&q=1`, `https://h/p?project=${run.projectId}&q=1`],
		] as const) {
			t.cm.engine.setStatus({ name: url });
			const body = expectOk(await status(A, run.token), `status with the project id in a ${label}`);
			assert.equal(body.name, expected, `${label}: the alias replaces the real project id`);
		}
	});

	await tt.test('no log line holds the matched value', () => {
		for (const needle of [foreignTk, t.cm.sessionToken, real.token, real.projectId]) assert.ok(!t.logs.some((l) => l.includes(needle)), `a log line holds ${needle}`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T42 — N1 property test
// ─────────────────────────────────────────────────────────────────────────────

test('T42 N1 property test: 200 seeded random sequences, and nothing real ever reaches the realm', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const engine = t.cm.engine;
	engine.userId = 'u-1234567890abcdef';
	const rng = mulberry32(1022);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const kinds = ['status', 'flow', 'trace', 'sse'] as const;

	/** Notes built from the run's real values, in the shapes the apps produce. */
	const notesFor = (real: IFakeRun): unknown[] => {
		const bank: unknown[] = [{ 'token-key': real.token }, { 'button-link': `https://h/chat/${real.projectId}/chat_1?auth=${real.publicToken}` }, `open https://h/dropper/${encodeURIComponent(real.projectId)}/chat_1?auth=${real.publicToken}`, `task ${real.id} is running`, 'user local says hi', { nested: { deep: [real.token, real.id] } }, 'plain note'];
		return Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(bank));
	};

	for (let i = 0; i < 200; i++) {
		t.clock.advance(10_000);
		const before = engine.runs.length;
		const run = await startRun(A);
		assert.equal(engine.runs.length, before + 1, `iteration ${i}: the fake engine minted a run`);
		const real = lastRun(t.cm);
		assert.match(real.token, /^tk_[0-9a-f]{32}$/, `iteration ${i}: a tk_`);
		assert.match(real.publicToken, /^pk_[0-9a-f]{32}$/, `iteration ${i}: a pk_`);
		assert.ok(real.projectId.startsWith('rrapp.'), `iteration ${i}: a real project id`);
		assert.match(real.id, /^[0-9a-f]{8}\.chat_1$/, `iteration ${i}: a real task id`);
		// Always: a plain status read, a pipeline read and an event.
		// Successful baseline traffic is REQUIRED: a gate that denied everything would leave the transcript clean.
		engine.setStatus({ notes: ['plain note'] });
		assert.deepEqual(expectOk(await status(A, run.token), `iteration ${i}: baseline status`).notes, ['plain note'], `iteration ${i}: the baseline status is delivered`);
		expectOk(await call(A, 'rrext_get_pipeline', { token: run.token }), `iteration ${i}: baseline pipeline`);
		t.cm.emitEngineEvent(engine.event(pick(kinds), { project_id: real.projectId, source: SRC, notes: ['plain note'] }));
		await A.request('client.addMonitor', { key: { token: run.token }, types: ['summary'] }).catch(() => undefined);
		// Then a random sequence.
		const steps = 2 + Math.floor(rng() * 5);
		for (let s = 0; s < steps; s++) {
			switch (pick(['status', 'event', 'restart', 'error', 'foreign', 'pipeline'] as const)) {
				case 'status':
					engine.setStatus({ notes: notesFor(real), ...(rng() < 0.3 ? { name: `run ${real.id}` } : {}) });
					await status(A, run.token);
					break;
				case 'event':
					t.cm.emitEngineEvent(engine.event(pick(kinds), { project_id: real.projectId, source: SRC, notes: notesFor(real) }));
					break;
				case 'restart':
					await call(A, 'restart', { token: run.token, projectId: run.projectId, source: SRC, pipeline: { components: [], source: SRC } });
					break;
				case 'error': {
					const command = pick(['rrext_get_task_status', 'rrext_get_pipeline']);
					engine.failWith(command, { message: `Task ${real.token} not found in project ${real.projectId} (${real.id})` });
					await call(A, command, { token: run.token });
					break;
				}
				case 'foreign':
					t.cm.emitEngineEvent(engine.event(pick(kinds), { project_id: randomUUID(), source: SRC }));
					break;
				case 'pipeline':
					await call(A, 'rrext_get_pipeline', { token: run.token });
					break;
			}
		}
		await call(A, 'terminate', { token: run.token });
	}
	await settle();
	assert.ok(A.received.length > 200, `the transcript must hold the traffic, it has ${A.received.length} messages`);
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T43 — engine error text
// ─────────────────────────────────────────────────────────────────────────────

test('T43 engine error text is scrubbed (handle and alias), and a thrown engine error has no stack', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	const text = (token: string, project: string): string => `Task ${token} not found in project ${project}`;

	await tt.test('a success: false answer', async () => {
		t.cm.engine.failWith('terminate', { message: text(real.token, real.projectId) });
		const result = await call(A, 'terminate', { token: run.token });
		assert.equal(engineErrorText(result, 'terminate failure'), text(run.token, run.projectId));
	});

	await tt.test('a thrown engine error (sanitizeEnvelope) is scrubbed the same way and loses its stack', async () => {
		const err = new Error(text(real.token, real.projectId));
		err.stack = `Error: ${err.message}\n    at engine (/srv/engine.py:1)`;
		t.cm.engine.throwNext('terminate', err);
		const result = await call(A, 'terminate', { token: run.token });
		assert.equal(result.kind, 'error', `a thrown engine error must arrive as an error envelope, got ${brief(result)}`);
		assert.equal(engineErrorText(result, 'thrown engine error'), text(run.token, run.projectId));
		const wire = A.received.map((m) => (m as { result?: { error?: Record<string, unknown> } }).result?.error).filter(Boolean) as Array<Record<string, unknown>>;
		assert.ok(wire.length > 0 && wire.every((w) => !('stack' in w) || w.stack === undefined), 'no stack reaches the realm');
	});
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T44 — the B3 exploit
// ─────────────────────────────────────────────────────────────────────────────

test("T44 B3: no (owner, project, source) candidate built from the realm transcript reproduces a run's pk_", async (tt) => {
	/** Reads everything an app can read about its run, then tries to rebuild the `pk_`. */
	const readAll = async (t: ITestRoot, A: IOpenedRealm, handle: string, alias: string): Promise<void> => {
		const real = lastRun(t.cm);
		await status(A, handle);
		await call(A, 'rrext_get_pipeline', { token: handle });
		await call(A, 'rrext_get_token', { projectId: alias, source: SRC });
		await call(A, 'restart', { token: handle, projectId: alias, source: SRC, pipeline: { components: [], source: SRC } });
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real.projectId, source: SRC }));
		await settle();
	};
	const noRebuild = (A: IOpenedRealm, targets: string[], what: string): void => {
		const hits = reproducePk(A, targets);
		assert.deepEqual(hits, [], `${what}: ${hits.length} candidate(s) reproduce a pk_ from the transcript, e.g. ${brief(hits[0])}`);
		assert.ok(transcript(A).length > 20, `${what}: the transcript is not empty`);
	};

	await tt.test('(a) the own run', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		await readAll(t, A, run.token, run.projectId);
		noRebuild(A, [lastRun(t.cm).publicToken], 'own run');
	});

	await tt.test('(b) a team-deploy run on the same root, seen by the root as a foreign event', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const foreignProject = randomUUID();
		const foreign: IFakeRun = { token: `tk_${randomBytes(16).toString('hex')}`, publicToken: generateToken({ kind: 'public', teamId: 'local', project_id: foreignProject, source: SRC }, 'pk_'), id: `${randomBytes(4).toString('hex')}.${SRC}`, projectId: foreignProject, source: SRC, ownerContent: { teamId: 'local' } };
		t.cm.engine.runs.push(foreign);
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: foreignProject, source: SRC, teamId: 'local' }));
		await settle();
		// The engine names the foreign project in an error string of the app's own request.
		t.cm.engine.failWith('terminate', { message: `cannot stop project ${foreignProject}` });
		await call(A, 'terminate', { token: run.token });
		const own = t.cm.engine.runs.find((r) => r !== foreign)!;
		await status(A, run.token);
		await call(A, 'rrext_get_pipeline', { token: run.token });
		noRebuild(A, [own.publicToken, foreign.publicToken], 'team deploy run');
		assertNoReal(A, t.cm);
	});

	await tt.test("(c) OSS constants: userId 'local', teamId 'local', a team-owned run", async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		t.cm.engine.userId = 'local';
		t.cm.engine.teamId = 'local';
		t.cm.engine.ownerContent = { teamId: 'local' };
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		await readAll(t, A, run.token, run.projectId);
		noRebuild(A, [lastRun(t.cm).publicToken], 'OSS team run');
	});

	await tt.test('(d) a user run whose real user id the engine quotes in free text (a note and an error string)', async (st) => {
		const t = makeRoot();
		st.after(() => t.cleanup());
		const user = 'u-1234567890abcdef';
		t.cm.engine.userId = user;
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus({ notes: [`started by ${user}`] });
		t.cm.engine.failWith('rrext_get_pipeline', { message: `pipeline of users/${user}/files/x is locked by ${user}` });
		await call(A, 'rrext_get_pipeline', { token: run.token });
		await readAll(t, A, run.token, run.projectId);
		noRebuild(A, [lastRun(t.cm).publicToken], 'user id in free text');
		assertNoReal(A, t.cm);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T108 — the task id
// ─────────────────────────────────────────────────────────────────────────────

test('T108 the task id is aliased as <8 chars after rh_>.<source> everywhere; a real one is replaced in free text or denied', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const B = t.open(ENTRY_B, { grant: GRANT_B });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	await startRun(B);
	const otherReal = lastRun(t.cm);
	assert.equal(run.id, `${run.token.slice(3, 11)}.${SRC}`, 'execute returns <8 chars after rh_>.<source>');
	assert.notEqual(run.id, real.id, 'the alias is not the real task id');
	const restarted = expectOk(await call(A, 'restart', { token: run.token, projectId: run.projectId, source: SRC, pipeline: { components: [], source: SRC } }), 'restart');
	assert.equal(restarted.id, run.id, 'restart returns the same task-id alias');

	const body = expectOk(await status(A, run.token), 'status');
	assert.equal(body.id, run.id, `a status body's id must be the task-id alias, got ${brief(body.id)}`);

	await A.request('client.addMonitor', { key: { token: run.token }, types: ['summary'] });
	t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real.projectId, source: SRC }));
	await settle();
	assert.equal(clientEvents(A)[0]?.id, run.id, "a client.event envelope's id is the task-id alias");

	t.cm.engine.setStatus({ name: `run ${real.id}` });
	assert.equal(expectOk(await status(A, run.token), 'status with the own task id in a string').name, `run ${run.id}`, 'the own real task id inside a string is replaced by the alias');

	t.cm.engine.setStatus({ name: `run ${otherReal.id}` });
	expectDenied(await status(A, run.token), 'credential', "another realm's real task id in a non-note field");
});

// ─────────────────────────────────────────────────────────────────────────────
// A replaced own value must not hide a shorter must-deny value that starts at the same offset
// ─────────────────────────────────────────────────────────────────────────────

test('an own project id (replaced) does not hide the API key that is a prefix of it', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	t.cm.engine.setStatus({ name: `see ${real.projectId} now` });
	assert.equal(expectOk(await status(A, run.token), 'control: the own project id alone').name, `see ${run.projectId} now`, 'control: the id is replaced by its alias');
	t.cm.apiKey = real.projectId.slice(0, 24); // a must-deny value that starts where the own id starts
	expectDenied(await status(A, run.token), 'credential', 'a deny value shorter than the exempt own id at the same offset');
});
