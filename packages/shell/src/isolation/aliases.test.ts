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
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createKnownProjects } from './aliases';
import { ENTRY_A, GRANT_A, RE, makeRoot, refAppKey } from './__test__/fixtures';
import { assertNoReal, call, engineErrorText, expectOk, lastRun } from './__test__/n1';
import { settle } from './__test__/realm';
import type { IOpenedRealm } from './__test__/realm';
import { brief, startRun } from './__test__/util';

const SRC = 'chat_1';
const keyA = refAppKey(ENTRY_A.id);
const status = (realm: IOpenedRealm, token: string): ReturnType<typeof call> => call(realm, 'rrext_get_task_status', { token });

test('T105 knownProjects: foreign ids are aliased wherever they appear, short ids by key only, and the own ids survive a flood', async (tt) => {
	// G4 round 2 (security N1, lead): only engine-shaped ids (UUID, rrapp.) join the root-wide set, so a
	// non-engine-shaped id from an event is no longer learnt; the uuid is still replaced.
	await tt.test('(1) a foreign uuid the root saw, quoted in an engine error, is replaced by a realm alias; a non-engine-shaped id is not learnt', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const foreign = randomUUID();
		const odd = 'org:acme/project 42 deployment';
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: foreign, source: SRC }));
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: odd, source: SRC }));
		t.cm.engine.failWith('terminate', { message: `project ${foreign} is held by ${encodeURIComponent(odd)}` });
		const message = engineErrorText(await call(A, 'terminate', { token: run.token }), 'terminate failure naming foreign projects');
		assert.ok(!message.includes(foreign), `the foreign uuid must not reach the realm, got ${JSON.stringify(message)}`);
		assert.match(message, /^project rp_[A-Za-z0-9_-]{22} is held by /, 'the uuid is replaced by a realm alias');
		assert.ok(message.endsWith(` is held by ${encodeURIComponent(odd)}`), `the non-engine-shaped id is not learnt root-wide, got ${JSON.stringify(message)}`);
	});

	await tt.test("(2) and (3) short id 'rag-example': aliased in project_id and map keys only; the word and 'local' in free text and file content stay", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const foreign = randomUUID();
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: foreign, source: SRC }));
		t.cm.engine.setStatus({ project_id: 'rag-example', name: 'rag-example demo run', notes: ['local rag-example note'], byProject: { 'rag-example': { n: 1 }, [foreign]: { n: 2 } } });
		const body = expectOk(await status(A, run.token), "status naming the short project id 'rag-example'");
		assert.match(String(body.project_id), RE.projectAlias, `project_id 'rag-example' must be an alias, got ${brief(body.project_id)}`);
		assert.equal(body.name, 'rag-example demo run', 'the word in status.name is unchanged');
		assert.deepEqual(body.notes, ['local rag-example note'], "the word and 'local' in a note are unchanged");
		const keys = Object.keys(body.byProject as Record<string, unknown>);
		assert.equal(keys.length, 2, 'both map keys survive');
		for (const key of keys) assert.match(key, RE.projectAlias, `a project-keyed map key must be an alias, got ${key}`);
		assert.ok(keys.includes(String(body.project_id)), 'the same short id has the same alias in a field and as a key');
		t.cm.engine.setFsJson({ title: 'rag-example local' });
		const file = expectOk(await call(A, 'rrext_store', { subcommand: 'fs_get_json', path: `apps/${keyA}/f.json` }), 'fs_get_json');
		assert.deepEqual(file.value, { title: 'rag-example local' }, "file content is the app's own data: unchanged");
	});

	await tt.test('(4) an unseen project_id gets an alias on first sight, the same one every time', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		t.cm.engine.setStatus({ project_id: 'unseen-project-0123456789' });
		const first = expectOk(await status(A, run.token), 'first read').project_id;
		const second = expectOk(await status(A, run.token), 'second read').project_id;
		assert.match(String(first), RE.projectAlias, `an unseen project_id must be aliased on first sight, got ${brief(first)}`);
		assert.equal(second, first, 'the alias is stable for the realm');
	});

	await tt.test('(5) a project-keyed map has its keys aliased', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const real = lastRun(t.cm);
		const foreign = randomUUID();
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: foreign, source: SRC }));
		t.cm.engine.setStatus({ byProject: { [real.projectId]: { n: 1 }, [foreign]: { n: 2 } } });
		const map = expectOk(await status(A, run.token), 'status with a project-keyed map').byProject as Record<string, { n: number }>;
		const keys = Object.keys(map);
		assert.ok(keys.includes(run.projectId), `the own project's key is its alias, got ${brief(keys)}`);
		assert.ok(
			keys.every((k) => RE.projectAlias.test(k)),
			`every key is an alias, got ${brief(keys)}`
		);
		assert.equal(keys.length, 2, `the own and the foreign project keep distinct entries, got ${brief(keys)}`);
		assert.equal(map[run.projectId]?.n, 1, 'values are kept');
		const foreignKey = keys.find((k) => k !== run.projectId);
		assert.equal(map[foreignKey as string]?.n, 2, 'the foreign project entry survives under its own alias');
		assertNoReal(A, t.cm, [foreign]);
	});

	await tt.test('(6) the set holds at most 4096 foreign ids, evicts the oldest, and is empty after logout', async (st) => {
		await st.test('the set itself', () => {
			const known = createKnownProjects();
			const ids = Array.from({ length: 5000 }, () => randomUUID());
			for (const id of ids) known.add(id);
			assert.ok(known.size() > 0 && known.size() <= 4096, `size must be in 1..4096, got ${known.size()}`);
			assert.ok(known.has(ids[4999]), 'the newest id is held');
			assert.ok(!known.has(ids[0]), 'the oldest id was evicted');
			known.add('rag-example');
			assert.ok(known.highEntropy().includes(ids[4999]) && !known.highEntropy().includes('rag-example'), 'a short id is held but is not high-entropy');
			known.clear();
			assert.equal(known.size(), 0, 'clear empties it');
		});
		await st.test('at the root: bounded while events flood in, 0 after shell:logout', async () => {
			const t = makeRoot();
			tt.after(() => t.cleanup());
			t.open(ENTRY_A, { grant: GRANT_A });
			assert.equal(typeof t.root.__stats, 'function', 'the root must expose __stats() for tests');
			for (let i = 0; i < 5000; i++) t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: randomUUID(), source: SRC }));
			const held = t.root.__stats!().knownProjects;
			assert.ok(held > 0 && held <= 4096, `the root holds 1..4096 foreign ids, got ${held}`);
			t.cm.emit('shell:logout', {});
			assert.equal(t.root.__stats!().knownProjects, 0, 'logout empties the set');
		});
	});

	await tt.test('(7) flood (N1-L): after 5000 foreign ids the own run is still scrubbed, to the same aliases as before', async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const real = lastRun(t.cm);
		for (let i = 0; i < 5000; i++) t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: randomUUID(), source: SRC }));
		await settle();
		t.cm.engine.setStatus({ notes: [`link https://h/chat/${real.projectId}/chat_1?auth=${real.publicToken}`] });
		const body = expectOk(await status(A, run.token), 'status after the flood');
		assert.deepEqual(body.notes, [`link https://h/chat/${run.projectId}/chat_1?auth=`], 'the note URL still carries the same rp_ alias, auth= empty');
		t.cm.engine.failWith('terminate', { message: `bad ${real.projectId} ${real.id} ${real.token}` });
		const message = engineErrorText(await call(A, 'terminate', { token: run.token }), 'terminate failure after the flood');
		assert.equal(message, `bad ${run.projectId} ${run.id} ${run.token}`, 'project id, task id and tk_ in an engine error: the same alias, task-id alias and handle');
		assertNoReal(A, t.cm);
	});
});
