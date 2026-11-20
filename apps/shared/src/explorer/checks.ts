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
// EXPLORER — RESULT CHECKS (failure is a property of the TOOL, not the node)
// =============================================================================
//
// What counts as a failed call depends on the tool that was called:
//
//   execute, read_query   a RAISED error (the client rejects) — the check only
//                         validates the envelope of a call that did not raise
//   get_data, get_query   `{valid: false}` with an `error` is a failure, even
//                         beside an `answer`; with an `answer` and no `error`
//                         it is the model answering in PROSE and is not; with
//                         neither it is a failure
//   store / vector tools  `{success: false, error}` — neither an exception nor
//                         `{valid: false}`
//   FalkorDB legacy query `{error, columns: [], rows: []}`
//   get_schema / refresh  never an error by itself: see classifySchemaV2, which
//                         refuses to read an absent or failed schema as an empty
//                         graph
//
// A check runs on the value a call RESOLVED with and must not throw; it
// reports a failure by returning one. Each is a pure function of its input so
// it is tested without a client.
// =============================================================================

import type { ExplorerErrorKind } from './errors';

// =============================================================================
// TYPES
// =============================================================================

/** The verdict of a check. */
export type CheckOutcome = { ok: true } | { ok: false; kind: ExplorerErrorKind; message: string; detail?: string };

/** Judges the value a tool call resolved with. Must not throw. */
export type ResultCheck = (value: unknown, ctx: { tool: string }) => CheckOutcome;

/** The passing verdict, shared so checks allocate nothing on the happy path. */
const OK: CheckOutcome = { ok: true };

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Whether a value is a plain JSON object (not null, not an array).
 *
 * @param value - Anything.
 * @returns True for `{...}`.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Describe a value's type for a malformed-envelope message.
 *
 * @param value - Anything.
 * @returns e.g. `null`, `array`, `string`.
 */
function typeName(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

/**
 * Build a malformed-envelope failure.
 *
 * @param tool - The tool name.
 * @param what - What was wrong.
 * @returns The failing outcome.
 */
function malformed(tool: string, what: string): CheckOutcome {
	return { ok: false, kind: 'malformed', message: `${tool} returned a malformed result: ${what}` };
}

/**
 * Read a non-empty string field.
 *
 * @param value - The object.
 * @param key - The field.
 * @returns The string, or undefined when absent, empty or not a string.
 */
function text(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' && field.trim() !== '' ? field : undefined;
}

// =============================================================================
// CHECKS
// =============================================================================

/**
 * The floor every tool gets: the result is an object.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkObject: ResultCheck = (value, ctx) => {
	return isPlainObject(value) ? OK : malformed(ctx.tool, `expected an object, got ${typeName(value)}`);
};

/**
 * get_data: the same rule as {@link checkGetQuery}. The graph and SQL nodes'
 * get_data passes the result of their query-writing tool (get_query, get_sql)
 * through unchanged when it is not `valid`, so a question the database cannot
 * answer comes back as the documented prose `{valid: false, answer}` and
 * passes, while `{valid: false, error}` (even beside an `answer`) and
 * `{valid: false}` with neither field fail as `invalid`.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkValidFlag: ResultCheck = (value, ctx) => checkGetQuery(value, ctx);

/**
 * get_query: `{valid: false, error}` is a failure, even beside an `answer`,
 * and so is `{valid: false}` with neither field; `{valid: false, answer}` with
 * no error is the model answering in prose — a legitimate result, not an
 * error. A blank string counts as an absent field.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkGetQuery: ResultCheck = (value, ctx) => {
	if (!isPlainObject(value)) return malformed(ctx.tool, `expected an object, got ${typeName(value)}`);
	if (value.valid !== false) return OK;
	const error = text(value, 'error');
	if (error !== undefined) return { ok: false, kind: 'invalid', message: error };
	// No error: an answer is prose and passes; neither is an unusable result.
	if (text(value, 'answer') !== undefined) return OK;
	return { ok: false, kind: 'invalid', message: `${ctx.tool} reported valid: false with neither an error nor an answer` };
};

/**
 * Store and vector tools: `{success: false, error}` is a failure.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkStoreSuccess: ResultCheck = (value, ctx) => {
	if (!isPlainObject(value)) return malformed(ctx.tool, `expected an object, got ${typeName(value)}`);
	if (value.success !== false) return OK;
	return { ok: false, kind: 'store', message: text(value, 'error') ?? `${ctx.tool} reported success: false without saying why` };
};

/**
 * FalkorDB's legacy `query`: `{error, columns, rows}` is a failure.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkLegacyErrorEnvelope: ResultCheck = (value, ctx) => {
	if (!isPlainObject(value)) return malformed(ctx.tool, `expected an object, got ${typeName(value)}`);
	const error = text(value, 'error');
	return error === undefined ? OK : { ok: false, kind: 'error-envelope', message: error };
};

/** The budgets a row envelope may name in `truncated_by` (null aside). */
const TRUNCATED_BY: readonly string[] = ['rows', 'elements', 'values'];

/**
 * The positional row envelope of read_query (and execute with shape "graph"):
 * `{columns: string[], rows: unknown[][], row_limit: number, truncated: boolean}`
 * plus additive metadata (`truncated_by`, `element_limit`, `elements`,
 * `value_limit`, `values`, `affected_rows`). `truncated_by` is null or names
 * the budget that cut the result: `rows`, `elements` or `values`. Rows are
 * ARRAYS in column order, so a result naming the same column twice keeps
 * both; each row must be exactly as wide as `columns`.
 *
 * @param value - The resolved value.
 * @param ctx - The tool being checked.
 * @returns The verdict.
 */
export const checkRowEnvelope: ResultCheck = (value, ctx) => {
	if (!isPlainObject(value)) return malformed(ctx.tool, `expected an object, got ${typeName(value)}`);
	const { columns, rows, row_limit: rowLimit, truncated } = value;
	if (!Array.isArray(columns) || !columns.every((column) => typeof column === 'string')) {
		return malformed(ctx.tool, 'columns must be an array of strings');
	}
	if (!Array.isArray(rows)) return malformed(ctx.tool, 'rows must be an array');
	for (let i = 0; i < rows.length; i++) {
		const row: unknown = rows[i];
		if (!Array.isArray(row)) return malformed(ctx.tool, `row ${i + 1} is not an array`);
		if (row.length !== columns.length) {
			return malformed(ctx.tool, `row ${i + 1} has ${row.length} values for ${columns.length} columns`);
		}
	}
	if (typeof rowLimit !== 'number' || !Number.isInteger(rowLimit) || rowLimit < 0) {
		return malformed(ctx.tool, 'row_limit must be a non-negative integer');
	}
	if (typeof truncated !== 'boolean') return malformed(ctx.tool, 'truncated must be a boolean');
	const truncatedBy = value.truncated_by;
	if (truncatedBy !== undefined && truncatedBy !== null && (typeof truncatedBy !== 'string' || !TRUNCATED_BY.includes(truncatedBy))) {
		return malformed(ctx.tool, 'truncated_by must be null, "rows", "elements" or "values"');
	}
	for (const key of ['element_limit', 'elements', 'value_limit', 'values', 'affected_rows'] as const) {
		const field = value[key];
		if (field !== undefined && (typeof field !== 'number' || !Number.isFinite(field))) {
			return malformed(ctx.tool, `${key} must be a number`);
		}
	}
	return OK;
};

/**
 * Run several checks in order; the first failure wins.
 *
 * @param checks - The checks to run.
 * @returns One check that applies them all.
 */
export function composeChecks(...checks: ResultCheck[]): ResultCheck {
	return (value, ctx) => {
		for (const check of checks) {
			const outcome = check(value, ctx);
			if (!outcome.ok) return outcome;
		}
		return OK;
	};
}

// =============================================================================
// SCHEMA EVIDENCE
// =============================================================================

/**
 * What a get_schema / refresh_schema answer actually proves.
 *
 * - `fresh`     — a v2 snapshot from a successful reflection.
 * - `stale`     — the last good snapshot, kept after a failed refresh.
 * - `error`     — reflection failed and no good snapshot exists.
 * - `incapable` — this node build cannot reflect (`capable: false`).
 * - `unknown`   — no v2 block at all (an older node): the answer proves NOTHING
 *                 about the graph and must never be shown as "empty".
 */
export type SchemaEvidence = 'fresh' | 'stale' | 'error' | 'incapable' | 'unknown';

/** The reading of a schema answer. */
export interface ISchemaReading {
	/** What the answer proves. */
	evidence: SchemaEvidence;
	/** The node's error text, when it gave one. */
	error?: string;
	/** ISO-8601 time of the snapshot, when the node reported it. */
	refreshedAt?: string;
	/** True when property metadata was sampled rather than exhaustive. */
	sampled?: boolean;
	/** True when the snapshot is incomplete because a bound was hit. */
	truncated?: boolean;
}

/**
 * Read the evidence out of a schema answer without ever promoting an absent
 * or failed one to "an empty graph".
 *
 * @param value - The resolved value of get_schema or refresh_schema.
 * @returns What the answer proves.
 */
export function classifySchemaV2(value: unknown): ISchemaReading {
	if (!isPlainObject(value)) return { evidence: 'unknown' };
	const block = value.schema;
	if (!isPlainObject(block) || block.version !== 2) {
		// A legacy answer: a bare `error` is a failure, everything else proves nothing.
		const error = text(value, 'error');
		return error === undefined ? { evidence: 'unknown' } : { evidence: 'error', error };
	}
	const error = text(block, 'error');
	const reading: ISchemaReading = { evidence: 'fresh' };
	if (error !== undefined) reading.error = error;
	if (typeof block.refreshed_at === 'string') reading.refreshedAt = block.refreshed_at;
	if (typeof block.sampled === 'boolean') reading.sampled = block.sampled;
	if (typeof block.truncated === 'boolean') reading.truncated = block.truncated;
	if (block.capable === false) reading.evidence = 'incapable';
	else if (block.stale === true) reading.evidence = 'stale';
	else if (error !== undefined) reading.evidence = 'error';
	return reading;
}
