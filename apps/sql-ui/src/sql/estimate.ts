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
// SQL — ESTIMATE (row estimates and the data browser's count planner)
// =============================================================================
//
// Pure: no client, no session. An exact COUNT(*) over a large table is slow,
// and the pager used to run one beside every page. The planner decides what a
// page request needs given what is already known: reuse a total cached for
// the same filter, read the catalog's estimate for a big unfiltered table,
// skip counting a big filtered one (the page asks for one extra row instead),
// or count exactly. On a schema-only node (`executeAllowed` false) it plans
// nothing, so no estimate or count statement is built.
// =============================================================================

import type { SqlDialect } from '../connect';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Tables with at least this many rows (by estimate) are not counted exactly. */
export const ESTIMATE_THRESHOLD = 100_000;

// =============================================================================
// ESTIMATE STATEMENTS
// =============================================================================

/** A statement and the values its `$n` placeholders bind to. */
export interface EstimateStatement {
	/** The statement; the row estimate comes back as a column named `estimate`. */
	sql: string;
	/** Bind values. */
	params: unknown[];
}

/**
 * The statement that reads one table's row estimate from the engine's own
 * catalog (no scan). Postgres `reltuples` is -1 for a table never analyzed
 * (PG 14+); MySQL `TABLE_ROWS` is a rough figure for InnoDB; ClickHouse
 * `total_rows` is NULL for engines that cannot know it.
 *
 * @param dialect - The engine dialect.
 * @param tableName - The table.
 * @returns The statement, or null when the engine has no known catalog form.
 */
export function estimateStatement(dialect: SqlDialect, tableName: string): EstimateStatement | null {
	switch (dialect) {
		case 'postgres':
			return {
				sql:
					'SELECT c.reltuples::bigint AS estimate FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
					"WHERE n.nspname = current_schema() AND c.relname = $1 AND c.relkind IN ('r', 'p', 'm')",
				params: [tableName],
			};
		case 'mysql':
			return {
				sql: 'SELECT TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1',
				params: [tableName],
			};
		case 'clickhouse':
			return {
				sql: 'SELECT total_rows AS estimate FROM system.tables WHERE database = currentDatabase() AND name = $1',
				params: [tableName],
			};
		default:
			return null;
	}
}

/**
 * Read the estimate out of the statement's rows. A negative number (-1 on a
 * table Postgres never analyzed), NULL, a missing row or a non-number all
 * mean "no estimate", and the caller counts exactly.
 *
 * @param rows - The rows the estimate statement returned.
 * @returns The estimate, or null when there is none.
 */
export function parseEstimate(rows: readonly unknown[]): number | null {
	const raw = (rows[0] as { estimate?: unknown } | undefined)?.estimate;
	if (raw === null || raw === undefined || raw === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

// =============================================================================
// COUNT PLANNER
// =============================================================================

/** What the browser knows about one table's size, and the last total it shows. */
export interface CountCache {
	/** The table. */
	table: string;
	/** The catalog estimate: undefined = not asked yet, null = none available. */
	estimate: number | null | undefined;
	/** The filter (see `countKey`) the cached total belongs to. */
	key: string | null;
	/** The cached total for that filter, or null when none is known. */
	total: number | null;
	/** Whether the cached total is an exact count (false = the catalog estimate). */
	exact: boolean;
	/** Bumped when a write invalidates the totals; a request counted before the bump cannot land its total. */
	epoch: number;
}

/** One page request, as the planner sees it. */
export interface CountRequest {
	/** The filter's key (see `countKey`). */
	key: string;
	/** Whether the request carries any search, header filter or chip. */
	filtered: boolean;
	/** Whether the connection can run statements at all (false = schema only). */
	executeAllowed: boolean;
	/** The user asked to count exactly. */
	forceExact: boolean;
	/** Whether the dialect has an estimate statement. */
	canProbe: boolean;
}

/**
 * What a page request needs for its total:
 * - `none`: send nothing (a schema-only node);
 * - `reuse`: the total for this filter is cached, so send no count;
 * - `probe`: read the catalog estimate, then plan again;
 * - `estimate`: show the catalog estimate (a big unfiltered table);
 * - `overfetch`: do not count, select one extra row (a big filtered table);
 * - `count`: run an exact COUNT(*).
 */
export type CountPlan = 'none' | 'reuse' | 'probe' | 'estimate' | 'overfetch' | 'count';

/**
 * A cache that knows nothing yet.
 *
 * @param table - The table.
 * @returns The empty cache.
 */
export function emptyCountCache(table: string): CountCache {
	return { table, estimate: undefined, key: null, total: null, exact: false, epoch: 0 };
}

/**
 * Record the catalog estimate (null when it is -1 or NULL).
 *
 * @param cache - The cache.
 * @param estimate - The parsed estimate.
 * @returns The updated cache.
 */
export function applyEstimate(cache: CountCache, estimate: number | null): CountCache {
	return { ...cache, estimate };
}

/**
 * Record the total shown for one filter.
 *
 * @param cache - The cache.
 * @param key - The filter's key.
 * @param total - The total.
 * @param exact - Whether it is an exact count.
 * @returns The updated cache.
 */
export function applyTotal(cache: CountCache, key: string, total: number, exact: boolean): CountCache {
	return { ...cache, key, total, exact };
}

/**
 * Record the total a request counted, unless a write invalidated the cache
 * after that request began (its total is then out of date).
 *
 * @param cache - The cache.
 * @param epoch - The cache's epoch when the request began.
 * @param key - The filter's key.
 * @param total - The total.
 * @param exact - Whether it is an exact count.
 * @returns The updated cache, or the cache unchanged when the epoch moved on.
 */
export function applyTotalIfCurrent(cache: CountCache, epoch: number, key: string, total: number, exact: boolean): CountCache {
	return cache.epoch === epoch ? applyTotal(cache, key, total, exact) : cache;
}

/**
 * Fold a probe's outcome into the cache. A probe the engine refused (a role
 * that cannot read the catalog) means "no estimate". A probe that failed only
 * because a newer request replaced it says nothing about the table, so
 * nothing is cached and the caller stops.
 *
 * @param cache - The cache.
 * @param probe - The rows the probe returned, or the way it failed.
 * @returns The updated cache, or null when the probe was superseded.
 */
export function applyProbeResult(cache: CountCache, probe: { rows: readonly unknown[] } | { error: true; superseded: boolean }): CountCache | null {
	if ('error' in probe) return probe.superseded ? null : applyEstimate(cache, null);
	return applyEstimate(cache, parseEstimate(probe.rows));
}

/**
 * Forget the totals (after a write changed the table) but keep what the
 * catalog said about the table's size.
 *
 * @param cache - The cache.
 * @returns The cache with no total.
 */
export function invalidateTotals(cache: CountCache): CountCache {
	return { ...cache, key: null, total: null, exact: false, epoch: cache.epoch + 1 };
}

/**
 * Decide what a page request needs for its total.
 *
 * @param cache - What is known so far.
 * @param req - The page request.
 * @returns The plan.
 */
export function planCount(cache: CountCache, req: CountRequest): CountPlan {
	// A schema-only node runs nothing, so the browser asks it nothing.
	if (!req.executeAllowed) return 'none';
	// Another page of a filter already counted: the total does not change. An
	// estimate is reused too, unless the user asked for the exact figure.
	if (cache.key === req.key && cache.total !== null && (cache.exact || !req.forceExact)) return 'reuse';
	if (req.forceExact) return 'count';
	if (cache.estimate === undefined && req.canProbe) return 'probe';
	const big = cache.estimate !== undefined && cache.estimate !== null && cache.estimate >= ESTIMATE_THRESHOLD;
	if (!big) return 'count';
	return req.filtered ? 'overfetch' : 'estimate';
}

// =============================================================================
// PAGES WITHOUT A COUNT
// =============================================================================

/** One page selected with an extra row, and the total that implies. */
export interface OverfetchedPage<Row> {
	/** The page's rows (the extra row removed). */
	rows: Row[];
	/** The smallest total consistent with what was seen: one past this page when more exist. */
	total: number;
	/** Whether more rows exist beyond this page. */
	hasMore: boolean;
}

/**
 * Turn a size + 1 select into a page. When the extra row came back, more
 * rows exist and the total is reported as one past this page, so the pager
 * offers a next page; otherwise this is the last page and the total is exact.
 *
 * @param rows - The rows the select returned (at most size + 1).
 * @param page - The 1-based page number.
 * @param size - The page size.
 * @returns The page, the implied total and whether more rows exist.
 */
export function overfetchPage<Row>(rows: readonly Row[], page: number, size: number): OverfetchedPage<Row> {
	if (rows.length > size) return { rows: rows.slice(0, size), total: page * size + 1, hasMore: true };
	return { rows: [...rows], total: (page - 1) * size + rows.length, hasMore: false };
}
