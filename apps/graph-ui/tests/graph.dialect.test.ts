// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE NODE'S DIALECT ANSWER: identity, capabilities, limits, honest wording
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canWrite, engineText, parseDialect, readBoundaryText, rowLimitChip, rowLimitFor, supportsReadQuery, supportsRefresh, targetText } from '../src/graph/dialect';
import { fixture } from './support/builders';

const load = (name: string) => parseDialect(fixture<Record<string, unknown>>(`dialect_${name}`));
/** The capability rules: a node advertises what it can do, and anything it does not say is unsupported. */

test('a current node reports engine, version, edition, target, capabilities and limits', () => {
	const neo = load('neo4j');
	assert.ok(neo);
	assert.equal(neo.dialect, 'neo4j');
	assert.equal(engineText(neo), 'Neo4j 5.26.31 Community');
	assert.equal(targetText(neo), 'database neo4j');
	assert.equal(neo.allowExecute, false);
	assert.equal(supportsReadQuery(neo), true);
	assert.equal(supportsRefresh(neo), true);
	assert.equal(neo.limits.maxRows, 25000);
	assert.equal(neo.limits.statementTimeoutMs, 30000);
	assert.equal(neo.readBoundary, 'read_session');
	assert.equal(neo.readBoundaryVerified, false);
	const age = load('age');
	assert.equal(age?.dialect, 'age');
	assert.match(engineText(age as never), /^Apache AGE|^AGE/i);
	const falkor = load('falkordb');
	assert.equal(targetText(falkor as never)?.startsWith('graph '), true);
	assert.equal(falkor?.readBoundary, 'ro_command');
});

test('an old node answers {dialect} only: nothing can be assumed, so read_query and refresh are unsupported', () => {
	const old = load('old_node');
	assert.ok(old);
	assert.equal(old.dialect, 'neo4j');
	assert.equal(supportsReadQuery(old), false, 'the app shows an upgrade message and never falls back to execute');
	assert.equal(supportsRefresh(old), false);
	assert.equal(canWrite(old), false);
	assert.equal(old.allowExecute, false);
	assert.equal(old.readBoundary, 'unknown');
	assert.equal(old.limits.maxRows, 1000, 'fallback limits, never unlimited');
	assert.equal(supportsReadQuery(null), false);
});

test('an unsupported or malformed answer is not a graph dialect', () => {
	for (const info of [null, {}, { dialect: 'postgres' }, { dialect: 'mysql' }, { dialect: 7 }, { dialect: 'NEO4J' }]) assert.equal(parseDialect(info as never), null, JSON.stringify(info));
});

test('the write console needs allow_execute AND the graph execute shape, and nothing else grants it', () => {
	const on = parseDialect({ dialect: 'neo4j', allow_execute: true, capabilities: { execute_shape_graph: true, read_query: true } });
	assert.equal(canWrite(on), true);
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_execute: true, capabilities: { read_query: true } })), false, 'no graph shape for execute');
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_execute: false, capabilities: { execute_shape_graph: true } })), false);
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_execute: 'true', capabilities: { execute_shape_graph: true } })), false, 'only the boolean true counts');
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_writes: true, capabilities: { execute_shape_graph: true } })), false, 'allow_writes is not allow_execute');
});

test('row limits: All is the node cap, nothing exceeds it, and a clamp never goes below 1', () => {
	const neo = load('neo4j');
	assert.equal(rowLimitFor(1000, neo), 1000);
	assert.equal(rowLimitFor(null, neo), 25000, 'All = the node\'s max_rows');
	assert.equal(rowLimitFor(200, neo), 200);
	const small = parseDialect({ dialect: 'falkordb', limits: { max_rows: 250 } });
	assert.equal(rowLimitFor(1000, small), 250, 'the node clamps, so ask for no more than it allows');
	assert.equal(rowLimitFor(null, small), 250);
	assert.equal(rowLimitFor(0, small), 1);
	assert.equal(rowLimitFor(null, null), 1000, 'an unprobed endpoint falls back to 1000, not unlimited');
});

test('malformed limits and capability values fall back instead of trusting them', () => {
	const d = parseDialect({ dialect: 'age', limits: { max_rows: -5, default_rows: 'x', statement_timeout_ms: 0, server_result_cap: 'big' }, capabilities: { read_query: 'yes', refresh_schema: 1, execute_shape_graph: true }, allow_execute: 1 });
	assert.ok(d);
	assert.equal(d.limits.maxRows, 1000);
	assert.equal(d.limits.statementTimeoutMs, 30000);
	assert.equal(d.limits.serverResultCap, null);
	assert.equal(d.capabilities.read_query, false, 'only the boolean true is a capability');
	assert.equal(d.allowExecute, false);
});

test('the read-boundary wording never promises more than the node verified', () => {
	const read = (b: string, verified = false) => readBoundaryText(parseDialect({ dialect: 'neo4j', read_boundary: b, read_boundary_verified: verified }) as never);
	assert.match(read('read_session'), /routing hint and not access control\. Connect with a read-only database user for a real guarantee\./);
	assert.match(read('database_role', true), /permissions were checked/);
	assert.match(read('database_role', false), /could not verify/);
	assert.match(read('ro_command'), /server enforces/);
	assert.match(read('read_only_tx'), /database enforces/);
	assert.match(read('something_new'), /did not say/);
	// A "verified" flag with a non-role boundary does not upgrade the claim.
	assert.ok(!/checked/.test(read('read_session', true)));
});

test('engine and target text fall back to the dialect name when the node does not say', () => {
	assert.equal(engineText(parseDialect({ dialect: 'falkordb' }) as never), 'FalkorDB');
	assert.equal(engineText(parseDialect({ dialect: 'age', engine: { name: 'Apache AGE', version: '1.5.0' } }) as never), 'Apache AGE 1.5.0');
	assert.equal(targetText(parseDialect({ dialect: 'neo4j' }) as never), null);
	assert.equal(targetText(parseDialect({ dialect: 'neo4j', database: 'neo4j', graph: 'g' }) as never), 'graph g');
});

test('a node that publishes no capabilities block advertises nothing: only an explicit true counts', () => {
	const unpublished = load('old_node');
	assert.equal(supportsReadQuery(unpublished), false);
	assert.equal(supportsRefresh(unpublished), false);
	assert.equal(supportsReadQuery(parseDialect({ dialect: 'neo4j', capabilities: { read_query: false } })), false);
	assert.equal(supportsReadQuery(parseDialect({ dialect: 'neo4j', capabilities: { read_query: 'true' } })), false, 'only the boolean true counts');
	assert.equal(supportsReadQuery(parseDialect({ dialect: 'neo4j', capabilities: { read_query: true } })), true);
	// Writing is never assumed: it needs allow_execute AND the graph shape.
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_execute: true })), false, 'allow_execute with no capability block: the graph shape is not advertised');
	assert.equal(canWrite(parseDialect({ dialect: 'neo4j', allow_execute: true, capabilities: { execute_shape_graph: false } })), false);
});

test('the row-limit chip says so when the node\'s maximum is below the choice, and is unchanged otherwise', () => {
	const small = parseDialect({ dialect: 'falkordb', limits: { max_rows: 250 } });
	const neo = parseDialect({ dialect: 'neo4j', limits: { max_rows: 25000 } });
	// 1,000 chosen on a node that allows 250: the two controls used to disagree with no explanation.
	const capped = rowLimitChip(1000, small);
	assert.equal(capped.text, "limit 250 (this connection's maximum)");
	assert.match(capped.title ?? '', /at most 250 rows per query \(the node's max_rows\)\. You chose 1,000, so 250 is sent\./);
	// A choice at or below the cap, and All (which is the cap by definition): the chip is exactly what it was.
	assert.deepEqual(rowLimitChip(200, small), { text: 'limit 200', title: null });
	assert.deepEqual(rowLimitChip(250, small), { text: 'limit 250', title: null });
	assert.deepEqual(rowLimitChip(null, small), { text: 'limit 250', title: null });
	assert.deepEqual(rowLimitChip(1000, neo), { text: 'limit 1,000', title: null });
	assert.deepEqual(rowLimitChip(null, neo), { text: 'limit 25,000', title: null });
	// The chip always agrees with what is sent.
	for (const choice of [200, 1000, null]) assert.ok(rowLimitChip(choice, small).text.startsWith(`limit ${rowLimitFor(choice, small).toLocaleString('en-US')}`));
	// No probe yet: the fallback maximum of 1,000 applies and nothing is claimed about a node.
	assert.deepEqual(rowLimitChip(1000, null), { text: 'limit 1,000', title: null });
	assert.equal(rowLimitChip(200, null).title, null);
});
