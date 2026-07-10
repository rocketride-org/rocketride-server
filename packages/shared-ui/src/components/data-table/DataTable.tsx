// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataTable — the platform's stock sortable / searchable / paginated table.
 *
 * The table owns all UI (toolbar search, sortable headers, page-size selector,
 * Prev / N / Next footer, loading row, integrated EmptyState); the
 * {@link DataSource} it is given owns the data. Apps supply columns, a source,
 * and optional row actions — never an API call.
 *
 * All query state (page, page size, sort, debounced search) lives inside the
 * component. Any state change re-runs the query; a search / sort / page-size
 * change resets to the first page. If the source exposes `subscribe`, a live
 * change silently re-runs the CURRENT query, preserving page / sort / search.
 *
 * The footer (row count + page-size selector + pager) auto-hides when it would
 * add nothing: it is shown only when the current result set spans more than one
 * page (`total > pageSize`) — filtered or not. A set that fits one page never
 * shows a pager.
 *
 * The container draws no outer border of its own: it drops cleanly inside a
 * Card (noBodyPadding) or stands alone.
 */

import React, { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commonStyles } from '../../themes/styles';
import { EmptyState } from '../empty-state/EmptyState';
import { InputField } from '../input-field/InputField';
import { DataQuery, DataSource } from './dataSource';

// =============================================================================
// TYPES
// =============================================================================

/** One column definition for the {@link DataTable}. */
export interface DataTableColumn<Row> {
	/** Row property key this column reads (also the sort key). */
	key: string;
	/** Column header label. */
	label: string;
	/** Whether the header is clickable to sort by this column. */
	sortable?: boolean;
	/** Text alignment of the header and its cells. Defaults to `'left'`. */
	align?: 'left' | 'right';
	/** Fixed column width (px number or CSS length). */
	width?: number | string;
	/** Custom cell renderer. Default: `String(row[key])`. */
	render?: (row: Row) => ReactNode;
}

/** Props for the {@link DataTable} component. */
export interface IDataTableProps<Row> {
	/** Column definitions in display order. */
	columns: DataTableColumn<Row>[];
	/** The data source the table queries. */
	source: DataSource<Row>;
	/** Toolbar search placeholder; the search box shows only if set AND the source honors search. */
	searchPlaceholder?: string;
	/** Formats the row count shown in the toolbar and footer, e.g. `(n) => \`${n} documents\``. */
	countLabel?: (total: number) => string;
	/** Selectable page sizes; the first entry is the initial size. Defaults to `[10, 25, 50]`. */
	pageSizes?: number[];
	/** Renders a trailing Actions column of ghost small Buttons for a row. */
	actions?: (row: Row) => ReactNode;
	/**
	 * Stable React key for a row. Supply this whenever a cell holds its own state
	 * (an open menu, an inline editor): without it rows fall back to their array
	 * index, so after a sort / search / page change React reconciles cell state
	 * against whatever row now sits at that index. Default: the row's array index.
	 */
	rowKey?: (row: Row) => string | number;
	/** EmptyState content shown when the query returns no rows. */
	emptyState?: { icon?: ReactNode; title: string; description?: string; action?: ReactNode };
	/** Fired with the row when a body row is clicked. */
	onRowClick?: (row: Row) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default page-size options; the first entry is the initial page size. */
const DEFAULT_PAGE_SIZES = [10, 25, 50];
/** Debounce applied to the toolbar search input before re-querying. */
const SEARCH_DEBOUNCE_MS = 250;
/** Ascending / descending sort glyphs (small triangles drawn in the brand colour). */
const SORT_GLYPH: Record<'asc' | 'desc', string> = { asc: '▲', desc: '▼' };

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Plain block — no outer border; sits inside a Card or stands alone.
	container: {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
	} as CSSProperties,

	// Toolbar: search box + row count, above the header.
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '12px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// Toolbar search box sizing (30px tall, 260px wide).
	search: {
		width: 260,
		height: 30,
	} as CSSProperties,

	// Toolbar / footer row-count text.
	count: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// The table element itself.
	table: {
		width: '100%',
		borderCollapse: 'collapse',
	} as CSSProperties,

	// Header cell — built on commonStyles.tableHeader, tuned to the mockup.
	headerCell: (align: 'left' | 'right', sortable: boolean, width?: number | string): CSSProperties => ({
		...commonStyles.tableHeader,
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.08em',
		color: 'var(--rr-text-secondary)',
		padding: '9px 12px',
		borderBottom: '1px solid var(--rr-border)',
		textAlign: align,
		width,
		cursor: sortable ? 'pointer' : 'default',
		userSelect: 'none',
		whiteSpace: 'nowrap',
	}),

	// Small triangle glyph after a sorted column's label.
	sortArrow: {
		fontSize: 9,
		marginLeft: 4,
		color: 'var(--rr-brand)',
	} as CSSProperties,

	// Body cell — built on commonStyles.tableCell, tuned to the mockup.
	bodyCell: (align: 'left' | 'right'): CSSProperties => ({
		...commonStyles.tableCell,
		fontSize: 13,
		padding: '10px 12px',
		textAlign: align,
	}),

	// Body row — pointer + hover only when the row is clickable.
	bodyRow: (clickable: boolean): CSSProperties => ({
		cursor: clickable ? 'pointer' : 'default',
	}),

	// Full-width "Loading..." row and zero-height EmptyState wrapper cell.
	messageCell: {
		...commonStyles.tableCell,
		fontSize: 13,
		padding: '10px 12px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// EmptyState is rendered in the body region, padded from the toolbar.
	emptyWrap: {
		padding: 16,
	} as CSSProperties,

	// Footer: row count (left) + page-size selector and pager (right).
	footer: {
		display: 'flex',
		alignItems: 'center',
		gap: 14,
		padding: '10px 16px',
		borderTop: '1px solid var(--rr-border)',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Page-size <select>, pushed to the right edge; aligned to the pager height.
	pageSizeSelect: {
		marginLeft: 'auto',
		height: 26,
		padding: '0 6px',
		fontFamily: 'inherit',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		cursor: 'pointer',
	} as CSSProperties,

	// Base pagination button.
	pgBtn: (on: boolean, disabled: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		minWidth: 26,
		height: 26,
		padding: '0 8px',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		fontSize: 12,
		background: 'var(--rr-bg-default)',
		color: 'var(--rr-text-primary)',
		cursor: disabled ? 'default' : 'pointer',
		// Current page: solid brand fill, white label, bold.
		...(on
			? {
					background: 'var(--rr-brand)',
					borderColor: 'var(--rr-brand)',
					color: 'var(--rr-fg-button)',
					fontWeight: 700,
			  }
			: null),
		// Disabled (non-current) Prev / Next: dimmed and non-interactive.
		...(disabled && !on ? { opacity: 0.5, pointerEvents: 'none' } : null),
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a sortable, searchable, paginated table over a {@link DataSource}.
 *
 * @typeParam Row - Row shape supplied by the source.
 * @param props - {@link IDataTableProps}.
 * @returns The table element.
 */
export function DataTable<Row>({
	columns,
	source,
	searchPlaceholder,
	countLabel,
	pageSizes = DEFAULT_PAGE_SIZES,
	actions,
	rowKey,
	emptyState,
	onRowClick,
}: IDataTableProps<Row>): React.ReactElement {
	// --- Capabilities: undefined defaults to honored (true) ------------------
	const caps = useMemo(
		() => ({
			sort: source.capabilities?.sort !== false,
			search: source.capabilities?.search !== false,
			paginate: source.capabilities?.paginate !== false,
		}),
		[source],
	);

	// --- Query state (all internal to the component) -------------------------
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(pageSizes[0] ?? DEFAULT_PAGE_SIZES[0]);
	const [sortBy, setSortBy] = useState<string | undefined>(undefined);
	const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
	const [searchInput, setSearchInput] = useState('');
	const [search, setSearch] = useState('');

	// --- Result state --------------------------------------------------------
	const [rows, setRows] = useState<Row[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);

	// --- Refs guarding async races and unmount -------------------------------
	// Latest query, kept current every render so silent refreshes read it.
	const queryRef = useRef<DataQuery>({ page, pageSize });
	queryRef.current = { page, pageSize, sortBy, sortDir, search: search || undefined };
	// Monotonic request id — stale (superseded) responses are discarded.
	const reqIdRef = useRef(0);
	// Mounted flag — prevents setState after unmount.
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	// --- Query runner --------------------------------------------------------
	/**
	 * Runs a query against the source, discarding stale / post-unmount results.
	 *
	 * @param q - The query to run.
	 * @param showLoading - Whether to show the loading row (false for silent refreshes).
	 */
	const runQuery = useCallback(
		(q: DataQuery, showLoading: boolean): void => {
			// Claim a request id; only the newest claim may apply its result.
			const id = ++reqIdRef.current;
			if (showLoading) setLoading(true);
			Promise.resolve(source.query(q))
				.then((result) => {
					// Ignore if unmounted or a newer query superseded this one.
					if (!mountedRef.current || id !== reqIdRef.current) return;
					setRows(result.rows);
					setTotal(result.total);
					setLoading(false);
				})
				.catch(() => {
					if (!mountedRef.current || id !== reqIdRef.current) return;
					setLoading(false);
				});
		},
		[source],
	);

	// --- Debounce the search input into the committed search term ------------
	useEffect(() => {
		// One-shot debounce (not a polling loop): commit after the pause.
		const timer = setTimeout(() => {
			setSearch(searchInput);
			// Search change resets to the first page.
			setPage(0);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [searchInput]);

	// --- Query-changing effect: any query param change re-queries ------------
	useEffect(() => {
		runQuery(queryRef.current, true);
		// queryRef.current is refreshed above every render before this runs.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runQuery, page, pageSize, sortBy, sortDir, search]);

	// --- Subscribe: silent re-query of the CURRENT query on live change ------
	useEffect(() => {
		if (!source.subscribe) return;
		// On change, re-run the current query without the loading row or resets.
		return source.subscribe(() => runQuery(queryRef.current, false));
	}, [source, runQuery]);

	// --- Clamp the page when a settled result set shrank below it -------------
	useEffect(() => {
		// A silent refresh (subscribe / live update) or a caller swapping `source`
		// re-runs the query at the CURRENT page. If the row total dropped so that
		// this page now starts past the end, `slice()` returns no rows while
		// total > 0 (so EmptyState never shows) — and when total <= pageSize the
		// footer hides too, leaving no pager to escape with. Snap back to the last
		// valid page once a query has settled; the query effect then re-fetches it.
		if (loading) return;
		const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
		if (page > lastPage) setPage(lastPage);
	}, [loading, total, pageSize, page]);

	// --- Sort toggle handler -------------------------------------------------
	/**
	 * Applies a sort click for a column: activates it ascending, or toggles the
	 * direction if it is already the sort column. Resets to the first page.
	 *
	 * @param key - The clicked column's key.
	 */
	const handleSort = useCallback(
		(key: string): void => {
			if (sortBy === key) {
				// Same column: flip direction.
				setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
			} else {
				// New column: start ascending.
				setSortBy(key);
				setSortDir('asc');
			}
			setPage(0);
		},
		[sortBy],
	);

	// --- Page-size change handler --------------------------------------------
	/**
	 * Applies a new page size and resets to the first page.
	 *
	 * @param size - The selected page size.
	 */
	const handlePageSize = useCallback((size: number): void => {
		setPageSize(size);
		setPage(0);
	}, []);

	// --- Derived render values -----------------------------------------------
	// Total column count including the optional trailing Actions column.
	const colCount = columns.length + (actions ? 1 : 0);
	// Show the search box only if a placeholder was given AND the source honors search.
	const showSearch = Boolean(searchPlaceholder) && caps.search;
	// The toolbar renders only if there is a search box or a count label.
	const showToolbar = showSearch || Boolean(countLabel);
	// Row-count text: the caller's label when present, else `${n} rows`.
	const countText = countLabel ? countLabel(total) : `${total} rows`;
	// Empty when a settled (non-loading) query returned nothing.
	const isEmpty = !loading && total === 0;
	// Total pages (at least one) for the pager.
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	// Footer visibility: the footer exists to page — so it renders only when the
	// current result set actually spans more than one page. Whether a search
	// term is active is irrelevant (design-owner 2026-07-08: a filtered set that
	// fits one page must not sprout a pager); the toolbar already shows the
	// count.
	const showFooter = total > pageSize;

	return (
		<div style={styles.container}>
			{/* Toolbar: search + count. */}
			{showToolbar && (
				<div style={styles.toolbar}>
					{showSearch && (
						<InputField
							style={styles.search}
							placeholder={searchPlaceholder}
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
						/>
					)}
					{countLabel && <span style={styles.count}>{countText}</span>}
				</div>
			)}

			{/* Empty state replaces the table + footer when there are no rows. */}
			{isEmpty ? (
				<div style={styles.emptyWrap}>
					<EmptyState
						icon={emptyState?.icon}
						title={emptyState?.title ?? 'No results'}
						description={emptyState?.description}
						action={emptyState?.action}
					/>
				</div>
			) : (
				<>
					<table style={styles.table}>
						<thead>
							<tr>
								{columns.map((col) => {
									// A header is interactive only if declared sortable and the source honors sort.
									const canSort = Boolean(col.sortable) && caps.sort;
									const align = col.align ?? 'left';
									const isSorted = sortBy === col.key;
									return (
										<th
											key={col.key}
											style={styles.headerCell(align, canSort, col.width)}
											// A sortable header keeps its implicit columnheader role, exposes the
											// current sort to assistive tech via aria-sort, and is keyboard-operable
											// (focusable + Enter / Space toggles it).
											tabIndex={canSort ? 0 : undefined}
											aria-sort={
												canSort ? (isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined
											}
											onClick={canSort ? () => handleSort(col.key) : undefined}
											onKeyDown={
												canSort
													? (e) => {
															if (e.key === 'Enter' || e.key === ' ') {
																e.preventDefault();
																handleSort(col.key);
															}
													  }
													: undefined
											}
										>
											{col.label}
											{/* Direction glyph only on the active sort column. */}
											{isSorted && <span style={styles.sortArrow}>{SORT_GLYPH[sortDir]}</span>}
										</th>
									);
								})}
								{/* Trailing Actions column header. */}
								{actions && <th style={styles.headerCell('right', false)}>Actions</th>}
							</tr>
						</thead>
						<tbody>
							{/* Loading row shown on first / query-changing loads (no prior rows). */}
							{loading && rows.length === 0 ? (
								<tr>
									<td style={styles.messageCell} colSpan={colCount}>
										Loading...
									</td>
								</tr>
							) : (
								rows.map((row, idx) => (
									<tr
										key={rowKey ? rowKey(row) : idx}
										style={styles.bodyRow(Boolean(onRowClick))}
										onClick={onRowClick ? () => onRowClick(row) : undefined}
									>
										{columns.map((col) => {
											const align = col.align ?? 'left';
											// Custom renderer wins; else stringify the keyed value.
											const content = col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key]);
											return (
												<td key={col.key} style={styles.bodyCell(align)}>
													{content}
												</td>
											);
										})}
										{/* Trailing Actions cell of ghost small Buttons. */}
										{actions && (
											<td style={styles.bodyCell('right')} onClick={(e) => e.stopPropagation()}>
												{actions(row)}
											</td>
										)}
									</tr>
								))
							)}
						</tbody>
					</table>

					{/* Footer: row count + page-size selector + pager. Auto-hidden when a
					    single unfiltered page makes it redundant (see showFooter). */}
					{showFooter && (
						<div style={styles.footer}>
							<span>{countText}</span>
							{/* The whole pagination cluster hides when the source cannot paginate. */}
							{caps.paginate && (
								<>
									<select
										style={styles.pageSizeSelect}
										value={pageSize}
										onChange={(e) => handlePageSize(Number(e.target.value))}
									>
										{pageSizes.map((size) => (
											<option key={size} value={size}>
												{size} / page
											</option>
										))}
									</select>
									<Pager page={page} totalPages={totalPages} onPage={setPage} />
								</>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

// =============================================================================
// PAGER
// =============================================================================

/** Props for the internal {@link Pager}. */
interface IPagerProps {
	/** 0-based current page. */
	page: number;
	/** Total number of pages (at least one). */
	totalPages: number;
	/** Fired with the target 0-based page index. */
	onPage: (page: number) => void;
}

/**
 * Renders the Prev / current-page / (next-page) / Next control cluster.
 *
 * Shows the current page number highlighted, the following page number when one
 * exists, and Prev / Next buttons disabled at the ends.
 *
 * @param props - {@link IPagerProps}.
 * @returns The pager element.
 */
function Pager({ page, totalPages, onPage }: IPagerProps): React.ReactElement {
	// Whether the neighbouring pages exist for Prev / Next affordances.
	const hasPrev = page > 0;
	const hasNext = page < totalPages - 1;

	/** Enter / Space activate a pager control, matching native button semantics. */
	const keyActivate = (e: React.KeyboardEvent, go: () => void): void => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			go();
		}
	};

	return (
		<>
			{/* Prev — disabled on the first page. */}
			<span
				role="button"
				aria-label="Previous page"
				aria-disabled={!hasPrev || undefined}
				tabIndex={hasPrev ? 0 : -1}
				style={styles.pgBtn(false, !hasPrev)}
				onClick={hasPrev ? () => onPage(page - 1) : undefined}
				onKeyDown={hasPrev ? (e) => keyActivate(e, () => onPage(page - 1)) : undefined}
			>
				Prev
			</span>
			{/* Current page number, highlighted (non-interactive marker). */}
			<span style={styles.pgBtn(true, false)} aria-current="page">
				{page + 1}
			</span>
			{/* Next page number, when one exists. */}
			{hasNext && (
				<span
					role="button"
					aria-label={`Page ${page + 2}`}
					tabIndex={0}
					style={styles.pgBtn(false, false)}
					onClick={() => onPage(page + 1)}
					onKeyDown={(e) => keyActivate(e, () => onPage(page + 1))}
				>
					{page + 2}
				</span>
			)}
			{/* Next — disabled on the last page. */}
			<span
				role="button"
				aria-label="Next page"
				aria-disabled={!hasNext || undefined}
				tabIndex={hasNext ? 0 : -1}
				style={styles.pgBtn(false, !hasNext)}
				onClick={hasNext ? () => onPage(page + 1) : undefined}
				onKeyDown={hasNext ? (e) => keyActivate(e, () => onPage(page + 1)) : undefined}
			>
				Next
			</span>
		</>
	);
}
