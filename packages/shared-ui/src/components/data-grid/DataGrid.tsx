// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataGrid — the platform's stock table, a thin React mount over Tabulator.
 *
 * Tabulator is a vanilla-JS library (`new Tabulator(el, options)`); this
 * component owns the React side of its lifecycle — mount/destroy, queueing
 * calls until the async `tableBuilt` event, event wiring, prop-driven data
 * updates, theme CSS, and layout persistence — so views don't reimplement it.
 *
 * It deliberately does NOT wrap Tabulator's API: `columns` are Tabulator's
 * own `ColumnDefinition` objects (plus the DataGrid's `rrNoPopup` exemption
 * marker and the `rrType` declared value type — see
 * {@link GridColumnDefinition}) and the `options` prop passes any native
 * option through. The component only adds platform defaults:
 *
 *  - the token theme (tabulator-theme.css) and EmptyState-styled placeholder
 *  - column drag-reorder, edge-drag resize, tristate header sort
 *    (Asc -> Desc -> None), and the per-column header popup with an
 *    Excel-style filter section whose control follows the column's declared
 *    `rrType` (text / checklist / Yes-No / date range / number range) —
 *    edits stay pending inside the popup until its Apply commits them —
 *    plus a live FORMAT section (alignment on every type; date/time
 *    patterns on 'date' columns; decimals / thousands / currency on
 *    'number' columns; persisted with the layout), show/hide toggles, and
 *    "Reset layout"
 *  - per-user layout persistence via {@link IDataGridPersistence}
 *  - the footer contract: footer renders only when the set spans >1 page
 *  - remote paging through `fetchPage` (DAP fetchers, not URLs)
 *  - a built-in title bar (Card-header look), ON BY DEFAULT on every grid,
 *    with a search box (REMOTE grids send the term server-side so it spans
 *    ALL pages; LOCAL grids narrow their fully-loaded rows client-side),
 *    a matching-row count, an "Export..." menu (CSV / JSON) covering every
 *    row matching the current filters and search, and a "Clear" button
 *    that appears only while a sort / search / filter deviates the view
 *    and resets exactly those three (the header popups' "Reset layout"
 *    additionally restores the declared column layout and deletes the
 *    per-user persisted state); `noSearch` / `noExport` opt out
 *    individually and the bar hides only when both are suppressed and no
 *    `title` is set
 *
 * Data modes (mutually exclusive):
 *  - LOCAL:  pass `data` — identity change applies silently (scroll, page and
 *            sort preserved), so poll-driven views can refresh freely.
 *  - REMOTE: pass `fetchPage` — one page per request with a real total;
 *            failures keep the prior rows and show a transient error overlay.
 */

import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	type CSSProperties,
	type ForwardedRef,
	type ReactElement,
	type ReactNode,
	type Ref,
} from 'react';
import type { Options } from 'tabulator-tables';
import { Tabulator } from './modules';
import { buildAutoColumns, exportRowsAsCsv, exportRowsAsJson, matchesSearch, normalizeColumns } from './defaults';
import type {
	GridColumnDefinition,
	HeaderFilterMode,
	IColumnFormat,
	IExportColumn,
	IGridInstanceState,
	IHeaderFilterBridge,
	IHeaderFormatBridge,
} from './defaults';
import { FilterStrip } from './FilterStrip';
import type { IGridFilterDef } from './FilterStrip';
import type { IDataGridPersistence } from './persistence';
import { Button } from '../button/Button';
import { commonStyles } from '../../themes/styles';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';
import './tabulator-theme.css';

// =============================================================================
// TYPES
// =============================================================================

/** One remote page request handed to {@link IDataGridProps.fetchPage}. */
export interface IDataGridPageRequest {
	/** 1-based page number (Tabulator convention; matches the saas list_* APIs). */
	page: number;
	/** Rows per page. */
	size: number;
	/** Active sorters (only populated when `remoteSort` is enabled). */
	sort: { field: string; dir: 'asc' | 'desc' }[];
	/**
	 * Committed filter values (non-empty only; {} when no filters). A string
	 * value means server-side "contains"; an array means server-side IN.
	 * Range bounds ride as separate string entries under the
	 * `${field}__gte` / `${field}__lte` keys: a 'date' column commits
	 * date-only strings or, when the popup's optional time is set,
	 * `${date}T${time}` ISO datetimes (the server makes a date-only upper
	 * bound end-of-day inclusive); a 'number' column commits numeric strings
	 * from its Min / Max inputs (the server coerces numeric bounds).
	 */
	filters: Record<string, string | string[]>;
	/**
	 * The committed title-bar search term — present only when non-empty.
	 * Forward it verbatim as the list_* `search` arg: the server matches it
	 * case-insensitively across the endpoint's searchable columns, so the
	 * search spans ALL pages (not just the loaded one).
	 */
	search?: string;
}

/** One remote page of rows plus the total row count across all pages. */
export interface IDataGridPage<Row> {
	/** The rows of the requested page. */
	rows: Row[];
	/** Total rows across every page (drives the pager). */
	total: number;
}

/** Props for the {@link DataGrid} component. */
export interface IDataGridProps<Row extends Record<string, unknown>> {
	/** Stable id keying layout persistence (required with `persistence`). */
	tableId?: string;
	/**
	 * Optional heading text at the left of the built-in title bar (Card-header
	 * look, rendered above the filter strip). The bar itself — search, count,
	 * and export — renders on EVERY grid by default regardless of the title;
	 * this prop only adds the heading. See `noSearch` / `noExport` to trim the
	 * bar's contents (the bar hides only when both are suppressed AND no title
	 * is set).
	 */
	title?: string;
	/**
	 * Hide the title bar's search input (and its matching-row count), which
	 * every grid shows by default. REMOTE grids search server-side: the term
	 * rides every page request as {@link IDataGridPageRequest.search}, so
	 * matches span ALL pages and the pager pages within the results. LOCAL
	 * grids (all rows already loaded) narrow client-side across every value.
	 * With `noExport` also set and no `title`, the whole bar disappears.
	 */
	noSearch?: boolean;
	/**
	 * Hide the title bar's "Export..." menu (CSV / JSON), which every grid
	 * shows by default. Exports cover EVERY row matching the current committed
	 * filters AND the active search term (remote grids walk all pages with
	 * both riding each request), restricted to the visible columns in display
	 * order. With `noSearch` also set, the grid contributes NO buttons at all
	 * (even the transient Clear): on a titled grid that leaves an
	 * actions-only card header — `actions` always render regardless — and
	 * with no `title`/`actions` either, the whole bar disappears.
	 */
	noExport?: boolean;
	/**
	 * Card-specific action buttons (e.g. "Add more capacity..."). Providing
	 * `actions` OR `title` switches the bar to its card-header form: the
	 * title stacked over the search + count tools on the left, and ONE
	 * vertically-centered cluster on the right — these actions first, then
	 * the grid's own buttons (Clear / Export) — under one shared fill and
	 * bottom border, so a card-hosted grid carries a single header instead
	 * of a Card header stacked on a grid bar. CardDataGrid is the same
	 * component re-typed with `title` required, for call sites where the
	 * grid IS the card.
	 */
	actions?: ReactNode;
	/**
	 * Declared column definitions — Tabulator-native plus the DataGrid's
	 * extensions ({@link GridColumnDefinition}): `rrNoPopup` (popup-exempt
	 * actions / icon columns) and `rrType`, the declared value type that
	 * selects the column's header-popup filter control. Declare EVERY
	 * available column — hidden ones with Tabulator's native `visible: false`
	 * (the default set is the visible ones; a persisted workspace layout
	 * still overrides visibility once saved). Memoize; identity change
	 * re-applies.
	 */
	columns: GridColumnDefinition[];
	/** LOCAL mode: current rows. Identity change applies silently in place. */
	data?: Row[];
	/** REMOTE mode: fetch one page. Mutually exclusive with `data`. */
	fetchPage?: (req: IDataGridPageRequest) => Promise<IDataGridPage<Row>>;
	/** Forward header-sort clicks to `fetchPage` instead of sorting locally. */
	remoteSort?: boolean;
	/** Page-size options; the first entry is the default size. */
	pageSizes?: number[];
	/** Disable pagination entirely (every row renders; no footer). */
	paginate?: boolean;
	/** Fixed height (px or CSS length) — enables internal scroll + virtual DOM. */
	height?: number | string;
	/** Empty-set placeholder title. */
	emptyTitle?: string;
	/** Empty-set placeholder description line. */
	emptyDescription?: string;
	/** Row click (ignored for clicks on action buttons inside the row). */
	onRowClick?: (row: Row) => void;
	/** Remote load failure (prior rows are kept; an overlay shows briefly). */
	onLoadError?: (error: Error) => void;
	/** Layout persistence adapter; active only when `tableId` is also set. */
	persistence?: IDataGridPersistence;
	/**
	 * Derive addable columns from the row keys: any key of the loaded rows
	 * not covered by a declared column becomes a hidden column (toggleable
	 * from the header menu, persisted like any other). The rows ARE the
	 * shape — new server fields appear automatically. Prefer declaring the
	 * full column set instead: auto columns carry no `rrType`, so they always
	 * fall back to the text filter.
	 */
	autoColumns?: boolean;
	/**
	 * Filter controls rendered in a strip above the table (grid-owned).
	 * Values auto-apply after a 300ms debounce: remote grids refetch from
	 * page 1 with the values in `req.filters`; local grids receive them via
	 * `onFiltersChange` and filter their own `data`.
	 */
	filters?: IGridFilterDef[];
	/** Debounced committed filter values (local-mode filtering hook). */
	onFiltersChange?: (values: Record<string, string | string[]>) => void;
	/**
	 * Async distinct-value lookup for the checklist filter of `rrType: 'enum'`
	 * columns (views wire it to the server's `list_distinct`). When absent,
	 * LOCAL grids derive the uniques from the current `data` rows; REMOTE
	 * grids fall back to the text filter for that column (one page of rows is
	 * not the full distinct set).
	 */
	fetchDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
	/** Native Tabulator options escape hatch — merged over the defaults. */
	options?: Options;
}

/** Imperative surface exposed through the component ref. */
export interface IDataGridHandle {
	/** The live Tabulator instance (null before mount / after unmount). */
	table: Tabulator | null;
	/**
	 * Re-run the remote query. `resetPage` returns to page 1 (after filters or
	 * search change); otherwise the current page is re-requested (mutations).
	 */
	refetch(opts?: { resetPage?: boolean }): void;
	/**
	 * Reset the grid COMPLETELY: persisted layout, sort, all filters (strip +
	 * header popups), and the grid-local search clear, then the instance
	 * rebuilds and re-queries page 1 with no filters.
	 */
	resetLayout(): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default page-size options (first entry = initial size). */
const DEFAULT_PAGE_SIZES = [10, 25, 50];

/** Debounce (ms) between the last search keystroke and the filter commit. */
const SEARCH_DEBOUNCE_MS = 250;

/** Export walk page size — the server clamps list APIs at 100 rows/page. */
const EXPORT_PAGE_SIZE = 100;

/** Export safety cap: larger sets export partially with a console warning. */
const EXPORT_ROW_CAP = 10000;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Title bar — replicates the Card header EXACTLY (source: Card.tsx
	// styles.header, which composes commonStyles.cardHeader and overrides to
	// the approved spec: left-aligned content, bottom divider, 13.5px/700
	// title), so a DataGrid title bar is indistinguishable from a Card header.
	titleBar: {
		...commonStyles.cardHeader,
		justifyContent: 'flex-start',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 13.5,
		fontWeight: 700,
	} as CSSProperties,

	// Card-header block (title and/or actions present): ONE fill and ONE
	// bottom border — a card-hosted grid must not stack two gray strips
	// (design decision 2026-07-16). Geometry (refined same day): the LEFT
	// side stacks the title over the search/count tools; the RIGHT side is a
	// single cluster — card actions then grid buttons — vertically centered
	// against the whole block. Carries the cardHeader typography (13px/600)
	// so the title is indistinguishable from a real Card header's.
	barStack: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		padding: '12px 16px',
		background: 'var(--rr-bg-titleBar-inactive)', /* cardHeader fill */
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Left side of the block: title line over the tools line.
	barLeft: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		minWidth: 0,
		flex: '1 1 auto',
	} as CSSProperties,

	// The left side's tools line (search + count).
	barTools: {
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,

	// Right-side cluster: card-specific actions LEFT of the grid buttons
	// (Clear / Export), vertically centered by the stack's align-items.
	barActions: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	// Grid-local search input — 30px inputField-look control; fixed width so
	// the bar never reflows while typing. Gains a left gap when a title
	// precedes it (the bar itself carries no gap, keeping it an exact copy of
	// the Card header values).
	search: (afterTitle: boolean): CSSProperties => ({
		...commonStyles.inputField,
		height: 30,
		width: 200,
		...(afterTitle ? { marginLeft: 12 } : {}),
	}),

	// Matching-row count after the search input — quiet metadata, not a
	// heading: the weight must be reset explicitly (the bar itself is 700 and
	// the span would inherit it) and the size sits below the footer-count's
	// 12.5px (user feedback 2026-07-16: smaller, not bold).
	count: {
		marginLeft: 10,
		fontSize: 11.5,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	// Right-aligned button cluster — Reset Layout (only while the view
	// deviates from its defaults) + the Export dropdown — pushed to the
	// bar's right edge like Card.tsx styles.headerActions.
	barRight: {
		marginLeft: 'auto',
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	// Export dropdown anchor — position:relative so the menu can absolutely
	// position below-right of the trigger button.
	exportWrap: {
		position: 'relative',
	} as CSSProperties,

	// Export dropdown menu — commonStyles.popupMenu (paper surface, --rr-border
	// edge, radius 8, widget shadow, 4px padding: the same values the
	// .tabulator-menu popups replicate in tabulator-theme.css), re-anchored
	// from fixed to absolute so it hangs below the trigger's right edge.
	exportMenu: {
		...commonStyles.popupMenu,
		position: 'absolute',
		top: '100%',
		right: 0,
		marginTop: 4,
		minWidth: 120,
	} as CSSProperties,

	// One export menu row — commonStyles.menuRow values (hover via a React
	// state flag since inline styles have no :hover); disabled rows dim and
	// refuse the pointer while an export walk is in flight.
	exportItem: (hovered: boolean, disabled: boolean): CSSProperties => ({
		...commonStyles.menuRow,
		...(hovered && !disabled ? { background: 'var(--rr-bg-list-hover)' } : {}),
		...(disabled ? { opacity: 0.5, cursor: 'default' } : {}),
	}),
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build the EmptyState-styled placeholder element Tabulator shows for a
 * zero-row set — the SAME single element for every empty render (initial
 * empty and filtered/searched-to-zero both go through the row manager's one
 * placeholder path).
 *
 * @param title - Headline (defaults to 'No results').
 * @param description - Optional secondary line.
 * @returns The placeholder element.
 */
function buildPlaceholder(title?: string, description?: string): HTMLElement {
	const wrap = document.createElement('div');
	// Tabulator wraps only STRING placeholders in its own
	// .tabulator-placeholder-contents element; a custom HTMLElement is
	// appended into .tabulator-placeholder as-is (verified in
	// tabulator_esm.mjs initializePlaceholder). The wrapper must therefore
	// carry the class itself, or the theme's EmptyState card rule — padding,
	// dashed border, surface fill — never applies.
	wrap.className = 'tabulator-placeholder-contents';
	const titleEl = document.createElement('span');
	titleEl.className = 'rr-grid-empty-title';
	titleEl.textContent = title ?? 'No results';
	wrap.appendChild(titleEl);
	if (description) {
		const descEl = document.createElement('span');
		descEl.className = 'rr-grid-empty-desc';
		descEl.textContent = description;
		wrap.appendChild(descEl);
	}
	return wrap;
}

/**
 * True when a click landed on an in-row action control — those clicks must
 * not also fire the row click.
 *
 * @param e - The native event from Tabulator's rowClick.
 * @returns Whether the event originated inside an action region.
 */
function isActionTarget(e: UIEvent): boolean {
	const target = e.target as HTMLElement | null;
	return !!target?.closest('.rr-cell-btn, [data-rr-actions]');
}

/**
 * Timestamp fragment for export filenames: `yyyyMMdd-HHmmss` in local time.
 *
 * @returns The formatted timestamp.
 */
function exportTimestamp(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, '0');
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Inner generic implementation (wrapped by forwardRef below).
 *
 * @typeParam Row - Row shape of the grid.
 * @param props - {@link IDataGridProps}.
 * @param ref - Imperative {@link IDataGridHandle}.
 * @returns The grid container element.
 */
function DataGridInner<Row extends Record<string, unknown>>(
	props: IDataGridProps<Row>,
	ref: ForwardedRef<IDataGridHandle>,
): ReactElement {
	const {
		tableId,
		title,
		actions,
		noSearch,
		noExport,
		columns,
		data,
		fetchPage,
		remoteSort = false,
		pageSizes = DEFAULT_PAGE_SIZES,
		paginate = true,
		height,
		emptyTitle,
		emptyDescription,
		onRowClick,
		onLoadError,
		persistence,
		autoColumns = false,
		filters,
		onFiltersChange,
		fetchDistinct,
		options,
	} = props;

	// ── Instance state ──────────────────────────────────────────────────────
	const containerRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<Tabulator | null>(null);
	const builtRef = useRef(false);
	// Calls made before Tabulator's async tableBuilt event are queued here.
	const queueRef = useRef<((table: Tabulator) => void)[]>([]);
	// Bumping the epoch tears down and rebuilds the instance (Reset layout).
	const [epoch, setEpoch] = useState(0);

	// ── Live-prop refs ──────────────────────────────────────────────────────
	// Tabulator options are snapshotted at build time; routing callbacks
	// through refs keeps them current without rebuilding the table.
	const fetchRef = useRef(fetchPage);
	fetchRef.current = fetchPage;
	const rowClickRef = useRef(onRowClick);
	rowClickRef.current = onRowClick;
	const loadErrorRef = useRef(onLoadError);
	loadErrorRef.current = onLoadError;
	const persistenceRef = useRef(persistence);
	persistenceRef.current = persistence;
	const dataRef = useRef(data);
	dataRef.current = data;
	const filtersChangeRef = useRef(onFiltersChange);
	filtersChangeRef.current = onFiltersChange;
	const fetchDistinctRef = useRef(fetchDistinct);
	fetchDistinctRef.current = fetchDistinct;
	const columnsRef = useRef(columns);
	columnsRef.current = columns;

	// ── Filter state (strip + header popups) ────────────────────────────────
	// Raw control values (all keys) and typeahead display labels; the compact
	// non-empty projection is what rides into fetchPage / onFiltersChange.
	// Strings come from the strip and 'text' popups (server-side "contains");
	// arrays come from checklist popups (server-side IN); 'date' / 'number'
	// popups write their bounds as `${field}__gte` / `${field}__lte` string
	// entries. Header popups batch their edits locally and commit through
	// the bridge only on Apply; the strip still auto-applies per keystroke.
	const [filterValues, setFilterValues] = useState<Record<string, string | string[]>>({});
	const [filterLabels, setFilterLabels] = useState<Record<string, string>>({});
	// Committed (compacted) values read by the remote fetch at request time.
	const committedFiltersRef = useRef<Record<string, string | string[]>>({});
	// Live mirror of filterValues for the header-popup bridge (built outside
	// React, so it reads through a ref instead of a stale closure).
	const filterValuesRef = useRef(filterValues);
	filterValuesRef.current = filterValues;

	/** Record one filter edit (the debounce effect below commits it). */
	const handleFilterChange = (key: string, value: string | string[], label?: string): void => {
		setFilterValues((prev) => ({ ...prev, [key]: value }));
		if (label !== undefined) setFilterLabels((prev) => ({ ...prev, [key]: label }));
	};

	/**
	 * True when a field has a committed (non-empty) filter. Range-typed
	 * columns (`rrType: 'date'` / `'number'`) never carry a value under
	 * their own key — they are active when EITHER of their `${field}__gte` /
	 * `${field}__lte` range keys is committed. Everything else checks its
	 * own key.
	 *
	 * @param field - The column's base field.
	 * @returns Whether the column should show the active-filter dot.
	 */
	const isFilterActive = (field: string): boolean => {
		const committed = committedFiltersRef.current;
		// Compaction already dropped '' / [] — key presence means active.
		const rrType = columnsRef.current.find((c) => c.field === field)?.rrType;
		if (rrType === 'date' || rrType === 'number') {
			return committed[`${field}__gte`] !== undefined || committed[`${field}__lte`] !== undefined;
		}
		return committed[field] !== undefined;
	};

	/**
	 * Toggle the active-filter indicator class on every column header from the
	 * committed filter values (a small brand dot via `.rr-col-filtered`).
	 * Re-run after each commit and whenever the header DOM is rebuilt
	 * (tableBuilt / setColumns), since rebuilt headers lose the class.
	 */
	const syncFilterIndicators = (): void => {
		const table = tableRef.current;
		if (!table || !builtRef.current) return;
		for (const col of table.getColumns()) {
			const field = col.getField();
			if (!field) continue;
			col.getElement().classList.toggle('rr-col-filtered', isFilterActive(field));
		}
	};

	// Auto-apply: 300ms after the last edit, commit the non-empty values and
	// either re-query from page 1 (remote) or hand them to the view (local).
	const filterInitRef = useRef(true);
	useEffect(() => {
		if (filterInitRef.current) {
			filterInitRef.current = false;
			return undefined;
		}
		const timer = setTimeout(() => {
			// Step 1: compact — drop empty strings AND empty arrays so fetchers
			// see only live filters (both spellings mean "filter off").
			const compact: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(filterValues)) {
				if (Array.isArray(value) ? value.length > 0 : value !== '') compact[key] = value;
			}
			committedFiltersRef.current = compact;
			// The Reset Layout button tracks the committed (non-empty) state.
			setFiltersActive(Object.keys(compact).length > 0);
			// Step 2: apply — remote grids restart from page 1; local grids get
			// the values and filter their own data.
			if (fetchRef.current) {
				whenBuilt((table) => void table.setData());
			} else {
				filtersChangeRef.current?.(compact);
			}
			// Step 3: reflect the committed state in the header indicators.
			syncFilterIndicators();
		}, 300);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filterValues]);

	// ── Title-bar search ────────────────────────────────────────────────────
	// Mode follows the grid's data mode. REMOTE: the committed term rides
	// every fetchPage request as `search` and re-queries from page 1, so the
	// server matches across ALL pages (its searchable string columns) and
	// the pager pages within the results. LOCAL: all rows are already loaded,
	// so a client-side predicate narrows them across every value. Mechanism
	// for LOCAL: Tabulator's Filter module with the default filterMode
	// 'local' — verified in tabulator_esm.mjs that refreshFilter() only calls
	// reloadData when filterMode is 'remote', so setFilter re-runs the local
	// data pipeline WITHOUT an ajax reload.
	const [searchText, setSearchText] = useState('');
	// Committed (trimmed) term, read by the remote request builders, the
	// LOCAL predicate, and the export path (a ref so all of them always see
	// the current term without rebuilding the instance).
	const committedSearchRef = useRef('');
	// Live mirror of the raw input for resetLayout (stashed on the Tabulator
	// instance at build time, so it reads through a ref, not a stale closure).
	const searchTextRef = useRef(searchText);
	searchTextRef.current = searchText;
	// Render mirror of "a search term is committed" — switches the title-bar
	// count into its matching-rows form in step with the actual commit (NOT
	// with the raw keystrokes, which commit 250ms later).
	const [searchActive, setSearchActive] = useState(false);

	// Commit the term 250ms after the last keystroke.
	const searchInitRef = useRef(true);
	useEffect(() => {
		if (searchInitRef.current) {
			searchInitRef.current = false;
			return undefined;
		}
		const timer = setTimeout(() => {
			const term = searchText.trim();
			committedSearchRef.current = term;
			setSearchActive(term !== '');
			if (fetchRef.current) {
				// REMOTE: re-query from page 1 — the request builder reads the
				// committed term and sends it server-side.
				whenBuilt((table) => void table.setData());
			} else {
				whenBuilt((table) => {
					// Step 1: install / clear the predicate over the loaded rows.
					if (term) {
						table.setFilter((row: Record<string, unknown>) => matchesSearch(row, committedSearchRef.current));
					} else {
						table.clearFilter(false);
					}
					// Step 2: the filter refresh is synchronous and local-only,
					// so re-run the page clamp and the footer contract by hand
					// (local paging recomputes max pages from the narrowed set).
					clampPage();
					syncFooter();
				});
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchText]);

	// ── Per-column display formats (header popup FORMAT section) ───────────
	// Live map of field -> IColumnFormat override (alignment, date/time
	// pattern, number decimals/separators). The popup edits it through the
	// __rrFormat bridge; the wrapping cell formatters (normalizeColumns) read
	// it at render time through the instance stash. Persisted under the
	// RR-private 'format' blob so Reset layout's clear() wipes it with the
	// rest of the layout while the Clear button leaves it alone.
	const formatsRef = useRef<Record<string, IColumnFormat>>({});

	// ── Clear button (title bar) ────────────────────────────────────────────
	// Render mirrors of "the grid deviates from its default DATA view": an
	// active sort, a committed search, or any committed filter makes the bar
	// show a Clear button (resets those three; the layout stays). Sort is
	// tracked from the remote request builder (authoritative for remote
	// grids — every sort change reloads) and the 'dataSorted' event (local
	// pipeline); filters from the same debounced commit the fetchers read.
	const [sortActive, setSortActive] = useState(false);
	const [filtersActive, setFiltersActive] = useState(false);

	// ── Matching-row count (title bar) ──────────────────────────────────────
	// The "N" of the count: remote grids capture the server total from the
	// last fetchPage result (updated in the ajaxRequestFunc .then — with a
	// search active that total already reflects it, since the term rides the
	// request); local grids read data.length directly at render. Null until
	// the first load.
	const [totalRows, setTotalRows] = useState<number | null>(null);
	// The "X" of the LOCAL "X of N rows": Tabulator's active (post-predicate)
	// row count, refreshed on the 'dataFiltered' event — verified in
	// tabulator_esm.mjs that the Filter module dispatches it with the
	// post-filter row set on every local pipeline refresh, so the count
	// tracks the search predicate.
	const [activeCount, setActiveCount] = useState<number | null>(null);

	// ── Export (CSV / JSON of every matching row) ───────────────────────────
	// One "Export..." trigger opens a small format menu; the menu items
	// disable while a walk is in flight; failures warn and re-enable.
	const [exporting, setExporting] = useState(false);
	// Re-entry guard (state updates flush async; the ref blocks double-clicks
	// landing before the disabled render).
	const exportingRef = useRef(false);
	// Dropdown open state + hovered row (inline styles have no :hover).
	const [exportMenuOpen, setExportMenuOpen] = useState(false);
	const [exportHover, setExportHover] = useState<'csv' | 'json' | null>(null);
	// The trigger + menu wrapper, for the outside-click dismissal check.
	const exportWrapRef = useRef<HTMLDivElement>(null);

	// While the export menu is open: outside-click AND Escape both dismiss it.
	useEffect(() => {
		if (!exportMenuOpen) return undefined;
		// Step 1: any pointer-down outside the trigger/menu wrapper closes.
		const onPointerDown = (event: MouseEvent): void => {
			if (!exportWrapRef.current?.contains(event.target as Node)) {
				setExportMenuOpen(false);
			}
		};
		// Step 2: Escape closes too (keyboard parity with the header popups).
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') setExportMenuOpen(false);
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [exportMenuOpen]);

	/**
	 * The grid's currently VISIBLE columns in display order, as export
	 * descriptors. Action pseudo-fields (starting '__') and popup-exempt columns
	 * (`rrNoPopup` actions / icon columns) are skipped.
	 */
	const collectExportColumns = (): IExportColumn[] => {
		const table = tableRef.current;
		if (!table || !builtRef.current) return [];
		const out: IExportColumn[] = [];
		for (const col of table.getColumns()) {
			if (!col.isVisible()) continue;
			const field = col.getField();
			if (!field || field.startsWith('__') || isPopupExempt(field)) continue;
			out.push({ field, title: String(col.getDefinition().title ?? field) });
		}
		return out;
	};

	/**
	 * Gather EVERY row matching the grid's current filters and search (not
	 * just the loaded page). LOCAL mode starts from the current `data` prop
	 * (which already reflects the view's strip filtering) and applies the
	 * client-side search predicate. REMOTE mode walks all pages through
	 * `fetchPage` with the committed filters, search term, and current sort
	 * riding each request — the server narrows, so no client re-filter (its
	 * match rules differ) — up to {@link EXPORT_ROW_CAP}.
	 *
	 * @returns The matching rows plus whether the cap truncated the set.
	 */
	const collectExportRows = async (): Promise<{ rows: Record<string, unknown>[]; partial: boolean }> => {
		let rows: Record<string, unknown>[];
		let partial = false;
		const fetchPageFn = fetchRef.current;
		if (!fetchPageFn) {
			// LOCAL: the data prop is the full (strip-filtered) set already;
			// the active search predicate narrows it like the grid does.
			rows = (dataRef.current ?? []) as Record<string, unknown>[];
			const term = committedSearchRef.current;
			if (term) rows = rows.filter((row) => matchesSearch(row, term));
		} else {
			// REMOTE: mirror what the grid itself sends — committed filters and
			// search always; the current sorters only when the grid sorts
			// remotely.
			const sort = remoteSort && tableRef.current && builtRef.current
				? tableRef.current.getSorters().map((sorter) => ({ field: sorter.field, dir: sorter.dir }))
				: [];
			rows = [];
			let total = Number.POSITIVE_INFINITY;
			let page = 1;
			// Walk page 1..N until the server total is covered or the cap trips.
			while (rows.length < total && rows.length < EXPORT_ROW_CAP) {
				const result = await fetchPageFn({
					page,
					size: EXPORT_PAGE_SIZE,
					sort,
					filters: committedFiltersRef.current,
					...(committedSearchRef.current ? { search: committedSearchRef.current } : {}),
				});
				total = result.total;
				rows.push(...(result.rows as Record<string, unknown>[]));
				// A short page means the server is exhausted — stop even if its
				// reported total was optimistic (guards an endless walk).
				if (result.rows.length < EXPORT_PAGE_SIZE) break;
				page += 1;
			}
			if (rows.length < total) {
				partial = true;
				console.warn(`DataGrid export: capped at ${rows.length} of ${total} matching rows; exporting what was fetched.`);
			}
		}
		return { rows, partial };
	};

	/**
	 * Run one export end to end: gather the matching rows, snapshot the
	 * visible columns, and download as `format`. Failures log a console
	 * warning and re-enable the buttons (no dialog — exports are best-effort).
	 *
	 * @param format - 'csv' or 'json'.
	 */
	const runExport = (format: 'csv' | 'json'): void => {
		if (exportingRef.current) return;
		exportingRef.current = true;
		setExporting(true);
		void collectExportRows()
			.then(({ rows, partial }) => {
				// Columns snapshot after the walk so late layout edits count.
				const exportColumns = collectExportColumns();
				// Truncated exports advertise it in the filename ('-partial').
				const filename = `${tableId ?? 'export'}-${exportTimestamp()}${partial ? '-partial' : ''}.${format}`;
				if (format === 'csv') exportRowsAsCsv(rows, exportColumns, filename);
				else exportRowsAsJson(rows, exportColumns, filename);
			})
			.catch((error: unknown) => {
				console.warn('DataGrid export failed:', error);
			})
			.finally(() => {
				exportingRef.current = false;
				setExporting(false);
			});
	};

	/**
	 * Export-menu item click: ignored while a walk is in flight (the rows
	 * render disabled), otherwise dismiss the menu and run the export.
	 *
	 * @param format - 'csv' or 'json'.
	 */
	const handleExportSelect = (format: 'csv' | 'json'): void => {
		if (exportingRef.current) return;
		setExportMenuOpen(false);
		runExport(format);
	};

	// ── Header-popup filter bridge ──────────────────────────────────────────
	// The popup panel is built outside React (defaults.buildHeaderPopup); it
	// reaches grid state through this bridge, stashed on the Tabulator
	// instance (IGridInstanceState.__rrHeaderFilter) at build time.

	/**
	 * True when the declared column for a field carries the `rrNoPopup`
	 * marker. Reads the retained PRE-normalized `columns` prop (the marker is
	 * stripped before definitions reach Tabulator); auto-derived columns are
	 * never declared, so they are never exempt.
	 */
	const isPopupExempt = (field: string): boolean =>
		columnsRef.current.find((c) => c.field === field)?.rrNoPopup === true;

	/**
	 * Resolve the filter control of a field from its declared column type
	 * ({@link GridColumnDefinition.rrType} on the retained pre-normalized
	 * defs):
	 *
	 *  - action pseudo-fields ('__*') and `rrNoPopup` columns: 'none'
	 *  - 'boolean' → static Yes/No checklist; 'date' → Start/End range;
	 *    'number' → Min/Max range (both ranges commit `${field}__gte` /
	 *    `${field}__lte` bounds)
	 *  - 'enum' → distinct-value checklist, downgraded to 'text' on a REMOTE
	 *    grid without `fetchDistinct` — the page at hand is only one page of
	 *    rows, not the full distinct set, so a checklist would lie
	 *  - 'string' / 'strings' / 'json' and undeclared fields (including
	 *    auto-derived columns) → 'text' (server-side "contains" / coercion
	 *    handles the rest)
	 */
	const resolveFilterMode = (field: string): HeaderFilterMode => {
		// Action pseudo-fields ('__rrActions', ...) never filter; neither do
		// columns that opted out of the header popup entirely (rrNoPopup).
		if (field.startsWith('__') || isPopupExempt(field)) return 'none';
		const rrType = columnsRef.current.find((c) => c.field === field)?.rrType;
		switch (rrType) {
			case 'boolean':
				return 'boolean';
			case 'date':
				return 'date';
			case 'number':
				return 'number';
			case 'enum':
				// A checklist needs an enumeration source: remote grids derive
				// nothing from their single loaded page, so without a
				// fetchDistinct they fall back to the text filter.
				return fetchRef.current && !fetchDistinctRef.current ? 'text' : 'values';
			default:
				// 'string' / 'strings' / 'json' / undeclared.
				return 'text';
		}
	};

	/**
	 * Distinct values of a field for a 'values' checklist: the view's
	 * `fetchDistinct` when wired (server `list_distinct`), otherwise derived
	 * from the current LOCAL rows (remote grids never reach this branch —
	 * {@link resolveFilterMode} already fell back to 'text').
	 */
	const getDistinctValues = (field: string): Promise<(string | number | boolean)[]> => {
		if (fetchDistinctRef.current) return fetchDistinctRef.current(field);
		// LOCAL derivation: unique primitive values of the current data rows.
		const rows = (dataRef.current ?? []) as Record<string, unknown>[];
		const seen = new Set<string>();
		const values: (string | number | boolean)[] = [];
		for (const row of rows) {
			const value = row[field];
			if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
			if (value === '') continue;
			const key = String(value);
			if (seen.has(key)) continue;
			seen.add(key);
			values.push(value);
		}
		// Human sort (numeric-aware) so the checklist reads naturally.
		values.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
		return Promise.resolve(values);
	};

	// ── Auto-columns ────────────────────────────────────────────────────────
	// Row keys already covered by a column (declared or previously auto-added);
	// reset on rebuild so Reset layout re-derives from the next data load.
	const autoKeysRef = useRef<Set<string>>(new Set());

	/**
	 * Extend the column set with hidden columns for any row keys not covered
	 * yet (the rows ARE the shape). Persisted visibility/width for an auto
	 * column is re-applied, so a user-shown extra survives reloads even
	 * though it is created after the persisted layout was restored.
	 */
	const maybeExtendColumns = (rows: Record<string, unknown>[] | undefined): void => {
		if (!autoColumns || !rows || rows.length === 0) return;
		// Step 1: what is already covered — declared fields + added autos.
		if (autoKeysRef.current.size === 0) {
			for (const def of columns) {
				if (def.field) autoKeysRef.current.add(def.field);
			}
		}
		// Step 2: build defs for the uncovered keys of the sample row.
		const persisted = tableId && persistenceRef.current
			? persistenceRef.current.read(tableId, 'columns')
			: undefined;
		const extras = buildAutoColumns(
			rows[0],
			autoKeysRef.current,
			Array.isArray(persisted) ? persisted : undefined,
		);
		if (extras.length === 0) return;
		for (const def of extras) {
			if (def.field) autoKeysRef.current.add(def.field);
		}
		// Step 3: append after the current defs — deferred a tick so a load in
		// progress settles before the column set changes. Extras are normalized
		// so they get the per-column header popup like declared columns.
		setTimeout(() => {
			whenBuilt((table) => {
				table.setColumns([...table.getColumnDefinitions(), ...normalizeColumns(extras)]);
				// setColumns rebuilds the header — restore active-filter dots.
				syncFilterIndicators();
			});
		}, 0);
	};

	/** Run now if built, otherwise queue for the tableBuilt flush. */
	const whenBuilt = (fn: (table: Tabulator) => void): void => {
		const table = tableRef.current;
		if (table && builtRef.current) fn(table);
		else queueRef.current.push(fn);
	};

	/** Snap the page back in range after a local data shrink. */
	const clampPage = (): void => {
		const table = tableRef.current;
		if (!table || !builtRef.current) return;
		const max = table.getPageMax();
		const page = table.getPage();
		if (typeof max === 'number' && typeof page === 'number' && max >= 1 && page > max) {
			void table.setPage(max);
		}
	};

	/** Toggle the footer-hiding class per the multi-page contract. */
	const syncFooter = (): void => {
		const table = tableRef.current;
		const el = containerRef.current;
		if (!table || !el || !builtRef.current) return;
		const max = table.getPageMax();
		el.classList.toggle('rr-grid--single-page', typeof max !== 'number' || max <= 1);
	};

	/**
	 * Shared reset mechanics behind the title bar's Clear button and the
	 * header popups' Reset layout row: clears every DATA-VIEW deviation —
	 * sort (it dies with the torn-down instance), every filter (strip +
	 * header popups: raw values, typeahead labels, AND the committed
	 * projection), and the search — then rebuilds. The fresh instance's own
	 * initial load re-queries page 1 with the now-empty filters, and
	 * tableBuilt's syncFilterIndicators clears every header dot from the
	 * empty committed record.
	 *
	 * @param wipeLayout - true (Reset layout) ALSO deletes the table's
	 *     persisted per-user state, so the rebuild restores the declared
	 *     column set / widths / order / page size; false (Clear) leaves the
	 *     layout and its persisted state untouched — only the persisted sort
	 *     blob is emptied, so the rebuilt instance does not restore the very
	 *     sort it just cleared.
	 */
	const performReset = (wipeLayout: boolean): void => {
		// Step 1: re-arm the debounce guards before the state writes —
		// setFilterValues({}) always changes identity, so its effect always
		// fires, and unguarded it would re-commit 300ms later and issue a
		// redundant second fetch on top of the rebuild's own initial load.
		// The SEARCH guard is re-armed only when there is text to clear:
		// setSearchText('') bails out entirely when the search was already
		// empty (primitive state — the effect never fires), so an
		// unconditionally armed guard could survive and swallow the user's
		// next real commit; when text IS cleared the effect fires exactly
		// once, and unguarded its delayed commit would re-query (remote
		// grids send the search server-side) on top of the rebuild's load.
		filterInitRef.current = true;
		if (searchTextRef.current !== '') searchInitRef.current = true;
		// Step 2: clear every filter surface — raw control values, typeahead
		// labels, and the committed projection the fetchers read.
		setFilterValues({});
		setFilterLabels({});
		committedFiltersRef.current = {};
		// Local grids filter their own `data` from onFiltersChange — hand
		// them the cleared values now, since the guarded debounce won't.
		if (!fetchRef.current) filtersChangeRef.current?.({});
		// Step 3: clear the grid-local search (input, committed term, and the
		// count-mode flag). The predicate itself dies with the instance, as
		// does the sort — drop the Clear button's signals with them.
		setSearchText('');
		committedSearchRef.current = '';
		setSearchActive(false);
		setSortActive(false);
		setFiltersActive(false);
		// Step 4: persisted state — Reset layout deletes the table's whole
		// per-user entry; Clear only EMPTIES the sort blob (a write, not a
		// clear, so persisted columns / widths / page size survive the
		// rebuild) — then rebuild (the fresh instance re-queries page 1 with
		// the now-empty filters, and tableBuilt's syncFilterIndicators clears
		// every header dot).
		if (tableId) {
			if (wipeLayout) persistenceRef.current?.clear(tableId);
			else persistenceRef.current?.write(tableId, 'sort', []);
		}
		// Display formats are LAYOUT state: Reset layout drops them (in-memory
		// too, covering non-persisted grids — persisted ones also re-seed {}
		// from the cleared store); Clear leaves them untouched.
		if (wipeLayout) formatsRef.current = {};
		builtRef.current = false;
		setEpoch((e) => e + 1);
	};

	/**
	 * The title bar's Clear action: back to the default DATA view — filters,
	 * sort, and search — keeping the user's column layout as it is.
	 */
	const clearView = (): void => performReset(false);

	/**
	 * The header popups' Reset layout action: everything Clear does PLUS the
	 * column layout — the per-user persisted state is deleted and the rebuild
	 * restores the declared defaults (columns, widths, order, page size).
	 */
	const resetLayout = (): void => performReset(true);

	// ── Build / destroy ─────────────────────────────────────────────────────
	useEffect(() => {
		if (!containerRef.current) return undefined;
		// Reset layout rebuilds from primaries; autos re-derive on next load.
		autoKeysRef.current = new Set();
		const remote = !!fetchRef.current;
		const persist = !!(tableId && persistenceRef.current);

		// Seed the display-format map from its persisted blob (Reset layout's
		// clear() deleted it -> {} -> declared rendering; Clear's sort-only
		// write left it alone -> the user's formats survive the rebuild).
		if (persist) {
			const storedFormats = persistenceRef.current!.read(tableId!, 'format');
			formatsRef.current =
				storedFormats && typeof storedFormats === 'object'
					? { ...(storedFormats as Record<string, IColumnFormat>) }
					: {};
		}

		// Column defaults: shared layout behavior only. The header popup
		// (filter + column visibility + reset) is wired PER COLUMN by
		// normalizeColumns, so `rrNoPopup` columns simply never receive the
		// option — no defaults-level popup that exempt columns would inherit.
		const columnDefaultsBase: Options['columnDefaults'] = {
			headerSort: false,
			// Header clicks cycle Asc -> Desc -> None -> Asc (verified in
			// tabulator_esm.mjs 6.5.2: the Sort module's tristate branch steps
			// startingDir -> opposite -> none, and the none step runs
			// Sort.clear() = setSort([]) — remoteSort grids then send an empty
			// sort array, so the server falls back to its default order, and
			// the theme's aria-sort CSS hides the arrow again).
			headerSortTristate: true,
			vertAlign: 'middle',
			resizable: 'header',
		};

		// Step 1: assemble the option set — platform defaults, then the mode
		// block (local vs remote), then persistence, then the caller's
		// escape-hatch options merged last (columnDefaults merged one level).
		// Columns are normalized: the rrNoPopup marker is stripped and the
		// header popup is attached to every non-exempt column.
		const built: Options = {
			layout: 'fitColumns',
			columns: normalizeColumns(columns),
			placeholder: buildPlaceholder(emptyTitle, emptyDescription),
			movableColumns: true,
			columnDefaults: {
				...columnDefaultsBase,
				...options?.columnDefaults,
			},
			...(height != null ? { height } : {}),
			...(paginate
				? {
						pagination: true,
						paginationMode: remote ? 'remote' : 'local',
						paginationSize: pageSizes[0],
						paginationSizeSelector: pageSizes.length > 1 ? pageSizes : false,
						paginationCounter: 'rows',
				  }
				: {}),
			...(remote
				? {
						// The URL is a required-but-unused token; every request is
						// served by the view's fetchPage through the ref.
						ajaxURL: tableId ?? 'rr-grid',
						sortMode: remoteSort ? 'remote' : undefined,
						dataLoaderError: 'Failed to load — showing previous results.',
						dataLoaderErrorTimeout: 4000,
						ajaxRequestFunc: (_url: string, _config: unknown, params: Record<string, unknown>) => {
							const page = typeof params.page === 'number' ? params.page : 1;
							const size = typeof params.size === 'number' ? params.size : pageSizes[0];
							const sort = (params.sort ?? params.sorters ?? []) as { field: string; dir: 'asc' | 'desc' }[];
							// Every sort change reloads remotely, so the request's
							// sorters are the authoritative active-sort signal.
							setSortActive(sort.length > 0);
							// Committed filters AND the committed search term ride
							// along with every request (search only when non-empty).
							return fetchRef.current!({
								page,
								size,
								sort,
								filters: committedFiltersRef.current,
								...(committedSearchRef.current ? { search: committedSearchRef.current } : {}),
							}).then((result) => {
								// The rows are the shape: derive addable columns.
								maybeExtendColumns(result.rows as Record<string, unknown>[]);
								// The server total feeds the title bar's row count.
								setTotalRows(result.total);
								return {
									data: result.rows,
									last_page: Math.max(1, Math.ceil(result.total / size)),
									last_row: result.total,
								};
							});
						},
				  }
				: { data: (dataRef.current ?? []) as Record<string, unknown>[] }),
			...(persist
				? {
						persistence: { sort: true, columns: ['width', 'visible'], page: { size: true, page: false } },
						persistenceID: tableId,
						persistenceMode: true,
						// Tabulator PREFIXES persistenceID before handing it to the
						// reader/writer (verified in tabulator_esm.mjs 6.5.2:
						// this.id = "tabulator-" + id), which silently forked the
						// store keys: Tabulator saved/restored under the prefixed
						// key while the grid's own paths (Clear's empty-sort write,
						// Reset layout's clear, auto-column width re-application)
						// targeted the raw tableId — so Clear could never empty the
						// sort Tabulator then restored. Ignore Tabulator's id and
						// key EVERYTHING by the raw tableId.
						persistenceReaderFunc: (_id: string, type: string) =>
							persistenceRef.current?.read(tableId!, type) ?? false,
						persistenceWriterFunc: (_id: string, type: string, blob: unknown) =>
							persistenceRef.current?.write(tableId!, type, blob),
				  }
				: {}),
			...options,
			// columnDefaults from `options` was already folded in above; make
			// sure a plain `...options` spread doesn't clobber the merge.
			...(options?.columnDefaults
				? { columnDefaults: { ...columnDefaultsBase, ...options.columnDefaults } }
				: {}),
		} as Options;

		// Step 2: create the instance and wire events.
		const table = new Tabulator(containerRef.current, built);
		tableRef.current = table;

		// Expose the reset action to the header popup (built outside React).
		if (persist) {
			(table as IGridInstanceState).__rrResetLayout = resetLayout;
		}

		// Header-popup filter bridge: the popup panel (also built outside
		// React) reads modes/values and writes edits through this stash; every
		// write rides the same debounced pipeline as the filter strip.
		const bridge: IHeaderFilterBridge = {
			mode: resolveFilterMode,
			getValue: (field) => filterValuesRef.current[field] ?? '',
			setValue: (field, value) => {
				handleFilterChange(field, value);
				// Instant indicator feedback — don't wait for the 300ms commit.
				const col = table.getColumns().find((c) => c.getField() === field);
				const active = Array.isArray(value) ? value.length > 0 : value !== '';
				col?.getElement().classList.toggle('rr-col-filtered', active);
			},
			// Range API for range-typed ('date' / 'number') columns — keyed
			// off the BASE field; the bounds live in the shared filter record
			// under the suffixed `${field}__gte` / `${field}__lte` keys.
			getRange: (field) => {
				const values = filterValuesRef.current;
				const start = values[`${field}__gte`];
				const end = values[`${field}__lte`];
				return {
					start: typeof start === 'string' ? start : '',
					end: typeof end === 'string' ? end : '',
				};
			},
			setRange: (field, range) => {
				// Step 1: write the provided bounds in ONE state update (so a
				// popup "Clear" of both bounds commits as a single edit); an
				// omitted bound is left untouched, '' clears one.
				setFilterValues((prev) => {
					const next = { ...prev };
					if (range.start !== undefined) next[`${field}__gte`] = range.start;
					if (range.end !== undefined) next[`${field}__lte`] = range.end;
					return next;
				});
				// Step 2: instant indicator feedback — merge the edit over the
				// live values (state flushes async) and mark the column active
				// while EITHER bound is non-empty.
				const merged = { ...filterValuesRef.current };
				if (range.start !== undefined) merged[`${field}__gte`] = range.start;
				if (range.end !== undefined) merged[`${field}__lte`] = range.end;
				const start = merged[`${field}__gte`];
				const end = merged[`${field}__lte`];
				const active =
					(typeof start === 'string' && start !== '') ||
					(typeof end === 'string' && end !== '');
				const col = table.getColumns().find((c) => c.getField() === field);
				col?.getElement().classList.toggle('rr-col-filtered', active);
			},
			getDistinct: getDistinctValues,
			isPopupExempt,
		};
		(table as IGridInstanceState).__rrHeaderFilter = bridge;

		// Header-popup FORMAT bridge: live per-column display picks. Each set()
		// merges the patch (undefined values CLEAR keys), persists the map, and
		// reformats the loaded rows in place so every cell re-runs its wrapped
		// formatter. Deliberately NOT redraw(true): a force redraw re-measures
		// column widths against the PRE-format cell content and clobbers
		// user-set widths — a format change must never move the columns.
		const formatBridge: IHeaderFormatBridge = {
			get: (field) => formatsRef.current[field],
			set: (field, patch) => {
				// Step 1: merge, dropping keys the patch explicitly cleared.
				const merged: IColumnFormat = { ...formatsRef.current[field], ...patch };
				for (const key of Object.keys(merged) as (keyof IColumnFormat)[]) {
					if (merged[key] === undefined) delete merged[key];
				}
				// Step 2: an emptied override disappears from the map entirely.
				if (Object.keys(merged).length === 0) delete formatsRef.current[field];
				else formatsRef.current[field] = merged;
				// Step 3: persist (RR-private blob type) and re-render in place.
				// row.reformat() rebuilds each visible row's cells (verified in
				// tabulator_esm.mjs: reinitialize -> initialize(true), rows off
				// the virtual window re-render lazily on scroll) — widths stay.
				if (tableId) persistenceRef.current?.write(tableId, 'format', { ...formatsRef.current });
				whenBuilt((t) => {
					for (const row of t.getRows()) row.reformat();
				});
			},
		};
		(table as IGridInstanceState).__rrFormat = formatBridge;

		table.on('tableBuilt', () => {
			builtRef.current = true;
			// Flush calls parked while Tabulator was still building.
			const queued = queueRef.current.splice(0);
			for (const fn of queued) fn(table);
			// LOCAL mode: the initial data is already here — derive columns.
			maybeExtendColumns(dataRef.current as Record<string, unknown>[] | undefined);
			syncFooter();
			// Restore active-filter dots (a rebuild loses header classes).
			syncFilterIndicators();
		});
		table.on('rowClick', (e, row) => {
			if (isActionTarget(e as UIEvent)) return;
			rowClickRef.current?.(row.getData() as Row);
		});
		table.on('dataProcessed', syncFooter);
		table.on('pageLoaded', syncFooter);
		// LOCAL grids sort in the data pipeline (no request to observe), so
		// the active-sort signal for the Reset Layout button comes from the
		// 'dataSorted' event, which carries the current sorter list.
		table.on('dataSorted', (sorters) => {
			setSortActive(sorters.length > 0);
		});
		// Track the active (post grid-local-search) row count for the title
		// bar's "X of N rows" readout. The Filter module dispatches
		// 'dataFiltered' with the post-filter set on every local pipeline
		// refresh (verified in tabulator_esm.mjs), including the unfiltered
		// case, so the count never goes stale.
		table.on('dataFiltered', () => {
			setActiveCount(table.getDataCount('active'));
		});
		table.on('dataLoadError', (error) => {
			loadErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
		});

		// Step 3: teardown reverses everything.
		return () => {
			builtRef.current = false;
			tableRef.current = null;
			table.destroy();
		};
		// Rebuild only on explicit epoch bumps (Reset layout) — options are a
		// deliberate snapshot; live values flow through the refs above.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [epoch]);

	// ── Prop-driven updates ─────────────────────────────────────────────────

	// LOCAL mode: apply new rows silently (keeps scroll / page / sort), then
	// clamp the page in case the set shrank beneath it.
	useEffect(() => {
		if (!data) return;
		maybeExtendColumns(data as Record<string, unknown>[]);
		whenBuilt((table) => {
			void table.replaceData(data as Record<string, unknown>[]).then(clampPage);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data]);

	// Column identity change: re-apply definitions (views memoize columns, so
	// this fires only when they genuinely change). Definitions are normalized
	// (rrNoPopup stripped, header popup attached per column) and the rebuilt
	// header gets its active-filter dots restored.
	const columnsInitRef = useRef(true);
	useEffect(() => {
		if (columnsInitRef.current) {
			columnsInitRef.current = false;
			return;
		}
		whenBuilt((table) => {
			table.setColumns(normalizeColumns(columns));
			syncFilterIndicators();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [columns]);

	// ── Imperative handle ───────────────────────────────────────────────────
	useImperativeHandle(ref, () => ({
		get table() {
			return tableRef.current;
		},
		refetch(opts?: { resetPage?: boolean }) {
			whenBuilt((table) => {
				if (opts?.resetPage) {
					// setData() restarts the remote query from page 1.
					void table.setData();
				} else {
					const page = table.getPage();
					void table.setPage(typeof page === 'number' ? page : 1);
				}
			});
		},
		resetLayout,
	}));

	// ── Render ──────────────────────────────────────────────────────────────
	// Bar activation (see the prop JSDoc): the bar with search + export is ON
	// BY DEFAULT on every grid; `noSearch` / `noExport` opt out individually.
	// A `title` and/or `actions` switches it to the card-header block (title
	// over tools left, centered actions + grid buttons right, one shared
	// fill + border) so a card-hosted grid never stacks a Card header on a
	// grid bar; with neither, the single tool row renders alone, and the bar
	// disappears entirely only when search and export are both suppressed
	// too.
	const hasTitle = title !== undefined;
	const hasIdentityRow = hasTitle || actions !== undefined;
	const showSearch = noSearch !== true;
	const showExport = noExport !== true;
	const showBar = hasIdentityRow || showSearch || showExport;
	const hasStrip = !!filters && filters.length > 0;
	// Clear renders only while something deviates the DATA view from its
	// defaults — an active sort, a committed search, or a committed filter.
	const clearVisible = sortActive || searchActive || filtersActive;

	// Matching-row count. LOCAL grids know both numbers — the data prop
	// length (N) and Tabulator's post-predicate active count (X) — so an
	// active search reads "X of N rows". REMOTE grids send the search
	// server-side, so the captured server total IS the match count and an
	// active search reads "N matching rows" (the unsearched baseline isn't
	// re-queried just for the label). Null total (remote grid before its
	// first page resolves) renders no count.
	const totalCount = data ? data.length : totalRows;
	let countText: string | null = null;
	if (totalCount !== null) {
		const noun = `row${totalCount === 1 ? '' : 's'}`;
		if (!searchActive) {
			countText = `${totalCount} ${noun}`;
		} else if (fetchPage) {
			countText = `${totalCount} matching ${noun}`;
		} else {
			countText = activeCount !== null ? `${activeCount} of ${totalCount} ${noun}` : `${totalCount} ${noun}`;
		}
	}

	// With a title bar or a filter strip, the pieces stack inside a wrapper;
	// the bare-container form is preserved otherwise (no layout change for
	// existing consumers). Fixed-height grids (`height` set — split panels)
	// need the wrapper to fill its parent and the grid container to flex into
	// the remainder: Tabulator's inline height:100% cannot resolve against an
	// auto-height wrapper, so without this the grid sizes to content and the
	// footer gets clipped by the panel's overflow:hidden.
	const fillsParent = height != null && (showBar || hasStrip);
	const gridEl = (
		<div
			ref={containerRef}
			className={onRowClick ? 'rr-grid rr-grid--clickable' : 'rr-grid'}
			// flex-basis 0 makes the main size flex-determined, so Tabulator's
			// inline height:100% is ignored in favour of the flexed remainder.
			style={fillsParent ? { flex: '1 1 0%', minHeight: 0 } : undefined}
		/>
	);
	if (!showBar && !hasStrip) return gridEl;

	// The TOOL pieces are shared by both bar forms (single tool row vs the
	// two-row header stack), so they are built once. The search never sits
	// after an inline title anymore — the identity row owns titles — so it
	// carries no leading gap in either form.
	const searchInput = showSearch && (
		<input
			style={styles.search(false)}
			placeholder="Search..."
			value={searchText}
			onChange={(e) => setSearchText(e.target.value)}
		/>
	);
	// Matching-row count right after the search input.
	const countEl = showSearch && countText !== null && <span style={styles.count}>{countText}</span>;
	// Grid-owned buttons (Clear / Export), suppressible as a GROUP: with
	// noSearch AND noExport both set the grid contributes no buttons at all
	// (even the transient Clear), leaving an actions-only header on titled
	// grids — caller-provided `actions` always render regardless. noExport
	// alone still lets Clear surface while the view deviates.
	const toolButtons = (showSearch || showExport) && (showExport || clearVisible) && (
		<div style={styles.barRight}>
			{/* Clear appears only while a sort, search, or filter
			    deviates the view — it resets those three and leaves
			    the column layout alone (the header popups' Reset
			    layout is the one that also restores the layout). */}
			{clearVisible && (
				<Button variant="ghost" small onClick={clearView}>
					Clear
				</Button>
			)}
			{showExport && (
				<div ref={exportWrapRef} style={styles.exportWrap}>
					{/* Trigger stays enabled during a walk so the menu can be
					    reopened — the format rows below show the disabled state. */}
					<Button variant="ghost" small onClick={() => setExportMenuOpen((openNow) => !openNow)}>
						Export...
					</Button>
					{exportMenuOpen && (
						<div style={styles.exportMenu} role="menu">
							{(['csv', 'json'] as const).map((format) => (
								<div
									key={format}
									role="menuitem"
									aria-disabled={exporting}
									style={styles.exportItem(exportHover === format, exporting)}
									onMouseEnter={() => setExportHover(format)}
									onMouseLeave={() => setExportHover((current) => (current === format ? null : current))}
									onClick={() => handleExportSelect(format)}
								>
									{format === 'csv' ? 'CSV' : 'JSON'}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);

	return (
		<div style={fillsParent ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined}>
			{/* Card-header block: title stacked over the search/count tools on
			    the left; card actions + grid buttons as one vertically-centered
			    cluster on the right; one shared fill and bottom border. */}
			{showBar && hasIdentityRow && (
				<div style={styles.barStack}>
					<div style={styles.barLeft}>
						<span>{title}</span>
						{/* Tools line renders only when the search is on; a
						    title-only grid degrades to a plain card header. */}
						{showSearch && (
							<div style={styles.barTools}>
								{searchInput}
								{countEl}
							</div>
						)}
					</div>
					{(actions !== undefined || toolButtons) && (
						<div style={styles.barActions}>
							{actions}
							{toolButtons}
						</div>
					)}
				</div>
			)}
			{/* Single tool row (no title / actions): the original bar form. */}
			{showBar && !hasIdentityRow && (
				<div style={styles.titleBar}>
					{searchInput}
					{countEl}
					{toolButtons}
				</div>
			)}
			{hasStrip && filters && (
				<FilterStrip
					defs={filters}
					values={filterValues}
					labels={filterLabels}
					onChange={handleFilterChange}
				/>
			)}
			{gridEl}
		</div>
	);
}

/**
 * The platform's stock table. See the module doc above for behavior; see
 * {@link IDataGridProps} for the API.
 */
export const DataGrid = forwardRef(DataGridInner) as <Row extends Record<string, unknown>>(
	props: IDataGridProps<Row> & { ref?: Ref<IDataGridHandle> },
) => ReactElement;
