// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LIVE TOOL-PATH FIXTURES: what the real nodes answered on Neo4j 5.26, FalkorDB
// 6.0.1 and Apache AGE 1.5.0, read by the app's own parsers
// =============================================================================
//
// tests/fixtures/v1/live/ holds answers captured from the node tools running on real
// drivers against disposable databases (see its README). These tests prove the app's
// readers accept exactly what the nodes send: dialect, schema (v2 block and the stale
// case), error strings, and the read_query envelopes for graphs, paths, a big AGE id,
// bytes and a truncated result.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describeFailure } from '../src/graph/failures';
import type { IFailureInput } from '../src/graph/failures';
import { canWrite, engineText, parseDialect, readBoundaryText, rowLimitFor, supportsReadQuery, supportsRefresh, targetText } from '../src/graph/dialect';
import { expandNode, modelFromResult } from '../src/graph/model';
import { chooseTab, collectEntities, summarizeResult } from '../src/graph/results';
import { parseSchema, schemaStatusText } from '../src/graph/schema';
import { buildSchemaTree } from '../src/graph/schemaTree';
import { truncationText } from '../src/graph/wording';
import { isGraphBytes } from '../src/graph/values';
import type { ReadQueryResult } from '../src/graph/types';

const ENGINES = ['neo4j', 'falkordb', 'age'] as const;

/** Read one live fixture. */
function live<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'v1', 'live', `${name}.json`), 'utf8')) as T;
}

/** A failure input the way the shared session builds it from the node's verbatim message. */
function failure(message: string, tool = 'read_query'): IFailureInput {
	const at = message.indexOf('\n');
	return { kind: 'raised', tool, message, headline: at === -1 ? message : message.slice(0, at), ...(at === -1 ? {} : { detail: message.slice(at + 1) }) };
}

// -----------------------------------------------------------------------------
// dialect
// -----------------------------------------------------------------------------

test('every live dialect answer is a supported, browsable, read-only node with its own limits', () => {
	for (const engine of ENGINES) {
		const dialect = parseDialect(live(`${engine}_dialect`));
		assert.ok(dialect, engine);
		assert.equal(dialect.dialect, engine);
		assert.equal(supportsReadQuery(dialect), true, engine);
		assert.equal(supportsRefresh(dialect), true, engine);
		assert.equal(dialect.allowExecute, false);
		assert.equal(canWrite(dialect), false, 'allow_execute is off, so there is no write console');
		assert.equal(dialect.readBoundaryVerified, false);
		assert.equal(rowLimitFor(null, dialect), dialect.limits.maxRows, '"All" is the node\'s cap');
		assert.ok(rowLimitFor(1_000_000, dialect) <= dialect.limits.maxRows, 'nothing above the cap is ever sent');
		assert.ok(readBoundaryText(dialect).length > 0);
	}
});

test('engine, edition and target read the way each engine reports them', () => {
	assert.equal(engineText(parseDialect(live('neo4j_dialect'))!), 'Neo4j 5.26.31 Community');
	assert.equal(targetText(parseDialect(live('neo4j_dialect'))!), 'database neo4j');
	assert.equal(engineText(parseDialect(live('age_dialect'))!), 'Apache AGE 1.5.0');
	assert.match(targetText(parseDialect(live('age_dialect'))!) ?? '', /^graph rr_graph_e2e_/);
	assert.equal(engineText(parseDialect(live('falkordb_dialect'))!), 'FalkorDB 6.0.1');
	assert.match(targetText(parseDialect(live('falkordb_dialect'))!) ?? '', /^graph gx_live_/);
});

test('limits differ by engine: FalkorDB is capped below the others and reports the server cap', () => {
	const [neo, falkor, age] = (['neo4j', 'falkordb', 'age'] as const).map((e) => parseDialect(live(`${e}_dialect`))!);
	assert.equal(neo.limits.maxRows, 25000);
	assert.equal(falkor.limits.maxRows, 250);
	assert.equal(falkor.limits.serverResultCap, 10000);
	assert.equal(age.limits.maxRows, 1000);
	assert.equal(age.limits.statementTimeoutMs, 30000);
	assert.equal(rowLimitFor(1000, falkor), 250, 'a larger choice is cut to the node\'s cap, not sent and truncated');
});

// -----------------------------------------------------------------------------
// schema
// -----------------------------------------------------------------------------

test('every live get_schema answer is a fresh v2 snapshot with the common type vocabulary', () => {
	const vocabulary = new Set(['string', 'integer', 'float', 'boolean', 'list', 'map', 'temporal', 'point', 'unknown']);
	for (const engine of ENGINES) {
		const view = parseSchema(live(`${engine}_get_schema`));
		assert.equal(view.evidence, 'fresh', engine);
		assert.equal(view.legacy, false);
		assert.ok(view.labels.length > 0 && view.relationshipTypes.length > 0, engine);
		assert.ok(view.sampled);
		assert.match(view.refreshedAt ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'ISO with milliseconds and Z');
		for (const label of view.labels) for (const p of label.properties) for (const t of p.types) assert.ok(vocabulary.has(t), `${engine}: ${label.name}.${p.name} has type ${t}`);
		assert.match(schemaStatusText(view, Date.parse(view.refreshedAt!) + 5000), /^Schema refreshed just now\.$/);
	}
});

test('counts: exact on FalkorDB and Neo4j, absent on AGE before ANALYZE', () => {
	const falkor = parseSchema(live('falkordb_get_schema'));
	assert.equal(falkor.labels.find((l) => l.name === 'Company')?.count, 1);
	assert.equal(falkor.labels.find((l) => l.name === 'Company')?.countEstimated, false);
	const age = parseSchema(live('age_get_schema'));
	assert.ok(age.labels.every((l) => l.count === null || l.countEstimated === true), 'an AGE count is an estimate, never presented as exact');
});

test('a relationship type lists every start/end pair and an old node\'s legacy keys are still readable', () => {
	const falkor = parseSchema(live('falkordb_get_schema'));
	const knows = falkor.relationshipTypes.find((t) => t.type === 'KNOWS');
	assert.deepEqual(knows?.endpoints.map((e) => `${e.start}>${e.end}`).sort(), ['Employee>Person', 'Person>Employee', 'Person>Person']);
	// The legacy keys alone (no v2 block) still read, flagged as an older format that cannot be refreshed.
	const legacyOnly = { ...live('age_get_schema') };
	delete legacyOnly.schema;
	const legacy = parseSchema(legacyOnly);
	assert.equal(legacy.legacy, true);
	assert.equal(legacy.evidence, 'unknown');
	assert.ok(legacy.labels.length > 0);
});

test('a failed refresh keeps the last good schema, marks it stale and carries the node\'s words', () => {
	const view = parseSchema(live('age_refresh_schema_stale'));
	assert.equal(view.evidence, 'stale');
	assert.equal(view.labels.length, parseSchema(live('age_get_schema')).labels.length, 'the last good snapshot is still there');
	assert.deepEqual(view.error, { headline: 'Schema refresh failed', detail: 'schema refresh budget exhausted' });
	assert.match(schemaStatusText(view, Date.parse(view.refreshedAt!) + 3 * 60_000), /showing the snapshot from refreshed 3 minutes ago/);
});

test('the sidebar tree of a large live schema stays position-addressed and complete', () => {
	const view = parseSchema(live('age_get_schema'));
	const tree = buildSchemaTree(view);
	assert.equal(tree.entries.length, view.labels.length + view.relationshipTypes.length);
	assert.equal(new Set(tree.entries.map((e) => e.path)).size, tree.entries.length);
});

// -----------------------------------------------------------------------------
// errors
// -----------------------------------------------------------------------------

test('live refusal and hint messages keep the node\'s headline and the raw driver text, and the app adds only its own hint', () => {
	for (const engine of ENGINES) {
		const errors = live<Record<string, string>>(`${engine}_errors`);
		const refused = describeFailure(failure(errors.refused_write), false);
		assert.match(refused.headline, /^Refused: read_query is read-only; this statement writes/, engine);
		assert.ok(refused.detail.length > 0, 'the database text is kept under the headline');
		assert.doesNotMatch(refused.detail, /^Database said/, 'the label is the app\'s, not part of the node text');
		assert.match(refused.hint ?? '', /Browsing is read-only/);
	}
	const age = live<Record<string, string>>('age_errors');
	assert.match(describeFailure(failure(age.hint_date), false).headline, /^Not supported on Apache AGE 1\.5\.0: date\(\)$/);
	assert.match(describeFailure(failure(age.hint_exists_subquery), false).hint ?? '', /rewrite the query/);
	assert.match(describeFailure(failure(age.invalid_cypher), false).headline, /^Invalid Cypher for Apache AGE$/);
});

test('a node timeout and a database error are told apart; the legacy execute-off text is recognised', () => {
	const neo = live<Record<string, string>>('neo4j_errors');
	const timeout = describeFailure(failure(neo.timeout), false);
	assert.equal(timeout.variant, 'warning');
	assert.match(timeout.hint ?? '', /Narrow it, or lower the row limit/);
	const db = describeFailure(failure(neo.db_error), false);
	assert.equal(db.headline, 'Query failed');
	assert.match(db.detail, /Invalid input 'RETURN'/);
	assert.match(describeFailure(failure(neo.execute_disabled, 'execute'), false).headline, /does not allow execute/);
	assert.match(describeFailure(failure(neo.invalid_input), false).headline, /^Invalid read_query input/);
	assert.equal(describeFailure(failure(neo.refused_call), false).headline, 'Refused: CALL apoc.periodic.iterate is not on the read-only procedure allowlist');
});

// -----------------------------------------------------------------------------
// read_query envelopes
// -----------------------------------------------------------------------------

test('live graph results draw: 3 columns of nodes and relationships, one model, parallel edges kept', () => {
	for (const engine of ENGINES) {
		const result = live<ReadQueryResult>(`${engine}_read_query_graph`);
		const s = summarizeResult(result);
		assert.equal(chooseTab(s), 'graph', engine);
		assert.equal(s.malformed, 0);
		assert.equal(s.danglingRelationships, 0, 'every relationship returned has both its nodes');
		assert.ok(s.nodeCount > 0 && s.relationshipCount > 0);
		const model = modelFromResult(collectEntities(result.rows));
		assert.equal(model.nodes.size, s.nodeCount);
		assert.equal(model.relationships.size, s.relationshipCount);
	}
});

test('live paths: their nodes and relationships are drawn, in stored direction', () => {
	for (const engine of ENGINES) {
		const result = live<ReadQueryResult>(`${engine}_read_query_path`);
		const e = collectEntities(result.rows);
		assert.ok(e.nodes.size >= 2 && e.relationships.size >= 1, engine);
		const model = modelFromResult(e);
		for (const r of model.relationships.values()) {
			assert.ok(model.nodes.has(r.start) && model.nodes.has(r.end), `${engine}: relationship ${r.id} has both ends`);
		}
	}
});

test('the AGE result with a duplicate column keeps both cells, positionally', () => {
	const result = live<ReadQueryResult>('age_read_query_graph');
	assert.equal(result.columns.filter((c) => c === 'a.name').length, 2);
	assert.ok(result.rows.every((row) => row.length === result.columns.length));
});

test('an AGE id beyond 2^53 survives as exact text, and the number beside it is flagged, not trusted', () => {
	const result = live<ReadQueryResult>('age_read_query_big_id');
	const s = summarizeResult(result);
	const ids = [...collectEntities(result.rows).nodes.keys()];
	assert.equal(ids.length, 1);
	assert.equal(String(BigInt(ids[0])), ids[0]);
	assert.ok(BigInt(ids[0]) > BigInt(Number.MAX_SAFE_INTEGER));
	assert.equal(typeof s.unsafeNumbers, 'number');
});

test('Neo4j bytes arrive tagged and are shown as bytes, not as text', () => {
	const result = live<ReadQueryResult>('neo4j_read_query_bytes');
	assert.ok(isGraphBytes(result.rows[0][0]));
});

test('a result truncated by rows says so in words and names the limit', () => {
	const result = live<ReadQueryResult>('neo4j_read_query_truncated');
	assert.equal(result.truncated, true);
	assert.match(truncationText(result) ?? '', /1 row/);
});

test('expanding a live node twice adds nothing the second time (the model is idempotent on real ids)', () => {
	const result = live<ReadQueryResult>('neo4j_read_query_graph');
	const entities = collectEntities(result.rows);
	const model = modelFromResult(collectEntities([]));
	const center = [...entities.nodes.keys()][0];
	const first = expandNode(model, center, entities);
	assert.ok(first.addedNodes.length > 0);
	const second = expandNode(first.model, center, entities);
	assert.deepEqual([second.addedNodes.length, second.addedRelationships.length], [0, 0]);
	assert.equal(second.model.nodes.size, first.model.nodes.size);
});
