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
// SQL — EXPLAIN (plan statement building + plan output parsing)
// =============================================================================
//
// Pure: no client, no session, no React. The caller executes the string
// buildExplain() returns and hands the resulting rows to parseExplain().
//
// PLAIN EXPLAIN ONLY. None of the statements built here execute the explained
// statement (MySQL/PostgreSQL/ClickHouse all plan without running unless the
// ANALYZE keyword is used, which this module never emits).
//
// SHAPE PROVENANCE — IMPORTANT. Every parser below is written from vendor
// DOCUMENTATION (MySQL 8.0 `EXPLAIN FORMAT=JSON`, PostgreSQL `EXPLAIN (FORMAT
// JSON)`, ClickHouse `EXPLAIN`) and from documented column names, NOT from
// output captured from a live server. No MySQL, PostgreSQL or ClickHouse
// instance was reachable while this was written, so the fixtures in
// tests/explain.test.ts are hand-built from those documents. Treat a parse
// miss as expected behaviour, never as an error: parseExplain reports
// `{ ok: false, reason }` and the UI falls back to the raw output it already
// shows by default.
// =============================================================================

import type { SqlDialect } from '../connect';

// =============================================================================
// TYPES
// =============================================================================

/** One `key: value` detail line of a plan node. */
export interface IPlanField {
	/** The planner's own field name, verbatim. */
	key: string;
	/** The value rendered as text. */
	value: string;
	/**
	 * True when the value is a bare number the planner ESTIMATED. The UI
	 * suffixes these with ` est.` — they are never measurements.
	 */
	numeric: boolean;
}

/** One node of a normalised plan tree. */
export interface IPlanNode {
	/** Row label, e.g. `Nested Loop` or `table: orders`. */
	label: string;
	/** The node's own scalar fields, in planner order. */
	fields: IPlanField[];
	/** Child nodes (empty for leaves). */
	children: IPlanNode[];
}

/** A successfully interpreted plan. */
export interface IPlanParseOk {
	/** Discriminant. */
	ok: true;
	/** The plan's root node. */
	root: IPlanNode;
}

/** An uninterpretable plan — the caller shows the raw output instead. */
export interface IPlanParseMiss {
	/** Discriminant. */
	ok: false;
	/** Why interpretation failed (shown to no one; useful in tests/logs). */
	reason: string;
}

/** Result of {@link parseExplain}. */
export type PlanParseResult = IPlanParseOk | IPlanParseMiss;

// =============================================================================
// STATEMENT BUILDING
// =============================================================================

/**
 * Build the plain EXPLAIN statement for a dialect.
 *
 * The statement is explained EXACTLY as the caller would run it, including any
 * LIMIT the results header applied — the caller passes the final text, this
 * function only prefixes it.
 *
 * @param dialect - The engine dialect.
 * @param sql - The statement to explain, exactly as it would run.
 * @returns The EXPLAIN statement, or null when the dialect has no support here.
 */
export function buildExplain(dialect: SqlDialect, sql: string): string | null {
	// A single trailing semicolon would land mid-statement for MySQL/Postgres
	// wrappers; strip exactly one, never more (an empty statement stays empty).
	const body = sql.replace(/\s*;\s*$/, '').trim();
	if (!body) return null;
	switch (dialect) {
		case 'mysql': return `EXPLAIN FORMAT=JSON ${body}`;
		case 'postgres': return `EXPLAIN (FORMAT JSON) ${body}`;
		case 'clickhouse': return `EXPLAIN ${body}`;
		default: return null;
	}
}

// =============================================================================
// VALUE HELPERS
// =============================================================================

/** Bare-number test: what the planner reports as an estimate, not a label. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * Render one scalar plan value as a field.
 *
 * @param key - The planner's field name.
 * @param value - The raw value from the plan document.
 * @returns The normalised field.
 */
function toField(key: string, value: unknown): IPlanField {
	if (typeof value === 'number') {
		return { key, value: String(value), numeric: Number.isFinite(value) };
	}
	const text = value === null || value === undefined ? '' : String(value);
	// MySQL reports cost_info numbers as JSON STRINGS ('1.25'), so the numeric
	// flag follows the text shape, not the JSON type.
	return { key, value: text, numeric: NUMERIC_TEXT.test(text) };
}

/** Object test that excludes arrays and null (both need different handling). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split a plan object into its scalar fields and its object/array children.
 *
 * @param obj - The plan object.
 * @param skip - Keys handled by the caller (already consumed as label/children).
 * @returns The scalar fields and the child entries, both in document order.
 */
function splitNode(obj: Record<string, unknown>, skip: string[]): { fields: IPlanField[]; children: [string, unknown][] } {
	const fields: IPlanField[] = [];
	const children: [string, unknown][] = [];
	for (const [key, value] of Object.entries(obj)) {
		if (skip.includes(key)) continue;
		if (isPlainObject(value) || Array.isArray(value)) {
			// An array of scalars (possible_keys, used_columns) is a field, not
			// a subtree; only arrays holding objects fan out into child nodes.
			if (Array.isArray(value) && !value.some(isPlainObject)) {
				fields.push(toField(key, value.join(', ')));
				continue;
			}
			children.push([key, value]);
			continue;
		}
		fields.push(toField(key, value));
	}
	return { fields, children };
}

// =============================================================================
// MYSQL — EXPLAIN FORMAT=JSON
// =============================================================================

/**
 * Walk one MySQL plan object generically: every nested object becomes a node,
 * every array of objects fans out into siblings. `table` objects are labelled
 * by their `table_name` so a scan reads as `table: orders`.
 *
 * Documented containers this handles by construction (no key list needed):
 * `query_block`, `nested_loop`, `table`, `ordering_operation`,
 * `grouping_operation`, `duplicates_removal`, `materialized_from_subquery`,
 * `attached_subqueries`, `union_result`.
 *
 * @param label - The label for this node (the parent's key, or a table name).
 * @param value - The plan object to walk.
 * @returns The node, or null when the value is not an object.
 */
function mysqlNode(label: string, value: unknown): IPlanNode | null {
	if (!isPlainObject(value)) return null;
	const tableName = typeof value.table_name === 'string' ? value.table_name : null;
	const nodeLabel = label === 'table' && tableName ? `table: ${tableName}` : label;
	const { fields, children } = splitNode(value, tableName && label === 'table' ? ['table_name'] : []);
	const childNodes: IPlanNode[] = [];
	for (const [key, child] of children) {
		if (Array.isArray(child)) {
			// nested_loop: [{ table: {...} }, { table: {...} }] — each element is
			// a one-key wrapper; unwrap it so the tree does not gain dead rows.
			child.forEach((element) => {
				if (!isPlainObject(element)) return;
				const entries = Object.entries(element);
				if (entries.length === 1 && isPlainObject(entries[0][1])) {
					const node = mysqlNode(entries[0][0], entries[0][1]);
					if (node) childNodes.push(node);
					return;
				}
				const node = mysqlNode(key, element);
				if (node) childNodes.push(node);
			});
			continue;
		}
		const node = mysqlNode(key, child);
		if (node) childNodes.push(node);
	}
	return { label: nodeLabel, fields, children: childNodes };
}

/**
 * Parse MySQL's single-row `EXPLAIN FORMAT=JSON` result.
 *
 * @param rows - The execute result rows.
 * @returns The parse result.
 */
function parseMysql(rows: Record<string, unknown>[]): PlanParseResult {
	const cell = rows[0]?.EXPLAIN ?? rows[0]?.explain;
	if (cell === undefined || cell === null) return { ok: false, reason: 'no EXPLAIN column in the first row' };
	let doc: unknown = cell;
	if (typeof cell === 'string') {
		try {
			doc = JSON.parse(cell);
		} catch {
			return { ok: false, reason: 'EXPLAIN column is not JSON' };
		}
	}
	if (!isPlainObject(doc)) return { ok: false, reason: 'plan document is not an object' };
	const block = doc.query_block;
	if (!isPlainObject(block)) return { ok: false, reason: 'no query_block in the plan document' };
	const root = mysqlNode('query_block', block);
	if (!root) return { ok: false, reason: 'query_block could not be walked' };
	return { ok: true, root };
}

// =============================================================================
// POSTGRES — EXPLAIN (FORMAT JSON)
// =============================================================================

/**
 * Walk one PostgreSQL `Plan` object. `Node Type` becomes the label (with
 * `Relation Name` appended so a scan reads as `Seq Scan on orders`); children
 * live under `Plans`.
 *
 * @param value - The plan object.
 * @returns The node, or null when the value is not a plan object.
 */
function postgresNode(value: unknown): IPlanNode | null {
	if (!isPlainObject(value)) return null;
	const nodeType = typeof value['Node Type'] === 'string' ? value['Node Type'] as string : null;
	if (!nodeType) return null;
	const relation = typeof value['Relation Name'] === 'string' ? value['Relation Name'] as string : null;
	const label = relation ? `${nodeType} on ${relation}` : nodeType;
	const { fields } = splitNode(value, ['Node Type', 'Plans']);
	const rawChildren = value.Plans;
	const children: IPlanNode[] = [];
	if (Array.isArray(rawChildren)) {
		rawChildren.forEach((child) => {
			const node = postgresNode(child);
			if (node) children.push(node);
		});
	}
	return { label, fields, children };
}

/**
 * Parse PostgreSQL's `EXPLAIN (FORMAT JSON)` result. The `QUERY PLAN` cell
 * arrives either already parsed (psycopg decodes json/jsonb into a Python
 * list, which survives to the browser as an array) or as a JSON string,
 * depending on the driver — both are handled.
 *
 * @param rows - The execute result rows.
 * @returns The parse result.
 */
function parsePostgres(rows: Record<string, unknown>[]): PlanParseResult {
	const first = rows[0];
	if (!first) return { ok: false, reason: 'no rows returned' };
	const cell = 'QUERY PLAN' in first ? first['QUERY PLAN'] : first['query plan'];
	if (cell === undefined || cell === null) return { ok: false, reason: 'no QUERY PLAN column in the first row' };
	let doc: unknown = cell;
	if (typeof cell === 'string') {
		try {
			doc = JSON.parse(cell);
		} catch {
			return { ok: false, reason: 'QUERY PLAN column is not JSON' };
		}
	}
	const entry = Array.isArray(doc) ? doc[0] : doc;
	if (!isPlainObject(entry)) return { ok: false, reason: 'plan document is not an object' };
	const root = postgresNode(entry.Plan);
	if (!root) return { ok: false, reason: 'no Plan object in the plan document' };
	return { ok: true, root };
}

// =============================================================================
// CLICKHOUSE — EXPLAIN (text rows)
// =============================================================================

/**
 * Parse ClickHouse's plain `EXPLAIN`: one text line per row in a column named
 * `explain`. Leading spaces carry the plan's nesting, so they drive depth;
 * flat output (no indentation) yields a flat list under a synthetic root.
 *
 * @param rows - The execute result rows.
 * @returns The parse result.
 */
function parseClickhouse(rows: Record<string, unknown>[]): PlanParseResult {
	const lines: { text: string; indent: number }[] = [];
	for (const row of rows) {
		const cell = row.explain ?? row.EXPLAIN;
		if (typeof cell !== 'string') continue;
		// A single cell may itself hold several lines when the driver joins them.
		cell.split('\n').forEach((raw) => {
			if (!raw.trim()) return;
			lines.push({ text: raw.trim(), indent: raw.length - raw.trimStart().length });
		});
	}
	if (lines.length === 0) return { ok: false, reason: 'no explain text rows' };

	// The shallowest line is the root; deeper lines attach to the nearest
	// preceding line with a smaller indent.
	const root: IPlanNode = { label: lines[0].text, fields: [], children: [] };
	const stack: { indent: number; node: IPlanNode }[] = [{ indent: lines[0].indent, node: root }];
	for (const line of lines.slice(1)) {
		const node: IPlanNode = { label: line.text, fields: [], children: [] };
		while (stack.length > 1 && line.indent <= stack[stack.length - 1].indent) stack.pop();
		// A sibling of the root (same indent, no deeper parent) still needs a
		// home: it becomes a child of the root rather than a lost node.
		stack[stack.length - 1].node.children.push(node);
		stack.push({ indent: line.indent, node });
	}
	return { ok: true, root };
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Interpret a plain EXPLAIN result into a normalised plan tree.
 *
 * Shapes are taken from vendor documentation, not from a live server (see the
 * module header). Any shape this does not recognise returns `ok: false` and
 * the caller keeps showing the database's raw output.
 *
 * @param dialect - The engine dialect the rows came from.
 * @param rows - The execute result rows, verbatim.
 * @returns The parsed tree, or a miss with its reason.
 */
export function parseExplain(dialect: SqlDialect, rows: Record<string, unknown>[]): PlanParseResult {
	if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'no rows returned' };
	switch (dialect) {
		case 'mysql': return parseMysql(rows);
		case 'postgres': return parsePostgres(rows);
		case 'clickhouse': return parseClickhouse(rows);
		default: return { ok: false, reason: `no plan parser for dialect ${dialect}` };
	}
}

/**
 * Count the nodes of a plan tree (the announcement says how big it is).
 *
 * @param node - The root node.
 * @returns The total node count including the root.
 */
export function countPlanNodes(node: IPlanNode): number {
	return 1 + node.children.reduce((sum, child) => sum + countPlanNodes(child), 0);
}

// =============================================================================
// RAW OUTPUT
// =============================================================================

/**
 * Render the database's plan output as the text a reader would have seen at a
 * SQL prompt. This is what the panel shows FIRST and by default: the
 * interpreted tree is a convenience over it, never a replacement for it.
 *
 * A single-column result (all three dialects) prints its cells one per line,
 * pretty-printing any cell the driver already decoded into an object. Anything
 * wider falls back to the whole row set as JSON, so nothing is hidden.
 *
 * @param rows - The execute result rows, verbatim.
 * @returns The raw text.
 */
export function formatRawPlan(rows: Record<string, unknown>[]): string {
	if (!Array.isArray(rows) || rows.length === 0) return '';
	const columns = Object.keys(rows[0] ?? {});
	if (columns.length !== 1) return JSON.stringify(rows, null, 2);
	const key = columns[0];
	return rows
		.map((row) => {
			const cell = row[key];
			if (cell === null || cell === undefined) return '';
			if (typeof cell === 'string') return cell;
			return JSON.stringify(cell, null, 2);
		})
		.join('\n');
}

// =============================================================================
// PATTERN NOTES
// =============================================================================

/** One rule-detected observation about a plan node. */
export interface IPlanNote {
	/** The planner field the rule read, verbatim — the note's whole evidence. */
	evidence: string;
	/** What that field conventionally means, in plain words. */
	text: string;
}

/**
 * Read one field's value.
 *
 * @param node - The node to read.
 * @param key - The field key.
 * @returns The value, or null when the node has no such field.
 */
function field(node: IPlanNode, key: string): string | null {
	return node.fields.find((f) => f.key === key)?.value ?? null;
}

/**
 * Rule-based notes for one plan node.
 *
 * These are TEXT PATTERNS over planner fields, not a cost model and not a
 * measurement: the caller labels them `detected by pattern`. Each note cites
 * the exact field it read so the reader can check it against the raw output.
 * A node no rule matches gets no notes — silence is not a verdict.
 *
 * @param node - The plan node to inspect.
 * @returns The notes, in rule order (possibly empty).
 */
export function planNotes(node: IPlanNode): IPlanNote[] {
	const notes: IPlanNote[] = [];

	// ── MySQL: access_type = ALL is the documented full-scan marker ──────────
	if (field(node, 'access_type') === 'ALL') {
		const rows = field(node, 'rows_examined_per_scan');
		notes.push({
			evidence: 'access_type = ALL',
			text: rows ? `full table scan (rows_examined_per_scan ${rows} est.)` : 'full table scan',
		});
	}

	// ── MySQL: filesort / temporary table, in either the tabular Extra
	//    column or the FORMAT=JSON booleans ──────────────────────────────────
	const extra = field(node, 'Extra') ?? '';
	if (extra.includes('Using filesort') || field(node, 'using_filesort') === 'true') {
		notes.push({
			evidence: extra.includes('Using filesort') ? 'Extra contains Using filesort' : 'using_filesort = true',
			text: 'sorted without an index',
		});
	}
	if (extra.includes('Using temporary') || field(node, 'using_temporary_table') === 'true') {
		notes.push({
			evidence: extra.includes('Using temporary') ? 'Extra contains Using temporary' : 'using_temporary_table = true',
			text: 'a temporary table holds the intermediate result',
		});
	}

	// ── PostgreSQL: Seq Scan is carried in the label (Node Type + relation) ──
	if (/^Seq Scan(?: on .+)?$/.test(node.label)) {
		notes.push({
			evidence: `Node Type = ${node.label}`,
			text: 'sequential scan',
		});
	}

	return notes;
}
