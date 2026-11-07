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

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { decidePipeFile, emptyPipelineSkeleton, firstDuplicate, otherFilesWithProjectId, readPipeProjectId, sameFileIdentity, withProjectId } from '../shared/util/pipeFileDecision';
import type { DuplicateCheck, KnownPipeFile, PipeFileEvent } from '../shared/util/pipeFileDecision';

const FILE = '/ws/pipelines/a.pipe';
const OTHER = '/ws/pipelines/b.pipe';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

/** A minimal pipeline file, with or without a project_id. */
function pipe(projectId?: string): string {
	return JSON.stringify(projectId === undefined ? { components: [] } : { components: [], project_id: projectId }, null, 2);
}

function decide(text: string, known: KnownPipeFile[], event: PipeFileEvent = 'created', settled = false) {
	return decidePipeFile({ event, filePath: FILE, text, known, settled });
}

// --- empty reads: the "once emptied a file" half of #2466 ------------------

test('an empty read on a changed file never writes', () => {
	for (const text of ['', '   ', '\n\t\n']) {
		assert.deepEqual(decide(text, [], 'changed'), { kind: 'leave', reason: 'empty' });
	}
});

test('an empty read on a created file is re-checked before anything is written', () => {
	assert.deepEqual(decide('', []), { kind: 'confirm-empty' });
});

test('a created file that is still empty after settling gets the skeleton', () => {
	assert.deepEqual(decide('', [], 'created', true), { kind: 'seed-empty' });
});

test('a created file that filled in while settling is judged on its content', () => {
	assert.deepEqual(decide(pipe(ID_A), [], 'created', true), { kind: 'leave', reason: 'id-ok' });
	assert.deepEqual(decide(pipe(), [], 'created', true), { kind: 'assign-id' });
});

// --- own id: the "silently rewrites project_id" half of #2466 ---------------

test("a file's own cached id is not a duplicate", () => {
	const known = [
		{ filePath: FILE, projectId: ID_A },
		{ filePath: OTHER, projectId: ID_B },
	];
	assert.deepEqual(decide(pipe(ID_A), known, 'created'), { kind: 'leave', reason: 'id-ok' });
	assert.deepEqual(decide(pipe(ID_A), known, 'changed'), { kind: 'leave', reason: 'id-ok' });
});

test('the same file under an unnormalised path is still itself', () => {
	const known = [{ filePath: '/ws/pipelines/../pipelines/a.pipe', projectId: ID_A }];
	assert.deepEqual(decide(pipe(ID_A), known), { kind: 'leave', reason: 'id-ok' });
});

// --- genuine duplicate -------------------------------------------------------

test('a genuine duplicate is not rewritten silently: the user is asked', () => {
	const known = [{ filePath: OTHER, projectId: ID_A }];
	assert.deepEqual(decide(pipe(ID_A), known, 'created'), { kind: 'ask-duplicate', projectId: ID_A, otherPaths: [OTHER] });
	assert.deepEqual(decide(pipe(ID_A), known, 'changed'), { kind: 'ask-duplicate', projectId: ID_A, otherPaths: [OTHER] });
});

// --- shared id: the restart guard (#2825) ---------------------------------------

test('otherFilesWithProjectId names the other files carrying the id, never the file itself', () => {
	const known = [
		{ filePath: '/ws/pipelines/../pipelines/a.pipe', projectId: ID_A }, // this file, unnormalised
		{ filePath: OTHER, projectId: ID_B },
	];
	assert.deepEqual(otherFilesWithProjectId(FILE, ID_A, known), []);
	assert.deepEqual(otherFilesWithProjectId(FILE, ID_B, known), [OTHER]);
});

test('every cached twin is returned, in cache order, so a stale first entry cannot hide a genuine later one', () => {
	const known = [
		{ filePath: '/ws/pipelines/old-name.pipe', projectId: ID_A }, // previous path, still cached after a rename
		{ filePath: OTHER, projectId: ID_A },
		{ filePath: '/ws/c.pipe', projectId: ID_B },
		{ filePath: '/ws/d.pipe', projectId: ID_A },
	];
	assert.deepEqual(otherFilesWithProjectId(FILE, ID_A, known), ['/ws/pipelines/old-name.pipe', OTHER, '/ws/d.pipe']);
});

test('case-only aliases are excluded on Windows and left for disk identity checks elsewhere', () => {
	const alias = '/ws/pipelines/A.pipe';
	assert.deepEqual(otherFilesWithProjectId(FILE, ID_A, [{ filePath: alias, projectId: ID_A }]), path.sep === '\\' ? [] : [alias]);
});

test('a file without a usable id has no twin, whatever the cache holds', () => {
	const known = [
		{ filePath: OTHER, projectId: undefined },
		{ filePath: '/ws/c.pipe', projectId: '' },
	];
	assert.deepEqual(otherFilesWithProjectId(FILE, undefined, known), []);
	assert.deepEqual(otherFilesWithProjectId(FILE, '', known), []);
	assert.deepEqual(otherFilesWithProjectId(FILE, '  ', known), []);
});

test('an id the parser passed through as a number or null is not a twin and does not throw', () => {
	// pipelineParser copies project_id without a type check, so the string
	// type is not enforced at runtime; the change handler must not reject on it.
	const known = [{ filePath: OTHER, projectId: 5 as unknown as string }];
	assert.deepEqual(otherFilesWithProjectId(FILE, 5 as unknown as string, known), []);
	assert.deepEqual(otherFilesWithProjectId(FILE, null as unknown as string, known), []);
});

test('the restart guard and the duplicate warning agree on which file is the twin', () => {
	// A save of a file that shares its id must not restart the other file's
	// task, and the warning names that same file: one definition for both.
	const known = [
		{ filePath: OTHER, projectId: ID_A },
		{ filePath: '/ws/c.pipe', projectId: ID_A },
	];
	const decision = decide(pipe(ID_A), known, 'changed');
	assert.equal(decision.kind, 'ask-duplicate');
	assert.deepEqual(decision.kind === 'ask-duplicate' ? decision.otherPaths : [], [OTHER, '/ws/c.pipe']);
	assert.deepEqual(otherFilesWithProjectId(FILE, ID_A, known), decision.kind === 'ask-duplicate' ? decision.otherPaths : []);
});

// --- firstDuplicate: which cached candidate is the twin ------------------------

const STALE = '/ws/pipelines/old-name.pipe'; // a renamed file's previous path, still cached
const ALIAS = '/ws/pipelines/A.pipe'; // another spelling of this file on a case-insensitive volume
const THIRD = '/ws/c.pipe';

/** An on-disk check scripted per path; every path asked is recorded, in order. */
function scripted(results: Record<string, DuplicateCheck>) {
	const asked: string[] = [];
	const check = async (candidate: string): Promise<DuplicateCheck> => {
		asked.push(candidate);
		return results[candidate];
	};
	return { check, asked };
}

test('a stale first candidate does not hide the genuine duplicate behind it', async () => {
	const { check, asked } = scripted({ [STALE]: 'resolved', [OTHER]: 'duplicate' });
	const found = await firstDuplicate([STALE, OTHER], check);
	assert.equal(found.duplicate, OTHER);
	assert.equal(found.sameFile, undefined);
	assert.deepEqual(asked, [STALE, OTHER]);
});

test('a same-file first candidate is remembered and the genuine second one is the duplicate', async () => {
	const { check } = scripted({ [ALIAS]: 'same-file', [OTHER]: 'duplicate', [THIRD]: 'duplicate' });
	const found = await firstDuplicate([ALIAS, OTHER, THIRD], check);
	assert.equal(found.duplicate, OTHER);
	assert.equal(found.sameFile, ALIAS);
});

test('only same-file candidates: no duplicate, and the first same-file one is reported', async () => {
	const { check } = scripted({ [ALIAS]: 'same-file', '/ws/link.pipe': 'same-file' });
	const found = await firstDuplicate([ALIAS, '/ws/link.pipe'], check);
	assert.equal(found.duplicate, undefined);
	assert.equal(found.sameFile, ALIAS);
});

test('an unreadable first candidate is reported, and a genuine second one is still the duplicate', async () => {
	const { check } = scripted({ '/ws/held.pipe': 'unreadable', [OTHER]: 'duplicate' });
	const found = await firstDuplicate(['/ws/held.pipe', OTHER], check);
	assert.equal(found.duplicate, OTHER);
	assert.equal(found.unreadable, '/ws/held.pipe');
});

test('only unreadable candidates: no duplicate, and the first unreadable one is reported for the restart guard', async () => {
	const { check } = scripted({ '/ws/held.pipe': 'unreadable', '/ws/busy.pipe': 'unreadable', [STALE]: 'resolved' });
	const found = await firstDuplicate([STALE, '/ws/held.pipe', '/ws/busy.pipe'], check);
	assert.equal(found.duplicate, undefined);
	assert.equal(found.unreadable, '/ws/held.pipe');
	assert.equal(found.sameFile, undefined);
});

test('the search stops at the first duplicate, and resolved candidates alone report nothing', async () => {
	const { check, asked } = scripted({ [STALE]: 'resolved', [OTHER]: 'duplicate', [THIRD]: 'duplicate' });
	assert.equal((await firstDuplicate([STALE], check)).duplicate, undefined);
	assert.equal((await firstDuplicate([STALE, OTHER, THIRD], check)).duplicate, OTHER);
	assert.deepEqual(asked, [STALE, STALE, OTHER]); // the third candidate is never asked
	assert.equal((await firstDuplicate([], check)).duplicate, undefined);
});

// --- file identity: a case-only rename or a hard link is the file itself -------

test('sameFileIdentity matches one inode on one device and nothing else', () => {
	assert.equal(sameFileIdentity({ dev: 1n, ino: 42n }, { dev: 1n, ino: 42n }), true);
	assert.equal(sameFileIdentity({ dev: 1n, ino: 42n }, { dev: 2n, ino: 42n }), false);
	assert.equal(sameFileIdentity({ dev: 1n, ino: 42n }, { dev: 1n, ino: 43n }), false);
});

test('two NTFS file ids that differ only below double precision are still two files', () => {
	// A 64-bit file reference: reuse count 40 in the top 16 bits, record index
	// in the low 48. As doubles these two are equal; as bigints they are not.
	const reference = (sequence: bigint, index: bigint): bigint => (sequence << 48n) | index;
	const a = reference(40n, 100000n);
	const b = reference(40n, 100001n);
	assert.equal(Number(a) === Number(b), true, 'the test needs ids that collide as doubles');
	assert.equal(sameFileIdentity({ dev: 7n, ino: a }, { dev: 7n, ino: b }), false);
	assert.equal(sameFileIdentity({ dev: 7n, ino: a }, { dev: 7n, ino: a }), true);
});

test('an inode the file system does not report (0) never identifies a file', () => {
	assert.equal(sameFileIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n }), false);
	assert.equal(sameFileIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 42n }), false);
});

// --- missing id ----------------------------------------------------------------

test('a pipeline with no usable project_id still gets one', () => {
	const texts = [pipe(), JSON.stringify({ components: [], project_id: '' }), JSON.stringify({ components: [], project_id: '  ' }), JSON.stringify({ components: [], project_id: 42 })];
	for (const text of texts) {
		assert.deepEqual(decide(text, [], 'created'), { kind: 'assign-id' });
		assert.deepEqual(decide(text, [], 'changed'), { kind: 'assign-id' });
	}
});

test('the wrapped { pipeline: ... } shape is handled like the bare one', () => {
	const wrapped = JSON.stringify({ pipeline: { components: [], project_id: ID_A } });
	assert.deepEqual(decide(wrapped, [{ filePath: OTHER, projectId: ID_A }]), { kind: 'ask-duplicate', projectId: ID_A, otherPaths: [OTHER] });
	assert.deepEqual(decide(JSON.stringify({ pipeline: { components: [] } }), []), { kind: 'assign-id' });
});

// --- not a pipeline ------------------------------------------------------------

test('invalid JSON and non-pipeline JSON are left alone', () => {
	assert.deepEqual(decide('{ not json', []), { kind: 'leave', reason: 'invalid-json' });
	assert.deepEqual(decide('[]', []), { kind: 'leave', reason: 'not-a-pipeline' });
	assert.deepEqual(decide('{"name":"x"}', []), { kind: 'leave', reason: 'not-a-pipeline' });
	assert.deepEqual(decide('{"components":{}}', []), { kind: 'leave', reason: 'not-a-pipeline' });
});

// --- readPipeProjectId ---------------------------------------------------------

test('readPipeProjectId tells an id, no id, and not a pipeline apart', () => {
	assert.equal(readPipeProjectId(pipe(ID_A)), ID_A);
	assert.equal(readPipeProjectId(pipe()), null);
	assert.equal(readPipeProjectId('nope'), undefined);
});

// --- withProjectId: the write keeps the user's formatting ------------------

test("replacing an existing id keeps the file's formatting", () => {
	const compact = `{ "components": [ { "id": "chat_1" } ],\n  "project_id":   "${ID_A}", "version": 1 }\n`;
	const out = withProjectId(compact, ID_B);
	assert.equal(out, compact.replace(ID_A, ID_B));
	assert.equal(JSON.parse(out ?? '').project_id, ID_B);
});

test('adding a missing id re-serialises with the id present', () => {
	const out = withProjectId(pipe(), ID_B);
	assert.deepEqual(JSON.parse(out ?? ''), { components: [], project_id: ID_B });
});

test('a trailing newline survives a re-serialisation', () => {
	assert.ok(withProjectId(`${pipe()}\n`, ID_B)?.endsWith('}\n'));
	assert.ok(withProjectId(pipe(), ID_B)?.endsWith('}'));
});

test('a second project_id string in the file falls back to a full re-serialisation', () => {
	const text = JSON.stringify({ components: [{ config: { project_id: 'x' } }], project_id: ID_A });
	const out = JSON.parse(withProjectId(text, ID_B) ?? '');
	assert.equal(out.project_id, ID_B);
	assert.equal(out.components[0].config.project_id, 'x');
});

test('a lone project_id string that is not the target falls back as well', () => {
	// JSON allows the key to be escaped, so the parsed target id can exist
	// without a literal "project_id" in the text. The only literal match
	// here is the nested one; swapping it would change the wrong value.
	const text = `{"components":[{"config":{"project_id":"x"}}],"project\\u005fid":"${ID_A}"}`;
	assert.equal(readPipeProjectId(text), ID_A);
	const out = JSON.parse(withProjectId(text, ID_B) ?? '');
	assert.equal(out.project_id, ID_B);
	assert.equal(out.components[0].config.project_id, 'x');
});

test('a nested id matching an escaped pipeline id is not replaced', () => {
	const bare = `{"components":[{"config":{"project_id":"${ID_A}"}}],"project\\u005fid":"${ID_A}"}`;
	for (const text of [bare, `{"pipeline":${bare}}`]) {
		const root = JSON.parse(withProjectId(text, ID_B) ?? '');
		const pipeline = root.pipeline ?? root;
		assert.equal(pipeline.project_id, ID_B);
		assert.equal(pipeline.components[0].config.project_id, ID_A);
	}
});

test('the wrapped shape gets its id on the inner pipeline object', () => {
	const out = JSON.parse(withProjectId(JSON.stringify({ pipeline: { components: [] } }), ID_B) ?? '');
	assert.equal(out.pipeline.project_id, ID_B);
	assert.equal(out.project_id, undefined);
});

test('withProjectId refuses text that is not a pipeline', () => {
	assert.equal(withProjectId('{ nope', ID_B), undefined);
	assert.equal(withProjectId('{"name":"x"}', ID_B), undefined);
});

test('the skeleton is a valid empty pipeline carrying the id', () => {
	assert.deepEqual(JSON.parse(emptyPipelineSkeleton(ID_A)), { project_id: ID_A, components: [] });
});
