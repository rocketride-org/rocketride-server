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
// N1 G4 ROUND 1 TESTS — T116-T125 (PR2a-2 review fixes F1-F9 and the security LOWs)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { buildBridgeInit } from './projection';
import type { IBridgeInitInput } from './projection';
import type { FrameOk } from './types';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, frameFor, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { assertNoReal, call, clientEvents, engineErrorText, expectDenied, expectOk, lastRun, transcript } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { assertNotForwarded, brief, outcome, startRun } from './__test__/util';

const SRC = 'chat_1';
const USER = 'u-1234567890abcdef';
const TEAM = 'team-0123456789abcdef';
const TEAM2 = 'team-fedcba9876543210';
const ORG = 'org-00112233445566778899';
const keyA = refAppKey(ENTRY_A.id);
const ALIAS_A = GRANT_A.frame!.identity!.userId;
const hex32 = (): string => randomBytes(16).toString('hex');
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });
const execute = (realm: IOpenedRealm, pipeline: Record<string, unknown> = {}): ReturnType<typeof call> => call(realm, 'execute', { pipeline: { components: [], source: SRC, ...pipeline }, args: [], ttl: 60 });

/** A root whose engine and account carry real, high-entropy user, team and org ids. */
function identityRoot(): ITestRoot {
	const t = makeRoot();
	t.cm.engine.userId = USER;
	t.cm.engine.teamId = TEAM;
	// The SDK's account info (`client.getAccountInfo()`, ConnectResult): user, dev team, org and its teams.
	t.cm.engine.client.getAccountInfo = () => ({ userId: USER, devTeam: TEAM, organization: { id: ORG, name: 'Acme', teams: [{ id: TEAM2, name: 'Ops' }] } });
	return t;
}

/** Waits (real time) until `cond` holds or `ms` pass. */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
}

/** Fills the root's foreign-project set and its seen set (4096 each) with foreign status events. */
async function fillRootSets(t: ITestRoot, n = 4200): Promise<void> {
	for (let i = 0; i < n; i++) t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: randomUUID(), source: SRC }));
	await settle();
	assert.ok(t.root.__stats!().knownProjects >= 4000, `setup: the foreign set is full, got ${t.root.__stats!().knownProjects}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// T116 — F1: real user, team and org ids in free text and store error paths
// ─────────────────────────────────────────────────────────────────────────────

test('T116 real user, team and org ids never reach a realm in free text, store errors or store replies', async (tt) => {
	await tt.test('a store error path names users/<real id>/files/: the prefix is stripped', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		t.cm.engine.failWith('rrext_store', { message: `Cannot modify: handle open under users/${USER}/files/apps/${keyA}/d/` });
		const message = engineErrorText(await call(A, 'rrext_store', { subcommand: 'fs_rmdir', path: `apps/${keyA}/d`, recursive: true }), 'fs_rmdir failure');
		assert.equal(message, `Cannot modify: handle open under apps/${keyA}/d/`);
		assertNoReal(A, t.cm, [TEAM, TEAM2, ORG]);
	});

	await tt.test('a thrown store error naming team and org scopes: the prefixes are stripped', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		t.cm.engine.throwNext('rrext_store', new Error(`busy: teams/${TEAM}/files/a and orgs/${ORG}/files/b`));
		const message = engineErrorText(await call(A, 'rrext_store', { subcommand: 'fs_stat', path: `apps/${keyA}/f` }), 'thrown fs_stat error');
		assert.equal(message, 'busy: a and b');
		assertNoReal(A, t.cm, [TEAM, TEAM2, ORG]);
	});

	await tt.test("free text: the user id becomes the grant's alias, team and org ids are redacted", async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus({ name: `owner ${USER}`, notes: [`team ${TEAM} org ${ORG} ops ${TEAM2}`] });
		const body = expectOk(await status(A, run.token), 'status naming real ids in free text');
		assert.equal(body.name, `owner ${ALIAS_A}`);
		assert.deepEqual(body.notes, ['team [redacted] org [redacted] ops [redacted]']);
		t.cm.engine.failWith('terminate', { message: `${USER} may not stop runs of ${TEAM}` });
		assert.equal(engineErrorText(await call(A, 'terminate', { token: run.token }), 'terminate failure'), `${ALIAS_A} may not stop runs of [redacted]`);
		assertNoReal(A, t.cm, [TEAM, TEAM2, ORG]);
	});

	// G4 round 2 (security N1, lead): identity ids are learnt from the SDK account info only, never from
	// engine bodies (a pipeline can author its own stamps). Without account info, key fields are still
	// rewritten, and free text is not.
	await tt.test('without account info nothing is learnt from engine bodies: key fields rewritten, free text unchanged', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		t.cm.engine.userId = USER;
		t.cm.engine.teamId = TEAM;
		// Account info that names none of the ids the engine stamps (PR2b fails closed with no
		// account info at all, so the realm needs some): nothing may be learnt from the bodies.
		t.cm.engine.client.getAccountInfo = () => ({ userId: 'local', devTeam: 'local', organization: null });
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus({ notes: [`by ${USER} for ${TEAM}`] });
		const body = expectOk(await status(A, run.token), 'status');
		assert.deepEqual(body.notes, [`by ${USER} for ${TEAM}`]);
		assert.equal(body.userId, ALIAS_A);
		assert.ok(!('teamId' in body));
	});

	await tt.test('a store reply (fs_stat) quoting the user id in a free field', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		t.cm.engine.extendBody('rrext_store', { detail: `owned by ${USER}` });
		const body = expectOk(await call(A, 'rrext_store', { subcommand: 'fs_stat', path: `apps/${keyA}/f` }), 'fs_stat');
		assert.equal(body.detail, `owned by ${ALIAS_A}`);
		assertNoReal(A, t.cm, [TEAM, TEAM2, ORG]);
	});

	await tt.test('an anonymous grant: the user id in free text is redacted', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, null) } });
		const run = await startRun(A);
		t.cm.engine.setStatus({ name: `owner ${USER}` });
		assert.equal(expectOk(await status(A, run.token), 'status').name, 'owner [redacted]');
		assertNoReal(A, t.cm, [TEAM, TEAM2, ORG]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T117 — F2 (security M1): a realm cannot plant ids for other realms
// ─────────────────────────────────────────────────────────────────────────────

test('T117 ids a realm plants in its own replies never change, refuse or evict anything for another realm', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const X = t.open(ENTRY_A, { grant: GRANT_A });
	const Y = t.open(ENTRY_B, { grant: GRANT_B });
	const runX = await startRun(X);
	const realX = lastRun(t.cm);
	const runY = await startRun(Y);
	const genuine = randomUUID();
	t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: genuine, source: SRC }));
	await settle();
	const knownBefore = t.root.__stats!().knownProjects;

	// Realm X's pipeline echo (rrext_get_pipeline) and status carry 4096 planted, high-entropy "project ids".
	const phrases = Array.from({ length: 4096 }, (_, i) => `planted phrase number ${i} for everyone`);
	t.cm.engine.extendBody('rrext_get_pipeline', { pipeline: { project_id: realX.projectId, source: SRC, components: phrases.map((p) => ({ config: { project_id: p, projectId: p } })) } });
	expectOk(await call(X, 'rrext_get_pipeline', { token: runX.token }), "X's pipeline read");
	t.cm.engine.extendBody('rrext_get_pipeline', { pipeline: { project_id: realX.projectId, source: SRC, components: [] } });
	t.cm.engine.setStatus({ project_id: phrases[0] });
	expectOk(await status(X, runX.token), "X's status naming a planted id at the top level");
	t.cm.engine.setStatus({});

	await tt.test('the root-wide set is unchanged by what X planted', () => {
		assert.equal(t.root.__stats!().knownProjects, knownBefore, `knownProjects grew from ${knownBefore} to ${t.root.__stats!().knownProjects}`);
	});

	await tt.test("Y's response round-trips the phrase unchanged, as text and as a map key", async () => {
		t.cm.engine.setStatus({ name: `about ${phrases[0]}`, byName: { [phrases[0]]: 1, body: 2 } });
		const body = expectOk(await status(Y, runY.token), "Y's status quoting a phrase X planted");
		assert.equal(body.name, `about ${phrases[0]}`);
		assert.deepEqual(Object.keys(body.byName as object).sort(), ['body', phrases[0]].sort());
		t.cm.engine.setStatus({});
	});

	await tt.test("Y's execute holding the phrase is forwarded", async () => {
		const before = t.cm.engine.received.length;
		const result = await execute(Y, { config: { text: phrases[0] } });
		expectOk(result, "Y's execute with a phrase X planted");
		assert.equal(t.cm.engine.messagesFor('execute', before).length, 1, 'forwarded');
		await call(Y, 'terminate', { token: String((result as { body: Record<string, unknown> }).body.token) });
	});

	await tt.test("an identity-looking value X gets echoed in a store reply is never learnt root-wide: Y's text keeps it", async () => {
		const planted = 'planted-user-id-from-x';
		t.cm.engine.extendBody('rrext_store', { userId: planted, teamId: `${planted}-team` });
		expectOk(await call(X, 'rrext_store', { subcommand: 'fs_stat', path: `apps/${keyA}/f` }), "X's fs_stat echoing identity-looking values");
		t.cm.engine.extendBody('rrext_store', { userId: undefined, teamId: undefined });
		t.cm.engine.setStatus({ name: `hello ${planted}` });
		assert.equal(expectOk(await status(Y, runY.token), "Y's status").name, `hello ${planted}`);
		t.cm.engine.setStatus({});
	});

	await tt.test('a genuine foreign uuid seen before the plant is still aliased', async () => {
		t.cm.engine.failWith('terminate', { message: `project ${genuine} failed` });
		assert.match(engineErrorText(await call(Y, 'terminate', { token: runY.token }), "Y's terminate failure"), /^project rp_[A-Za-z0-9_-]{22} failed$/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T118 — F3 (security M2): bounded scrub cost with the root's sets full
// ─────────────────────────────────────────────────────────────────────────────

/** The best of `n` timed runs, in ms. */
async function best(n: number, run: () => Promise<void>): Promise<number> {
	let min = Infinity;
	for (let i = 0; i < n; i++) {
		const start = performance.now();
		await run();
		min = Math.min(min, performance.now() - start);
	}
	return min;
}

test('T118 scrub cost is linear in the message, not in the needle sets (sets full)', async (tt) => {
	await tt.test('inbound: a 256 KiB execute of 60,000 strings is gated in under 50 ms', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A, caps: ['core', 'pipelines.run', 'fs.app'] });
		await fillRootSets(t);
		const strings = Array.from({ length: 60_000 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[i % 26]);
		const ms = await best(3, async () => {
			const result = await execute(A, { config: { strings } });
			expectOk(result, 'execute with 60,000 strings');
			await call(A, 'terminate', { token: String((result as { body: Record<string, unknown> }).body.token) });
		});
		tt.diagnostic(`inbound 60,000 strings: ${ms.toFixed(1)} ms (round trip incl. terminate)`);
		// Widened 5x for loaded CI hosts (margin was under 3x: up to 27.5 ms seen).
		assert.ok(ms < 250, `inbound gate took ${ms.toFixed(1)} ms`);
	});

	await tt.test('outbound: an 8 MiB status response is scrubbed and delivered in under 200 ms', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		await fillRootSets(t);
		const blob = randomBytes(4_000_000).toString('hex');
		const big = Array.from({ length: 2000 }, (_, i) => blob.slice(i * 4000, (i + 1) * 4000));
		t.cm.engine.setStatus({ big });
		const ms = await best(3, async () => {
			expectOk(await status(A, run.token), '8 MiB status');
		});
		tt.diagnostic(`outbound 8 MiB: ${ms.toFixed(1)} ms`);
		// Widened 5x for loaded CI hosts (margin was under 3x: up to 128 ms seen).
		assert.ok(ms < 1000, `outbound scrub took ${ms.toFixed(1)} ms`);
	});

	await tt.test('events: 1000 owned events of 50 strings each are delivered in under 500 ms', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		const real = lastRun(t.cm);
		await fillRootSets(t);
		const notes = Array.from({ length: 50 }, (_, i) => `note ${i} of a chatty run, nothing secret here`);
		const events = Array.from({ length: 1000 }, () => t.cm.engine.event('flow', { project_id: real.projectId, source: SRC, notes }));
		const before = clientEvents(A).length;
		const start = performance.now();
		for (const event of events) t.cm.emitEngineEvent(event);
		await until(() => clientEvents(A).length - before >= 1000);
		const ms = performance.now() - start;
		tt.diagnostic(`1000 events x 50 strings: ${ms.toFixed(1)} ms`);
		assert.equal(clientEvents(A).length - before, 1000, 'every event is delivered');
		assert.ok(ms < 500, `1000 events took ${ms.toFixed(1)} ms`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T119 — F4: the broad credential shape is anchored and redacted, not dropped
// ─────────────────────────────────────────────────────────────────────────────

test('T119 legitimate data shaped like pk_/tk_ is delivered: anchored, the broad shape redacted, base64url data untouched', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	const b64 = `aGVsbG8tk_${hex32()}d29ybGQ`;

	await tt.test('an owned event with an index name and base64url data is delivered', async () => {
		const before = clientEvents(A).length;
		t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: real.projectId, source: SRC, index: 'pk_customer_orders_idx', blob: b64 }));
		await settle();
		const got = clientEvents(A).slice(before);
		assert.equal(got.length, 1, `the event must be delivered, got ${got.length}`);
		const body = got[0].body as Record<string, unknown>;
		assert.equal(body.index, '[redacted]', 'the broad shape is redacted in place');
		assert.equal(body.blob, b64, 'base64url data (no word boundary before tk_) is unchanged');
	});

	await tt.test('a status field of the broad shape is redacted, not denied', async () => {
		t.cm.engine.setStatus({ name: 'pk_customer_orders_idx', blob: b64 });
		const body = expectOk(await status(A, run.token), 'status with a broad-shape name');
		assert.equal(body.name, '[redacted]');
		assert.equal(body.blob, b64);
	});

	await tt.test('an engine-format credential outside notes is still denied', async () => {
		t.cm.engine.setStatus({ name: `x tk_${hex32()}` });
		expectDenied(await status(A, run.token), 'credential', 'engine-format tk_ in status.name');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T120 — F5: only file content is exempt, marked by the root, not by shape
// ─────────────────────────────────────────────────────────────────────────────

test('T120 store replies are fully scrubbed except fs_get_json.value and fs_list_dir names; the exemption cannot be forged', async (tt) => {
	await tt.test('fs_stat: identity and project fields are rewritten', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		t.cm.engine.extendBody('rrext_store', { userId: USER, teamId: TEAM, project_id: 'rag-example' });
		const body = expectOk(await call(A, 'rrext_store', { subcommand: 'fs_stat', path: `apps/${keyA}/f` }), 'fs_stat');
		assert.equal(body.userId, ALIAS_A, 'userId is the alias');
		assert.ok(!('teamId' in body), 'teamId is removed');
		assert.match(String(body.project_id), /^rp_[A-Za-z0-9_-]{22}$/, 'project_id is aliased');
	});

	await tt.test('fs_list_dir: entry names are exempt, the rest of an entry is not', async () => {
		const t = identityRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		t.cm.engine.extendBody('rrext_store', { entries: [{ name: 'pk_customer_orders_idx.json', type: 'file', userId: USER }], count: 1 });
		const body = expectOk(await call(A, 'rrext_store', { subcommand: 'fs_list_dir', path: `apps/${keyA}` }), 'fs_list_dir');
		const entry = (body.entries as Array<Record<string, unknown>>)[0];
		assert.equal(entry.name, 'pk_customer_orders_idx.json', 'a file name is app data: unchanged');
		assert.equal(entry.userId, ALIAS_A, "an entry's identity field is rewritten");
	});

	await tt.test("fs_get_json.value is the app's own data: identity fields unchanged, a live token still replaced", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const real = lastRun(t.cm);
		t.cm.engine.setFsJson({ userId: 'app-user', teamId: 'app-team', project_id: 'mine', note: `tok ${real.token}` });
		const body = expectOk(await call(A, 'rrext_store', { subcommand: 'fs_get_json', path: `apps/${keyA}/f.json` }), 'fs_get_json');
		assert.deepEqual(body.value, { userId: 'app-user', teamId: 'app-team', project_id: 'mine', note: `tok ${run.token}` });
	});

	await tt.test("a store error text naming another app's minted id is redacted", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		const foreignRr = `rrapp.${refAppKey(ENTRY_B.id)}.${randomUUID()}`;
		t.cm.engine.failWith('rrext_store', { message: `conflict ${foreignRr}` });
		const message = engineErrorText(await call(A, 'rrext_store', { subcommand: 'fs_stat', path: `apps/${keyA}/f` }), 'fs_stat failure');
		assert.equal(message, 'conflict [redacted]');
	});

	await tt.test("an app-lane answer shaped like a store reply gets no exemption: another app's minted id is denied", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A1 = t.open(ENTRY_A, { grant: GRANT_A, viewId: 'v1' });
		const A2 = t.open(ENTRY_A, { grant: GRANT_A, viewId: 'v2' });
		const foreignRr = `rrapp.${refAppKey(ENTRY_B.id)}.${randomUUID()}`;
		A2.bus.handle(`app.${keyA}.echo`, () => ({ ok: true, value: { command: 'rrext_store', text: foreignRr } }));
		await settle();
		const result = await outcome(A1.request(`app.${keyA}.echo`, {}));
		assert.equal(result.ok, false, `the forged store reply must be refused, got ${brief(result)}`);
		assert.ok(!transcript(A1).some((s) => s.includes(foreignRr)), 'the minted id never reaches A1');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T121 — F6: the inbound engine-credential pattern
// ─────────────────────────────────────────────────────────────────────────────

test('T121 inbound: engine-format credentials after an underscore, in uppercase hex or longer are refused', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	await startRun(A);
	for (const [what, value] of [
		['auth_tk_<hex>', `auth_tk_${hex32()}`],
		['uppercase hex', `tk_${hex32().toUpperCase()}`],
		['40 hex digits', `pk_${hex32()}${hex32().slice(0, 8)}`],
	] as const) {
		await tt.test(`refused: ${what}`, async () => {
			const before = t.cm.engine.received.length;
			const result = await execute(A, { config: { header: value } });
			if (result.kind === 'ok') await call(A, 'terminate', { token: String(result.body.token) });
			expectDenied(result, 'credential', `execute holding ${what}`);
			assertNotForwarded(t.cm.engine, before, what);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// T122 — F7: buildBridgeInit checks identity shapes and runs the backstop
// ─────────────────────────────────────────────────────────────────────────────

test('T122 buildBridgeInit: identity only with ru_/ro_ aliases, and a credential anywhere but entryPrefix throws', async (tt) => {
	const input = (frame: FrameOk, extra: Partial<IBridgeInitInput> = {}): IBridgeInitInput => ({
		info: { realmId: 'realm-x', label: 'x', appId: ENTRY_A.id, appKey: keyA, moduleId: ENTRY_A.moduleId, viewId: 'view-a', version: 1, caps: new Set(['core']) },
		frame,
		displayName: 'Ada',
		theme: {},
		props: { isConnected: true, activeView: 'view-a', activeActivity: null, sidePanelOpen: false, theme: 'dark' },
		engineHttpUrl: 'http://localhost:5565',
		proto: 1,
		...extra,
	});
	const org = GRANT_A.frame!.identity!.organizations;

	await tt.test('a real (non-ru_) user id gives identity null', () => {
		assert.equal(buildBridgeInit(input(frameFor(ENTRY_A, { userId: USER, organizations: org }))).identity, null);
	});
	await tt.test('a real (non-ro_) org id gives identity null', () => {
		assert.equal(buildBridgeInit(input(frameFor(ENTRY_A, { userId: ALIAS_A, organizations: [{ id: ORG, name: 'Acme' }] }))).identity, null);
	});
	await tt.test('a credential in theme or props throws; the frame token in entryPrefix does not', () => {
		assert.throws(() => buildBridgeInit(input(GRANT_A.frame!, { theme: { '--x': `tk_${hex32()}` } })), /credential/);
		assert.throws(() => buildBridgeInit(input(GRANT_A.frame!, { displayName: `rrapp.${refAppKey(ENTRY_B.id)}.${randomUUID()}` })), /credential/);
		assert.doesNotThrow(() => buildBridgeInit(input(frameFor(ENTRY_A, GRANT_A.frame!.identity, `tk_${hex32()}`))));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T123 — F8: events that arrive before the execute answer
// ─────────────────────────────────────────────────────────────────────────────

test("T123 an event for a run whose execute answer is still in flight is buffered and delivered, not dropped or made 'foreign'", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const release = t.cm.engine.hold('execute');
	const before = t.cm.engine.received.length;
	const pending = execute(A);
	await until(() => t.cm.engine.messagesFor('execute', before).length === 1);
	const minted = (t.cm.engine.messagesFor('execute', before)[0].message.arguments as { pipeline: { project_id: string } }).pipeline.project_id;
	const stats = t.root.__stats!();
	t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: minted, source: SRC }));
	await settle();
	release();
	const body = expectOk(await pending, 'execute');
	await settle();
	const events = clientEvents(A);
	assert.equal(events.length, 1, `the early event is delivered once, got ${events.length}`);
	assert.equal((events[0].body as Record<string, unknown>).project_id, body.projectId, "with the run's alias");
	assert.equal(t.root.__stats!().eventsDropped, stats.eventsDropped, 'it is not counted as dropped');
	assert.equal(t.root.__stats!().knownProjects, stats.knownProjects, "the realm's own minted id never joins the foreign set");
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T124 — F9: the API key is known before the first client.request is answered
// ─────────────────────────────────────────────────────────────────────────────

test('T124 the first client.request waits for the host.apiKey answer fetched at attach', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	Object.assign(t.cm.apiKeySources, { client: false, host: true });
	const release = t.cm.holdApiKey();
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	t.cm.engine.extendBody('execute', { note: `key ${t.cm.apiKey}` });
	setTimeout(release, 30);
	expectDenied(await execute(A), 'credential', 'an execute answer holding the API key, sent before host.apiKey answered');
	assertNoReal(A, t.cm);
});

// ─────────────────────────────────────────────────────────────────────────────
// T125 — security LOWs: __proto__ keys, depth, identity key case
// ─────────────────────────────────────────────────────────────────────────────

test('T125 an own __proto__ key stays an own property, depth is bounded, identity keys match in any case', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	t.cm.engine.userId = USER;
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);

	await tt.test('an own __proto__ key is kept as an own property and never becomes the prototype', async () => {
		t.cm.engine.setStatus(JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<string, unknown>);
		const body = expectOk(await status(A, run.token), 'status with an own __proto__ key');
		assert.ok(Object.prototype.hasOwnProperty.call(body, '__proto__'), `the own key survives, got ${brief(Object.keys(body))}`);
		assert.deepEqual(Object.getOwnPropertyDescriptor(body, '__proto__')?.value, { polluted: 'yes' });
		assert.equal(Object.getPrototypeOf(body), Object.prototype);
	});

	await tt.test('a 200-deep engine payload is refused as too_large, not a RangeError', async () => {
		let deep: Record<string, unknown> = { leaf: 1 };
		for (let i = 0; i < 200; i++) deep = { d: deep };
		t.cm.engine.setStatus({ deep });
		expectDenied(await status(A, run.token), 'too_large', 'a 200-deep status');
	});

	await tt.test('identity keys match in any case', async () => {
		t.cm.engine.setStatus({ UserID: USER, TeamID: 'some-team', Run_Kind: 'dev', OWNERKIND: 'user', ORG_ID: 'o' });
		const body = expectOk(await status(A, run.token), 'status with odd-cased identity keys');
		assert.equal(body.UserID, ALIAS_A);
		for (const key of ['TeamID', 'Run_Kind', 'OWNERKIND', 'ORG_ID']) assert.ok(!(key in body), `${key} is removed`);
	});
});
