// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataSource — the contract that decouples {@link DataTable} from its data.
 *
 * The table never talks to an API. It talks to a `DataSource`, which answers a
 * single question: "give me page N, sorted by X, matching filter Y." Two stock
 * adapters cover every case:
 *
 * - {@link createArrayDataSource} — the view already holds every row (Billing
 *   Rates, connection/model lists, poll snapshots). Sort / search / pagination
 *   run client-side, for free.
 * - {@link createQueryDataSource} — server-backed lists (Users, Audit Logs,
 *   paginated dashboards). The adapter forwards the {@link DataQuery} verbatim to
 *   the app's API call and returns its page + total.
 *
 * Both adapters expose a `refresh()` method and a `subscribe` hook so live
 * sources (polling, DAP push events) can make the table silently re-run its
 * current query without losing page / sort / filter state.
 *
 * STABILITY REQUIREMENT: pass {@link DataTable} a STABLE `source` reference.
 * DataTable keys its query / subscribe effects off `source` identity, so a
 * source built inline in JSX (`source={createArrayDataSource(rows)}`) is a new
 * object every render and re-subscribes on each one. Memoize it, and feed live
 * data through the array adapter's getter form rather than by rebuilding it:
 *
 *     const source = useMemo(() => createArrayDataSource(() => rowsRef.current), []);
 *     // ...then call source.refresh() when the underlying rows change.
 *
 * For a fixed array whose identity is already stable,
 * `useMemo(() => createArrayDataSource(rows), [rows])` is fine.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Parameters of one table query. */
export interface DataQuery {
	/** 0-based page index. */
	page: number;
	pageSize: number;
	/** Column key to sort by; undefined = source's natural order. */
	sortBy?: string;
	sortDir?: 'asc' | 'desc';
	/** Free-text filter from the toolbar search box. */
	search?: string;
	/**
	 * Column-scoped filters. RESERVED — DataTable does not yet populate this and
	 * has no UI for it; the array adapter ignores it. It exists so a
	 * {@link createQueryDataSource} fetcher can forward caller-supplied filters
	 * verbatim to its API without a contract change when per-column filtering
	 * lands. Do not rely on the table setting it.
	 */
	filters?: Record<string, string | number | boolean>;
}

/** One page of results. */
export interface DataPage<Row> {
	rows: Row[];
	total: number;
}

/** What the table talks to. The table NEVER calls APIs directly. */
export interface DataSource<Row> {
	query(q: DataQuery): Promise<DataPage<Row>>;
	/** What the source honors natively; the table hides affordances that are false. Default: all true. */
	capabilities?: { sort?: boolean; search?: boolean; paginate?: boolean };
	/** Optional change signal: call onChange to make the table silently re-run its current query. Returns unsubscribe. */
	subscribe?(onChange: () => void): () => void;
}

// =============================================================================
// VALUE COMPARISON
// =============================================================================

/**
 * Comparator used by the client-side array adapter's sort.
 *
 * Normalizes both operands before comparing: numbers compare numerically,
 * strings via `localeCompare`, and `null` / `undefined` sort last. Any other
 * mixed pairing falls back to a `String()` comparison with `<` / `>`.
 *
 * @param a - Left value.
 * @param b - Right value.
 * @returns Negative if `a` precedes `b`, positive if it follows, `0` if equal.
 */
function compareValues(a: unknown, b: unknown): number {
	// null / undefined always sort after any concrete value (ascending order).
	const aNil = a === null || a === undefined;
	const bNil = b === null || b === undefined;
	if (aNil && bNil) return 0;
	if (aNil) return 1;
	if (bNil) return -1;
	// Numbers compare numerically.
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
	// Strings compare with the locale-aware collator.
	if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
	// Mixed / other types: fall back to string comparison.
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}

// =============================================================================
// ARRAY ADAPTER
// =============================================================================

/**
 * Builds a {@link DataSource} over an in-memory row set.
 *
 * All operations run client-side: search is a case-insensitive substring match
 * against `String(value)` of every enumerable own property; sort uses
 * {@link compareValues}; pagination is a slice. When `rows` is a function it is
 * re-invoked on every query (a live snapshot getter), so a source backed by
 * changing state stays current.
 *
 * @typeParam Row - Row shape (must be a string-keyed record).
 * @param rows - The row set, or a getter returning the current snapshot.
 * @returns A {@link DataSource} augmented with a `refresh()` trigger.
 */
export function createArrayDataSource<Row extends Record<string, unknown>>(
	rows: Row[] | (() => Row[]),
): DataSource<Row> & { refresh(): void } {
	// Change listeners registered via subscribe(); refresh() fans out to them.
	const listeners = new Set<() => void>();

	// Snapshot getter: a function is re-invoked per query, an array used as-is.
	const snapshot = (): Row[] => (typeof rows === 'function' ? rows() : rows);

	return {
		async query(q: DataQuery): Promise<DataPage<Row>> {
			// Copy so the source's own array is never mutated by sort/filter.
			let data = snapshot().slice();

			// 1. Search: case-insensitive substring over every own value's String().
			const term = q.search?.trim().toLowerCase();
			if (term) {
				data = data.filter((row) => Object.values(row).some((v) => String(v).toLowerCase().includes(term)));
			}

			// 2. Sort: stable-ordered compare, direction applied as a multiplier.
			if (q.sortBy) {
				const key = q.sortBy;
				const dir = q.sortDir === 'desc' ? -1 : 1;
				data.sort((a, b) => compareValues(a[key], b[key]) * dir);
			}

			// 3. Total reflects the FILTERED row count, before pagination.
			const total = data.length;

			// 4. Paginate: slice the requested window out of the filtered set.
			const start = q.page * q.pageSize;
			const pageRows = data.slice(start, start + q.pageSize);

			return { rows: pageRows, total };
		},

		// The client adapter honors every affordance natively.
		capabilities: { sort: true, search: true, paginate: true },

		subscribe(onChange: () => void): () => void {
			listeners.add(onChange);
			// Unsubscribe removes just this listener.
			return () => {
				listeners.delete(onChange);
			};
		},

		refresh(): void {
			// Notify every subscriber so the table re-runs its current query.
			listeners.forEach((fn) => fn());
		},
	};
}

// =============================================================================
// QUERY ADAPTER
// =============================================================================

/**
 * Builds a {@link DataSource} over a server-backed fetcher.
 *
 * The query is forwarded verbatim to `fetcher`, which performs the API call and
 * returns its page + total. Whatever the API cannot honor is either declared in
 * `capabilities` (the table hides the affordance) or post-processed inside the
 * fetcher — the table cannot tell the difference. Shares the same
 * `refresh()` / `subscribe` mechanism as the array adapter.
 *
 * @typeParam Row - Row shape.
 * @param fetcher - Performs one query and resolves a {@link DataPage}.
 * @param capabilities - Optional declaration of what the source honors natively.
 * @returns A {@link DataSource} augmented with a `refresh()` trigger.
 */
export function createQueryDataSource<Row>(
	fetcher: (q: DataQuery) => Promise<DataPage<Row>>,
	capabilities?: DataSource<Row>['capabilities'],
): DataSource<Row> & { refresh(): void } {
	// Change listeners registered via subscribe(); refresh() fans out to them.
	const listeners = new Set<() => void>();

	return {
		query(q: DataQuery): Promise<DataPage<Row>> {
			// Forward the query untouched to the app-supplied fetcher.
			return fetcher(q);
		},

		capabilities,

		subscribe(onChange: () => void): () => void {
			listeners.add(onChange);
			// Unsubscribe removes just this listener.
			return () => {
				listeners.delete(onChange);
			};
		},

		refresh(): void {
			// Notify every subscriber so the table re-runs its current query.
			listeners.forEach((fn) => fn());
		},
	};
}
