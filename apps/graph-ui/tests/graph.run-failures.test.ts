// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FAILURE NOTICES AND RUN CONFIGURATION
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBatchOutcome, formatPriorStatements } from 'shared/explorer';
import type { IStatementRunBase } from 'shared/explorer';
import { ExplorerToolError } from 'shared/explorer';
import { WRITE_MAY_HAVE_APPLIED, WRITE_PROBABLY_ROLLED_BACK, describeFailure, describeFailureMessage, describeFailureOf, describeWriteFailure } from '../src/graph/failures';
import type { IFailureInput } from '../src/graph/failures';
import { GRAPH_BATCH_WORDS, prepareStatement, refuseNonReads, toHistoryEntry } from '../src/graph/runConfig';
import { parseDialect } from '../src/graph/dialect';
import { fixture } from './support/builders';

const errors = fixture<Record<string, string>>('errors');

/** A failure input the way the shared session builds it from a verbatim message. */
function failure(kind: string, message: string, tool = 'read_query'): IFailureInput {
	const at = message.indexOf('\n');
	return { kind, tool, message, headline: at === -1 ? message : message.slice(0, at), ...(at === -1 ? {} : { detail: message.slice(at + 1) }) };
}

test('a refusal leads with the node\'s headline, the database text under it, and points at the write console only where there is one', () => {
	const read = describeFailure(failure('raised', errors.refused_write), false);
	assert.equal(read.headline, 'Refused: read_query is read-only; this statement writes (CREATE)');
	assert.match(read.detail, /Use the write console/);
	assert.match(read.hint ?? '', /Browsing is read-only/);
	const writable = describeFailure(failure('raised', errors.refused_write), true);
	assert.match(writable.hint ?? '', /use the write console for this connection/);
	assert.equal(read.ignore, false);
});

// On the node "Refused:" means a safety rule or the database refused the statement (graph_errors.py), not only "this
// writes". A read refused for its size, an AGE resource rule or a missing privilege is not a write problem, so only the
// write refusals point at the write console.
const WRITE_REFUSALS = [
	'Refused: read_query is read-only; this statement writes (CREATE)', // cypher_safety.py, AGE firewall write_clause
	'Refused: read_query is read-only; this statement writes', // graph_falkordb RO_QUERY
	'Refused: the database refused a write on the read-only path', // graph_neo4j, rocketride_graph (read-only transaction)
];
const OTHER_REFUSALS = [
	'Refused: the first row holds more than 10,000 graph elements', // graph_instance_base.py first-row budget
	'Refused: the first row holds more than 500,000 values',
	"Refused: USE is not allowed; read_query runs against the node's configured database", // cypher_safety.py
	'Refused: SHOW USERS is not allowed on the read-only path',
	'Refused: LOAD CSV is not allowed on the read-only path',
	'Refused: CALL apoc.periodic.iterate is not on the read-only procedure allowlist',
	'Refused: GRANT is not allowed on the read-only path',
	'Refused: unterminated string literal',
	'Refused: variable-length patterns need an upper bound', // rocketride_graph _FIREWALL_HEADLINES
	'Refused: variable-length pattern is too deep',
	'Refused: query is too long',
	'Refused: expression is nested too deeply',
	'Refused: CALL is not allowed on the read-only path',
	'Refused: the database user may not run this statement', // graph_neo4j Security.* (a reader without TRAVERSE too)
];

test('only a write refusal points at the write console; other refusals keep the node\'s own remedy and add no hint', () => {
	for (const headline of WRITE_REFUSALS) {
		const message = `${headline}\nthe database's own text`;
		assert.match(describeFailure(failure('raised', message), true).hint ?? '', /use the write console for this connection/, headline);
		assert.match(describeFailure(failure('raised', message), false).hint ?? '', /Browsing is read-only/, headline);
		assert.match(describeFailureMessage(message, true).hint ?? '', /write console/, headline);
	}
	for (const headline of OTHER_REFUSALS) {
		for (const canWrite of [true, false]) {
			const n = describeFailure(failure('raised', `${headline}\nNarrow the query.`), canWrite);
			assert.equal(n.headline, headline);
			assert.equal(n.detail, 'Narrow the query.', 'the node\'s second line still carries its remedy');
			assert.equal(n.hint, null, `${headline} (canWrite ${canWrite})`);
			assert.equal(n.variant, 'error');
		}
	}
});

test('live non-write refusals (AGE CALL, Neo4j procedure allowlist) get no write hint', () => {
	const age = fixture<Record<string, string>>('live/age_errors', 'v1');
	const neo = fixture<Record<string, string>>('live/neo4j_errors', 'v1');
	for (const message of [age.refused_call, neo.refused_call]) {
		assert.match(message, /^Refused: /);
		for (const canWrite of [true, false]) assert.equal(describeFailure(failure('raised', message), canWrite).hint, null, message);
	}
});

test('an AGE limitation keeps the node\'s explanation and says what to do', () => {
	const n = describeFailure(failure('raised', errors.age_hint), false);
	assert.match(n.headline, /^Not supported on Apache AGE 1\.5\.0: date\(\)/);
	assert.match(n.detail, /store dates as ISO-8601 strings/);
	assert.match(n.hint ?? '', /rewrite the query/);
});

test('a timeout says this app stopped waiting and that nothing here cancels the query', () => {
	const n = describeFailure(failure('timeout', 'Stopped waiting for read_query after 40 s. The node may still be running it; there is no way to cancel it from here.'), false);
	assert.equal(n.variant, 'warning');
	assert.match(n.hint ?? '', /cannot be cancelled from here/);
	const node = describeFailure(failure('raised', errors.timeout), false);
	assert.match(node.headline, /^Query timed out after 30000 ms/);
	assert.match(node.hint ?? '', /Narrow it, or lower the row limit/);
});

test('an upgrade (and the engine\'s unknown-tool text) is a warning with the upgrade message, never a fallback hint', () => {
	for (const input of [failure('upgrade', 'This node does not advertise read_query'), failure('raised', 'No handler found for tool read_query')]) {
		const n = describeFailure(input, true);
		assert.equal(n.variant, 'warning');
		assert.match(n.headline, /does not support read_query yet/);
		assert.match(n.headline, /never falls back to execute/);
	}
});

test('the upgrade message names the tool the node lacks: refresh, Ask and execute each say their own thing, and only read_query\'s mentions the no-fallback rule', () => {
	const refresh = describeFailure(failure('upgrade', 'This node cannot run refresh_schema: it does not advertise it.', 'refresh_schema'), false);
	assert.match(refresh.headline, /cannot refresh its schema/);
	assert.doesNotMatch(refresh.headline, /read_query/);
	assert.match(describeFailure(failure('raised', 'No handler found for tool get_query', 'get_query'), false).headline, /cannot turn a question into Cypher/);
	assert.match(describeFailure(failure('upgrade', 'x', 'execute'), true).headline, /execute with the graph result shape/);
	assert.match(describeFailure(failure('upgrade', 'x', 'something_else'), true).headline, /does not support something_else yet/);
	// The tool is also read from the fixed wording when the thrown value is not available (the runner passes only the message).
	assert.match(describeFailureMessage('This node cannot run refresh_schema: it does not advertise it.', false).headline, /cannot refresh its schema/);
	assert.match(describeFailureMessage('No handler found for tool get_query', false).headline, /cannot turn a question/);
	assert.match(describeFailureMessage('No handler found for tool read_query', false).headline, /never falls back to execute/);
});

test('the legacy execute-disabled text is recognised', () => {
	const n = describeFailure(failure('raised', errors.execute_disabled_legacy, 'execute'), false);
	assert.equal(n.headline, 'This node does not allow execute (allow_execute is off).');
	assert.match(n.hint ?? '', /Browsing with Cypher works/);
});

test('unavailable, malformed and invalid failures each get their own plain hint', () => {
	assert.match(describeFailure(failure('unavailable', "No running task for pipeline 'P'. Start the pipeline and retry."), false).hint ?? '', /Start the pipeline/);
	assert.match(describeFailure(failure('malformed', 'read_query returned a malformed result: columns is not an array'), false).hint ?? '', /may need an upgrade/);
	assert.equal(describeFailure(failure('invalid', 'Generated query contains write or admin clauses', 'get_query'), false).variant, 'error');
	assert.match(describeFailure(failure('raised', errors.invalid_input), false).headline, /^Invalid read_query input/);
});

test('a stale result is ignored entirely', () => {
	const n = describeFailure(failure('stale', 'superseded'), false);
	assert.equal(n.ignore, true);
	assert.equal(n.headline, '');
});

test('an unrecognised failure shows the node\'s text unchanged', () => {
	const n = describeFailure(failure('raised', errors.db_error), false);
	assert.equal(n.headline, 'Query failed');
	assert.match(n.detail, /^Database said: Variable `x` not defined/);
	assert.equal(n.hint, null);
	assert.equal(describeFailure({ kind: 'raised', tool: 't', message: '', headline: '' }, false).headline, '');
});

// -----------------------------------------------------------------------------
// Run configuration
// -----------------------------------------------------------------------------

const neo = parseDialect(fixture<Record<string, unknown>>('dialect_neo4j'));

test('a statement is sent exactly as written (a trailing semicolon removed), and the limit travels separately', () => {
	const p = prepareStatement('  MATCH (n) RETURN n;  ', 1000, neo);
	assert.equal(p.cypher, 'MATCH (n) RETURN n');
	assert.equal(p.limit, 1000);
	assert.equal(p.kind, 'read');
	assert.ok(!/limit/i.test(p.cypher), 'no LIMIT was added to the user\'s text');
	assert.equal(prepareStatement('RETURN 1;;', null, neo).limit, 25000, 'All is the node cap');
	assert.equal(prepareStatement('RETURN 1', 1000, null).limit, 1000);
	const comment = prepareStatement('MATCH (n) RETURN n // see ;', 200, neo);
	assert.equal(comment.cypher, 'MATCH (n) RETURN n // see ;', 'a semicolon inside a comment is not stripped');
});

test('writes are recognised with their finding; reads have none', () => {
	assert.equal(prepareStatement('CREATE (n)', 200, neo).kind, 'write');
	assert.equal(prepareStatement('CREATE (n)', 200, neo).finding?.kind, 'CREATE');
	assert.equal(prepareStatement('MATCH (n) RETURN n', 200, neo).finding, null);
});

test('the browse editor refuses a batch holding a write and names which statement and what was seen', () => {
	const batch = ['MATCH (n) RETURN n', 'MATCH (n) DETACH DELETE n', 'RETURN 1'].map((s) => prepareStatement(s, 1000, neo));
	const refusal = refuseNonReads(batch, false);
	assert.match(refusal ?? '', /^Not sent: statement 2 looks like it changes data or runs a command \(DETACH DELETE\)\. /);
	assert.match(refusal ?? '', /Query tabs only run reads, and this connection has no write console\./);
	assert.match(refuseNonReads(batch, true) ?? '', /Query tabs only run reads; use the write console for this connection\./);
	assert.match(refusal ?? '', /This is a text check, not a database safeguard\.$/);
	assert.equal(refuseNonReads(['RETURN 1', 'MATCH (n) RETURN n'].map((s) => prepareStatement(s, 1000, neo)), false), null);
});

test('a history entry holds the statement and the run, and nothing else', () => {
	const entry = toHistoryEntry({ cypher: 'MATCH (n) RETURN n', at: 5, ms: 12.6, outcome: 'rows', rows: 3, limit: 1000, kind: 'MATCH' }, 'id-1');
	assert.deepEqual(entry, { id: 'id-1', at: 5, ms: 13, outcome: 'rows', rows: 3, limit: 1000, kind: 'MATCH', cypher: 'MATCH (n) RETURN n' });
	const failed = toHistoryEntry({ cypher: 'X', at: 1, ms: -3, outcome: 'error', error: 'boom', kind: '' }, 'id-2');
	assert.equal(failed.ms, 0);
	assert.equal(failed.kind, 'OTHER');
	assert.equal(failed.error, 'boom');
	assert.ok(!('rows' in failed));
	assert.ok(!JSON.stringify(entry).includes('token'));
});

test('the shared runner hands over the message only: the kinds the session writes are recognised by their fixed wording', () => {
	assert.equal(describeFailureMessage('Stopped waiting for read_query after 40 s. The node may still be running it; there is no way to cancel it from here.', false).variant, 'warning');
	assert.match(describeFailureMessage('This node cannot run read_query: it does not advertise "read_query". Update the pipeline\'s node to a version that supports it.', true).headline, /does not support read_query yet/);
	assert.match(describeFailureMessage("No running task for pipeline 'P'. Start the pipeline and retry.", false).hint ?? '', /Start the pipeline/);
	assert.match(describeFailureMessage('read_query returned a malformed result: columns is not an array', false).hint ?? '', /may need an upgrade/);
	const refused = describeFailureMessage(errors.refused_write, false);
	assert.equal(refused.headline, 'Refused: read_query is read-only; this statement writes (CREATE)');
	assert.equal(refused.verbatim, 'Use the write console (execute) on a node with allow_execute enabled.', 'the node\'s remaining lines are the verbatim "Database said" text');
	assert.equal(refused.generic, false);
	const plain = describeFailureMessage('Something odd', false);
	assert.equal(plain.headline, 'Something odd');
	assert.equal(plain.verbatim, '');
	// A node message that merely mentions these words is not mistaken for a session message.
	assert.equal(describeFailureMessage('Query failed\nDatabase said: Stopped waiting for lock after 3 s.', false).variant, 'error');
});

test('Graph\'s batch words never claim a rollback and name nothing as committed', () => {
	const run = (index: number, kind: string, outcome: IStatementRunBase['outcome']): IStatementRunBase => ({ index, kind, verb: kind.toUpperCase(), outcome });
	const reads = [run(0, 'read', 'rows'), run(1, 'read', 'rows'), run(2, 'read', 'error')];
	assert.equal(formatPriorStatements(reads, 2, GRAPH_BATCH_WORDS), 'Statements 1\u20132 already ran.');
	const writes = [run(0, 'write', 'rows'), run(1, 'read', 'error')];
	assert.equal(formatPriorStatements(writes, 1, GRAPH_BATCH_WORDS), 'Statement 1 already executed on the database: each statement is a separate request, so nothing is rolled back.');
	assert.equal(formatBatchOutcome([run(0, 'read', 'rows'), run(1, 'write', 'rows'), run(2, 'write', 'error'), run(3, 'write', 'skipped')], GRAPH_BATCH_WORDS), '1 ran \u00b7 2 executed \u00b7 3 failed \u00b7 4 not run');
	for (const text of [GRAPH_BATCH_WORDS.changed, GRAPH_BATCH_WORDS.priorChanged('x'), GRAPH_BATCH_WORDS.priorRead('x')]) assert.ok(!/committed|atomic|transaction/i.test(text.replace('nothing is rolled back', '')), text);
});

test('when the shared runner passes the thrown ExplorerToolError, its kind decides, not the wording', () => {
	const timeout = new ExplorerToolError({ kind: 'timeout', tool: 'read_query', message: 'Anything at all, worded differently' });
	assert.equal(describeFailureOf(timeout.message, timeout, false).variant, 'warning');
	const upgrade = new ExplorerToolError({ kind: 'upgrade', tool: 'read_query', message: 'Totally different words' });
	assert.match(describeFailureOf(upgrade.message, upgrade, true).headline, /does not support read_query yet/);
	const refused = new ExplorerToolError({ kind: 'raised', tool: 'read_query', message: errors.refused_call });
	const notice = describeFailureOf(refused.message, refused, false);
	assert.match(notice.headline, /^Refused: CALL apoc\.periodic\.iterate/);
	assert.match(notice.verbatim, /^Allowed: db\.labels/);
	// A plain Error (or nothing) falls back to reading the message.
	assert.equal(describeFailureOf('boom', new Error('boom'), false).headline, 'boom');
	assert.equal(describeFailureOf('boom', undefined, false).headline, 'boom');
});

// execute(shape 'graph') can fail after the statement committed (the node could not build the envelope, or this app
// rejected the answer). The write console then says the write may have been applied, not "Refused: ..." with a hint
// to use the write console the user is already in.
test('in the write console a failure that can come after the statement ran says the write may have been applied', () => {
	const message = 'Refused: the first row holds more than 10,000 graph elements';
	const refused = describeWriteFailure(message, new ExplorerToolError({ kind: 'raised', tool: 'execute', message }));
	assert.equal(refused.headline, message, 'the node\'s own words lead');
	assert.equal(refused.hint, WRITE_MAY_HAVE_APPLIED);
	assert.match(refused.hint ?? '', /^The write may or may not have been applied/);
	assert.doesNotMatch(refused.hint ?? '', /use the write console/i);
	const timeout = 'Stopped waiting for execute after 40 s. The node may still be running it; there is no way to cancel it from here.';
	assert.equal(describeWriteFailure(timeout, new ExplorerToolError({ kind: 'timeout', tool: 'execute', message: timeout })).hint, WRITE_MAY_HAVE_APPLIED);
	assert.equal(describeWriteFailure('Query result cannot be represented', undefined).hint, WRITE_MAY_HAVE_APPLIED, 'a bare message counts too');
});

test('the may-have-applied note makes no claim about a rollback of the failing statement, which the app cannot know', () => {
	assert.doesNotMatch(WRITE_MAY_HAVE_APPLIED, /nothing is rolled back/i);
	assert.match(WRITE_MAY_HAVE_APPLIED, /may or may not have been applied/);
});

test('a database text that says the transaction was rolled back, or was killed by a memory limit, says it was probably not applied', () => {
	for (const detail of ['The transaction was rolled back.', 'dbms.memory.transaction.total.max threshold reached', 'Neo.TransientError.General.TransactionMemoryLimit']) {
		const message = `Query failed\n${detail}`;
		const notice = describeWriteFailure(message, new ExplorerToolError({ kind: 'raised', tool: 'execute', message }));
		assert.equal(notice.hint, WRITE_PROBABLY_ROLLED_BACK, detail);
	}
	assert.doesNotMatch(WRITE_PROBABLY_ROLLED_BACK, /nothing is rolled back/i);
	const other = 'Query failed\nconnection reset';
	assert.equal(describeWriteFailure(other, new ExplorerToolError({ kind: 'raised', tool: 'execute', message: other })).hint, WRITE_MAY_HAVE_APPLIED);
});

test('in the write console a refusal before anything was sent keeps its own words, and a dropped answer stays silent', () => {
	const upgrade = 'This node cannot run execute: it does not advertise "execute_shape_graph". Update the pipeline\'s node to a version that supports it.';
	assert.notEqual(describeWriteFailure(upgrade, new ExplorerToolError({ kind: 'upgrade', tool: 'execute', message: upgrade })).hint, WRITE_MAY_HAVE_APPLIED);
	const off = 'execute tool is disabled for this node (set allow_execute=true)';
	assert.match(describeWriteFailure(off, new ExplorerToolError({ kind: 'raised', tool: 'execute', message: off })).headline, /does not allow execute/);
	assert.notEqual(describeWriteFailure(off, undefined).hint, WRITE_MAY_HAVE_APPLIED);
	assert.equal(describeWriteFailure('dropped', new ExplorerToolError({ kind: 'stale', tool: 'execute', message: 'dropped' })).ignore, true);
});
