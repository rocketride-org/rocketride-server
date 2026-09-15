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
// SCHEMA — QUALITY RULES (what the snapshot alone can honestly report)
// =============================================================================
//
// PURE functions over one `get_schema` snapshot. Nothing here reads data,
// indexes, constraints beyond primary and foreign keys, or anything the
// snapshot does not contain — and nothing here changes anything.
//
// Three rules, and the reason each one stops where it does:
//   R1  A table has no primary key. The snapshot knows this for certain on
//       engines that reflect one — but ClickHouse reports no primary-key
//       CONSTRAINT at all (a MergeTree ORDER BY is not one), so there the
//       rule would fire on every table and mean nothing. It drops to `info`
//       with wording that names the engine, rather than accusing the schema.
//   R3  A foreign key names a table or column the snapshot does not have.
//       Certain within the snapshot; a snapshot read before a migration can
//       produce this against a database that is perfectly consistent, which
//       is why the page states when it was read.
//   R2  The two sides of a foreign key spell their type differently. This is
//       a TEXT comparison after normalisation, not a compatibility check, so
//       it is reported as information and never as a problem.
//
// Deliberately absent: anything based on naming conventions. A column called
// `customer_id` that matches another table's primary key is a guess, and a
// guess in a list of findings reads as a fact.
// =============================================================================

import type { ISqlSchemaResponse, SqlDialect } from '../connect';

// =============================================================================
// TYPES
// =============================================================================

/** How seriously to take a finding. */
export type Severity = 'info' | 'warning';

/** The rules this module can report. */
export type RuleId = 'R1' | 'R2' | 'R3';

/**
 * What each rule is called on screen. Rule ids are for cross-referencing,
 * not for reading: a grid column of `R1`/`R2`/`R3` tells a first-time reader
 * nothing, and there is nowhere on the page to look them up.
 */
export const RULE_LABELS: Record<RuleId, string> = {
	R1: 'No primary key',
	R2: 'Type strings differ',
	R3: 'Dangling foreign key',
};

/** One thing worth saying about the schema snapshot. */
export interface IFinding {
	/** Which rule produced it. */
	rule: RuleId;
	/** `warning` = worth fixing; `info` = worth knowing, not a verdict. */
	severity: Severity;
	/** The table the finding is about. */
	table: string;
	/** The column, when the finding is about one. */
	column?: string;
	/** Short mono evidence, e.g. `INT -> BIGINT` or `no primary key`. */
	evidence: string;
	/** The sentence shown to the reader. */
	message: string;
}

// =============================================================================
// TYPE NORMALISATION
// =============================================================================

/**
 * Spellings that are the SAME type in MySQL, PostgreSQL or ClickHouse, and
 * are therefore not worth reporting as a difference. The list is deliberately
 * short and exact: every entry is an alias the engine itself treats as
 * identical, not a judgement that two types are close enough.
 */
const TYPE_ALIASES: Record<string, string> = {
	INTEGER: 'INT',
	INT4: 'INT',
	INT2: 'SMALLINT',
	INT8: 'BIGINT',
	BOOL: 'BOOLEAN',
	'CHARACTER VARYING': 'VARCHAR',
	CHARACTER: 'CHAR',
	'DOUBLE PRECISION': 'DOUBLE',
};

/**
 * Reduce a datatype string to the form the comparison uses: upper case,
 * single-spaced, with any parenthesised arguments dropped so `INT(11)` and
 * `INT` are the same, then resolved through the alias list.
 *
 * Dropping the arguments is the deliberate part: a display width, a
 * precision, or a length is a real difference in some engines and noise in
 * others, and this module cannot tell which without knowing far more than a
 * snapshot holds. It compares the base type and says so.
 *
 * @param type - The engine-reported datatype string.
 * @returns The normalised type name.
 */
export function normaliseType(type: string): string {
	const base = type
		.replace(/\([^)]*\)/g, '')
		.trim()
		.replace(/\s+/g, ' ')
		.toUpperCase();
	return TYPE_ALIASES[base] ?? base;
}

// =============================================================================
// RULES
// =============================================================================

/**
 * Run every rule over one schema snapshot.
 *
 * Findings are ordered warnings first, then by table and column, so the list
 * reads the same on every render and the ones worth acting on come first.
 *
 * @param schema - The connection's schema snapshot.
 * @param dialect - The engine dialect; it decides what a missing primary key
 *                  means (see R1).
 * @returns Every finding, ordered.
 */
export function runSchemaChecks(
	schema: ISqlSchemaResponse | null | undefined,
	dialect: SqlDialect = 'unknown',
): IFinding[] {
	const tables = schema?.tables ?? {};
	const findings: IFinding[] = [];

	for (const [table, def] of Object.entries(tables)) {
		// ── R1 — no primary key ──────────────────────────────────────────────
		// On ClickHouse this says nothing about the table: the engine
		// reflects no primary-key constraint for any of them, so reporting
		// every table as a problem would be noise dressed as a finding.
		if (!def?.primary_key?.length) {
			findings.push(dialect === 'clickhouse'
				? {
					rule: 'R1',
					severity: 'info',
					table,
					evidence: 'none reflected',
					message: 'ClickHouse reflects no primary-key constraint, so this says nothing about the table.',
				}
				: {
					rule: 'R1',
					severity: 'warning',
					table,
					evidence: 'no primary key',
					message: 'Table has no primary key. Rows cannot be addressed individually, and the data browser cannot page in a guaranteed order.',
				});
		}

		// Column types of this table, for the R2 comparison.
		const columnTypes = new Map((def?.columns ?? []).map((column) => [column.column, column.type]));

		for (const fk of def?.foreign_keys ?? []) {
			const referred = tables[fk.referred_table];

			// ── R3 — the key points at something not in the snapshot ─────────
			if (!referred) {
				findings.push({
					rule: 'R3',
					severity: 'warning',
					table,
					column: fk.columns.join(', '),
					evidence: `${fk.referred_table} missing`,
					message: `Foreign key refers to table "${fk.referred_table}", which is not in this schema snapshot.`,
				});
				continue;
			}

			const referredTypes = new Map(referred.columns.map((column) => [column.column, column.type]));

			fk.columns.forEach((column, index) => {
				const referredColumn = fk.referred_columns[index];
				if (referredColumn === undefined) return;

				if (!referredTypes.has(referredColumn)) {
					findings.push({
						rule: 'R3',
						severity: 'warning',
						table,
						column,
						evidence: `${fk.referred_table}.${referredColumn} missing`,
						message: `Foreign key refers to column "${fk.referred_table}.${referredColumn}", which is not in this schema snapshot.`,
					});
					return;
				}

				// ── R2 — the two sides spell their type differently ──────────
				const local = columnTypes.get(column);
				const remote = referredTypes.get(referredColumn);
				if (local === undefined || remote === undefined) return;
				if (normaliseType(local) === normaliseType(remote)) return;

				findings.push({
					rule: 'R2',
					severity: 'info',
					table,
					column,
					evidence: `${local} -> ${remote}`,
					message: `Type strings differ from ${fk.referred_table}.${referredColumn} (compared textually). The engine may still accept both.`,
				});
			});
		}
	}

	// Warnings first; then a stable alphabetical order within each severity.
	const rank: Record<Severity, number> = { warning: 0, info: 1 };
	return findings.sort((a, b) => (
		(rank[a.severity] - rank[b.severity])
		|| a.table.localeCompare(b.table)
		|| (a.column ?? '').localeCompare(b.column ?? '')
		|| a.rule.localeCompare(b.rule)
	));
}
