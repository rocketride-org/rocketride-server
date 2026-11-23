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
// N1 G4 ROUND 2 TESTS — T126 (matcher worst case), T117 r2 (event-borne plants),
// T127-T130 (user alias shape, overlapping matches, rrapp. after a dot, project key case)
// =============================================================================

/// <reference types="node" />

import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DAPMessage } from 'rocketride';
import { createMatcher, matcherShape } from './match';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, frameFor, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import { call, expectDenied, expectOk, lastRun } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { assertCost, bestPair, startRun } from './__test__/util';

const SRC = 'chat_1';
const keyA = refAppKey(ENTRY_A.id);
const keyB = refAppKey(ENTRY_B.id);
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });

/** How far over its no-ids control a run may go on a loaded host (see assertCost). */
const COST_RATIO = 10;

/** 4096 minted ids of one app, all sharing `rrapp.<key>.`, put into the root's foreign set through unowned events (as late events of terminated runs would). */
async function fillMinted(t: ITestRoot, key: string): Promise<string[]> {
	const ids = Array.from({ length: 4096 }, () => `rrapp.${key}.${randomUUID()}`);
	for (const id of ids) t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: id, source: SRC }));
	await settle();
	assert.equal(t.root.__stats!().knownProjects, 4096, 'setup: 4096 shared-prefix ids are held');
	return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// T126 — DA R2-1 / security N2: the matcher's worst case
// ─────────────────────────────────────────────────────────────────────────────

test('T126 shared-prefix needles cost nothing extra: lookup is per distinct length, never per needle', async (tt) => {
	const flood = `rrapp.${keyA.slice(0, 2)}`;

	await tt.test('(a) inbound: a 256 KiB pipeline string of rrapp.<2 chars> repeated, with 4096 shared-prefix ids held, is gated in under 50 ms', async () => {
		const t = makeRoot();
		const c = makeRoot();
		tt.after(() => {
			t.cleanup();
			c.cleanup();
		});
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const C = c.open(ENTRY_A, { grant: GRANT_A });
		await fillMinted(t, keyA);
		const text = flood.repeat(Math.floor((250 * 1024) / flood.length));
		// Only the execute is timed: the terminate that frees the run is clean-up.
		const round = (realm: IOpenedRealm) => async (): Promise<number> => {
			const start = performance.now();
			const result = await call(realm, 'execute', { pipeline: { components: [], source: SRC, config: { text } }, args: [], ttl: 60 });
			const took = performance.now() - start;
			const body = expectOk(result, 'execute with a shared-prefix flood string');
			await call(realm, 'terminate', { token: String(body.token) });
			return took;
		};
		const ms = await bestPair(3, round(C), round(A));
		tt.diagnostic(`T126(a) inbound 256 KiB shared-prefix: ${ms.measured.toFixed(1)} ms, ${ms.control.toFixed(1)} ms with no ids held`);
		assertCost('inbound', ms, 50, COST_RATIO);
	});

	await tt.test('(a) outbound: the same text as an fs_get_json value is delivered in under 50 ms', async () => {
		const t = makeRoot();
		const c = makeRoot();
		tt.after(() => {
			t.cleanup();
			c.cleanup();
		});
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const C = c.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		await startRun(C);
		await fillMinted(t, keyA);
		const text = flood.repeat(Math.floor((250 * 1024) / flood.length));
		t.cm.engine.setFsJson({ text });
		c.cm.engine.setFsJson({ text });
		const round = (realm: IOpenedRealm) => async (): Promise<number> => {
			const start = performance.now();
			const answer = await call(realm, 'rrext_store', { subcommand: 'fs_get_json', path: `apps/${keyA}/f.json` });
			const took = performance.now() - start;
			const body = expectOk(answer, 'fs_get_json');
			assert.equal((body.value as { text: string }).text, text);
			return took;
		};
		const ms = await bestPair(3, round(C), round(A));
		tt.diagnostic(`T126(a) outbound fs_get_json 256 KiB shared-prefix: ${ms.measured.toFixed(1)} ms, ${ms.control.toFixed(1)} ms with no ids held`);
		assertCost('outbound', ms, 50, COST_RATIO);
	});

	await tt.test('(b) outbound: an 8 MiB status of the flood text with shared-prefix needles held is delivered in under 1000 ms', async () => {
		const t = makeRoot();
		const c = makeRoot();
		tt.after(() => {
			t.cleanup();
			c.cleanup();
		});
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const C = c.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const runC = await startRun(C);
		await fillMinted(t, keyA);
		const chunk = flood.repeat(500);
		t.cm.engine.setStatus({ big: Array.from({ length: 2000 }, () => chunk) });
		c.cm.engine.setStatus({ big: Array.from({ length: 2000 }, () => chunk) });
		const ms = await bestPair(
			3,
			async () => {
				const start = performance.now();
				const answer = await status(C, runC.token);
				const took = performance.now() - start;
				expectOk(answer, '8 MiB shared-prefix status, no ids held');
				return took;
			},
			async () => {
				const start = performance.now();
				const answer = await status(A, run.token);
				const took = performance.now() - start;
				expectOk(answer, '8 MiB shared-prefix status');
				return took;
			}
		);
		tt.diagnostic(`T126(b) outbound 8 MiB shared-prefix: ${ms.measured.toFixed(1)} ms, ${ms.control.toFixed(1)} ms with no ids held`);
		// Widened 5x for loaded CI hosts (margin was under 3x: up to 137 ms seen).
		assertCost('outbound', ms, 1000, COST_RATIO);
	});

	await tt.test('(c) structural: 4096 needles sharing a 32-char prefix leave no group with more than one entry per length', () => {
		const ids = Array.from({ length: 4096 }, () => `rrapp.${keyA}.${randomUUID()}`);
		const shape = matcherShape(createMatcher(ids.map((id) => [id, 1] as const)));
		tt.diagnostic(`T126(c) shape: ${JSON.stringify(shape)}`);
		assert.equal(shape.needles, 4096);
		assert.ok(shape.maxLengthsPerGroup <= 1, `a group holds ${shape.maxLengthsPerGroup} lengths`);
		assert.ok(shape.maxLengthsPerGroup <= shape.lengthBound, 'and never more than the class bound');
		// Even needles that share their whole class prefix are one exact lookup per length, never a scan over needles.
		const shared = Array.from({ length: 4096 }, (_, i) => `${'x'.repeat(64)}${String(i).padStart(4, '0')}`);
		const sharedShape = matcherShape(createMatcher(shared.map((id) => [id, 1] as const)));
		assert.equal(sharedShape.maxLengthsPerGroup, 1, `4096 needles with one 64-char prefix and one length form a single exact-lookup group, got ${JSON.stringify(sharedShape)}`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T117 r2 — security N1: plants through event bodies
// ─────────────────────────────────────────────────────────────────────────────

test('T117 r2 event bodies plant nothing root-wide: identity stamps, non-engine-shaped project ids and odd status ids', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const X = t.open(ENTRY_A, { grant: GRANT_A });
	const Y = t.open(ENTRY_B, { grant: GRANT_B });
	await startRun(X);
	const realX = lastRun(t.cm);
	const runY = await startRun(Y);
	const phrase = 'a twenty char phrase';
	const teamPhrase = 'team phrase planted here';
	const projectPhrase = 'a project phrase planted for all';
	const idPhrase = 'status id phrase planted';
	const knownBefore = t.root.__stats!().knownProjects;
	// An owned and an unowned event whose bodies carry their own runKind (the engine then skips its stamp).
	t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: realX.projectId, source: SRC, runKind: 'x', userId: phrase, teamId: teamPhrase }));
	t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: randomUUID(), source: SRC, runKind: 'x', userId: phrase, teamId: teamPhrase }));
	// An unowned event with a non-engine-shaped project id, and a status event with a non-task-id id.
	t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: projectPhrase, source: SRC }));
	const odd = t.cm.engine.event('status', { project_id: randomUUID(), source: SRC });
	(odd as unknown as { id: string }).id = idPhrase;
	t.cm.emitEngineEvent(odd);
	await settle();

	await tt.test("Y's text holding the phrases is not rewritten or refused", async () => {
		t.cm.engine.setStatus({ name: `${phrase} | ${teamPhrase} | ${projectPhrase} | ${idPhrase}` });
		const body = expectOk(await status(Y, runY.token), "Y's status quoting planted phrases");
		assert.equal(body.name, `${phrase} | ${teamPhrase} | ${projectPhrase} | ${idPhrase}`);
		t.cm.engine.setStatus({});
	});
	await tt.test('only the engine-shaped unowned project id joined the foreign set', () => {
		assert.equal(t.root.__stats!().knownProjects, knownBefore + 2, 'the two uuids, not the phrase');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// T127-T130 — the round 2 LOWs
// ─────────────────────────────────────────────────────────────────────────────

test('T127 a grant user id without the ru_ shape is never copied: user fields are removed and free text redacted', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const USER = 'u-1234567890abcdef';
	t.cm.engine.userId = USER;
	const A = t.open(ENTRY_A, { grant: { frame: frameFor(ENTRY_A, { userId: 'plain-not-an-alias', organizations: [] }) } });
	const run = await startRun(A);
	t.cm.engine.setStatus({ userId: USER, name: `owner ${USER}` });
	const body = expectOk(await status(A, run.token), 'status');
	assert.ok(!('userId' in body), `userId must be removed, got ${JSON.stringify(body.userId)}`);
	assert.equal(body.name, 'owner [redacted]');
});

test('T128 a replacement that starts before a must-deny value and overlaps it never hides it: the deny wins', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	const real = lastRun(t.cm);
	// A real task id the root saw whose first 8 chars are the last 8 of the realm's own project id.
	const seenTaskId = `${real.projectId.slice(-8)}.${SRC}`;
	const event = t.cm.engine.event('status', { project_id: randomUUID(), source: SRC });
	(event as unknown as { id: string }).id = seenTaskId;
	t.cm.emitEngineEvent(event as DAPMessage);
	await settle();
	t.cm.engine.setStatus({ name: `${real.projectId}.${SRC}` });
	expectDenied(await status(A, run.token), 'credential', 'own project id overlapping a seen task id');
});

test("T129 another app's minted id right after a dot is caught", async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	t.cm.engine.setStatus({ name: `foo.rrapp.${keyB}.${randomUUID()}` });
	expectDenied(await status(A, run.token), 'credential', 'foo.rrapp.<id> in status.name');
});

test('T130 project id keys are matched in any case', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const run = await startRun(A);
	t.cm.engine.setStatus({ ProjectID: 'rag-example', PROJECT_ID: randomBytes(4).toString('hex') });
	const body = expectOk(await status(A, run.token), 'status with odd-cased project keys');
	assert.match(String(body.ProjectID), /^rp_[A-Za-z0-9_-]{22}$/);
	assert.match(String(body.PROJECT_ID), /^rp_[A-Za-z0-9_-]{22}$/);
});
