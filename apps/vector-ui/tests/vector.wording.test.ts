// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORDING: every code and every caveat has a sentence; refusals say which one it was
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { CAVEATS, TOOL_CODES } from '../src/contract/types';
import { BUSY, CANCELLED_TEXT, CAVEAT_SENTENCES, CODE_SENTENCES, EMPTY, GENERIC_REFUSAL, WRITE_TIMEOUT_TEXT, caveatSentence, codeSentence, failureText } from '../src/vector/wording';
import { fixture } from './support/fixtures';

test('every documented code has a sentence, and every documented caveat has one', () => {
	for (const code of TOOL_CODES) {
		const sentence = CODE_SENTENCES[code];
		assert.ok(typeof sentence === 'string' && sentence.length > 10, `${code} has a sentence`);
		assert.match(sentence, /[.!?]$/, `${code}: a full sentence`);
	}
	for (const caveat of CAVEATS) {
		const sentence = CAVEAT_SENTENCES[caveat];
		assert.ok(typeof sentence === 'string' && sentence.length > 10, `${caveat} has a sentence`);
		assert.match(sentence, /[.!?]$/, `${caveat}: a full sentence`);
	}
	assert.deepEqual(Object.keys(CODE_SENTENCES).sort(), [...TOOL_CODES].sort(), 'no sentence for a code that does not exist');
	assert.deepEqual(Object.keys(CAVEAT_SENTENCES).sort(), [...CAVEATS].sort());
});

test("the app knows exactly the codes the store nodes document (the errors fixture, pinned to vx_types by the nodes' tests)", () => {
	assert.deepEqual(Object.keys(fixture('errors')).sort(), [...TOOL_CODES].sort());
});

test('agents have no write switch of their own: allow_write, the outer gate, alone decides, so no code says agents are refused', () => {
	assert.equal((TOOL_CODES as readonly string[]).includes('WRITES_AGENT'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(CODE_SENTENCES, 'WRITES_AGENT'), false);
	assert.equal(codeSentence('WRITES_AGENT'), GENERIC_REFUSAL, 'a code no node sends reads as the generic refusal');
});

test('the write refusals say exactly which rule refused', () => {
	assert.equal(codeSentence('WRITES_DISABLED'), 'Removing documents is turned off on this store node (allow_writes).');
	assert.equal(codeSentence('WRITES_SOURCE'), 'Only a Tools source may remove documents.');
	assert.equal(codeSentence('WRITES_UNKNOWN_CALLER'), 'The engine did not identify this request, so the store refused the write. Update the engine to a version that supports the Vector Explorer.');
	assert.equal(codeSentence('RESERVED_ID'), "That record is the collection's control record and cannot be removed.");
	for (const code of ['WRITES_PUBLIC', 'WRITES_BROADCAST', 'READS_PUBLIC', 'SOMETHING_NEW', undefined]) {
		assert.equal(codeSentence(code), GENERIC_REFUSAL, String(code));
	}
	assert.equal(GENERIC_REFUSAL, "The store refused this request; see the pipeline's run log.");
});

test('the caveat sentences the console shows', () => {
	assert.equal(caveatSentence('brute_force_search'), 'This store searches by brute force (exact); large collections answer slowly.');
	assert.equal(caveatSentence('score_scale_raw'), "Scores are the backend's raw values, not 0–1.");
	assert.equal(caveatSentence('extras_not_stored'), 'This backend does not keep file size or ingest time.');
	assert.equal(caveatSentence('cloud_only_unverified'), 'This backend was not run against a live server in this build.');
	assert.equal(caveatSentence('documents_by_first_chunk'), 'Documents are counted by their first chunk on this store.');
	assert.equal(caveatSentence('document_count_capped'), 'Orphan counts above 1,000 are not exact on this store.');
	assert.equal(caveatSentence('documents_unsorted'), 'This store lists documents in storage order; the directory sorts what is loaded.');
	assert.equal(caveatSentence('documents_paging_unsupported'), 'This store cannot page its document list; only the first page is shown.');
	assert.equal(caveatSentence('model_mismatch'), 'The chat embedding model differs from the one this collection was built with; results may be meaningless.');
	assert.equal(caveatSentence('meta_column_pending'), 'File size and ingest time are not stored yet: another session holds this table; the store will retry.');
	assert.equal(caveatSentence('filtered_search_may_underfill'), 'A search limited to some documents may return fewer results than asked: this pgvector is older than 0.8.');
	assert.equal(caveatSentence('a_caveat_from_a_newer_node'), null, 'an unknown caveat is not invented a sentence');
});

test('a refused write reads as its sentence, not as the raw envelope', () => {
	for (const name of ['delete_writes_disabled', 'delete_writes_source', 'delete_unknown_caller', 'delete_reserved_id']) {
		const envelope = fixture(name);
		const error = new ExplorerToolError({ kind: 'store', tool: 'delete', message: envelope.error, code: envelope.code });
		const text = failureText(error, { write: true });
		assert.ok(text, name);
		assert.equal(text.headline, codeSentence(envelope.code), name);
		assert.equal(text.detail, undefined, `${name}: the sentence is the whole message`);
	}
});

test("a read failure leads with the sentence and keeps the node's own words as detail", () => {
	const errors = fixture('errors');
	const error = new ExplorerToolError({ kind: 'store', tool: 'stats', message: errors.STORE_ERROR.error, code: 'STORE_ERROR' });
	assert.deepEqual(failureText(error), { headline: CODE_SENTENCES.STORE_ERROR, detail: 'OperationalError: the store did not answer' });
	const limited = new ExplorerToolError({ kind: 'store', tool: 'embed', message: errors.RATE_LIMITED.error, code: 'RATE_LIMITED' });
	assert.match(failureText(limited)!.headline, /^Too many/);
});

test('a write the app stopped waiting for may still complete; a read timeout says it stopped waiting; a dropped result says nothing', () => {
	const timeout = new ExplorerToolError({ kind: 'timeout', tool: 'delete', message: 'Stopped waiting for delete after 40 s. The node may still be running it; there is no way to cancel it from here.' });
	assert.deepEqual(failureText(timeout, { write: true }), { headline: WRITE_TIMEOUT_TEXT });
	assert.equal(WRITE_TIMEOUT_TEXT, 'The request may still complete on the server. Refresh to check.');
	const readTimeout = new ExplorerToolError({ kind: 'timeout', tool: 'stats', message: 'Stopped waiting for stats after 40 s. The node may still be running it; there is no way to cancel it from here.' });
	assert.match(failureText(readTimeout)!.headline, /^Stopped waiting for stats/);
	assert.equal(failureText(new ExplorerToolError({ kind: 'stale', tool: 'stats', message: 'dropped' })), null);
});

test('no running task, an old node and a restarting pipeline each say what to do', () => {
	const missing = failureText(new ExplorerToolError({ kind: 'unavailable', tool: 'stats', message: "No running task for pipeline 'Vector docs'. Start the pipeline and retry." }));
	assert.match(missing!.headline, /Start the pipeline/);
	const upgrade = failureText(new ExplorerToolError({ kind: 'upgrade', tool: 'documents', message: 'This node cannot run documents: it does not advertise "documents".' }));
	assert.match(upgrade!.headline, /Update the pipeline's store node/);
	const stopped = failureText(new ExplorerToolError({ kind: 'raised', tool: 'stats', message: 'Task is not running', code: 'TASK_STOPPED' }));
	assert.match(stopped!.headline, /not running \(it may be restarting\)/);
	const other = failureText(new Error('socket closed\nmore'));
	assert.deepEqual(other, { headline: 'socket closed', detail: 'more' });
});

test('busy labels and the cancel sentence', () => {
	assert.deepEqual(BUSY, { refreshing: 'Refreshing…', sampling: 'Sampling…', embedding: 'Embedding…', removing: 'Removing…', restoring: 'Restoring…', listingTrash: 'Listing the trash…', uploading: 'Uploading…', layingOut: 'Laying out…', loadingDocuments: 'Loading documents…' });
	assert.equal(CANCELLED_TEXT, 'Cancelled. Nothing was sent.');
	assert.equal(EMPTY.trash, 'The trash is empty.');
});
