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
// EXPLORER CHECKS — one verdict per tool, never per node family
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	checkGetQuery,
	checkLegacyErrorEnvelope,
	checkObject,
	checkRowEnvelope,
	checkStoreSuccess,
	checkValidFlag,
	classifySchemaV2,
	composeChecks,
} from './checks';
import type { CheckOutcome } from './checks';

/**
 * Run a check with a tool name.
 *
 * @param check - The check.
 * @param value - The resolved value.
 * @param tool - The tool name.
 * @returns The verdict.
 */
function run(check: (value: unknown, ctx: { tool: string }) => CheckOutcome, value: unknown, tool = 't'): CheckOutcome {
	return check(value, { tool });
}

describe('checkObject', () => {
	it('accepts an object and rejects everything else as malformed', () => {
		assert.deepEqual(run(checkObject, {}), { ok: true });
		for (const bad of [null, undefined, 'x', 3, true, []]) {
			const outcome = run(checkObject, bad, 'dialect');
			assert.equal(outcome.ok, false);
			if (!outcome.ok) {
				assert.equal(outcome.kind, 'malformed');
				assert.match(outcome.message, /^dialect returned a malformed result: expected an object/);
			}
		}
	});
});

describe('checkValidFlag (get_data)', () => {
	it('fails on valid:false with an error', () => {
		assert.deepEqual(run(checkValidFlag, { valid: false, error: 'bad cypher', rows: [] }), { ok: false, kind: 'invalid', message: 'bad cypher' });
	});

	it('passes valid:true and results without the flag', () => {
		assert.equal(run(checkValidFlag, { valid: true, rows: [] }).ok, true);
		assert.equal(run(checkValidFlag, { rows: [] }).ok, true);
	});

	it('still fails valid:false when the node gave no reason, and says so', () => {
		const outcome = run(checkValidFlag, { valid: false }, 'get_data');
		assert.equal(outcome.ok, false);
		if (!outcome.ok) assert.match(outcome.message, /get_data reported valid: false with neither an error nor an answer/);
	});

	// The graph and SQL nodes' get_data pass get_query's / get_sql's
	// {answer, valid: false} through unchanged when the question gets a prose
	// answer: a documented result.
	it('passes valid:false with an answer and no error, the node answering in prose', () => {
		assert.equal(run(checkValidFlag, { valid: false, answer: 'There are three people in the graph.' }).ok, true);
		assert.deepEqual(run(checkValidFlag, { valid: false, answer: 'prose', error: 'bad cypher' }), { ok: false, kind: 'invalid', message: 'bad cypher' });
	});
});

describe('checkGetQuery', () => {
	it('treats valid:false WITH an error as a failure', () => {
		assert.deepEqual(run(checkGetQuery, { valid: false, error: 'LLM unavailable' }), { ok: false, kind: 'invalid', message: 'LLM unavailable' });
	});

	it('treats valid:false WITH an answer as legitimate prose, not an error', () => {
		assert.deepEqual(run(checkGetQuery, { valid: false, answer: 'There are 3 people named Alice.' }), { ok: true });
	});

	it('treats valid:false with an error AND an answer as a failure', () => {
		assert.equal(run(checkGetQuery, { valid: false, error: 'x', answer: 'y' }).ok, false);
	});

	it('rejects valid:false with neither, and passes valid:true', () => {
		assert.equal(run(checkGetQuery, { valid: false }).ok, false);
		assert.equal(run(checkGetQuery, { valid: true, cypher: 'MATCH (n) RETURN n' }).ok, true);
	});

	it('does not read a blank error as an error', () => {
		assert.equal(run(checkGetQuery, { valid: false, error: '   ', answer: 'prose' }).ok, true);
	});
});

describe('checkStoreSuccess (store / vector tools)', () => {
	it('fails on success:false with the node error, as a store failure', () => {
		assert.deepEqual(run(checkStoreSuccess, { success: false, error: 'collection missing' }), { ok: false, kind: 'store', message: 'collection missing' });
	});

	it('passes success:true and results that carry no flag', () => {
		assert.equal(run(checkStoreSuccess, { success: true }).ok, true);
		assert.equal(run(checkStoreSuccess, { results: [] }).ok, true);
	});

	it('is neither an exception nor {valid:false}: valid:false alone passes this check', () => {
		assert.equal(run(checkStoreSuccess, { valid: false }).ok, true);
	});
});

describe('checkLegacyErrorEnvelope (FalkorDB query)', () => {
	it('fails on {error, columns, rows}', () => {
		assert.deepEqual(run(checkLegacyErrorEnvelope, { error: 'Query timed out', columns: [], rows: [] }), { ok: false, kind: 'error-envelope', message: 'Query timed out' });
	});

	it('passes a normal result', () => {
		assert.equal(run(checkLegacyErrorEnvelope, { columns: ['n'], rows: [[1]] }).ok, true);
	});
});

describe('checkRowEnvelope (read_query, execute shape graph)', () => {
	const good = { columns: ['a', 'a'], rows: [[1, 2], [3, 4]], row_limit: 1000, truncated: false };

	it('accepts the positional envelope, duplicate column names included', () => {
		assert.deepEqual(run(checkRowEnvelope, good), { ok: true });
	});

	it('accepts the additive metadata', () => {
		assert.equal(run(checkRowEnvelope, { ...good, truncated: true, truncated_by: 'elements', element_limit: 10000, elements: 10000, affected_rows: 0 }).ok, true);
		assert.equal(run(checkRowEnvelope, { ...good, truncated_by: null }).ok, true);
	});

	it('accepts every truncated_by the contract allows, the value budget included', () => {
		// The node cuts a result at the value budget with truncated_by "values";
		// that is an honest partial result, never a malformed one.
		for (const by of [null, 'rows', 'elements', 'values']) {
			const outcome = run(checkRowEnvelope, { ...good, truncated: by !== null, truncated_by: by }, 'read_query');
			assert.deepEqual(outcome, { ok: true }, `truncated_by ${JSON.stringify(by)}`);
		}
		const cut = { ...good, truncated: true, truncated_by: 'values', element_limit: 10000, elements: 4, value_limit: 500000, values: 499998 };
		assert.deepEqual(run(checkRowEnvelope, cut, 'read_query'), { ok: true });
	});

	it('rejects a mistyped value budget as malformed', () => {
		for (const bad of [
			{ ...good, value_limit: '500000' },
			{ ...good, values: null },
			{ ...good, values: Number.NaN },
		]) {
			const outcome = run(checkRowEnvelope, bad, 'read_query');
			assert.equal(outcome.ok, false, JSON.stringify(bad));
			if (!outcome.ok) assert.equal(outcome.kind, 'malformed');
		}
	});

	it('rejects a row as wide as neither the columns nor an array', () => {
		const narrow = run(checkRowEnvelope, { ...good, rows: [[1]] });
		assert.equal(narrow.ok, false);
		if (!narrow.ok) assert.match(narrow.message, /row 1 has 1 values for 2 columns/);
		const notArray = run(checkRowEnvelope, { ...good, rows: [{ a: 1 }] });
		assert.equal(notArray.ok, false);
	});

	it('rejects missing or mistyped required fields as malformed', () => {
		for (const bad of [
			{ ...good, columns: 'a' },
			{ ...good, columns: [1] },
			{ ...good, rows: {} },
			{ ...good, row_limit: '1000' },
			{ ...good, row_limit: 1.5 },
			{ ...good, row_limit: -1 },
			{ ...good, truncated: 'no' },
			{ ...good, truncated_by: 'cols' },
			{ ...good, elements: '3' },
			{ columns: [], rows: [] },
			null,
		]) {
			const outcome = run(checkRowEnvelope, bad, 'read_query');
			assert.equal(outcome.ok, false, JSON.stringify(bad));
			if (!outcome.ok) assert.equal(outcome.kind, 'malformed');
		}
	});

	it('does not judge raised errors: those never reach a check', () => {
		// A result that merely CONTAINS the word error is still a well-formed envelope.
		assert.equal(run(checkRowEnvelope, { ...good, columns: ['error'], rows: [['x']] }).ok, true);
	});
});

describe('composeChecks', () => {
	it('returns the first failure and stops', () => {
		let calls = 0;
		const counting = ((): CheckOutcome => { calls += 1; return { ok: true }; });
		const check = composeChecks(checkObject, checkValidFlag, counting);
		assert.equal(check(null, { tool: 't' }).ok, false);
		assert.equal(calls, 0);
		assert.equal(check({ valid: false, error: 'x' }, { tool: 't' }).ok, false);
		assert.equal(calls, 0);
		assert.equal(check({ valid: true }, { tool: 't' }).ok, true);
		assert.equal(calls, 1);
	});
});

describe('classifySchemaV2', () => {
	const block = (over: Record<string, unknown>) => ({ nodes: [], relationships: [], schema: { version: 2, labels: [], relationship_types: [], sampled: false, truncated: false, refreshed_at: '2026-10-04T10:00:00Z', source: 'refresh', stale: false, error: null, capable: true, ...over } });

	it('reads a good v2 snapshot as fresh and carries its freshness', () => {
		assert.deepEqual(classifySchemaV2(block({ sampled: true })), { evidence: 'fresh', refreshedAt: '2026-10-04T10:00:00Z', sampled: true, truncated: false });
	});

	it('reads the kept snapshot after a failed refresh as stale, with the error', () => {
		const reading = classifySchemaV2(block({ stale: true, error: 'refresh timed out' }));
		assert.equal(reading.evidence, 'stale');
		assert.equal(reading.error, 'refresh timed out');
	});

	it('reads a failed reflection with no good snapshot as an error', () => {
		const reading = classifySchemaV2(block({ error: 'cannot reflect' }));
		assert.equal(reading.evidence, 'error');
		assert.equal(reading.error, 'cannot reflect');
	});

	it('reads capable:false as incapable even if nothing else is wrong', () => {
		assert.equal(classifySchemaV2(block({ capable: false })).evidence, 'incapable');
	});

	it('NEVER promotes an absent schema block to an empty graph', () => {
		// An old node: legacy keys only. This is the case that used to look empty.
		assert.deepEqual(classifySchemaV2({ nodes: [], relationships: [] }), { evidence: 'unknown' });
		assert.deepEqual(classifySchemaV2({}), { evidence: 'unknown' });
		assert.deepEqual(classifySchemaV2(null), { evidence: 'unknown' });
		assert.deepEqual(classifySchemaV2('x'), { evidence: 'unknown' });
		assert.deepEqual(classifySchemaV2({ schema: { version: 1 } }), { evidence: 'unknown' });
	});

	it('reads a legacy bare error as an error', () => {
		assert.deepEqual(classifySchemaV2({ error: 'Node label :Person not found' }), { evidence: 'error', error: 'Node label :Person not found' });
	});
});
