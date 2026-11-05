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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// chatResult — what the Chat source answers, turned into text and citations
// =============================================================================
//
// The chat lane answers with `result_types` naming its fields: `answers` from
// the LLM and, through the pipeline's response_documents node, `documents`
// (the chunks the store retrieved). The console shows the answer and cites
// those chunks; it never invents a source the answer did not carry.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer';
import { CHAT_MAX_CHARS, CHAT_TIMEOUT_MS, CHAT_TIMEOUT_SENTENCE, STUB_PREFIX, chatErrorSentence, parseChatResult, summariseSources, validateQuestion } from '../src/vector/chatResult';

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON.
 */
function fixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', name), 'utf8')) as Record<string, unknown>;
}

test('chatResult: an answer with documents yields the text and ranked citations', () => {
	const parsed = parseChatResult(fixture('chat_result_with_documents.json'));
	assert.equal(parsed.empty, false);
	assert.match(parsed.text, /^\[STUB-LLM\] deterministic answer\./);
	assert.equal(parsed.stub, true);
	assert.equal(parsed.hasDocumentsLane, true);
	assert.deepEqual(
		parsed.sources.map((source) => [source.rank, source.objectId, source.chunkId, source.path, source.score]),
		[
			[1, '75b89d86-a64e-5143-bf50-55d4a7fd8cd2', 0, 'C:/demo/handbooks/falcon_handbook.md', 0.5757919640293089],
			[2, '75b89d86-a64e-5143-bf50-55d4a7fd8cd2', 4, 'C:/demo/handbooks/falcon_handbook.md', 0.4107],
			[3, '91ae15d4-3f6e-589f-bb81-72301f2ca1b6', 1, 'C:/demo/field/kestrel_field_guide.md', 0.3121],
		]
	);
	assert.deepEqual(parsed.sources[0].key, ['75b89d86-a64e-5143-bf50-55d4a7fd8cd2', 0]);
	assert.match(parsed.sources[0].text, /Glassbrook spring/);
});

test('chatResult: an answer without a documents lane has no citations and says so', () => {
	const parsed = parseChatResult(fixture('chat_result_no_documents.json'));
	assert.equal(parsed.hasDocumentsLane, false);
	assert.deepEqual(parsed.sources, []);
	assert.match(parsed.text, /^\[STUB-LLM\]/);
});

test('chatResult: fields are found through result_types, whatever they are named', () => {
	const parsed = parseChatResult({
		result_types: { reply: 'answers', cited: 'documents' },
		reply: ['First part.', 'Second part.'],
		cited: [{ page_content: 'x', score: 0.4, metadata: { objectId: 'abc', chunkId: 2, parent: 'a/b.md' } }],
	});
	assert.equal(parsed.text, 'First part.\n\nSecond part.');
	assert.equal(parsed.stub, false);
	assert.equal(parsed.sources.length, 1);
	assert.equal(parsed.sources[0].path, 'a/b.md');
});

test('chatResult: without result_types the answers and documents keys are read', () => {
	const parsed = parseChatResult({ answers: 'Plain answer', documents: [{ page_content: 'y', metadata: { objectId: 'o1', chunkId: 0 } }] });
	assert.equal(parsed.text, 'Plain answer');
	assert.equal(parsed.sources.length, 1);
	assert.equal(parsed.sources[0].score, null);
	assert.equal(parsed.sources[0].path, '');
});

test('chatResult: a JSON answer is shown as a JSON code block', () => {
	const parsed = parseChatResult({ result_types: { answers: 'answers' }, answers: [{ total: 3, items: ['a'] }] });
	assert.equal(parsed.text, '```json\n{\n  "total": 3,\n  "items": [\n    "a"\n  ]\n}\n```');
});

test('chatResult: unusable citations are dropped, duplicates kept once, the control record never cited', () => {
	const parsed = parseChatResult({
		result_types: { answers: 'answers', documents: 'documents' },
		answers: ['ok'],
		documents: [{ page_content: 'a', score: 0.9, metadata: { objectId: 'o1', chunkId: 0 } }, { page_content: 'dup', score: 0.8, metadata: { objectId: 'o1', chunkId: 0 } }, { page_content: 'no id', metadata: { chunkId: 1 } }, { page_content: 'control', metadata: { objectId: 'schema', chunkId: 0 } }, { page_content: 'bad chunk', metadata: { objectId: 'o2', chunkId: -1 } }, { page_content: 'string chunk', score: '0.5', metadata: { objectId: 'o3', chunkId: '7' } }, 'not an object', null],
	});
	assert.deepEqual(
		parsed.sources.map((source) => [source.rank, source.objectId, source.chunkId, source.score]),
		[
			[1, 'o1', 0, 0.9],
			[2, 'o3', 7, null],
		]
	);
});

test('chatResult: an empty or malformed answer is reported as empty, never thrown', () => {
	for (const wire of [null, undefined, 'text', 42, [], {}, { result_types: { answers: 'answers' }, answers: [] }, { answers: [''] }]) {
		const parsed = parseChatResult(wire);
		assert.equal(parsed.empty, true, JSON.stringify(wire));
		assert.equal(parsed.text, '');
		assert.deepEqual(parsed.sources, []);
	}
});

test('summariseSources: count and top score in the header line', () => {
	const parsed = parseChatResult(fixture('chat_result_with_documents.json'));
	assert.equal(summariseSources(parsed.sources).line, '3 sources · 0.58 top');
	assert.equal(summariseSources(parsed.sources.slice(0, 1)).line, '1 source · 0.58 top');
	assert.equal(summariseSources([]).line, 'No sources returned');
	const unscored = parseChatResult({ documents: [{ page_content: 'x', metadata: { objectId: 'o', chunkId: 0 } }] });
	assert.equal(summariseSources(unscored.sources).line, '1 source');
});

test('validateQuestion: trims, refuses empty and over-long questions', () => {
	assert.deepEqual(validateQuestion('  Where is the water?  '), { ok: true, text: 'Where is the water?' });
	assert.deepEqual(validateQuestion('   '), { ok: false, reason: 'Type a question first.' });
	assert.equal(CHAT_MAX_CHARS, 4000);
	const long = validateQuestion('x'.repeat(4001));
	assert.equal(long.ok, false);
	assert.match((long as { reason: string }).reason, /4,000 characters/);
	assert.equal(validateQuestion('x'.repeat(4000)).ok, true);
});

test('chatErrorSentence: timeouts, missing sources and failures read as plain sentences', () => {
	assert.equal(CHAT_TIMEOUT_MS, 120_000);
	assert.equal(CHAT_TIMEOUT_SENTENCE, 'Stopped waiting after 120 s. The pipeline may still be answering; there is no way to cancel it from here.');
	assert.deepEqual(chatErrorSentence(new ExplorerToolError({ kind: 'timeout', tool: 'chat', message: 'anything' })), { kind: 'timeout', message: CHAT_TIMEOUT_SENTENCE });
	assert.equal(chatErrorSentence(new ExplorerToolError({ kind: 'stale', tool: 'chat', message: 'dropped' })).kind, 'stale');
	const unavailable = chatErrorSentence(new ExplorerToolError({ kind: 'unavailable', tool: 'chat', message: "No running chat source for pipeline 'Vector demo'. Start it and retry." }));
	assert.equal(unavailable.kind, 'unavailable');
	assert.equal(unavailable.message, 'This pipeline has no running Chat source.');
	assert.match(unavailable.detail ?? '', /No running chat source/);
	const raised = chatErrorSentence(new ExplorerToolError({ kind: 'raised', tool: 'chat', message: 'LLM call failed\nHTTP 401 from the provider' }));
	assert.deepEqual(raised, { kind: 'error', message: 'The question failed: LLM call failed', detail: 'HTTP 401 from the provider' });
	assert.deepEqual(chatErrorSentence(new Error('socket closed')), { kind: 'error', message: 'The question failed: socket closed' });
	assert.deepEqual(chatErrorSentence('weird'), { kind: 'error', message: 'The question failed: weird' });
});

test('STUB_PREFIX: matches what the local stub LLM prefixes', () => {
	assert.equal(STUB_PREFIX, '[STUB-LLM]');
	assert.equal(parseChatResult({ answers: ['  [STUB-LLM] x'] }).stub, true);
	assert.equal(parseChatResult({ answers: ['A real answer mentioning [STUB-LLM] later'] }).stub, false);
});
