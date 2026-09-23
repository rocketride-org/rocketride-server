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
// SCHEMA — RELATIONS (declared foreign keys only: graph, paths, join SQL)
// =============================================================================
//
// PURE module over one `get_schema` snapshot. Every relationship here is a
// foreign key the engine DECLARED — nothing is inferred from column or table
// NAMES, anywhere, ever. A name that merely looks like a key is not a
// relationship, and this app never presents one as if it were.
//
// Consequences worth stating plainly:
//   - ClickHouse declares no foreign keys, so its graph is always empty.
//   - A schema that models its relationships only by convention produces an
//     empty graph too. That is an honest "unknown", not a bug.
// =============================================================================

import type { ISqlSchemaResponse, SqlDialect } from '../connect';

// =============================================================================
// TYPES
// =============================================================================

/**
 * One declared foreign key, as an edge from the REFERENCING (child) table to
 * the REFERENCED (parent) table. `columns` and `refColumns` are positionally
 * paired, so a composite key carries every pair.
 */
export interface IRelationEdge {
	/** Stable index within the owning graph — distinguishes parallel keys. */
	id: number;
	/** The referencing (child) table. */
	table: string;
	/** The referencing columns, in declaration order. */
	columns: string[];
	/** The referenced (parent) table. */
	refTable: string;
	/** The referenced columns, positionally paired with {@link columns}. */
	refColumns: string[];
}

/** The declared-foreign-key graph of one schema snapshot. */
export interface IRelationGraph {
	/** Table names present in the snapshot (the only nodes a path may visit). */
	tables: string[];
	/** Every declared foreign key, including keys pointing outside `tables`. */
	edges: IRelationEdge[];
}

/** One traversal of one edge while walking a join path. */
export interface IJoinHop {
	/** The declared foreign key being traversed. */
	edge: IRelationEdge;
	/** The table the walk arrived from. */
	from: string;
	/** The table the walk arrives at. */
	to: string;
	/**
	 * True when the hop runs parent -> child, i.e. against the key's declared
	 * direction. The key itself is unchanged; only the walk is reversed.
	 */
	reversed: boolean;
}

/** One complete path between two tables over declared foreign keys. */
export interface IJoinPath {
	/** The starting table. */
	from: string;
	/** The destination table. */
	to: string;
	/** The hops in walk order (`hops.length` = number of joins). */
	hops: IJoinHop[];
}

/** Structural orientation of a schema, derived from inbound key counts. */
export interface IOrientation {
	/** Tables other tables point at, most-referenced first. */
	hubs: { table: string; inbound: number }[];
	/** Tables that reference others but are referenced by none. */
	leaves: string[];
	/** Tables with no declared relationship in either direction. */
	isolated: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Hard ceiling on enumerated shortest paths. A densely keyed schema can hold
 * a combinatorial number of equal-length paths; the finder stops here so the
 * drawer cannot be wedged. The caller compares `paths.length` against this to
 * tell the user more paths exist — the list is never silently reduced to one.
 */
export const MAX_JOIN_PATHS = 25;
// Exported because the drawer compares against it: at the cap the list is a
// sample, and only the caller can say so on screen.

/** Default ceiling on joins in a path (5 tables). */
const DEFAULT_MAX_DEPTH = 4;

// =============================================================================
// GRAPH
// =============================================================================

/**
 * Build the declared-foreign-key graph of a schema snapshot.
 *
 * Malformed keys (no columns, or a column count that does not match the
 * referenced side) are dropped — a half-described key cannot produce a
 * correct ON clause. Keys pointing at a table missing from the snapshot are
 * KEPT as edges so schema-quality rules can report them, but path finding
 * never walks through a table that is not in `tables`.
 *
 * @param schema - The connection's schema snapshot.
 * @returns The relation graph (empty when the snapshot declares no keys).
 */
export function buildRelationGraph(schema: ISqlSchemaResponse | null | undefined): IRelationGraph {
	const tablesMap = schema?.tables ?? {};
	const tables = Object.keys(tablesMap);
	const edges: IRelationEdge[] = [];

	for (const table of tables) {
		const def = tablesMap[table];
		for (const fk of def?.foreign_keys ?? []) {
			const columns = fk.columns ?? [];
			const refColumns = fk.referred_columns ?? [];
			// A key with no columns, no target, or mismatched arity cannot be
			// turned into a join condition — skip rather than guess a pairing.
			if (columns.length === 0) continue;
			if (columns.length !== refColumns.length) continue;
			if (!fk.referred_table) continue;
			edges.push({
				id: edges.length,
				table,
				columns: [...columns],
				refTable: fk.referred_table,
				refColumns: [...refColumns],
			});
		}
	}

	return { tables, edges };
}

/**
 * The foreign keys declared BY other tables that point AT one table
 * (including a self-referential key the table declares on itself).
 *
 * @param graph - The relation graph.
 * @param table - The referenced table.
 * @returns The inbound edges, in graph order.
 */
export function inboundReferences(graph: IRelationGraph, table: string): IRelationEdge[] {
	return graph.edges.filter((edge) => edge.refTable === table);
}

/**
 * The foreign keys one table declares on other tables.
 *
 * @param graph - The relation graph.
 * @param table - The referencing table.
 * @returns The outbound edges, in graph order.
 */
export function outboundReferences(graph: IRelationGraph, table: string): IRelationEdge[] {
	return graph.edges.filter((edge) => edge.table === table);
}

/**
 * Classify every table by its declared relationships: hubs (referenced by
 * others, most first), leaves (reference others but are referenced by none),
 * isolated (neither). Self-references do not make a table its own hub.
 *
 * @param graph - The relation graph.
 * @returns The orientation summary.
 */
export function orientation(graph: IRelationGraph): IOrientation {
	const inbound = new Map<string, Set<string>>();
	const outbound = new Map<string, Set<string>>();
	for (const table of graph.tables) {
		inbound.set(table, new Set());
		outbound.set(table, new Set());
	}

	for (const edge of graph.edges) {
		// A table pointing at itself is not a relationship to another table.
		if (edge.table === edge.refTable) continue;
		inbound.get(edge.refTable)?.add(edge.table);
		outbound.get(edge.table)?.add(edge.refTable);
	}

	const hubs: { table: string; inbound: number }[] = [];
	const leaves: string[] = [];
	const isolated: string[] = [];

	for (const table of graph.tables) {
		const inCount = inbound.get(table)?.size ?? 0;
		const outCount = outbound.get(table)?.size ?? 0;
		if (inCount > 0) hubs.push({ table, inbound: inCount });
		else if (outCount > 0) leaves.push(table);
		else isolated.push(table);
	}

	// Most-referenced first; ties keep snapshot order for a stable render.
	hubs.sort((a, b) => (b.inbound - a.inbound) || a.table.localeCompare(b.table));

	return { hubs, leaves, isolated };
}

// =============================================================================
// PATH FINDING
// =============================================================================

/** One undirected adjacency entry: the edge and the table it leads to. */
interface IAdjacency {
	/** The edge traversed. */
	edge: IRelationEdge;
	/** The table reached. */
	to: string;
	/** True when the traversal runs parent -> child. */
	reversed: boolean;
}

/**
 * Build the undirected adjacency map, restricted to tables in the snapshot.
 * Self-referential keys are omitted: a hop from a table to itself can never
 * shorten a path and would only invite a loop.
 *
 * @param graph - The relation graph.
 * @returns Adjacency lists keyed by table name.
 */
function buildAdjacency(graph: IRelationGraph): Map<string, IAdjacency[]> {
	const known = new Set(graph.tables);
	const adjacency = new Map<string, IAdjacency[]>();
	for (const table of graph.tables) adjacency.set(table, []);

	for (const edge of graph.edges) {
		// Both endpoints must exist in the snapshot to be walkable.
		if (!known.has(edge.table) || !known.has(edge.refTable)) continue;
		// Self-referential key: valid to display, never useful as a hop.
		if (edge.table === edge.refTable) continue;
		adjacency.get(edge.table)?.push({ edge, to: edge.refTable, reversed: false });
		adjacency.get(edge.refTable)?.push({ edge, to: edge.table, reversed: true });
	}

	return adjacency;
}

/**
 * Find EVERY shortest join path between two tables over declared foreign keys,
 * treating each key as undirected.
 *
 * Two tables are often joinable in several equally short ways — through
 * parallel keys, or through different intermediate tables. Which one is
 * correct depends on what the caller means, and this module cannot know that,
 * so it returns all of them and leaves the choice to the person. The result is
 * capped at {@link MAX_JOIN_PATHS}; a caller seeing that many should say so.
 *
 * @param graph - The relation graph.
 * @param from - The starting table.
 * @param to - The destination table.
 * @param maxDepth - Maximum number of joins (default {@link DEFAULT_MAX_DEPTH}).
 * @returns The shortest paths, or an empty array when none exists in range.
 */
export function findJoinPaths(
	graph: IRelationGraph,
	from: string,
	to: string,
	maxDepth: number = DEFAULT_MAX_DEPTH,
): IJoinPath[] {
	const known = new Set(graph.tables);
	if (from === to) return [];
	if (!known.has(from) || !known.has(to)) return [];
	if (maxDepth < 1) return [];

	const adjacency = buildAdjacency(graph);

	// ── Breadth-first layering from `from` (distance in joins) ───────────────
	const distance = new Map<string, number>([[from, 0]]);
	let frontier = [from];
	let depth = 0;
	while (frontier.length > 0 && depth < maxDepth && !distance.has(to)) {
		const next: string[] = [];
		for (const table of frontier) {
			for (const step of adjacency.get(table) ?? []) {
				if (distance.has(step.to)) continue;
				distance.set(step.to, depth + 1);
				next.push(step.to);
			}
		}
		frontier = next;
		depth += 1;
	}

	const target = distance.get(to);
	if (target === undefined || target > maxDepth) return [];

	// ── Enumerate every path whose every hop descends one layer ──────────────
	const paths: IJoinPath[] = [];
	const hops: IJoinHop[] = [];

	/**
	 * Depth-first walk over the BFS layering, collecting complete paths.
	 *
	 * @param table - The table reached so far.
	 */
	const walk = (table: string): void => {
		if (paths.length >= MAX_JOIN_PATHS) return;
		if (table === to) {
			paths.push({ from, to, hops: [...hops] });
			return;
		}
		const here = distance.get(table);
		if (here === undefined) return;
		for (const step of adjacency.get(table) ?? []) {
			// Only edges that move strictly one layer closer to the target.
			if (distance.get(step.to) !== here + 1) continue;
			hops.push({ edge: step.edge, from: table, to: step.to, reversed: step.reversed });
			walk(step.to);
			hops.pop();
			if (paths.length >= MAX_JOIN_PATHS) return;
		}
	};

	walk(from);
	return paths;
}

// =============================================================================
// SQL GENERATION
// =============================================================================

/** The header comment every generated join carries. */
const JOIN_SQL_HEADER = '-- generated from declared foreign keys; review before running';

/**
 * Derive a short alias for each table position in a path. Table initials
 * (`order_items` -> `oi`) read better than `a`/`b`/`c` in a join, so they are
 * tried first; a collision or an unusable initial falls back to a positional
 * letter, and a final numeric suffix guarantees uniqueness. Aliases are per
 * POSITION, not per table, so a path that revisits a name still reads.
 *
 * @param tables - The tables in path order.
 * @returns One alias per position.
 */
function aliasesFor(tables: string[]): string[] {
	const used = new Set<string>();
	const letters = 'abcdefghijklmnopqrstuvwxyz';

	return tables.map((table, index) => {
		// Initials of the underscore/space separated words, lowercased.
		const initials = table
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean)
			.map((word) => word[0])
			.join('');
		// Must start with a letter to be a bare alias in every dialect.
		let base = /^[a-z]/.test(initials) ? initials : (letters[index % letters.length] ?? 't');
		if (used.has(base)) base = `${base}${index + 1}`;
		while (used.has(base)) base = `${base}_`;
		used.add(base);
		return base;
	});
}

/**
 * Render a join path as a runnable SELECT.
 *
 * The statement is a PREVIEW: it selects every column of the first and last
 * table and caps the result at 100 rows. It is generated from declared keys
 * alone, which is exactly what the header comment says — nothing about it is
 * inferred, and nothing about it is verified against the data.
 *
 * @param dialect - The engine dialect (drives identifier quoting).
 * @param path - The path to render.
 * @param quoteIdent - The dialect's identifier quoter.
 * @returns The generated SQL, or '' for an empty path.
 */
export function generateJoinSql(
	dialect: SqlDialect,
	path: IJoinPath,
	quoteIdent: (dialect: SqlDialect, name: string) => string,
): string {
	if (path.hops.length === 0) return '';

	// Tables in walk order: the start, then each hop's destination.
	const tables = [path.from, ...path.hops.map((hop) => hop.to)];
	const alias = aliasesFor(tables);

	const lines: string[] = [JOIN_SQL_HEADER];
	lines.push(`SELECT ${alias[0]}.*, ${alias[alias.length - 1]}.*`);
	lines.push(`FROM ${quoteIdent(dialect, tables[0] as string)} ${alias[0]}`);

	path.hops.forEach((hop, index) => {
		const fromAlias = alias[index] as string;
		const toAlias = alias[index + 1] as string;
		const { edge } = hop;
		// Pair the arriving side's columns with the departing side's. Walking
		// child -> parent joins on the parent's referenced columns; the
		// reversed walk joins on the child's constrained columns.
		const conditions = edge.columns.map((childColumn, i) => {
			const parentColumn = edge.refColumns[i] as string;
			const arriving = hop.reversed ? childColumn : parentColumn;
			const departing = hop.reversed ? parentColumn : childColumn;
			return `${toAlias}.${quoteIdent(dialect, arriving)} = ${fromAlias}.${quoteIdent(dialect, departing)}`;
		});
		lines.push(`JOIN ${quoteIdent(dialect, hop.to)} ${toAlias} ON ${conditions.join(' AND ')}`);
	});

	lines.push('LIMIT 100');
	return lines.join('\n');
}

/**
 * One-line description of a hop for the path list in the drawer, e.g.
 * `order_items.order_id -> orders.id`. Always written in the key's DECLARED
 * direction (child -> parent) so the reader sees the key, not the walk.
 *
 * @param hop - The hop to describe.
 * @returns The hop line.
 */
export function describeHop(hop: IJoinHop): string {
	const { edge } = hop;
	const left = edge.columns.map((column) => `${edge.table}.${column}`).join(', ');
	const right = edge.refColumns.map((column) => `${edge.refTable}.${column}`).join(', ');
	return `${left} -> ${right}`;
}
