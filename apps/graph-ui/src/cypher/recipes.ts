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
// CYPHER - GENERATED QUERIES (engine-specific, parameterised)
// =============================================================================
//
// Every query the app writes itself - label preview, inspect, expand, connect,
// find path - is built here and nowhere else, under two rules:
//
//   VALUES ARE BOUND. Element ids (and lists of ids) travel as parameters, never
//   spliced into the text. Ids are opaque strings and live handles: the
//   comparison is `elementId(n) = $id` on Neo4j 5+ and `id(n) = toInteger($id)`
//   on FalkorDB and Apache AGE, whose ids are 64-bit integers that only a string
//   parameter carries exactly (AGE converts a 17-digit id without rounding).
//
//   IDENTIFIERS ARE QUOTED BY THE DIALECT. Labels cannot be parameters on any
//   engine, so they are placed in the text through quoteIdentifier, from the
//   schema's real label names, and a label that cannot be quoted safely is
//   refused with a reason instead of being concatenated.
//
// The only numbers that appear in query text are integers this module computes
// itself and clamps: row limits and path depths.
//
// What is not generated, on purpose: RETURN * (AGE rejects it), ORDER BY on a
// RETURN alias (AGE fails on it), WHERE n:Label (AGE cannot parse it), multiple
// labels on one node (AGE has one label per node), shortestPath (AGE has none),
// datetime() and friends. The generated queries stay inside what all three
// engines accept.
// =============================================================================

import { PATH_MAX_DEPTH, PREVIEW_LIMIT } from '../graph/budgets';
import { quoteIdentifier } from './quote';
import type { GraphDialect } from './quote';

// =============================================================================
// TYPES
// =============================================================================

/** A query ready for `read_query`. */
export interface IRecipe {
	/** The Cypher text. */
	cypher: string;
	/** Bound parameters. */
	params: Record<string, string | string[]>;
	/** The row limit to send with it. */
	limit: number;
}

/** Why a recipe could not be produced. */
export interface IRecipeRefusal {
	refusal: string;
}

/** A recipe or the reason there is none. */
export type RecipeResult = IRecipe | IRecipeRefusal;

/** What the app knows about the engine when it builds a query. */
export interface IEngine {
	dialect: GraphDialect;
	/** The engine version string from `dialect`, when the node reports one. */
	version?: string | null;
}

/** The AGE ceiling for the OR-chain connect query (no `IN` over bound ids is proven on AGE). */
export const AGE_CONNECT_MAX_NODES = 40;

/**
 * On AGE, the most drawn relationships an expansion leaves out by id. AGE 1.5.0 has no list comprehension, so each id
 * is its own parameter in an OR chain; 200 keeps the statement near 6,000 characters, inside the rocketride_graph
 * node's 10,000-character limit. Drawn relationships past this are fetched again and counted into the row limit.
 */
export const AGE_EXPAND_MAX_EXCLUDED = 200;

/**
 * Whether a recipe result is a refusal.
 *
 * @param result - A recipe result.
 * @returns True for a refusal.
 */
export function isRefusal(result: RecipeResult): result is IRecipeRefusal {
	return 'refusal' in result;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The major version number in a version string ("5.26.31" -> 5), or null.
 *
 * @param version - A version string.
 * @returns The major version, or null when it cannot be read.
 */
export function majorVersion(version: string | null | undefined): number | null {
	const match = /^\s*v?(\d+)/.exec(version ?? '');
	return match ? Number(match[1]) : null;
}

/**
 * The predicate that selects one node by its id.
 *
 * @param engine - The engine and its version.
 * @param variable - The node variable in the query.
 * @param param - The parameter holding the id.
 * @returns The predicate text, or a refusal for Neo4j older than 5 (not supported, see the README).
 */
export function idPredicate(engine: IEngine, variable: string, param: string): string | IRecipeRefusal {
	if (engine.dialect === 'neo4j') {
		const major = majorVersion(engine.version);
		if (major !== null && major < 5) return { refusal: `Neo4j ${engine.version} is older than 5; Graph Explorer needs elementId(), which arrived in Neo4j 5.` };
		return `elementId(${variable}) = $${param}`;
	}
	return `id(${variable}) = toInteger($${param})`;
}

/**
 * Clamp a number to a positive integer within bounds.
 *
 * @param value - Any number.
 * @param min - Smallest allowed.
 * @param max - Largest allowed.
 * @returns A safe integer.
 */
function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Reject an id that cannot be sent (empty, not text, absurdly long).
 *
 * @param id - A candidate id.
 * @returns True when the id may be bound.
 */
function validId(id: unknown): id is string {
	return typeof id === 'string' && id.length > 0 && id.length <= 512;
}

// =============================================================================
// RECIPES
// =============================================================================

/**
 * The first nodes of a label (the schema sidebar's click).
 *
 * @param engine - The engine.
 * @param label - A label exactly as the schema reports it.
 * @param limit - Nodes to fetch (default 25).
 * @returns The recipe, or why there is none.
 */
export function labelPreview(engine: IEngine, label: string, limit: number = PREVIEW_LIMIT): RecipeResult {
	const quoted = quoteIdentifier(label, engine.dialect);
	if (quoted === null) return { refusal: `The label "${printable(label)}" cannot be put in a generated query on this engine. Write the query by hand if it must be browsed.` };
	const n = clampInt(limit, 1, 1000);
	return { cypher: `MATCH (n:${quoted}) RETURN n LIMIT ${n}`, params: {}, limit: n };
}

/**
 * The first relationships of a type, with both end nodes (the schema sidebar's
 * click on a relationship type).
 *
 * @param engine - The engine.
 * @param type - A relationship type exactly as the schema reports it.
 * @param limit - Relationships to fetch (default 25).
 * @returns The recipe, or why there is none.
 */
export function typePreview(engine: IEngine, type: string, limit: number = PREVIEW_LIMIT): RecipeResult {
	const quoted = quoteIdentifier(type, engine.dialect);
	if (quoted === null) return { refusal: `The relationship type "${printable(type)}" cannot be put in a generated query on this engine. Write the query by hand if it must be browsed.` };
	const n = clampInt(limit, 1, 1000);
	return { cypher: `MATCH (a)-[r:${quoted}]->(b) RETURN a, r, b LIMIT ${n}`, params: {}, limit: n };
}

/**
 * One node by id (the inspector's refresh, and the stale-handle check).
 *
 * @param engine - The engine.
 * @param id - The element id (opaque string).
 * @returns The recipe, or why there is none.
 */
export function inspectNode(engine: IEngine, id: string): RecipeResult {
	if (!validId(id)) return { refusal: 'There is no usable id for this element.' };
	const predicate = idPredicate(engine, 'n', 'id');
	if (typeof predicate !== 'string') return predicate;
	return { cypher: `MATCH (n) WHERE ${predicate} RETURN n LIMIT 1`, params: { id }, limit: 1 };
}

/**
 * The relationships around a node that are not drawn yet, and the nodes at their other ends.
 *
 * `drawn` holds the ids of this node's relationships already on the canvas. They are left out of the request itself
 * (bound, never spliced), so the answer holds only relationships the canvas does not have and a repeat asks for the
 * NEXT ones. That matters because the node clamps the row count to its own cap: asking for "everything drawn plus the
 * wanted ones" stops making progress once that passes the cap, and every repeat then returns the same drawn rows.
 * `wanted + 1` rows give the wanted new neighbours when they exist, and the extra row tells the caller more exist.
 * On AGE only the first {@link AGE_EXPAND_MAX_EXCLUDED} can be left out; the rest may come back, so as many more rows
 * are asked for, and past the node's row cap a repeat can stop making progress (the caller says so).
 *
 * The node is matched on its own and its relationships OPTIONALLY: a node that still exists answers with at least one
 * row holding itself, even when nothing new hangs from it, so an empty answer always means it is no longer found.
 *
 * @param engine - The engine.
 * @param id - The element id of the node to expand.
 * @param wanted - New neighbours wanted (the per-expansion cap).
 * @param drawn - Ids of this node's relationships already drawn.
 * @returns The recipe, or why there is none.
 */
export function expandNeighbors(engine: IEngine, id: string, wanted: number, drawn: readonly string[]): RecipeResult {
	if (!validId(id)) return { refusal: 'There is no usable id for this element.' };
	const predicate = idPredicate(engine, 'n', 'id');
	if (typeof predicate !== 'string') return predicate;
	const unique = Array.from(new Set(drawn));
	const usable = unique.filter(validId);
	const left = engine.dialect === 'age' ? usable.slice(0, AGE_EXPAND_MAX_EXCLUDED) : usable;
	const params: Record<string, string | string[]> = { id };
	let exclude = '';
	if (left.length > 0 && engine.dialect === 'age') {
		left.forEach((rid, i) => {
			params[`d${i}`] = rid;
		});
		exclude = ` WHERE NOT (${left.map((_, i) => `id(r) = toInteger($d${i})`).join(' OR ')})`;
	} else if (left.length > 0) {
		params.drawn = left;
		exclude = engine.dialect === 'neo4j' ? ' WHERE NOT (elementId(r) IN $drawn)' : ' WHERE NOT (id(r) IN [x IN $drawn | toInteger(x)])';
	}
	// Drawn relationships that could not be left out may come back: ask for that many more rows.
	const rows = clampInt(clampInt(wanted, 1, 1000) + (unique.length - left.length) + 1, 2, 2000);
	return { cypher: `MATCH (n) WHERE ${predicate} OPTIONAL MATCH (n)-[r]-(m)${exclude} RETURN n, r, m LIMIT ${rows}`, params, limit: rows };
}

/**
 * The relationships among a set of nodes already on the canvas.
 *
 * @param engine - The engine.
 * @param ids - Element ids of the nodes.
 * @param max - Relationships to fetch at most.
 * @returns The recipe, or why there is none.
 */
export function connectNodes(engine: IEngine, ids: readonly string[], max: number): RecipeResult {
	const clean = Array.from(new Set(ids.filter(validId)));
	if (clean.length < 2) return { refusal: 'Connecting needs at least two nodes.' };
	const rows = clampInt(max, 1, 2000);
	if (engine.dialect === 'age') {
		// No bound list can be compared with AGE ids exactly, so each id is its own
		// parameter in an OR chain; that is bounded to keep the statement small.
		if (clean.length > AGE_CONNECT_MAX_NODES) return { refusal: `Connecting more than ${AGE_CONNECT_MAX_NODES} nodes is not supported on Apache AGE yet; select fewer nodes.` };
		const params: Record<string, string> = {};
		clean.forEach((id, i) => {
			params[`i${i}`] = id;
		});
		const either = (v: string): string => `(${clean.map((_, i) => `id(${v}) = toInteger($i${i})`).join(' OR ')})`;
		return { cypher: `MATCH (a)-[r]->(b) WHERE ${either('a')} AND ${either('b')} RETURN a, r, b LIMIT ${rows}`, params, limit: rows };
	}
	if (engine.dialect === 'neo4j') {
		const major = majorVersion(engine.version);
		if (major !== null && major < 5) return { refusal: `Neo4j ${engine.version} is older than 5; Graph Explorer needs elementId(), which arrived in Neo4j 5.` };
	}
	// Neo4j compares elementId() with the bound strings; FalkorDB converts them one by one.
	const inList = (v: string): string => (engine.dialect === 'neo4j' ? `elementId(${v}) IN $ids` : `id(${v}) IN [x IN $ids | toInteger(x)]`);
	return { cypher: `MATCH (a)-[r]->(b) WHERE ${inList('a')} AND ${inList('b')} RETURN a, r, b LIMIT ${rows}`, params: { ids: clean }, limit: rows };
}

/**
 * One path of EXACTLY `depth` relationships between two nodes (traversal in
 * either direction; each relationship keeps its stored direction in the answer).
 *
 * The depth is a literal because AGE only accepts a literal range; it is an
 * integer this function clamps to 1..10, never a value from the user.
 *
 * @param engine - The engine.
 * @param fromId - Element id of the first node.
 * @param toId - Element id of the second node.
 * @param depth - Relationships in the path (1..10).
 * @returns The recipe, or why there is none.
 */
export function pathAtDepth(engine: IEngine, fromId: string, toId: string, depth: number): RecipeResult {
	if (!validId(fromId) || !validId(toId)) return { refusal: 'There is no usable id for one of the two nodes.' };
	if (fromId === toId) return { refusal: 'Pick two different nodes.' };
	const from = idPredicate(engine, 'a', 'from');
	if (typeof from !== 'string') return from;
	const to = idPredicate(engine, 'b', 'to');
	if (typeof to !== 'string') return to;
	const d = clampInt(depth, 1, PATH_MAX_DEPTH);
	return { cypher: `MATCH p = (a)-[*${d}..${d}]-(b) WHERE ${from} AND ${to} RETURN p LIMIT 1`, params: { from: fromId, to: toId }, limit: 1 };
}

/**
 * Printable form of a name for messages (control characters shown escaped, bounded).
 *
 * @param name - Any text.
 * @returns A short single-line rendering.
 */
function printable(name: string): string {
	const text = name.length > 60 ? `${name.slice(0, 59)}…` : name;
	let out = '';
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
	}
	return out;
}
