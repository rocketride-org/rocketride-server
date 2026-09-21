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
// SQL — COMPLETION MODEL (schema-aware suggestions and keyword snippets)
// =============================================================================
//
// All of the editor's suggestion logic lives here as pure functions so it can
// be tested without Monaco; `SqlEditor` only adapts the candidates below into
// Monaco's `CompletionItem` shape.
//
// This is string matching, NOT a SQL parser, and it is meant to stay that way:
// a wrong suggestion costs a keystroke, while a parser would cost a dependency
// and a maintenance burden the app has no budget for. Alias resolution is a
// regex over FROM / JOIN / UPDATE / INSERT INTO clauses.
//
// Ordering is carried entirely by `sortText`, because Monaco merges these with
// its own SQL keyword list and only the sort text decides who wins:
//   0_  columns of the table a `alias.` / `table.` prefix names
//   1_  joins prefilled from a DECLARED foreign key, then table names, when
//       the caret follows FROM / JOIN / UPDATE / INTO / TABLE
//   2_  columns of every table the buffer mentions (or, when it mentions
//       none, the table list)
//   3_  keyword snippets
// Monaco's own keywords sort after all of these.
//
// Everything here comes from the schema SNAPSHOT, which is read once per
// refresh — hence the `snapshotNote` shown as each group's documentation.
// Relationships come from DECLARED foreign keys only; a column that merely
// looks like a key by name is never treated as one.
// =============================================================================

import type { ISqlSchemaColumn, ISqlSchemaResponse, SqlDialect } from '../connect';
import { quoteIdent } from './paging';

// =============================================================================
// TYPES
// =============================================================================

/** One declared foreign key, flattened for join generation. */
export interface IFkEdge {
	/** Table the key is declared on. */
	fromTable: string;
	/** Constrained columns, in order. */
	fromColumns: string[];
	/** Table the key points at. */
	toTable: string;
	/** Referenced columns, in the matching order. */
	toColumns: string[];
}

/** Everything the suggester needs from one schema snapshot. */
export interface ICompletionModel {
	/** Unix ms the snapshot was read. */
	refreshedAt: number;
	/** Database name, when the node reported one. */
	database?: string;
	/** Table names, in snapshot order. */
	tables: string[];
	/** Columns per table, keyed by table name. */
	columnsByTable: Record<string, ISqlSchemaColumn[]>;
	/** Declared foreign keys across the whole snapshot. */
	foreignKeys: IFkEdge[];
	/**
	 * Documentation line naming when the snapshot was read — and saying what
	 * Refresh can and cannot do about it. A node without the `refresh_schema`
	 * tool serves the reflection it took at task start no matter how often the
	 * user presses Refresh, so the hint must not promise otherwise.
	 */
	snapshotNote: string;
}

/** What a candidate is, for the editor's icon and for tests. */
export type CompletionKind = 'table' | 'column' | 'snippet';

/** One suggestion, in a Monaco-independent shape. */
export interface ICompletionCandidate {
	/** What kind of thing this is. */
	kind: CompletionKind;
	/** Text shown in the list. */
	label: string;
	/** Secondary text shown beside the label. */
	detail: string;
	/** Longer text shown in the details pane (set on each group's first item). */
	documentation?: string;
	/** Sort key; the group prefix decides which group wins. */
	sortText: string;
	/** Text inserted on accept (quoted when the identifier needs it). */
	insertText: string;
	/** True when {@link insertText} uses Monaco's snippet placeholder syntax. */
	snippet?: boolean;
}

/** One table reference found in a buffer. */
interface ISourceRef {
	/** The table name, unquoted and without any schema prefix. */
	table: string;
	/** The alias it was given, when it has one. */
	alias?: string;
}

// =============================================================================
// PATTERNS
// =============================================================================

/** A table reference after FROM / JOIN / UPDATE / INTO, with an optional alias. */
const SOURCE_REF = /\b(?:from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*))?)(?:\s+(?:as\s+)?("[^"]+"|`[^`]+`|[A-Za-z_][A-Za-z0-9_$]*))?/gi;

/** Words that follow a table name but are NOT an alias. */
const NOT_AN_ALIAS = new Set([
	'on', 'where', 'set', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'join',
	'group', 'order', 'limit', 'having', 'union', 'except', 'intersect', 'values', 'select',
	'using', 'when', 'and', 'or', 'as', 'offset', 'into', 'from', 'straight_join', 'window',
	'for', 'lateral', 'returning', 'partition', 'tablesample', 'with', 'default', 'duplicate',
]);

/** A trailing `alias.` / `table.` prefix, with the partial word after it. */
const QUALIFIER = /([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*)?$/;

/** The caret sits where a table name belongs. */
const TABLE_POSITION = /\b(from|join|update|into|table)\s+[A-Za-z_][A-Za-z0-9_$]*$|\b(from|join|update|into|table)\s+$/i;

/** An identifier that needs no quoting. */
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Zero-pad a group index so sort text orders numerically.
 *
 * @param index - The position within its group.
 * @returns A three-digit string.
 */
function pad(index: number): string {
	return String(index).padStart(3, '0');
}

/**
 * Strip surrounding quotes from an identifier and drop any schema prefix.
 *
 * @param raw - The identifier as it appeared in the text.
 * @returns The bare name.
 */
function bareName(raw: string): string {
	const last = raw.split('.').pop() ?? raw;
	return last.trim().replace(/^["`]|["`]$/g, '');
}

/**
 * Render an identifier for insertion, quoting only when it needs it.
 *
 * @param dialect - The engine dialect.
 * @param name - The identifier.
 * @returns The name, quoted if necessary.
 */
function ident(dialect: SqlDialect, name: string): string {
	return PLAIN_IDENT.test(name) ? name : quoteIdent(dialect, name);
}

/**
 * Find a table in the model, matching case-insensitively.
 *
 * @param model - The completion model.
 * @param name - The name to look for.
 * @returns The table's name as the snapshot spells it, or undefined.
 */
function findTable(model: ICompletionModel, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return model.tables.find((table) => table.toLowerCase() === wanted);
}

/**
 * Every table reference in a buffer, in the order they appear.
 *
 * @param text - The SQL text to scan.
 * @returns The references found.
 */
function scanSources(text: string): ISourceRef[] {
	const out: ISourceRef[] = [];
	SOURCE_REF.lastIndex = 0;
	let match = SOURCE_REF.exec(text);
	while (match) {
		const table = bareName(match[1]);
		const rawAlias = match[2] ? bareName(match[2]) : undefined;
		const alias = rawAlias && !NOT_AN_ALIAS.has(rawAlias.toLowerCase()) ? rawAlias : undefined;
		out.push(alias ? { table, alias } : { table });
		match = SOURCE_REF.exec(text);
	}
	return out;
}

// =============================================================================
// MODEL
// =============================================================================

/**
 * Format a snapshot timestamp as `HH:MM` in the viewer's local time.
 *
 * @param at - Unix ms.
 * @returns The clock time.
 */
function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Build the suggestion model from a schema snapshot.
 *
 * Memoise this on the snapshot's refresh time — it walks every table.
 *
 * @param schema - The snapshot, or null when none is loaded.
 * @param refreshedAt - Unix ms the snapshot was read (defaults to now).
 * @returns The completion model (empty, but usable, for a null snapshot).
 */
export function buildCompletionModel(schema: ISqlSchemaResponse | null | undefined, refreshedAt: number = Date.now()): ICompletionModel {
	const tables: string[] = [];
	const columnsByTable: Record<string, ISqlSchemaColumn[]> = {};
	const foreignKeys: IFkEdge[] = [];

	for (const [table, definition] of Object.entries(schema?.tables ?? {})) {
		tables.push(table);
		columnsByTable[table] = definition.columns ?? [];
		for (const fk of definition.foreign_keys ?? []) {
			foreignKeys.push({
				fromTable: table,
				fromColumns: fk.columns,
				toTable: fk.referred_table,
				toColumns: fk.referred_columns,
			});
		}
	}

	return {
		refreshedAt,
		database: schema?.database,
		tables,
		columnsByTable,
		foreignKeys,
		snapshotNote: `Missing a table? The snapshot dates from ${clock(refreshedAt)}; Refresh re-reads it only on nodes with refresh_schema.`,
	};
}

/**
 * Map the aliases (and bare table names) a buffer declares onto table names.
 *
 * Keys are lower-cased; a table with no alias maps to itself so `orders.` is
 * resolvable too. A word that is really the next SQL keyword (`WHERE`, `SET`,
 * `ON`, …) is never taken as an alias.
 *
 * @param text - The SQL text to scan.
 * @returns Alias (or table name) to table name.
 */
export function resolveAliases(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const source of scanSources(text)) {
		out[source.table.toLowerCase()] = source.table;
		if (source.alias) out[source.alias.toLowerCase()] = source.table;
	}
	return out;
}

// =============================================================================
// CANDIDATE BUILDERS
// =============================================================================

/**
 * Tag the first candidate of a group with the snapshot note, so the details
 * pane explains where the suggestions came from without repeating it on every
 * row.
 *
 * @param candidates - The group's candidates.
 * @param note - The snapshot note.
 * @returns The same array, with documentation on its first entry.
 */
function documentFirst(candidates: ICompletionCandidate[], note: string): ICompletionCandidate[] {
	if (candidates.length > 0) candidates[0].documentation = note;
	return candidates;
}

/**
 * Table-name candidates.
 *
 * @param model - The completion model.
 * @param dialect - The engine dialect (quoting).
 * @param prefix - The sort-text group prefix.
 * @returns One candidate per table.
 */
function tableCandidates(model: ICompletionModel, dialect: SqlDialect, prefix: string): ICompletionCandidate[] {
	return documentFirst(model.tables.map((table, index) => ({
		kind: 'table' as const,
		label: table,
		detail: `${table} · ${model.columnsByTable[table]?.length ?? 0} columns`,
		sortText: `${prefix}${pad(index)}`,
		insertText: ident(dialect, table),
	})), model.snapshotNote);
}

/**
 * Column candidates for a list of tables.
 *
 * @param model - The completion model.
 * @param tables - Tables whose columns to offer, in order.
 * @param dialect - The engine dialect (quoting).
 * @param prefix - The sort-text group prefix.
 * @returns One candidate per column.
 */
function columnCandidates(model: ICompletionModel, tables: string[], dialect: SqlDialect, prefix: string): ICompletionCandidate[] {
	const out: ICompletionCandidate[] = [];
	for (const table of tables) {
		for (const column of model.columnsByTable[table] ?? []) {
			out.push({
				kind: 'column',
				label: column.column,
				detail: `${table} · ${column.type}`,
				sortText: `${prefix}${pad(out.length)}`,
				insertText: ident(dialect, column.column),
			});
		}
	}
	return documentFirst(out, model.snapshotNote);
}

/**
 * Pick a short, unused alias for a table.
 *
 * @param table - The table to alias.
 * @param used - Aliases already taken (lower-cased).
 * @returns An alias that is not in `used`.
 */
function pickAlias(table: string, used: Set<string>): string {
	const letters = table.toLowerCase().replace(/[^a-z]/g, '') || 't';
	const tries = [letters[0], letters.slice(0, 2), letters.slice(0, 3)];
	for (const candidate of tries) {
		if (candidate && !used.has(candidate)) return candidate;
	}
	let n = 1;
	while (used.has(`${letters[0]}${n}`)) n += 1;
	return `${letters[0]}${n}`;
}

/**
 * Join clauses prefilled from DECLARED foreign keys, for the table already in
 * the buffer. Composite keys produce a multi-column `ON`. Nothing is inferred
 * from a column's name.
 *
 * @param model - The completion model.
 * @param sources - The table references already in the buffer.
 * @param dialect - The engine dialect (quoting).
 * @returns One candidate per usable foreign key, in both directions.
 */
function fkJoinCandidates(model: ICompletionModel, sources: ISourceRef[], dialect: SqlDialect): ICompletionCandidate[] {
	const out: ICompletionCandidate[] = [];
	if (sources.length === 0) return out;
	const present = new Set(sources.map((source) => source.table.toLowerCase()));
	const used = new Set<string>();
	for (const source of sources) {
		used.add(source.table.toLowerCase());
		if (source.alias) used.add(source.alias.toLowerCase());
	}

	/**
	 * The name to write for a table already in the buffer: its alias if it has
	 * one, otherwise the table name itself.
	 *
	 * @param table - The table name.
	 * @returns The reference to write.
	 */
	const referenceFor = (table: string): string => {
		const source = sources.find((entry) => entry.table.toLowerCase() === table.toLowerCase());
		return ident(dialect, source?.alias ?? source?.table ?? table);
	};

	for (const fk of model.foreignKeys) {
		const label = `FK ${fk.fromTable}.${fk.fromColumns.join(', ')} -> ${fk.toTable}.${fk.toColumns.join(', ')}`;
		const directions: { near: string; far: string; nearColumns: string[]; farColumns: string[] }[] = [
			{ near: fk.fromTable, far: fk.toTable, nearColumns: fk.fromColumns, farColumns: fk.toColumns },
			{ near: fk.toTable, far: fk.fromTable, nearColumns: fk.toColumns, farColumns: fk.fromColumns },
		];
		for (const direction of directions) {
			if (!present.has(direction.near.toLowerCase())) continue;
			// Already joined in — nothing to suggest.
			if (present.has(direction.far.toLowerCase())) continue;
			const farAlias = pickAlias(direction.far, used);
			used.add(farAlias);
			const near = referenceFor(direction.near);
			const on = direction.farColumns
				.map((column, i) => `${farAlias}.${ident(dialect, column)} = ${near}.${ident(dialect, direction.nearColumns[i])}`)
				.join(' AND ');
			const text = `${ident(dialect, direction.far)} ${farAlias} ON ${on}`;
			out.push({
				kind: 'snippet',
				label: text,
				detail: label,
				sortText: `1_0_${pad(out.length)}`,
				insertText: text,
			});
		}
	}
	return documentFirst(out, model.snapshotNote);
}

/** Keyword snippets, offered everywhere and sorted last among our groups. */
const SNIPPETS: { label: string; insertText: string }[] = [
	{ label: 'SELECT … FROM', insertText: 'SELECT ${1:*}\nFROM ${2:table}' },
	{ label: 'JOIN … ON', insertText: 'JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:column}' },
	{ label: 'INSERT … VALUES', insertText: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})' },
	{ label: 'UPDATE … SET … WHERE', insertText: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition}' },
	{ label: 'CREATE TABLE', insertText: 'CREATE TABLE ${1:table} (\n\t${2:id} ${3:INT}\n)' },
	{ label: 'EXPLAIN', insertText: 'EXPLAIN ${1:SELECT 1}' },
];

/**
 * The keyword-snippet candidates.
 *
 * @returns One candidate per snippet.
 */
function snippetCandidates(): ICompletionCandidate[] {
	return SNIPPETS.map((snippet, index) => ({
		kind: 'snippet' as const,
		label: snippet.label,
		detail: 'snippet',
		sortText: `3_${pad(index)}`,
		insertText: snippet.insertText,
		snippet: true,
	}));
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Suggest completions for a caret position.
 *
 * A trailing `alias.` / `table.` prefix wins outright and returns ONLY that
 * table's columns; when the qualifier cannot be resolved nothing is returned,
 * so Monaco's own keyword list stands alone rather than the app guessing.
 * (A consequence worth knowing: a schema-qualified `db.table` reads as an
 * unresolvable qualifier and suppresses the app's suggestions at that caret.)
 *
 * @param model - The completion model for the connection.
 * @param textBefore - Buffer text up to the caret.
 * @param dialect - The engine dialect (quoting).
 * @param textAfter - Buffer text after the caret. Used ONLY to resolve aliases,
 *                    so `SELECT o.|` followed by `FROM orders o` still knows
 *                    what `o` is. Optional; alias resolution degrades to the
 *                    text before the caret without it.
 * @returns The candidates, unsorted (read `sortText`).
 */
export function suggestAt(
	model: ICompletionModel,
	textBefore: string,
	dialect: SqlDialect = 'unknown',
	textAfter: string = '',
): ICompletionCandidate[] {
	const whole = `${textBefore} ${textAfter}`;
	const sources = scanSources(whole).filter((source) => findTable(model, source.table));
	const aliases = resolveAliases(whole);

	// `alias.` / `table.` — only that table's columns, and only if it resolves.
	const qualifier = QUALIFIER.exec(textBefore);
	if (qualifier) {
		const resolved = aliases[qualifier[1].toLowerCase()] ?? qualifier[1];
		const table = findTable(model, resolved);
		if (!table) return [];
		return columnCandidates(model, [table], dialect, '0_');
	}

	const out: ICompletionCandidate[] = [];
	const tablePosition = TABLE_POSITION.exec(textBefore);
	if (tablePosition) {
		const keyword = (tablePosition[1] ?? tablePosition[2] ?? '').toLowerCase();
		if (keyword === 'join') out.push(...fkJoinCandidates(model, sources, dialect));
		out.push(...tableCandidates(model, dialect, '1_1_'));
	} else if (sources.length > 0) {
		const tables: string[] = [];
		for (const source of sources) {
			const table = findTable(model, source.table);
			if (table && !tables.includes(table)) tables.push(table);
		}
		out.push(...columnCandidates(model, tables, dialect, '2_0_'));
	} else {
		out.push(...tableCandidates(model, dialect, '2_1_'));
	}

	out.push(...snippetCandidates());
	return out;
}
