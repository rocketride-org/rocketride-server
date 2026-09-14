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
 *    edits stay pending inside the popup until its Apply commits them, and
 *    committed filters apply on BOTH data modes: REMOTE grids send them with
 *    every page request; LOCAL grids filter their own loaded rows with the
 *    server convention's exact semantics (rowMatchesFilters — no host
 *    wiring) — plus a live FORMAT section (alignment on every type; date/time
 *    patterns on 'date' columns; decimals / thousands / currency on
 *    'number' columns; persisted with the layout), show/hide toggles, and
 *    "Reset layout"
 *  - per-user layout persistence via {@link IDataGridPersistence}
 *  - the footer contract: footer renders only when the set spans >1 page
 *  - remote paging through `fetchPage` (DAP fetchers, not URLs)
 *  - a built-in title bar (Card-header look), ON BY DEFAULT on every grid,
 *    with a COLLAPSIBLE search box behind a magnifier toggle (collapsed by
 *    default — the bar reads {title} {magnifier} {count}; expanding
 *    autofocuses the field, collapsing clears the term so a hidden field
 *    never hides an active search; the open state persists per user with
 *    the display settings; REMOTE grids send the term server-side so it
 *    spans ALL pages; LOCAL grids narrow their fully-loaded rows
 *    client-side), a matching-row count, a GEAR settings menu — DISPLAY
 *    toggles (grid lines / alternating rows, persisted per user), the
 *    COLUMNS show/hide checklist, and the EXPORT rows (CSV / JSON covering
 *    every row matching the current filters and search) — and a "Clear"
 *    button that appears only while a sort / search / filter deviates the
 *    view and resets exactly those three (the header popups' "Reset layout"
 *    additionally restores the declared column layout, display settings,
 *    and deletes the per-user persisted state); `noExport` hides the gear's
 *    Export section, and the bar hides only when `noSearch` and `noExport`
 *    are both suppressed and no `title` is set
 *
 * Data modes (mutually exclusive):
 *  - LOCAL:  pass `data` — identity change applies silently (scroll, page and
 *            sort preserved), so poll-driven views can refresh freely.
 *  - REMOTE: pass `fetchPage` — one page per request with a real total;
 *            failures keep the prior rows and show a transient error overlay.
 */

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ForwardedRef, type ReactElement, type ReactNode, type Ref } from 'react';
import type { Options } from 'tabulator-tables';
import { Tabulator } from './modules';
import { createPortal } from 'react-dom';
import { applyDefaultLayout, buildAutoColumns, closeHeaderPopup, defaultGroupFields, defaultSorters, exportRowsAsCsv, exportRowsAsJson, matchesSearch, normalizeColumns, rowMatchesFilters, toggleColumnWithFit } from './defaults';
import { BxCog, BxSearch } from '../BoxIcon';
import type { GridColumnDefinition, HeaderFilterMode, IColumnFormat, IExportColumn, IGridInstanceState, IHeaderFilterBridge, IHeaderFormatBridge } from './defaults';
import { FilterStrip } from './FilterStrip';
import type { IGridFilterDef } from './FilterStrip';
import type { IDataGridPersistence } from './persistence';
import { createMessageGridPersistence } from './gridConfigChannel';

// One lazy shared message adapter backs every grid that supplies only a
// tableId — the adapter caches per table, so sharing is safe, and laziness
// keeps SSR/test environments without a document from touching it at import.
let defaultMessagePersistence: IDataGridPersistence | null = null;

/** The tableId-default persistence: the grid config channel adapter. */
function getDefaultPersistence(): IDataGridPersistence {
	if (!defaultMessagePersistence) defaultMessagePersistence = createMessageGridPersistence();
	return defaultMessagePersistence;
}
import { Button } from '../button/Button';
import { cardHeaderChrome } from '../card/Card';
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
	 * Hide the title bar's search entirely — magnifier toggle, input, and
	 * matching-row count. EXCEPTIONAL (2026-07-18): the field is collapsed
	 * behind the magnifier by default, so search costs one glyph and should
	 * stay enabled everywhere — "the table is small" no longer justifies
	 * this prop. REMOTE grids search server-side: the term rides every page
	 * request as {@link IDataGridPageRequest.search}, so matches span ALL
	 * pages and the pager pages within the results. LOCAL grids (all rows
	 * already loaded) narrow client-side across every value.
	 * With `noExport` also set and no `title`, the whole bar disappears.
	 */
	noSearch?: boolean;
	/**
	 * Hide the EXPORT section of the gear menu (CSV / JSON), which every grid
	 * shows by default. Exports cover EVERY row matching the current committed
	 * filters AND the active search term (remote grids walk all pages with
	 * both riding each request), restricted to the visible columns in display
	 * order. The gear itself (display toggles + column checklist) remains.
	 * With `noSearch` also set, the grid contributes NO buttons at all
	 * (gear and the transient Clear included): on a titled grid that leaves
	 * an actions-only card header — `actions` always render regardless — and
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
	 * Declared column definitions — the full per-column contract
	 * ({@link GridColumnDefinition}): Tabulator-native options plus the
	 * DataGrid extensions. Declare EVERY available column; each declares its
	 * result-row key (`field`), value type (`rrType` — selects the filter
	 * control), and its place in the DEFAULT view:
	 *
	 * - `rrDefault: true` — part of the default view; the default ORDER is
	 *   the order defaulted columns appear in this array. A column WITHOUT
	 *   the flag is available (toggleable from the header menu, filterable,
	 *   exportable) but hidden by default. The synthesized default layout
	 *   applies exactly when the user has NO persisted layout; a saved
	 *   workspace layout always wins, and Reset layout returns to the
	 *   declared defaults.
	 * - `rrDefaultSort: 'asc' | 'desc'` — the grid's default sort (composes
	 *   across columns in array order; Clear returns to it).
	 * - `rrGroup` — default row grouping by this column.
	 * - `rrDescription` — human description; becomes the header tooltip and
	 *   the COLUMNS toggle-list tooltip.
	 * - `rrOptions` — static filter vocabulary; the column's filter becomes a
	 *   checklist of exactly these options (how enum-like strings and JSON
	 *   string-arrays like sysPermissions get real selectors).
	 *
	 * Legacy (flag-free) declarations keep the old behavior: array order +
	 * native `visible` flags. Memoize; identity change re-applies.
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
	/**
	 * Layout persistence adapter override. Normally OMITTED: a grid with a
	 * `tableId` persists over the grid config channel by default (the host
	 * bridge answers — web shell from workspace prefs, VSCode from project
	 * state; no bridge = defaults). Supply one only to bypass the channel.
	 */
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
	 * page 1 with the values in `req.filters`; local grids filter THEMSELVES
	 * — the committed record runs through the grid-internal predicate
	 * (rowMatchesFilters, the server convention's semantics) over the loaded
	 * rows. A strip key with no matching row field is skipped by the
	 * predicate (server parity), so cross-field strip filters (typeaheads
	 * over joined values) stay the host's job via `onFiltersChange`.
	 */
	filters?: IGridFilterDef[];
	/**
	 * Debounced committed filter values — an OPTIONAL observation hook (URL
	 * sync, analytics, host-side filtering of strip-only keys). LOCAL grids
	 * no longer require it to filter: they apply committed header-popup and
	 * strip filters to their own rows grid-internally.
	 */
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

/** Per-grid display settings (persisted per user under the 'display' blob). */
interface IGridDisplaySettings {
	/** Row separator hairlines. */
	lines: boolean;
	/** Alternating even-row wash. */
	zebra: boolean;
	/**
	 * Title-bar search field expanded (the magnifier toggle). Collapsed is
	 * the default — the bar reads {title} {magnifier} {count} on one line —
	 * and collapsing always clears the term, so the hidden field never hides
	 * an active search.
	 */
	searchOpen: boolean;
}

/** The declared default view: hairlines on, no striping, search collapsed. */
const DEFAULT_DISPLAY_SETTINGS: IGridDisplaySettings = { lines: true, zebra: false, searchOpen: false };

/** Gear panel width — the header popup panel's width (.rr-grid-hp / .rr-grid-gear). */
const GEAR_PANEL_WIDTH = 248;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Title bar — replicates the Card header EXACTLY (source: Card.tsx
	// styles.header, which composes commonStyles.cardHeader and overrides to
	// the approved spec: left-aligned content, bottom divider, 13.5px/700
	// title), so a DataGrid title bar is indistinguishable from a Card header.
	titleBar: {
		...cardHeaderChrome.header,
	} as CSSProperties,

	// Card-header block (title and/or actions present): ONE fill and ONE
	// bottom border — a card-hosted grid must not stack two gray strips
	// (design decision 2026-07-16). The chrome — fill, divider, padding, and
	// the 13.5/700 title typography — comes from Card.tsx's OWN exported
	// header styles, never re-declared here (user directive, same day), so
	// the grid title is a Card header by construction. Only the two-row
	// GEOMETRY is grid-local: title stacked over the tools line on the left,
	// one vertically-centered cluster on the right.
	// position:relative anchors the gear's absolute corner slot.
	barStack: {
		...cardHeaderChrome.header,
		justifyContent: 'space-between',
		gap: 12,
		position: 'relative',
	} as CSSProperties,

	// The gear's slot in the STACKED header form: pinned to the header's
	// upper-right corner (design owner), out of the vertically-centered
	// actions cluster.
	gearCorner: {
		position: 'absolute',
		top: 6,
		right: 8,
	} as CSSProperties,

	// Left side of the block: title line over the tools line.
	barLeft: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		minWidth: 0,
		flex: '1 1 auto',
	} as CSSProperties,

	// The stacked header's title line: heading + the magnifier toggle, plus
	// the row count while the search field is collapsed (the one-row
	// {title} {magnifier} {count} form).
	barTitleRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		minWidth: 0,
	} as CSSProperties,

	// The left side's tools line (search + count) — resets the header's
	// title weight so only the title line carries it.
	barTools: {
		display: 'flex',
		alignItems: 'center',
		fontWeight: 400,
	} as CSSProperties,

	// Right-side cluster: card-specific actions LEFT of the grid buttons
	// (Clear / Export), vertically centered by the stack's align-items —
	// Card's own headerActions placement plus the flex layout the multi-
	// button cluster needs.
	// marginRight clears the gear's corner column so the centered cluster
	// never slides under it.
	barActions: {
		...cardHeaderChrome.actions,
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginRight: 24,
	} as CSSProperties,

	// Grid-local search input — 30px inputField-look control; fixed width so
	// the bar never reflows while typing. Gains a left gap when the
	// magnifier precedes it on the same row (the single tool row); the
	// stacked form's tools line keeps it flush left (the bar itself carries
	// no gap, keeping it an exact copy of the Card header values).
	search: (afterToggle: boolean): CSSProperties => ({
		...commonStyles.inputField,
		height: 30,
		width: 200,
		...(afterToggle ? { marginLeft: 12 } : {}),
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

	// Gear anchor — position:relative so the panel can absolutely position
	// below-right of the trigger button.
	exportWrap: {
		position: 'relative',
	} as CSSProperties,

	// Gear settings panel — commonStyles.popupMenu (paper surface, --rr-border
	// edge, radius 8, widget shadow: the same values the .tabulator-menu
	// popups replicate in tabulator-theme.css), re-anchored from fixed to
	// absolute so it hangs below the trigger's right edge. Width and padding
	// mirror the header popup panel (sections own the horizontal inset).
	// The panel's SURFACE, width, and typography all come from the header
	// popup's own classes (the panel carries the full .tabulator-popup class
	// stack — see the JSX), so the gear panel and the column popups are the
	// same surface by construction. Inline carries ONLY the FIXED viewport
	// anchoring (the panel portals into document.body so it escapes the
	// account overlay's clipping and scroll region — like the header popups),
	// capped to the viewport below the anchor and internally scrollable so a
	// gear near the bottom edge never clips its sections. z-index clears the
	// shell Modal layer (2000).
	// The panel NEVER scrolls as a whole (matching the header popup) — only
	// the COLUMNS list inside caps and scrolls; the open-clamp effect shifts
	// the whole panel up instead when it would overflow the viewport.
	gearMenu: (anchor: { top: number; left: number }): CSSProperties => ({
		position: 'fixed',
		top: anchor.top,
		left: anchor.left,
		zIndex: 2100,
	}),

	// The gear trigger — a BARE glyph, not a Button: quiet secondary tone at
	// rest, primary while hovered or with the panel open (the close-glyph /
	// header-ellipsis treatment, per the design owner).
	gearButton: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		background: 'none',
		border: 'none',
		padding: 2,
		cursor: 'pointer',
		color: active ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
	}),

	// Spacer standing in for the 13px check box on label-only rows (the
	// Export CSV / Json rows), so every section row's label starts at the
	// same x as the checkbox rows above.
	gearCheckSpacer: {
		width: 13,
		flexShrink: 0,
	} as CSSProperties,
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
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
function DataGridInner<Row extends Record<string, unknown>>(props: IDataGridProps<Row>, ref: ForwardedRef<IDataGridHandle>): ReactElement {
	const { tableId, title, actions, noSearch, noExport, columns, data, fetchPage, remoteSort = false, pageSizes = DEFAULT_PAGE_SIZES, paginate = true, height, emptyTitle, emptyDescription, onRowClick, onLoadError, persistence, autoColumns = false, filters, onFiltersChange, fetchDistinct, options } = props;

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
	// An explicit adapter wins; with only a tableId the grid persists over
	// the grid config channel (the host bridge — web shell or VSCode webview
	// — answers it; no bridge = declared defaults, writes dropped).
	const resolvedPersistence = persistence ?? (tableId ? getDefaultPersistence() : undefined);
	const persistenceRef = useRef(resolvedPersistence);
	persistenceRef.current = resolvedPersistence;
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
	// non-empty projection is what rides into fetchPage, the grid-internal
	// LOCAL predicate, and onFiltersChange. Strings come from the strip and
	// 'text' popups ("contains"); arrays come from checklist popups (IN);
	// 'date' / 'number' popups write their bounds as `${field}__gte` /
	// `${field}__lte` string entries. Header popups batch their edits locally
	// and commit through the bridge only on Apply; the strip still
	// auto-applies per keystroke.
	const [filterValues, setFilterValues] = useState<Record<string, string | string[]>>({});
	const [filterLabels, setFilterLabels] = useState<Record<string, string>>({});
	// Committed (compacted) values, read at evaluation time by the remote
	// request builder, the LOCAL row predicate, and the export walk.
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
	// either re-query from page 1 (remote) or refresh the grid-internal row
	// predicate (local — the observation callback fires too).
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
			// Step 2: apply — remote grids restart from page 1; local grids
			// filter THEMSELVES by refreshing the grid-internal predicate over
			// the loaded rows, then still hand observers the committed record
			// (an optional hook — URL sync, host-side strip-only filtering).
			if (fetchRef.current) {
				whenBuilt(requeryFromPageOne);
			} else {
				whenBuilt(applyLocalPredicate);
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
				whenBuilt(requeryFromPageOne);
			} else {
				// LOCAL: refresh the combined search + filter predicate over
				// the loaded rows (it reads the committed term through the ref).
				whenBuilt(applyLocalPredicate);
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

	/**
	 * Whether a live sorter list DEVIATES from the grid's DECLARED default
	 * sort. On a grid with `rrDefaultSort` declarations the default view is
	 * SORTED — the default sort riding a request must not light the Clear
	 * button, while clearing it (tristate to none) must. Order-sensitive
	 * comparison; on grids without declarations this reduces to `length > 0`.
	 *
	 * @param sorters - Live sorters ({field, dir}) from either tracking site.
	 * @returns True when the view's sort differs from the declared default.
	 */
	const sortDeviates = (sorters: { field?: string; dir?: string }[]): boolean => {
		const declared = defaultSorters(columnsRef.current);
		if (sorters.length !== declared.length) return true;
		return sorters.some((s, i) => s.field !== declared[i].column || s.dir !== declared[i].dir);
	};

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
	// tracks the combined search + committed-filter predicate.
	const [activeCount, setActiveCount] = useState<number | null>(null);

	// ── Export (CSV / JSON of every matching row) ───────────────────────────
	// The format rows live in the gear menu's EXPORT section; the rows
	// disable while a walk is in flight; failures warn and re-enable.
	const [exporting, setExporting] = useState(false);
	// Re-entry guard (state updates flush async; the ref blocks double-clicks
	// landing before the disabled render).
	const exportingRef = useRef(false);

	// ── Gear menu (display settings + column toggles + export) ─────────────
	// One gear trigger opens the grid's settings panel: DISPLAY toggles (grid
	// lines / alternating rows), the COLUMNS show-hide list
	// (same behavior as the header popups' checklist), and the EXPORT rows.
	const [gearOpen, setGearOpen] = useState(false);
	// Hover tint for the bare gear glyph (inline styles have no :hover).
	const [gearHover, setGearHover] = useState(false);
	// The trigger wrapper, for the outside-click dismissal check.
	const gearWrapRef = useRef<HTMLDivElement>(null);
	// The PORTALED panel (it escapes clipped/scrolled ancestors by rendering
	// into document.body) — a second containment check for dismissal, and
	// the guard that keeps the panel's own internal scrolling from closing it.
	const gearPanelRef = useRef<HTMLDivElement>(null);
	// Viewport anchor computed when the panel opens (fixed positioning).
	const [gearAnchor, setGearAnchor] = useState<{ top: number; left: number } | null>(null);
	// Snapshot of toggleable columns for the panel's checklist, refreshed on
	// open and after every toggle (the table is the source of truth).
	const [gearColumns, setGearColumns] = useState<{ field: string; title: string; visible: boolean; tooltip?: string }[]>([]);
	// Per-grid display settings; persisted per user under the 'display' blob
	// (Reset layout deletes the table's entry, restoring these defaults).
	// The ref mirror lets the build effect read the CURRENT value while
	// seeding from the persisted blob.
	const [displaySettings, setDisplaySettings] = useState<IGridDisplaySettings>(DEFAULT_DISPLAY_SETTINGS);
	const displaySettingsRef = useRef(displaySettings);
	displaySettingsRef.current = displaySettings;

	// While the gear panel is open: outside-click, Escape, ancestor scroll,
	// and window resize all dismiss it. Scroll-close is what keeps a
	// viewport-anchored panel honest — the account overlay scrolls its own
	// body, and a fixed panel would otherwise float away from its gear (the
	// exact drift the header popups exhibited). The panel's OWN scrolling
	// (its overflow, the COLUMNS list) must not close it — hence the
	// containment guard on the scroll target.
	useEffect(() => {
		if (!gearOpen) return undefined;
		// Step 1: any pointer-down outside the trigger AND the portaled panel
		// closes (the panel lives in document.body, not inside the trigger).
		const onPointerDown = (event: MouseEvent): void => {
			const target = event.target as Node;
			if (!gearWrapRef.current?.contains(target) && !gearPanelRef.current?.contains(target)) {
				setGearOpen(false);
			}
		};
		// Step 2: Escape closes too (keyboard parity with the header popups).
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') setGearOpen(false);
		};
		// Step 3: ancestor scroll / resize invalidate the anchor — close.
		const onScroll = (event: Event): void => {
			if (event.target instanceof Node && gearPanelRef.current?.contains(event.target)) return;
			setGearOpen(false);
		};
		const onResize = (): void => setGearOpen(false);
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
			document.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onResize);
		};
	}, [gearOpen]);

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
	 * and applies the grid's own combined predicate — the committed search
	 * term AND the committed filters ({@link rowMatchesFilters}) — exactly
	 * like the grid narrows itself. REMOTE mode walks all pages through
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
			// LOCAL: the grid-internal predicate narrows the full data prop
			// the same way the visible grid does (an empty term / record
			// admits everything, so the filter is unconditional).
			rows = ((dataRef.current ?? []) as Record<string, unknown>[]).filter((row) => matchesSearch(row, committedSearchRef.current) && rowMatchesFilters(row, committedFiltersRef.current, columnsRef.current));
		} else {
			// REMOTE: mirror what the grid itself sends — committed filters and
			// search always; the current sorters only when the grid sorts
			// remotely.
			const sort = remoteSort && tableRef.current && builtRef.current ? tableRef.current.getSorters().map((sorter) => ({ field: sorter.field, dir: sorter.dir })) : [];
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
		setGearOpen(false);
		runExport(format);
	};

	// ── Gear panel helpers ──────────────────────────────────────────────────

	/**
	 * Rebuild the gear panel's column snapshot from the live table: titled,
	 * non-exempt columns (same filter as the header popups' checklist), in
	 * alphabetical order — the list is a lookup, not a layout mirror.
	 */
	const refreshGearColumns = (): void => {
		const table = tableRef.current;
		if (!table) {
			setGearColumns([]);
			return;
		}
		const snapshot = table
			.getColumns()
			.filter((col) => {
				const colField = col.getField();
				if (!colField || colField.startsWith('__') || isPopupExempt(colField)) return false;
				return (col.getDefinition().title ?? '') !== '';
			})
			.map((col) => {
				// The declared rrDescription lands on headerTooltip
				// (normalizeColumns), so the row inherits it as its tooltip.
				const tooltip = col.getDefinition().headerTooltip;
				return {
					field: col.getField(),
					title: String(col.getDefinition().title),
					visible: col.isVisible(),
					...(typeof tooltip === 'string' ? { tooltip } : {}),
				};
			})
			.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
		setGearColumns(snapshot);
	};

	/** Toggle the gear trigger: snapshot the columns and the panel's viewport
	    anchor fresh on every open (fixed positioning under the gear, right
	    edges aligned, clamped on-screen). */
	const handleGearClick = (): void => {
		if (!gearOpen) {
			refreshGearColumns();
			const rect = gearWrapRef.current?.getBoundingClientRect();
			setGearAnchor(rect ? { top: rect.bottom + 4, left: Math.max(8, rect.right - GEAR_PANEL_WIDTH) } : null);
		}
		setGearOpen((openNow) => !openNow);
	};

	// On-screen clamp: once the panel has rendered (and whenever its content
	// changes its height), shift it UP if its bottom would pass the viewport
	// — the panel itself never scrolls (only its COLUMNS list does), so a
	// gear near the bottom edge gets a fully visible panel above the fold.
	useLayoutEffect(() => {
		if (!gearOpen || !gearAnchor) return;
		const panel = gearPanelRef.current;
		if (!panel) return;
		const overflow = gearAnchor.top + panel.offsetHeight - (window.innerHeight - 8);
		if (overflow > 0) {
			const top = Math.max(8, gearAnchor.top - overflow);
			if (top !== gearAnchor.top) setGearAnchor({ ...gearAnchor, top });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gearOpen, gearAnchor, gearColumns]);

	/**
	 * Show/hide one column from the gear panel's checklist — the same
	 * last-visible guard and reveal content-fit as the header popups.
	 */
	const handleGearColumnToggle = (field: string): void => {
		const table = tableRef.current;
		if (!table) return;
		const col = table.getColumns().find((c) => c.getField() === field);
		if (!col) return;
		const visibleCount = gearColumns.filter((c) => c.visible).length;
		if (col.isVisible() && visibleCount <= 1) return;
		toggleColumnWithFit(col);
		refreshGearColumns();
	};

	/**
	 * Merge a display-settings patch, persisting the result per user (the
	 * 'display' blob rides the same store as the layout, so Reset layout —
	 * which deletes the table's whole entry — restores these defaults too).
	 */
	const updateDisplaySettings = (patch: Partial<IGridDisplaySettings>): void => {
		setDisplaySettings((current) => {
			const next = { ...current, ...patch };
			if (tableId) persistenceRef.current?.write(tableId, 'display', next);
			return next;
		});
	};

	// ── Search visibility (title-bar magnifier toggle) ─────────────────────
	// The field is COLLAPSED by default and the magnifier expands it in
	// place; the open state is a display setting (rides the persisted
	// 'display' blob with lines/zebra, so Reset layout restores the
	// collapsed default while Clear leaves it alone).
	const [searchHover, setSearchHover] = useState(false);
	// The input node, for the expand autofocus.
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	// True only across the render following an EXPLICIT expand click — a
	// grid whose persisted state is open must not steal focus on mount.
	const searchFocusPendingRef = useRef(false);

	/**
	 * Toggle the search field open/closed from the magnifier. Collapsing
	 * CLEARS the term (through the normal debounced commit, so the re-query
	 * or local-predicate refresh rides the standard path): the field-hidden
	 * state never hides an active search — the same visibility principle as
	 * the header-filter brand dots.
	 */
	const toggleSearchOpen = (): void => {
		const opening = !displaySettings.searchOpen;
		if (opening) searchFocusPendingRef.current = true;
		else setSearchText('');
		updateDisplaySettings({ searchOpen: opening });
	};

	// Autofocus the input after an explicit expand (never on mount): the bar
	// does not animate, so a plain focus on the post-toggle render is safe.
	useEffect(() => {
		if (displaySettings.searchOpen && searchFocusPendingRef.current) {
			searchFocusPendingRef.current = false;
			searchInputRef.current?.focus();
		}
	}, [displaySettings.searchOpen]);

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
	const isPopupExempt = (field: string): boolean => columnsRef.current.find((c) => c.field === field)?.rrNoPopup === true;

	/**
	 * Resolve the filter control of a field from its declared column type
	 * ({@link GridColumnDefinition.rrType} on the retained pre-normalized
	 * defs). Every non-exempt column resolves a REAL mode on BOTH data modes:
	 * REMOTE grids send committed values with each page request, and LOCAL
	 * grids apply them grid-internally over their loaded rows
	 * ({@link rowMatchesFilters} — no host callback required, so no filter
	 * ever commits into a void):
	 *
	 *  - action pseudo-fields ('__*') and `rrNoPopup` columns: 'none'
	 *  - 'boolean' → static Yes/No checklist; 'date' → Start/End range;
	 *    'number' → Min/Max range (both ranges commit `${field}__gte` /
	 *    `${field}__lte` bounds)
	 *  - any column with declared `rrOptions` → checklist (the entries UNION
	 *    the declared vocabulary with the live distinct values)
	 *  - 'enum' / 'strings' → distinct-value checklist ('strings' arrays are
	 *    exploded to their elements — by list_distinct remotely, by local
	 *    derivation otherwise), downgraded to 'text' on a REMOTE grid
	 *    without `fetchDistinct` — the page at hand is only one page of
	 *    rows, not the full distinct set, so a checklist would lie
	 *  - 'string' / 'json' and undeclared fields (including auto-derived
	 *    columns) → 'text' ("contains" / coercion — server-side remotely,
	 *    the grid-internal predicate locally — handles the rest)
	 */
	const resolveFilterMode = (field: string): HeaderFilterMode => {
		// Action pseudo-fields ('__rrActions', ...) never filter; neither do
		// columns that opted out of the header popup entirely (rrNoPopup).
		if (field.startsWith('__') || isPopupExempt(field)) return 'none';
		const column = columnsRef.current.find((c) => c.field === field);
		// A declared static vocabulary (rrOptions) makes ANY column a
		// checklist — enum-like strings, JSON string-arrays (sysPermissions),
		// and remote enums with no distinct endpoint. The committed array
		// reaches the server as IN on scalar columns, contains-ANY on array
		// columns.
		if (column?.rrOptions && column.rrOptions.length > 0) return 'values';
		switch (column?.rrType) {
			case 'boolean':
				return 'boolean';
			case 'date':
				return 'date';
			case 'number':
				return 'number';
			case 'enum':
			case 'strings':
				// A checklist needs an enumeration source: remote grids derive
				// nothing from their single loaded page, so without a
				// fetchDistinct they fall back to the text filter. 'strings'
				// (JSON string-array) qualifies like 'enum': the server's
				// list_distinct explodes array columns into their distinct
				// ELEMENTS, and local derivation flattens arrays the same way.
				return fetchRef.current && !fetchDistinctRef.current ? 'text' : 'values';
			default:
				// 'string' / 'json' / undeclared.
				return 'text';
		}
	};

	/**
	 * The DECLARED static filter vocabulary of a column (`rrOptions`),
	 * normalized to value/label pairs for the popup checklist — null when the
	 * column declares none (the checklist then falls back to distinct values).
	 */
	const getDeclaredOptions = (field: string): { value: string; label: string }[] | null => {
		const options = columnsRef.current.find((c) => c.field === field)?.rrOptions;
		if (!options || options.length === 0) return null;
		return options.map((option) => (typeof option === 'string' ? { value: option, label: option } : { value: option.value, label: option.label }));
	};

	/**
	 * Distinct values of a field for a 'values' checklist: the view's
	 * `fetchDistinct` when wired (server `list_distinct`), otherwise derived
	 * from the current LOCAL rows. A REMOTE grid without `fetchDistinct` only
	 * reaches this via a declared `rrOptions` column — its `data` is undefined,
	 * so this returns [] and the checklist shows the declared options alone.
	 */
	const getDistinctValues = (field: string): Promise<(string | number | boolean)[]> => {
		if (fetchDistinctRef.current) return fetchDistinctRef.current(field);
		// LOCAL derivation: unique primitive values of the current data rows.
		// String-array values (JSON array columns like sysPermissions) flatten
		// to their elements — mirroring the server's list_distinct explosion.
		const rows = (dataRef.current ?? []) as Record<string, unknown>[];
		const seen = new Set<string>();
		const values: (string | number | boolean)[] = [];
		const add = (value: string | number | boolean): void => {
			if (value === '') return;
			const key = String(value);
			if (seen.has(key)) return;
			seen.add(key);
			values.push(value);
		};
		for (const row of rows) {
			const value = row[field];
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === 'string') add(item);
				}
				continue;
			}
			if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
			add(value);
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
		const persisted = tableId && persistenceRef.current ? persistenceRef.current.read(tableId, 'columns') : undefined;
		const extras = buildAutoColumns(rows[0], autoKeysRef.current, Array.isArray(persisted) ? persisted : undefined);
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

	/**
	 * Re-query a REMOTE grid from page 1 with the freshly committed
	 * filters/search (the request builder reads them from refs). QUIET when
	 * the grid is already ON page 1 — the overwhelmingly common case while
	 * filtering — via replaceData(), which re-runs the request pipeline and
	 * swaps rows in place with no loading overlay; only a genuine page jump
	 * goes through setData()'s loader path.
	 */
	const requeryFromPageOne = (table: Tabulator): void => {
		// getPage() is false when pagination is off — nothing to reset, so
		// the quiet path applies there too.
		const page = table.getPage();
		if (page === 1 || page === false) void table.replaceData();
		else void table.setData();
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
	 * Install / clear the ONE Tabulator filter a LOCAL grid runs: a row must
	 * pass the committed search term AND every committed filter (header
	 * popups + strip), the latter evaluated grid-internally by
	 * {@link rowMatchesFilters} with the server convention's exact semantics
	 * — LOCAL grids filter THEMSELVES, no host callback required. The
	 * predicate reads the committed refs at evaluation time, so re-running
	 * this after each commit is the whole refresh; with nothing committed the
	 * filter clears entirely. Tabulator's filter refresh is synchronous and
	 * local-only (see the search-mode note above), so the page clamp and the
	 * footer contract re-run by hand — and the 'dataFiltered' event it fires
	 * keeps the title bar's "X of N rows" active count tracking the combined
	 * predicate.
	 *
	 * @param table - The built Tabulator instance (via whenBuilt).
	 */
	const applyLocalPredicate = (table: Tabulator): void => {
		// Step 1: install / clear the combined predicate over the loaded rows.
		const hasFilters = Object.keys(committedFiltersRef.current).length > 0;
		if (committedSearchRef.current !== '' || hasFilters) {
			table.setFilter((row: Record<string, unknown>) => matchesSearch(row, committedSearchRef.current) && rowMatchesFilters(row, committedFiltersRef.current, columnsRef.current));
		} else {
			table.clearFilter(false);
		}
		// Step 2: re-run the page clamp and the footer contract (local paging
		// recomputes max pages from the narrowed set).
		clampPage();
		syncFooter();
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
		// The grid-internal LOCAL predicate dies with the torn-down instance
		// (the rebuilt table starts unfiltered over the emptied refs); hosts
		// observing commits through onFiltersChange still get the cleared
		// record now, since the guarded debounce won't fire.
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
		// per-user entry; Clear only REWRITES the sort blob to the DECLARED
		// default sort (a write, not a clear, so persisted columns / widths /
		// page size survive the rebuild; the persisted blob is what the
		// rebuilt instance restores, so writing the declared sorters is how
		// "Clear" returns a default-sorted grid to its default ORDER rather
		// than to unsorted) — then rebuild (the fresh instance re-queries
		// page 1 with the now-empty filters, and tableBuilt's
		// syncFilterIndicators clears every header dot).
		if (tableId) {
			if (wipeLayout) persistenceRef.current?.clear(tableId);
			else persistenceRef.current?.write(tableId, 'sort', defaultSorters(columnsRef.current));
		}
		// Display formats AND the gear's display settings are LAYOUT state:
		// Reset layout drops both (in-memory too, covering non-persisted
		// grids — persisted ones also re-seed defaults from the cleared
		// store); Clear leaves them untouched.
		if (wipeLayout) {
			formatsRef.current = {};
			setDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
		}
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
			formatsRef.current = storedFormats && typeof storedFormats === 'object' ? { ...(storedFormats as Record<string, IColumnFormat>) } : {};
		}

		// Gear display settings: the persisted blob (merged over the defaults
		// so blobs written before a setting existed stay valid) or the live
		// state on non-persisted grids. Resolved SYNCHRONOUSLY into a local —
		// the options assembly below needs the value NOW (fixed height is a
		// build option), while setState only lands next render.
		const seededDisplay = persist
			? (() => {
					const storedDisplay = persistenceRef.current!.read(tableId!, 'display');
					return storedDisplay && typeof storedDisplay === 'object' ? { ...DEFAULT_DISPLAY_SETTINGS, ...(storedDisplay as Partial<IGridDisplaySettings>) } : DEFAULT_DISPLAY_SETTINGS;
				})()
			: displaySettingsRef.current;
		if (persist) setDisplaySettings(seededDisplay);

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

		// The declared DEFAULT view, synthesized from the column contract:
		// layout (contract mode orders by rrDefault and hides unindexed
		// columns), sort (rrDefaultSort compositions feed initialSort — the
		// persistence module REPLACES initialSort with the persisted blob when
		// one exists, so declarations apply exactly when the user has saved
		// nothing; verified in tabulator_esm.mjs 6.5.2 Persistence.tableBuilt),
		// and grouping (rrGroup fields feed groupBy; client-side, so remote
		// grids group within the loaded page).
		const laidOut = applyDefaultLayout(columns);
		const declaredSort = defaultSorters(columns);
		const groupFields = defaultGroupFields(columns);

		// Step 1: assemble the option set — platform defaults, then the mode
		// block (local vs remote), then persistence, then the caller's
		// escape-hatch options merged last (columnDefaults merged one level).
		// Columns are normalized: the rrNoPopup marker is stripped and the
		// header popup is attached to every non-exempt column.
		const built: Options = {
			layout: 'fitColumns',
			columns: normalizeColumns(laidOut),
			...(declaredSort.length > 0 ? { initialSort: declaredSort } : {}),
			...(groupFields.length > 0 ? { groupBy: groupFields } : {}),
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
							// sorters are the authoritative active-sort signal —
							// "active" meaning DEVIATING from the declared default.
							setSortActive(sortDeviates(sort));
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
						persistenceReaderFunc: (_id: string, type: string) => persistenceRef.current?.read(tableId!, type) ?? false,
						persistenceWriterFunc: (_id: string, type: string, blob: unknown) => persistenceRef.current?.write(tableId!, type, blob),
					}
				: {}),
			...options,
			// columnDefaults from `options` was already folded in above; make
			// sure a plain `...options` spread doesn't clobber the merge.
			...(options?.columnDefaults ? { columnDefaults: { ...columnDefaultsBase, ...options.columnDefaults } } : {}),
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
				const active = (typeof start === 'string' && start !== '') || (typeof end === 'string' && end !== '');
				const col = table.getColumns().find((c) => c.getField() === field);
				col?.getElement().classList.toggle('rr-col-filtered', active);
			},
			getDistinct: getDistinctValues,
			getOptions: getDeclaredOptions,
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
		// the active-sort signal for the Clear button comes from the
		// 'dataSorted' event, which carries the current sorter list —
		// compared against the declared default sort, same as remote.
		table.on('dataSorted', (sorters) => {
			setSortActive(sortDeviates(sorters.map((s) => ({ field: s.field, dir: s.dir }))));
		});
		// Track the active (post grid-local-search) row count for the title
		// bar's "X of N rows" readout. The Filter module dispatches
		// 'dataFiltered' with the post-filter set on every local pipeline
		// refresh (verified in tabulator_esm.mjs), including the unfiltered
		// case, so the count never goes stale.
		table.on('dataFiltered', (_filters, rows) => {
			// Use the event's freshly-computed active row set, NOT
			// getDataCount('active'): at dispatch time the RowManager's active
			// set can lag the just-applied filter, so getDataCount returns a
			// stale value under live LOCAL replaceData (the "0 of N" count bug
			// when matches stream in after a search is committed).
			setActiveCount(rows.length);
		});
		table.on('dataLoadError', (error) => {
			loadErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
		});
		// Header popups are body-anchored at DOCUMENT coordinates: when an
		// ANCESTOR container scrolls (the account overlay's body), the popup
		// stays put while the grid moves under it — visibly drifting away
		// from its column. Close on any scroll outside the popup itself
		// (its own checklist scrolling must not dismiss it), mirroring the
		// gear panel's behavior.
		let popupScrollCloser: ((event: Event) => void) | null = null;
		table.on('popupOpened', () => {
			if (popupScrollCloser) return;
			popupScrollCloser = (event: Event) => {
				if (event.target instanceof Element && event.target.closest('.tabulator-popup')) return;
				closeHeaderPopup();
			};
			document.addEventListener('scroll', popupScrollCloser, true);
		});
		table.on('popupClosed', () => {
			if (!popupScrollCloser) return;
			document.removeEventListener('scroll', popupScrollCloser, true);
			popupScrollCloser = null;
		});

		// Container-size healing. Two failure modes, one observer:
		//  - Hidden-panel reveal: a grid built inside a display:none panel
		//    measures 0 wide and Tabulator crushes the column layout (the
		//    known hidden-panel-dimensions gotcha) — re-lay out IMMEDIATELY
		//    on the first real width.
		//  - Wrong-width build: a grid built mid tab/document transition
		//    measures a real but WRONG width (e.g. ~500px in a 1500px card)
		//    and Tabulator's own autoResize does not reliably re-fit
		//    fitColumns afterwards — re-lay out after the size SETTLES
		//    (trailing debounce, so panel drag-resizes don't pay a full
		//    redraw per frame).
		let lastWidth = containerRef.current.clientWidth;
		let settleTimer: number | null = null;
		const revealObserver = new ResizeObserver(() => {
			const width = containerRef.current?.clientWidth ?? 0;
			if (width === lastWidth || !builtRef.current) return;
			const revealed = lastWidth === 0 && width > 0;
			lastWidth = width;
			if (settleTimer != null) {
				window.clearTimeout(settleTimer);
				settleTimer = null;
			}
			if (revealed) {
				table.redraw(true);
				return;
			}
			// Collapsing to 0 needs no redraw — the reveal path handles the
			// way back.
			if (width === 0) return;
			settleTimer = window.setTimeout(() => {
				settleTimer = null;
				if (builtRef.current) table.redraw(true);
			}, 120);
		});
		revealObserver.observe(containerRef.current);

		// Step 3: teardown reverses everything.
		return () => {
			builtRef.current = false;
			tableRef.current = null;
			revealObserver.disconnect();
			if (settleTimer != null) {
				window.clearTimeout(settleTimer);
				settleTimer = null;
			}
			if (popupScrollCloser) {
				document.removeEventListener('scroll', popupScrollCloser, true);
				popupScrollCloser = null;
			}
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
			table.setColumns(normalizeColumns(applyDefaultLayout(columns)));
			syncFilterIndicators();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [columns]);

	// Display-setting classes (grid lines / zebra) via classList — NEVER the
	// React className prop: Tabulator stamps its own classes on the container
	// at build, and a className rewrite would wipe them (see gridEl). The
	// epoch dep re-applies after a rebuild in case teardown touched classes.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		el.classList.toggle('rr-grid--no-lines', !displaySettings.lines);
		el.classList.toggle('rr-grid--zebra', displaySettings.zebra);
	}, [displaySettings.lines, displaySettings.zebra, epoch]);

	// ── Imperative handle ───────────────────────────────────────────────────
	useImperativeHandle(ref, () => ({
		get table() {
			return tableRef.current;
		},
		refetch(opts?: { resetPage?: boolean }) {
			whenBuilt((table) => {
				if (opts?.resetPage) {
					// Page-1 restart — quiet when already there.
					requeryFromPageOne(table);
				} else {
					// replaceData() re-runs the CURRENT request quietly: rows
					// swap in place with scroll preserved and NO loading
					// overlay — setPage(current) re-requested too, but through
					// the loader path, flashing the grid on every poll-driven
					// refresh (the same reason LOCAL mode uses replaceData).
					void table.replaceData();
				}
			});
		},
		resetLayout,
	}));

	// ── Render ──────────────────────────────────────────────────────────────
	// Bar activation (see the prop JSDoc): the bar with search + export is ON
	// BY DEFAULT on every grid; `noSearch` / `noExport` opt out individually.
	// A `title` and/or `actions` switches it to the card-header block (the
	// title line — heading + magnifier, plus the count while the field is
	// collapsed — over the expanded tools line on the left, centered actions
	// + grid buttons right, one shared fill + border) so a card-hosted grid
	// never stacks a Card header on a grid bar; with neither, the single
	// tool row renders alone, and the bar disappears entirely only when
	// search and export are both suppressed too.
	const hasTitle = title !== undefined;
	const hasIdentityRow = hasTitle || actions !== undefined;
	const showSearch = noSearch !== true;
	// The input itself renders only while the magnifier has it expanded;
	// collapsed, the bar shows just {magnifier} {count}.
	const searchVisible = showSearch && displaySettings.searchOpen;
	const showExport = noExport !== true;
	const showBar = hasIdentityRow || showSearch || showExport;
	const hasStrip = !!filters && filters.length > 0;
	// Clear renders only while something deviates the DATA view from its
	// defaults — an active sort, a committed search, or a committed filter.
	const clearVisible = sortActive || searchActive || filtersActive;

	// Matching-row count. LOCAL grids know both numbers — the data prop
	// length (N) and Tabulator's post-predicate active count (X) — so any
	// grid-internal narrowing (a committed search OR committed filters, both
	// live in the one local predicate) reads "X of N rows". REMOTE grids
	// narrow server-side — filters shape the reported total directly, and an
	// active search reads "N matching rows" (the unsearched baseline isn't
	// re-queried just for the label). Null total (remote grid before its
	// first page resolves) renders no count.
	const totalCount = data ? data.length : totalRows;
	// LOCAL narrowing spans search and filters; REMOTE only flags search
	// (a filtered remote total is already the plain count).
	const narrowed = fetchPage ? searchActive : searchActive || filtersActive;
	let countText: string | null = null;
	if (totalCount !== null) {
		const noun = `row${totalCount === 1 ? '' : 's'}`;
		if (!narrowed) {
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
			// The className prop must stay CONSTANT across renders: Tabulator
			// stamps its own classes onto this element at build, and a React
			// className change REWRITES the whole class attribute — wiping
			// them and unstyling the entire grid (headers collapse to bare
			// text). The gear's display-setting classes therefore apply via
			// classList in an effect, never through this prop.
			className={onRowClick ? 'rr-grid rr-grid--clickable' : 'rr-grid'}
			// flex-basis 0 makes the main size flex-determined, so Tabulator's
			// inline height:100% is ignored in favour of the flexed remainder.
			style={fillsParent ? { flex: '1 1 0%', minHeight: 0 } : undefined}
		/>
	);
	if (!showBar && !hasStrip) return gridEl;

	// The TOOL pieces are shared by both bar forms (single tool row vs the
	// two-row header stack), so they are built once. The input renders only
	// while expanded; in the single tool row it follows the magnifier on the
	// same line and takes the leading gap, while the stacked form's tools
	// line keeps it flush left (the magnifier sits up on the title line).
	const searchInput = searchVisible && (
		<input
			ref={searchInputRef}
			style={styles.search(!hasIdentityRow)}
			placeholder="Search..."
			value={searchText}
			onChange={(e) => setSearchText(e.target.value)}
			onKeyDown={(e) => {
				if (e.key !== 'Escape') return;
				// Escape clears a live term; a second press (field already
				// empty) collapses. Consumed here so a host overlay's
				// document-level Escape handling never also fires.
				e.stopPropagation();
				if (searchText !== '') setSearchText('');
				else toggleSearchOpen();
			}}
		/>
	);
	// The magnifier — the search field's visibility toggle. A BARE glyph
	// like the gear (design owner): quiet secondary tone at rest, primary
	// while hovered or with the field expanded.
	const searchToggle = showSearch && (
		<button type="button" style={styles.gearButton(searchHover || displaySettings.searchOpen)} onMouseEnter={() => setSearchHover(true)} onMouseLeave={() => setSearchHover(false)} onClick={toggleSearchOpen} aria-label="Toggle search" aria-expanded={displaySettings.searchOpen}>
			<BxSearch size={15} />
		</button>
	);
	// Matching-row count: after the input while expanded, after the
	// magnifier on the title line while collapsed.
	const countEl = showSearch && countText !== null && <span style={styles.count}>{countText}</span>;
	// One gear-panel toggle row (display settings): popup-vocabulary check
	// row, React-rendered — the class names are the same global CSS the
	// header popups use, so the two surfaces stay visually identical.
	const settingRow = (label: string, on: boolean, onToggle: () => void): ReactNode => (
		<div className="rr-grid-hp-item" role="menuitemcheckbox" aria-checked={on} onClick={onToggle}>
			<span className={on ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check'} />
			<span className="rr-grid-hp-item-label">{label}</span>
		</div>
	);
	// Grid-owned controls (Clear / the gear), suppressible as a GROUP: with
	// noSearch AND noExport both set the grid contributes no buttons at all
	// (even the transient Clear), leaving an actions-only header on titled
	// grids — caller-provided `actions` always render regardless.
	const showGridButtons = showSearch || showExport;
	// Clear appears only while a sort, search, or filter deviates the view —
	// it resets those three and leaves the column layout alone (the gear's
	// Reset layout is the one that also restores the layout). Rides the
	// actions cluster.
	const clearButton = showGridButtons && clearVisible && (
		<Button variant="ghost" small onClick={clearView}>
			Clear
		</Button>
	);
	// The gear (DISPLAY toggles, EXPORT rows, COLUMNS list, Reset layout) is
	// its own control: the STACKED header pins it to the upper-right CORNER
	// (design owner) instead of the vertically-centered cluster; the
	// single-row bar keeps it at the row's right end (the corner there).
	const gearControl = showGridButtons && (
		<div ref={gearWrapRef} style={styles.exportWrap}>
			{/* BARE gear glyph — never a Button (design owner): quiet
				    secondary tone, primary on hover / while open. */}
			<button type="button" style={styles.gearButton(gearHover || gearOpen)} onMouseEnter={() => setGearHover(true)} onMouseLeave={() => setGearHover(false)} onClick={handleGearClick} aria-label="Grid settings" aria-expanded={gearOpen}>
				<BxCog size={15} />
			</button>
			{gearOpen &&
				gearAnchor &&
				createPortal(
					/* The FULL header-popup class stack: .tabulator-popup +
						   container paint the popup surface, .rr-grid-hp shapes
						   the box (248px, vertical padding), .rr-grid-gear adds
						   the font reset — the gear panel and the column popups
						   are the same surface by construction. */
					<div ref={gearPanelRef} style={styles.gearMenu(gearAnchor)} className="tabulator-popup tabulator-popup-container rr-grid-hp rr-grid-gear" role="menu">
						{/* DISPLAY: per-grid presentation toggles (persisted per
						    user). */}
						<div className="rr-grid-hp-section">
							<div className="rr-grid-hp-label">Display</div>
							{settingRow('Grid lines', displaySettings.lines, () => updateDisplaySettings({ lines: !displaySettings.lines }))}
							{settingRow('Alternating rows', displaySettings.zebra, () => updateDisplaySettings({ zebra: !displaySettings.zebra }))}
						</div>
						{/* EXPORT: a labelled section with the CSV / JSON walk
						    rows, indented under the label like every other
						    section's rows (noExport hides just this section;
						    the gear itself remains). */}
						{showExport && (
							<div className="rr-grid-hp-section">
								<div className="rr-grid-hp-label">Export</div>
								{(['csv', 'json'] as const).map((format) => (
									<div key={format} className="rr-grid-hp-item" role="menuitem" aria-disabled={exporting} style={exporting ? { opacity: 0.5, cursor: 'default' } : undefined} onClick={() => handleExportSelect(format)}>
										<span style={styles.gearCheckSpacer} />
										<span className="rr-grid-hp-item-label">{format === 'csv' ? 'CSV' : 'Json'}</span>
									</div>
								))}
							</div>
						)}
						{/* COLUMNS: the same show/hide checklist the header
						    popups carry (alphabetical lookup; last-visible
						    guard; reveal content-fit). LAST section (design
						    owner): the open-ended list sits at the bottom so
						    the fixed-size sections above never move. */}
						{gearColumns.length > 0 && (
							<div className="rr-grid-hp-section">
								<div className="rr-grid-hp-label">Columns</div>
								<div className="rr-grid-hp-list">
									{gearColumns.map((col) => (
										<div key={col.field} className="rr-grid-hp-item" role="menuitemcheckbox" aria-checked={col.visible} title={col.tooltip} onClick={() => handleGearColumnToggle(col.field)}>
											<span className={col.visible ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check'} />
											<span className="rr-grid-hp-item-label">{col.title}</span>
										</div>
									))}
								</div>
							</div>
						)}
						{/* Reset layout: the header popup's exact bottom form —
						    divider + right-aligned quiet-outline button.
						    Restores the declared defaults (layout, sort,
						    filters, formats, display settings) and deletes
						    the per-user stored entry. */}
						<div className="rr-grid-hp-divider" />
						<div className="rr-grid-hp-section">
							<div className="rr-grid-hp-actions">
								<button
									type="button"
									className="rr-grid-hp-btn"
									onClick={() => {
										setGearOpen(false);
										resetLayout();
									}}
								>
									Reset layout
								</button>
							</div>
						</div>
					</div>,
					document.body
				)}
		</div>
	);

	return (
		<div style={fillsParent ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined}>
			{/* Card-header block: title stacked over the search/count tools on
			    the left; card actions + Clear as the vertically-centered
			    cluster on the right; the GEAR pinned to the upper-right
			    corner; one shared fill and bottom border. */}
			{showBar && hasIdentityRow && (
				<div style={styles.barStack}>
					{gearControl && <div style={styles.gearCorner}>{gearControl}</div>}
					<div style={styles.barLeft}>
						{/* Title line: heading + magnifier; while the field is
						    collapsed the count rides here too — the one-row
						    {title} {magnifier} {count} form. A noSearch grid
						    degrades to a plain card-header title line. */}
						<div style={styles.barTitleRow}>
							<span>{title}</span>
							{searchToggle}
							{!searchVisible && countEl}
						</div>
						{/* Tools line only while the field is expanded. */}
						{searchVisible && (
							<div style={styles.barTools}>
								{searchInput}
								{countEl}
							</div>
						)}
					</div>
					{(actions !== undefined || clearButton) && (
						<div style={styles.barActions}>
							{actions}
							{clearButton}
						</div>
					)}
				</div>
			)}
			{/* Single tool row (no title / actions): the original bar form —
			    magnifier + (expanded) input + count on the left, Clear and
			    the gear at the row's right end. */}
			{showBar && !hasIdentityRow && (
				<div style={styles.titleBar}>
					{searchToggle}
					{searchInput}
					{countEl}
					{(clearButton || gearControl) && (
						<div style={styles.barRight}>
							{clearButton}
							{gearControl}
						</div>
					)}
				</div>
			)}
			{hasStrip && filters && <FilterStrip defs={filters} values={filterValues} labels={filterLabels} onChange={handleFilterChange} />}
			{gridEl}
		</div>
	);
}

/**
 * The platform's stock table. See the module doc above for behavior; see
 * {@link IDataGridProps} for the API.
 */
export const DataGrid = forwardRef(DataGridInner) as <Row extends Record<string, unknown>>(props: IDataGridProps<Row> & { ref?: Ref<IDataGridHandle> }) => ReactElement;
