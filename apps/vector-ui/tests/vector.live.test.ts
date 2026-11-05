// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LIVE CAPTURES: the app reads every answer the live drivers gave
// =============================================================================
//
// tests/fixtures/v1/live/<backend>/ holds real tool answers captured from the
// shipped templates in an engine against the live test databases, on a new
// collection and on a legacy-shaped one (nodes/test/vector_wire_fixtures.py;
// test_vector_wire_fixtures_full.py fails when they no longer match the
// tools). The other suites run on the hand-written provisional fixtures; this
// one runs the app's readers over the captures, so a field a driver really
// sends differently fails here.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { CAVEATS, TOOL_CODES } from '../src/contract/types';
import { readChunksPage, readDeleteResult, readDialect, readDocumentsPage, readStats, readTrashResult, unwrapEnvelope } from '../src/vector/results';
import { CODE_SENTENCES, caveatSentence, codeSentence, failureText, GENERIC_REFUSAL } from '../src/vector/wording';

const LIVE = path.resolve(__dirname, 'fixtures', 'v1', 'live');
/** The supported backends, by the folder their captures are in. */
const BACKENDS = ['pgvector', 'rocketride_vector', 'qdrant', 'chroma'];
/** The two collections every capture is taken on: '' (new) and '.legacy'. */
const KINDS = ['', '.legacy'];
/** Captures taken on the new collection at least (the legacy one is read too when it was captured). */
const TRASH_CAPTURES = ['soft_delete', 'restore', 'delete.deleted_only', 'chunks.in_trash'];

/** The kinds a capture exists in: always the new collection; the legacy one when it was captured. */
function kindsOf(backend: string, base: string): string[] {
	const present = new Set(names(backend));
	return KINDS.filter((kind) => kind === '' || present.has(`${base}${kind}`));
}

type Answer = Record<string, any>;

/** One capture, parsed. */
function capture(backend: string, name: string): Answer {
	return JSON.parse(fs.readFileSync(path.join(LIVE, backend, `${name}.json`), 'utf8')) as Answer;
}

/** The capture names of a backend, without `.json`. */
function names(backend: string): string[] {
	return fs
		.readdirSync(path.join(LIVE, backend))
		.filter((file) => file.endsWith('.json'))
		.map((file) => file.slice(0, -'.json'.length))
		.sort();
}

/** The error unwrapEnvelope throws for a failure envelope. */
function refusal(tool: string, answer: Answer): ExplorerToolError {
	try {
		unwrapEnvelope(tool, answer);
	} catch (error) {
		assert.ok(error instanceof ExplorerToolError, `an ExplorerToolError, got ${String(error)}`);
		return error;
	}
	assert.fail(`${tool}: a failure envelope was read as a success`);
}

test('every supported backend has the captures the readers below use, on a new and a legacy collection', () => {
	for (const backend of BACKENDS) {
		const present = new Set(names(backend));
		for (const base of ['dialect', 'stats', 'stats.quick', 'list_documents', 'chunks', 'delete', 'sample', 'search']) {
			for (const kind of KINDS) assert.ok(present.has(`${base}${kind}`), `${backend}/${base}${kind}.json is captured`);
		}
		for (const base of TRASH_CAPTURES) assert.ok(present.has(base), `${backend}/${base}.json is captured`);
		for (const old of ['documents', 'remove_document']) assert.ok(![...present].some((name) => name === old || name.startsWith(`${old}.`)), `${backend}: no capture of the retired tool ${old}`);
	}
});

test('dialect: every capture reads as a vector store of its backend, and every caveat it names has a sentence', () => {
	for (const backend of BACKENDS) {
		for (const kind of KINDS) {
			const dialect = readDialect(unwrapEnvelope('dialect', capture(backend, `dialect${kind}`)));
			assert.ok(dialect, `${backend}${kind}: read as a vector store`);
			assert.equal(dialect.backend, backend === 'rocketride_vector' ? 'pgvector' : backend);
			assert.equal(dialect.dimension, 384);
			for (const caveat of dialect.caveats) {
				assert.ok((CAVEATS as readonly string[]).includes(caveat), `${backend}${kind}: caveat ${caveat} is in the contract`);
				assert.ok(caveatSentence(caveat), `${backend}${kind}: caveat ${caveat} has a sentence`);
			}
		}
	}
});

test('stats: full and quick read with figures, and the legacy collection counts its document without a first chunk', () => {
	for (const backend of BACKENDS) {
		for (const kind of KINDS) {
			for (const mode of ['stats', 'stats.quick']) {
				const stats = readStats(unwrapEnvelope('stats', capture(backend, `${mode}${kind}`)));
				assert.equal(stats.legacyOnly, false, `${backend}/${mode}${kind}: the extended answer`);
				assert.equal(stats.collectionExists, true);
				assert.ok((stats.chunks ?? 0) > 0, `${backend}/${mode}${kind}: chunks counted`);
				assert.equal(stats.dimension, 384);
				assert.equal(stats.metric, 'cosine');
				assert.ok('deleted_documents' in capture(backend, `${mode}${kind}`), `${backend}/${mode}${kind}: the Trash count is answered (a count or null)`);
				for (const caveat of stats.caveats) assert.ok(caveatSentence(caveat), `${backend}/${mode}${kind}: caveat ${caveat} has a sentence`);
			}
			const full = readStats(capture(backend, `stats${kind}`));
			if (kind === '.legacy' && full.withoutFirstChunk !== null) assert.equal(full.withoutFirstChunk, 1, `${backend}: the planted orphan`);
		}
	}
});

test('list_documents: every row of a first page reads, and a document without its first chunk appears only on the legacy collection', () => {
	for (const backend of BACKENDS) {
		for (const kind of KINDS) {
			const raw = capture(backend, `list_documents${kind}`);
			const page = readDocumentsPage(unwrapEnvelope('list_documents', raw));
			assert.equal(page.items.length, raw.items.length, `${backend}${kind}: no row dropped`);
			assert.ok(
				page.items.every((item) => item.objectId && item.path.startsWith('C:/demo/')),
				`${backend}${kind}: ids and paths`
			);
			// The captures hold a first page; an unsorted store lists its orphan at the end of the listing.
			const orphans = page.items.filter((item) => !item.has_first_chunk).length;
			if (kind === '') assert.equal(orphans, 0, `${backend}: a new collection has no document without its first chunk`);
			else assert.ok(orphans <= 1, `${backend}${kind}: at most the planted orphan`);
			if (kind === '.legacy' && page.sorted) assert.equal(orphans, 1, `${backend}${kind}: a sorted first page lists the planted orphan`);
		}
	}
});

test('chunks: pages read in chunk order and never carry a vector', () => {
	for (const backend of BACKENDS) {
		for (const kind of KINDS) {
			const page = readChunksPage(unwrapEnvelope('chunks', capture(backend, `chunks${kind}`)));
			assert.ok(page.items.length > 0, `${backend}${kind}: a page`);
			const ids = page.items.map((item) => item.chunkId);
			assert.deepEqual(
				ids,
				[...ids].sort((a, b) => a - b)
			);
			for (const item of page.items) {
				assert.ok(!('vector' in item.metadata) && !('embedding' in item.metadata), `${backend}${kind}: no vector in metadata`);
			}
		}
	}
});

test('delete: the documents of the batch are removed, not found, or (deleted_only) kept live, as the node reported', () => {
	for (const backend of BACKENDS) {
		for (const [base, kinds] of [
			['delete', KINDS],
			['delete.deleted_only', kindsOf(backend, 'delete.deleted_only')],
		] as const) {
			for (const kind of kinds) {
				const raw = capture(backend, `${base}${kind}`);
				const sent: string[] = raw.audit.object_ids;
				const view = readDeleteResult(unwrapEnvelope('delete', raw), sent);
				assert.equal(view.removedChunks, raw.removed_chunks ?? null, `${backend}/${base}${kind}`);
				assert.deepEqual([...view.removed.map((r) => r.objectId), ...view.notFound, ...view.keptLive].sort(), [...new Set(sent)].sort(), `${backend}/${base}${kind}: every id is accounted for once`);
				assert.equal(raw.audit.action, 'vector.delete');
				if (base === 'delete') assert.deepEqual(view.keptLive, [], `${backend}${kind}: without deleted_only nothing is kept`);
				else assert.ok(view.keptLive.length > 0, `${backend}/${base}${kind}: the partly trashed document is kept`);
			}
		}
	}
});

test('soft_delete and restore: the documents moved into and out of the trash, and the chunks they moved', () => {
	for (const backend of BACKENDS) {
		for (const tool of ['soft_delete', 'restore']) {
			for (const kind of kindsOf(backend, tool)) {
				const raw = capture(backend, `${tool}${kind}`);
				const view = readTrashResult(unwrapEnvelope(tool, raw));
				assert.ok(view.moved.length > 0, `${backend}/${tool}${kind}: a document moved`);
				assert.ok(view.movedChunks === null || view.movedChunks > 0, `${backend}/${tool}${kind}: its chunks, or null where the store cannot count`);
				assert.equal(raw.audit.action, `vector.${tool}`);
			}
		}
	}
});

test('chunks of a document in the trash: IN_TRASH, with its own sentence', () => {
	for (const backend of BACKENDS) {
		for (const kind of kindsOf(backend, 'chunks.in_trash')) {
			const error = refusal('chunks', capture(backend, `chunks.in_trash${kind}`));
			assert.equal(error.code, 'IN_TRASH', `${backend}${kind}`);
			assert.equal(failureText(error)?.headline, CODE_SENTENCES.IN_TRASH);
		}
	}
});

test('refusals: every captured failure is a store error that keeps its documented code and has its own sentence', () => {
	let seen = 0;
	for (const backend of BACKENDS) {
		for (const name of names(backend)) {
			const answer = capture(backend, name);
			if (answer.success !== false) continue;
			seen += 1;
			const tool = name.split('.')[0];
			const error = refusal(tool, answer);
			assert.equal(error.kind, 'store', `${backend}/${name}`);
			assert.ok((TOOL_CODES as readonly string[]).includes(error.code ?? ''), `${backend}/${name}: ${error.code} is a contract code`);
			assert.notEqual(codeSentence(error.code), GENERIC_REFUSAL, `${backend}/${name}: ${error.code} has its own sentence`);
			const casePart = name.split('.')[1];
			if (casePart && casePart !== 'legacy') assert.equal(error.code, casePart.toUpperCase(), `${backend}/${name}: the capture is for ${casePart}`);
		}
	}
	assert.ok(seen >= BACKENDS.length * 4, `refusal captures were read (${seen})`);
});
