// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataGrid helpers — DOM cell factories, the actions column builder, the
 * per-column header popup (filter + column show/hide + reset layout), the
 * local-search predicate, and the grid-internal LOCAL filter predicate
 * ({@link rowMatchesFilters} — the client twin of the server list
 * convention's filter semantics).
 *
 * Tabulator formatters build DOM outside React, so in-cell primitives are
 * plain elements styled by the token CSS classes in `tabulator-theme.css`
 * (`.rr-cell-badge`, `.rr-cell-btn`, ...). Those classes replicate the VALUES
 * of StatusBadge / Button / commonStyles from the same `--rr-*` tokens, so
 * themes stay in sync automatically.
 */

import type { CellComponent, ColumnDefinition, ColumnComponent } from 'tabulator-tables';
import type { Tabulator } from './modules';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Declared value type of a grid column — drives which filter control the
 * column's header popup renders (the DataGrid resolves the control from this
 * type; there is no per-view override map):
 *
 * - `'string'`  — free text; text "contains" input.
 * - `'number'`  — numeric scalar; Min / Max bound inputs writing the
 *                 `${field}__gte` / `${field}__lte` filter keys (the server
 *                 coerces numeric bounds).
 * - `'boolean'` — true/false flag; static two-entry Yes/No checklist.
 * - `'date'`    — ISO date / datetime; Start / End range inputs (each a date
 *                 plus an optional time) writing the `${field}__gte` /
 *                 `${field}__lte` filter keys — a bound with a time commits
 *                 as `${date}T${time}`; a date-only end bound is made
 *                 end-of-day inclusive server-side.
 * - `'enum'`    — low-cardinality discrete codes; distinct-value checklist
 *                 (fetchDistinct on remote grids, derived from the loaded
 *                 rows on local ones).
 * - `'strings'` — JSON string-array column (e.g. sysPermissions); text input
 *                 (server-side: contains ANY matching element).
 * - `'json'`    — structured payload blob (e.g. requestData); text input
 *                 over the serialized text (server coercion handles it).
 *
 * An undeclared type (including auto-derived columns) defaults to the text
 * "contains" input, exactly like `'string'`.
 */
export type GridColumnRRType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'strings' | 'json';

/**
 * ColumnDefinition plus DataGrid extensions — the full per-column contract a
 * view declares. `field` is the key in the result rows; `title`, `rrType`,
 * and any Tabulator-native option (width, formatter, `headerSort`, ...) ride
 * alongside. The DataGrid-private markers:
 *
 * - `rrNoPopup` exempts a column from the header popup (filter + show/hide +
 *   reset) AND from the toggle list — icon/chrome columns.
 * - `rrType` declares the column's value type ({@link GridColumnRRType}),
 *   which selects the header-popup filter control.
 * - `rrDefault` marks the column as part of the DEFAULT view; the default
 *   ORDER is the order the defaulted columns appear in the `columns` array.
 *   A column WITHOUT it is available (declared, filterable, toggleable from
 *   the header menu) but hidden by default. When ANY column declares
 *   `rrDefault` the grid runs in contract mode: the default layout derives
 *   from the flags alone ({@link applyDefaultLayout}) and applies whenever
 *   the user has no persisted layout — a persisted workspace layout, once
 *   saved, still wins. With NO flags declared the legacy behavior holds
 *   (array order + native `visible` flags).
 * - `rrDefaultSort` opts the column into the grid's DEFAULT sort (applied
 *   when the user has no persisted sort; multiple declarations compose in
 *   array order). Remote grids send it on the first request.
 * - `rrGroup` groups rows by this column by default (client-side — on remote
 *   grids groups form within the loaded page).
 * - `rrDescription` documents the column for humans: it becomes the header
 *   tooltip (Tabulator `headerTooltip`) and the toggle-list row tooltip.
 * - `rrOptions` declares a curated selection vocabulary: the filter control
 *   becomes a checklist of the declared options (label defaults to the
 *   value) UNIONed with the live distinct values, so values that ship in
 *   data appear without a code change — declared labels win on overlap.
 *   This is how enum-like string columns and JSON-array columns (e.g.
 *   sysPermissions) get a real selector: the committed array reaches the
 *   server as IN on scalar columns and contains-ANY on array columns.
 *
 * Every marker is stripped before the definitions reach Tabulator
 * ({@link normalizeColumns}), so exempt columns simply never receive the
 * `headerPopup` option and Tabulator never sees an unknown option.
 */
// The cell handle DataGrid formatters/callbacks receive. OUR name for the
// contract surface — third-party (tabulator) names are never blessed on the
// frozen shell surface; the shapes are inlined structurally at freeze time.
export type GridCellComponent = CellComponent;

export type GridColumnDefinition = ColumnDefinition & {
	/** Exempt this column from the header popup and its toggle list. */
	rrNoPopup?: boolean;
	/** Declared value type — selects the header-popup filter control. */
	rrType?: GridColumnRRType;
	/** Part of the default view (order = position in the columns array). */
	rrDefault?: boolean;
	/** Direction this column contributes to the grid's default sort. */
	rrDefaultSort?: 'asc' | 'desc';
	/** Group rows by this column by default. */
	rrGroup?: boolean;
	/**
	 * REQUIRED short human description — every declared column carries a name
	 * (`title`) and a description; the description renders as the header
	 * tooltip and the COLUMNS toggle-list tooltip. State what the value IS
	 * (units, sign conventions, id semantics) — not a restatement of the
	 * title.
	 */
	rrDescription: string;
	/** Curated filter vocabulary — checklist, unioned with live distinct values. */
	rrOptions?: (string | { value: string; label: string })[];
};

/** Semantic variants for {@link badgeEl} — mirrors StatusBadge's variants. */
export type CellBadgeVariant = 'success' | 'info' | 'warning' | 'error' | 'muted';

/** Visual kinds for {@link buttonEl} — mirrors the small Button variants. */
export type CellButtonKind = 'ghost' | 'secondary' | 'danger';

/** One action rendered by {@link createActionsColumn}. */
export interface IGridAction<Row> {
	/** Stable key reported to `onAction` when the button is clicked. */
	key: string;
	/** Button label; a function derives it from the row (e.g. toggle labels). */
	label: string | ((row: Row) => string);
	/** Visual kind; a function derives it from the row. Default 'ghost'. */
	kind?: CellButtonKind | ((row: Row) => CellButtonKind);
}

/** Configuration for {@link createActionsColumn}. */
export interface IActionsColumnConfig<Row> {
	/** The actions rendered (in order) in every row. */
	actions: IGridAction<Row>[];
	/** Fired with the action key and the clicked row's data. */
	onAction: (key: string, row: Row) => void;
	/** Column width; defaults to 120. */
	width?: number;
}

// =============================================================================
// DOM CELL FACTORIES
// =============================================================================

/**
 * Build a status pill (StatusBadge clone) for a cell.
 *
 * @param variant - Semantic state variant.
 * @param label - Pill text.
 * @returns The pill element.
 */
export function badgeEl(variant: CellBadgeVariant, label: string): HTMLElement {
	const el = document.createElement('span');
	el.className = `rr-cell-badge rr-cell-badge--${variant}`;
	el.textContent = label;
	return el;
}

/**
 * Build a small action button (Button small-variant clone) for a cell.
 * The `data-action` attribute is how {@link createActionsColumn} routes clicks.
 *
 * @param kind - Visual kind.
 * @param label - Button text.
 * @param action - Stable action key stored in `data-action`.
 * @returns The button element.
 */
export function buttonEl(kind: CellButtonKind, label: string, action: string): HTMLElement {
	const el = document.createElement('button');
	el.type = 'button';
	el.className = `rr-cell-btn rr-cell-btn--${kind}`;
	el.dataset.action = action;
	el.textContent = label;
	return el;
}

/**
 * Build a 32px round avatar with initials for a cell.
 *
 * @param initials - One-or-two character label.
 * @param background - CSS background (use one of the `--rr-chart-*` tokens).
 * @returns The avatar element.
 */
export function avatarEl(initials: string, background: string): HTMLElement {
	const el = document.createElement('span');
	el.className = 'rr-cell-avatar';
	el.style.background = background;
	el.textContent = initials;
	return el;
}

/**
 * Build a monospace text span for a cell (ids, emails, code-ish values).
 *
 * @param text - Cell text.
 * @returns The span element.
 */
export function monoEl(text: string): HTMLElement {
	const el = document.createElement('span');
	el.className = 'rr-cell-mono';
	el.textContent = text;
	return el;
}

/**
 * Build a muted secondary text span for a cell (dates, de-emphasised values).
 *
 * @param text - Cell text.
 * @returns The span element.
 */
export function mutedEl(text: string): HTMLElement {
	const el = document.createElement('span');
	el.className = 'rr-cell-muted';
	el.textContent = text;
	return el;
}

// =============================================================================
// LOCAL SEARCH
// =============================================================================

/**
 * Case-insensitive substring match over every own string/number value of a
 * row — the standard predicate for view-side filtering of LOCAL grid data
 * (replaces the old array-source's built-in search).
 *
 * @param row - The row object.
 * @param term - Raw search input (trimmed internally; empty matches all).
 * @returns True when the row matches.
 */
export function matchesSearch(row: Record<string, unknown>, term: string): boolean {
	const needle = term.trim().toLowerCase();
	if (!needle) return true;
	// Scan only primitive own values — nested objects are view-specific.
	for (const value of Object.values(row)) {
		if (typeof value !== 'string' && typeof value !== 'number') continue;
		if (String(value).toLowerCase().includes(needle)) return true;
	}
	return false;
}

// =============================================================================
// LOCAL FILTERS (grid-internal twin of the server list convention)
// =============================================================================

/** Range-operator suffixes carried by filter keys (e.g. `createdAt__gte`). */
const RANGE_SUFFIXES = ['__gte', '__lte'] as const;

/** A filter key's range operator — '' when the key carries none. */
type RangeSuffix = (typeof RANGE_SUFFIXES)[number] | '';

/**
 * Split a filter key into its base field and range suffix — the client twin
 * of the server convention's `split_range_suffix` (ai/common/list_rows.py).
 *
 * @param key - Raw filter key (e.g. 'createdAt__gte').
 * @returns The base field plus the suffix ('' when the key carries none).
 */
function splitRangeSuffix(key: string): { base: string; suffix: RangeSuffix } {
	for (const suffix of RANGE_SUFFIXES) {
		if (key.endsWith(suffix)) return { base: key.slice(0, -suffix.length), suffix };
	}
	return { base: key, suffix: '' };
}

/**
 * Coerce a filter string to a boolean — the server's truthy spellings
 * (`coerce_bool`: '1' / 'true' / 'yes' / 'on', case-insensitive).
 *
 * @param value - Committed filter value.
 * @returns The coerced boolean.
 */
function coerceBooleanText(value: string): boolean {
	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Render one cell value as comparable filter text: null/undefined become ''
 * (the server renders missing values empty), objects and arrays render as
 * their JSON serialization (the server's text-cast path), and primitives pass
 * through String().
 *
 * @param value - The raw cell value.
 * @returns The comparable text.
 */
function filterCellText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * Parse one committed date bound to an epoch-ms instant. Bounds ride the wire
 * as date-only strings or `${date}T${time}` ISO datetimes; zone-less strings
 * are stamped UTC first (the shared {@link assumeUtc} contract). A date-only
 * UPPER bound widens to end-of-day inclusive, mirroring the server's
 * `parse_datetime_bound` so "until 2026-07-15" covers that whole day.
 *
 * @param value - The committed bound string.
 * @param endInclusive - True for `__lte` bounds.
 * @returns The instant in epoch ms, or null when the bound does not parse.
 */
function parseDateBoundMs(value: string, endInclusive: boolean): number | null {
	const trimmed = value.trim();
	const ms = new Date(assumeUtc(trimmed)).getTime();
	if (Number.isNaN(ms)) return null;
	// Server parity: a 10-char bound is date-only — widen the upper bound to
	// the last instant of that day (the server subtracts one microsecond;
	// millisecond resolution is the client equivalent).
	if (endInclusive && trimmed.length === 10) return ms + 24 * 60 * 60 * 1000 - 1;
	return ms;
}

/**
 * Parse one cell value as an epoch-ms instant for date-bound comparison:
 * Date instances pass through, numbers are epoch ms (the same reading
 * {@link formatDateValue} uses), and strings parse with the zone-less-is-UTC
 * wire contract applied.
 *
 * @param value - The raw cell value.
 * @returns The instant in epoch ms, or null when the value does not parse.
 */
function parseCellDateMs(value: unknown): number | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string' && value.trim() !== '') {
		const ms = new Date(assumeUtc(value)).getTime();
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

/**
 * Evaluate ONE committed filter entry against one cell value — the client
 * twin of the server convention's `_row_matches_filter`
 * (ai/common/list_rows.py), with the column's declared rrType standing in
 * for the server's row-value type dispatch:
 *
 *  - ARRAY value → set membership (checklist commits; server-side IN):
 *    scalar cells match when their lowercased text equals ANY member;
 *    array-valued cells (e.g. sysPermissions) match when ANY element does
 *    (contains-ANY); boolean cells match their 'true'/'false' spelling.
 *    Arrays are invalid on range keys — the entry is inert (row passes).
 *  - `__gte` / `__lte` bounds on a 'number' column (or an undeclared column
 *    with a numeric cell) → numeric comparison; on a 'date' column (and
 *    everything else) → parsed-instant comparison with the date-only
 *    end-of-day widening. An unparsable bound is inert; a cell with no
 *    parsable value fails lower bounds and passes upper bounds (the server's
 *    empty-string comparison behavior).
 *  - Bare string on a 'boolean' column (or a boolean cell) → both sides
 *    coerce through the truthy spellings and compare equal.
 *  - Bare string on a 'number' column (or a numeric cell) → numeric
 *    equality; an unparsable filter value is inert, an unparsable cell fails.
 *  - Bare string otherwise ('string' / 'strings' / 'json' / 'enum' /
 *    undeclared) → case-insensitive containment over the cell's text
 *    rendering ({@link filterCellText}: objects and arrays — 'json' blobs
 *    included — compare over their JSON serialization).
 *
 * @param cellValue - The row's value for the entry's base field.
 * @param value - The committed filter value (string, or array = membership).
 * @param suffix - The key's range suffix ('' for a bare key).
 * @param rrType - The base field's declared column type, if any.
 * @returns True when the cell passes this entry.
 */
function matchesFilterEntry(
	cellValue: unknown,
	value: string | string[],
	suffix: RangeSuffix,
	rrType: GridColumnRRType | undefined,
): boolean {
	// ── Array value: set membership (server-side IN / contains-ANY) ─────────
	if (Array.isArray(value)) {
		// Arrays are invalid on range keys — the entry is inert.
		if (suffix !== '') return true;
		// Normalize members to lowercased text, dropping empties; an emptied
		// set means "filter off".
		const members = new Set(value.map((item) => String(item).toLowerCase()).filter((item) => item !== ''));
		if (members.size === 0) return true;
		// Array-valued cell: ANY element matching admits the row.
		if (Array.isArray(cellValue)) {
			return cellValue.some((element) => members.has(String(element).toLowerCase()));
		}
		// Boolean cell: match the stringified spelling the checklist commits.
		if (typeof cellValue === 'boolean') return members.has(cellValue ? 'true' : 'false');
		return members.has(filterCellText(cellValue).toLowerCase());
	}

	// ── Range bounds (`__gte` / `__lte` string entries) ─────────────────────
	if (suffix !== '') {
		const numericCell = typeof cellValue === 'number' && Number.isFinite(cellValue);
		if (rrType === 'number' || (rrType === undefined && numericCell)) {
			// Numeric bound: an unparsable bound is inert (server parity).
			const bound = Number(value);
			if (value.trim() === '' || Number.isNaN(bound)) return true;
			const cellText = filterCellText(cellValue);
			const cellNum = typeof cellValue === 'number' ? cellValue : Number(cellText);
			if (cellText === '' || Number.isNaN(cellNum)) return false;
			return suffix === '__gte' ? cellNum >= bound : cellNum <= bound;
		}
		// Date bound ('date' columns and non-numeric fallbacks): compare
		// parsed instants; an unparsable bound is inert.
		const boundMs = parseDateBoundMs(value, suffix === '__lte');
		if (boundMs === null) return true;
		const cellMs = parseCellDateMs(cellValue);
		// Server parity: a valueless cell compares like the empty string —
		// below every lower bound, under every upper bound.
		if (cellMs === null) return suffix === '__lte';
		return suffix === '__gte' ? cellMs >= boundMs : cellMs <= boundMs;
	}

	// ── Bare string value: coercion follows the declared column type ────────
	if (rrType === 'boolean' || typeof cellValue === 'boolean') {
		// Both sides coerce through the truthy spellings and compare equal.
		const cellBool = typeof cellValue === 'boolean' ? cellValue : coerceBooleanText(filterCellText(cellValue));
		return cellBool === coerceBooleanText(value);
	}
	if (rrType === 'number' || (typeof cellValue === 'number' && Number.isFinite(cellValue))) {
		// Numeric equality; an unparsable filter value is inert (server
		// parity: float(value) raising leaves the row admitted).
		const bound = Number(value);
		if (value.trim() === '' || Number.isNaN(bound)) return true;
		const cellText = filterCellText(cellValue);
		const cellNum = typeof cellValue === 'number' ? cellValue : Number(cellText);
		if (cellText === '' || Number.isNaN(cellNum)) return false;
		return cellNum === bound;
	}
	// Strings, string-arrays, and 'json' blobs: case-insensitive containment
	// over the text rendering (objects/arrays serialize as JSON).
	return filterCellText(cellValue).toLowerCase().includes(value.toLowerCase());
}

/**
 * True when a row passes EVERY committed filter entry — the grid-internal
 * predicate LOCAL grids run over their loaded rows, mirroring the server
 * list convention's semantics (ai/common/list_rows.py `_row_matches_filter`)
 * so a grid cannot tell whether its filters ran client- or server-side.
 * Entry semantics live on {@link matchesFilterEntry}; per-entry behavior:
 *
 *  - Entries AND together; '' and [] values mean "filter off" (skipped —
 *    the DataGrid's compaction drops them before commit anyway).
 *  - Range keys (`${field}__gte` / `${field}__lte`) resolve their BASE field
 *    by stripping the suffix; the base field's declared rrType selects
 *    numeric vs date bound comparison.
 *  - A key whose base field is not a property of the row is SKIPPED, exactly
 *    like the server drops unknown filter keys — so a strip-only key (e.g. a
 *    typeahead filtering by a joined value the host applies itself) never
 *    zeroes the grid.
 *
 * @param row - The row object.
 * @param filters - Committed filter record (the DataGrid's compacted state).
 * @param columns - The grid's declared columns (rrType lookup by base field).
 * @returns True when the row passes every committed entry.
 */
export function rowMatchesFilters(
	row: Record<string, unknown>,
	filters: Record<string, string | string[]>,
	columns: GridColumnDefinition[],
): boolean {
	for (const [key, rawValue] of Object.entries(filters)) {
		// Step 1: normalize — empty string / emptied array means "filter off".
		let value: string | string[];
		if (Array.isArray(rawValue)) {
			value = rawValue.map(String).filter((item) => item !== '');
			if (value.length === 0) continue;
		} else {
			value = String(rawValue);
			if (value === '') continue;
		}
		// Step 2: resolve the base field (range suffixes ride separate keys)
		// and its declared column type.
		const { base, suffix } = splitRangeSuffix(key);
		// Step 3: unknown keys are skipped (server parity — see the JSDoc).
		if (!(base in row)) continue;
		const rrType = columns.find((c) => c.field === base)?.rrType;
		// Step 4: every committed entry must pass (AND semantics).
		if (!matchesFilterEntry(row[base], value, suffix, rrType)) return false;
	}
	return true;
}

// =============================================================================
// EXPORT (CSV / JSON download of grid rows)
// =============================================================================

/** One exported column: the row field to read and the header title to show. */
export interface IExportColumn {
	/** Row field the values are read from. */
	field: string;
	/** Human column title (becomes the CSV header cell). */
	title: string;
}

/**
 * Serialize one raw row value to export text: null/undefined become '',
 * arrays join their serialized items with '; ', objects JSON.stringify, and
 * primitives pass through String().
 *
 * @param value - The raw row value.
 * @returns The serialized text.
 */
function exportCellText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.map((item) => exportCellText(item)).join('; ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * RFC-4180 escape one CSV field: a value containing a comma, quote, or line
 * break is wrapped in quotes with embedded quotes doubled; anything else
 * passes through untouched.
 *
 * @param text - The serialized field text.
 * @returns The escaped CSV field.
 */
function csvEscape(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Trigger a browser download of a text payload via a Blob object URL and a
 * transient anchor click (no navigation, no dialogs).
 *
 * @param content - File content.
 * @param mime - MIME type of the download.
 * @param filename - Suggested file name (with extension).
 */
function downloadTextFile(content: string, mime: string, filename: string): void {
	// Step 1: wrap the payload in an object URL.
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	// Step 2: click a transient anchor pointing at it.
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	// Step 3: remove the anchor and release the URL.
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

/**
 * Download rows as an RFC-4180 CSV file: a header row of the column titles,
 * then one line per row with each column's raw value serialized by
 * {@link exportCellText} and escaped by {@link csvEscape}. Lines join with
 * CRLF per the RFC.
 *
 * @param rows - The rows to export.
 * @param columns - Visible columns in display order (field + title).
 * @param filename - Download file name (with extension).
 */
export function exportRowsAsCsv(rows: Record<string, unknown>[], columns: IExportColumn[], filename: string): void {
	const lines: string[] = [];
	// Header row: the column titles.
	lines.push(columns.map((col) => csvEscape(col.title)).join(','));
	// Data rows: serialized + escaped values in column order.
	for (const row of rows) {
		lines.push(columns.map((col) => csvEscape(exportCellText(row[col.field]))).join(','));
	}
	downloadTextFile(lines.join('\r\n'), 'text/csv;charset=utf-8', filename);
}

/**
 * Download rows as a JSON file: an array of objects restricted to the
 * exported columns' fields, with values passed through raw (untouched).
 *
 * @param rows - The rows to export.
 * @param columns - Visible columns in display order (their fields project).
 * @param filename - Download file name (with extension).
 */
export function exportRowsAsJson(rows: Record<string, unknown>[], columns: IExportColumn[], filename: string): void {
	// Project each row onto the visible fields only.
	const projected = rows.map((row) => {
		const entry: Record<string, unknown> = {};
		for (const col of columns) entry[col.field] = row[col.field];
		return entry;
	});
	downloadTextFile(JSON.stringify(projected, null, '\t'), 'application/json', filename);
}

// =============================================================================
// ACTIONS COLUMN
// =============================================================================

/**
 * Build the trailing Actions column — right-aligned small buttons, exempt from
 * sorting / moving / the header popup, and excluded from row-click handling
 * (the DataGrid's rowClick guard skips clicks inside `[data-rr-actions]`).
 *
 * @typeParam Row - Row shape of the grid.
 * @param config - Actions and click router.
 * @returns A DataGrid column definition to append to the columns array.
 */
export function createActionsColumn<Row>(config: IActionsColumnConfig<Row>): GridColumnDefinition {
	const { actions, onAction, width = 120 } = config;
	return {
		title: 'Actions',
		field: '__rrActions',
		rrDescription: 'Row actions.',
		width,
		hozAlign: 'right',
		headerSort: false,
		resizable: false,
		// Popup exemption marker — actions columns never get the header popup
		// and never appear in its show/hide toggle list. Stripped by
		// normalizeColumns before the definition reaches Tabulator.
		rrNoPopup: true,
		// Formatter: one small button per action, wrapped so the rowClick guard
		// can recognise the whole cell as an actions region.
		formatter: (cell: CellComponent) => {
			const row = cell.getRow().getData() as Row;
			const wrap = document.createElement('span');
			wrap.dataset.rrActions = 'true';
			wrap.className = 'rr-cell-actions';
			for (const action of actions) {
				const label = typeof action.label === 'function' ? action.label(row) : action.label;
				const kind = typeof action.kind === 'function' ? action.kind(row) : action.kind ?? 'ghost';
				wrap.appendChild(buttonEl(kind, label, action.key));
			}
			return wrap;
		},
		// Route clicks on the buttons to the view's handler by action key.
		cellClick: (e: UIEvent, cell: CellComponent) => {
			const target = (e.target as HTMLElement).closest('button[data-action]');
			if (!target) return;
			onAction((target as HTMLElement).dataset.action ?? '', cell.getRow().getData() as Row);
		},
	};
}

// =============================================================================
// AUTO-COLUMNS (the rows ARE the shape — derive addable columns from row keys)
// =============================================================================

/**
 * Turn a camelCase row key into a human column title.
 *
 * @param key - Row key (e.g. 'phoneNumberVerified').
 * @returns Title-cased label (e.g. 'Phone Number Verified').
 */
export function titleFromKey(key: string): string {
	const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Matches ISO 8601 date / datetime strings (the wire format for datetimes). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

/**
 * Type-heuristic formatter, keyed off the value actually in the cell:
 * boolean -> yes/no badge, ISO datetime string -> muted local date-time,
 * array -> badge list, object -> truncated JSON, null -> ''. Used by every
 * auto-derived column (which has no declared type), and exported for views
 * to reuse on declared hidden columns whose rare reveal does not warrant a
 * bespoke formatter.
 *
 * @param cell - The Tabulator cell.
 * @returns The formatted cell content.
 */
export function autoFormatter(cell: CellComponent): HTMLElement | string {
	const value = cell.getValue();
	if (value === null || value === undefined || value === '') return '';
	if (typeof value === 'boolean') {
		return badgeEl(value ? 'success' : 'muted', value ? 'Yes' : 'No');
	}
	if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
		return mutedEl(value.substring(0, 19).replace('T', ' '));
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return mutedEl('--');
		const wrap = document.createElement('span');
		wrap.className = 'rr-cell-badges';
		for (const item of value) wrap.appendChild(badgeEl('info', String(item)));
		return wrap;
	}
	if (typeof value === 'object') {
		// No own width cap — .rr-cell-truncate ellipsizes at 100% of the CELL,
		// so the text fills however wide the user makes the column (a fixed
		// cap here truncated JSON far short of the column edge). Runaway
		// column widths are contained where they arise: the popup's
		// reveal-fit clamps its measured width (REVEAL_FIT_MAX_WIDTH).
		const el = document.createElement('span');
		el.className = 'rr-cell-mono rr-cell-truncate';
		const text = JSON.stringify(value);
		el.textContent = text;
		el.title = text.length > 500 ? `${text.slice(0, 500)}...` : text;
		return el;
	}
	return String(value);
}

// =============================================================================
// FORMAT OVERRIDES (header popup FORMAT section — value rendering)
// =============================================================================

/** Zero-pad a date/time part to two digits. */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Stamp a zone-less ISO datetime string as UTC. The platform wire contract
 * is that server datetimes are UTC, but JavaScript parses a zone-less
 * datetime string ('2026-07-16T15:42:07', with or without the T) as LOCAL
 * time — silently skewing the display by the viewer's zone offset. Strings
 * that already carry a zone (Z or a ±hh:mm offset) and date-only strings
 * (which the ISO spec already parses as UTC midnight) pass through.
 *
 * @param text - The raw wire string.
 * @returns The string to hand to `new Date()`.
 */
const assumeUtc = (text: string): string => {
	const trimmed = text.trim();
	if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed;
	if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) return `${trimmed.replace(' ', 'T')}Z`;
	return trimmed;
};

/**
 * Render a 'date' column value per its {@link IColumnFormat} date/time pick.
 * The date and time parts are independent: either alone renders just that
 * part; both render "date time". The 12-hour clock is the default; `clock24`
 * switches the time part to 24-hour. Values render in the viewer's LOCAL
 * time by default (the wire carries UTC); the `utc` pick renders the UTC
 * parts instead — including the date part, since a UTC instant near midnight
 * falls on a different local date.
 *
 * The modifiers ([24HR] / [UTC]) act even WITHOUT a pattern pick: toggled
 * alone, the override takes over the full default datetime
 * (MM/DD/YY HH:MM:SS) — otherwise the toggle would sit dead on a column
 * still rendered by its own formatter.
 *
 * @param value - The raw cell value (ISO string / epoch / Date).
 * @param fmt - The column's format override.
 * @returns The formatted text, or null when no date/time/modifier pick is
 *     set or the value does not parse as a date (callers fall back to the
 *     base render).
 */
export function formatDateValue(value: unknown, fmt: IColumnFormat): string | null {
	// No pick -> not our business; unparsable -> base formatter knows best.
	if (!fmt.dateFormat && !fmt.timeFormat && !fmt.utc && !fmt.clock24) return null;
	if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
	const date = value instanceof Date ? value : new Date(typeof value === 'string' ? assumeUtc(value) : value);
	if (Number.isNaN(date.getTime())) return null;
	// Pattern picks; a bare modifier defaults to the full datetime.
	let dateFormat = fmt.dateFormat;
	let timeFormat = fmt.timeFormat;
	if (!dateFormat && !timeFormat) {
		dateFormat = 'MM/DD/YY';
		timeFormat = 'HH:MM:SS';
	}
	// One instant, two readouts: pick the UTC or the local part set whole.
	const parts = fmt.utc
		? {
				year: date.getUTCFullYear(),
				month: date.getUTCMonth() + 1,
				day: date.getUTCDate(),
				hours: date.getUTCHours(),
				minutes: date.getUTCMinutes(),
				seconds: date.getUTCSeconds(),
		  }
		: {
				year: date.getFullYear(),
				month: date.getMonth() + 1,
				day: date.getDate(),
				hours: date.getHours(),
				minutes: date.getMinutes(),
				seconds: date.getSeconds(),
		  };
	const out: string[] = [];
	// Step 1: the date part (exclusive pair).
	if (dateFormat === 'MM/YY') {
		out.push(`${pad2(parts.month)}/${pad2(parts.year % 100)}`);
	} else if (dateFormat === 'MM/DD/YY') {
		out.push(`${pad2(parts.month)}/${pad2(parts.day)}/${pad2(parts.year % 100)}`);
	}
	// Step 2: the time part (exclusive pair), 12-hour unless clock24.
	if (timeFormat) {
		const minutes = pad2(parts.minutes);
		const seconds = timeFormat === 'HH:MM:SS' ? `:${pad2(parts.seconds)}` : '';
		if (fmt.clock24) {
			out.push(`${pad2(parts.hours)}:${minutes}${seconds}`);
		} else {
			const hours12 = parts.hours % 12 === 0 ? 12 : parts.hours % 12;
			out.push(`${hours12}:${minutes}${seconds} ${parts.hours < 12 ? 'AM' : 'PM'}`);
		}
	}
	return out.join(' ');
}

/**
 * Render a 'number' column value per its {@link IColumnFormat} number picks:
 * fixed decimals (0-3), thousands separators, and a '$' currency prefix —
 * each independent, composed as `-$1,234.50` (sign outside the currency).
 *
 * @param value - The raw cell value (number or numeric string).
 * @param fmt - The column's format override.
 * @returns The formatted text, or null when no number pick is set or the
 *     value is not numeric (callers fall back to the base render).
 */
export function formatNumberValue(value: unknown, fmt: IColumnFormat): string | null {
	if (fmt.decimals === undefined && !fmt.thousands && !fmt.currency) return null;
	const num =
		typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
	if (Number.isNaN(num)) return null;
	// Format the magnitude, then re-apply sign and prefix around it.
	let text = fmt.decimals !== undefined ? Math.abs(num).toFixed(fmt.decimals) : String(Math.abs(num));
	if (fmt.thousands) {
		const [integer, fraction] = text.split('.');
		text = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction !== undefined ? `.${fraction}` : '');
	}
	if (fmt.currency) text = `$${text}`;
	return (num < 0 ? '-' : '') + text;
}

/** A column formatter FUNCTION (the string built-in names excluded). */
type ColumnFormatterFn = Exclude<ColumnDefinition['formatter'], string | undefined>;

/**
 * Wrap a column's formatter with the FORMAT-override layer: on every cell
 * render, read the grid's live format map (through the instance stash) and
 * apply the field's picks — alignment as an inline text-align on the cell,
 * date/number picks as replacement text — falling back to the column's own
 * formatter (or a safe plaintext render) when no pick claims the value.
 *
 * @param field - The column's field (the format map key).
 * @param base - The column's declared formatter, if any.
 * @returns The wrapping formatter to place on the Tabulator definition.
 */
function wrapFormatter(field: string, base: ColumnFormatterFn | undefined): ColumnFormatterFn {
	return (cell, formatterParams, onRendered) => {
		const fmt = (cell.getTable() as IGridInstanceState).__rrFormat?.get(field);
		if (fmt) {
			// Alignment rides as inline styles; a fresh render without an
			// override never sets them, so clearing falls back to the column
			// default on the reformat the bridge triggers. text-align alone is
			// NOT enough: the grid's vertAlign columnDefault makes every cell
			// inline-flex (verified in tabulator_esm.mjs — vertAlign switches
			// the cell to flex and horizontal position to justify-content), so
			// both properties are set to cover flex and non-flex cells alike.
			if (fmt.align) {
				const el = cell.getElement();
				el.style.textAlign = fmt.align;
				el.style.justifyContent =
					fmt.align === 'left' ? 'flex-start' : fmt.align === 'center' ? 'center' : 'flex-end';
			}
			const dateText = formatDateValue(cell.getValue(), fmt);
			if (dateText !== null) return mutedEl(dateText);
			const numberText = formatNumberValue(cell.getValue(), fmt);
			if (numberText !== null) return numberText;
		}
		if (base) return base(cell, formatterParams, onRendered);
		// No declared formatter: mimic Tabulator's plaintext default, but via
		// textContent so raw values can never inject markup.
		const value = cell.getValue();
		const span = document.createElement('span');
		span.textContent = value === null || value === undefined ? '' : String(value);
		return span;
	};
}

/** Persisted layout entry shape for one column (Tabulator columns blob). */
interface IPersistedColumn {
	field?: string;
	width?: number;
	visible?: boolean;
}

/**
 * Build hidden, addable column definitions for row keys the view did not
 * declare. Called by DataGrid when `autoColumns` is set, using the first
 * received row as the shape sample. Previously persisted visibility/width
 * for an auto column (the user showed it before a reload) is re-applied so
 * layout choices survive even though auto columns are created after the
 * persisted layout was restored.
 *
 * @param sampleRow - One row from the loaded data (the shape sample).
 * @param knownFields - Fields already covered by declared columns.
 * @param persisted - The persisted Tabulator columns blob, if any.
 * @returns Column definitions for the undeclared keys (visible: false unless
 *          the persisted layout says otherwise).
 */
export function buildAutoColumns(
	sampleRow: Record<string, unknown>,
	knownFields: Set<string>,
	persisted?: IPersistedColumn[],
): ColumnDefinition[] {
	const persistedByField = new Map<string, IPersistedColumn>();
	for (const entry of persisted ?? []) {
		if (entry.field) persistedByField.set(entry.field, entry);
	}

	const defs: ColumnDefinition[] = [];
	for (const key of Object.keys(sampleRow)) {
		if (knownFields.has(key) || key.startsWith('__')) continue;
		const saved = persistedByField.get(key);
		const value = sampleRow[key];
		const def: ColumnDefinition = {
			title: titleFromKey(key),
			field: key,
			visible: saved?.visible ?? false,
			...(saved?.width ? { width: saved.width } : {}),
			// Numbers read best right-aligned; everything else left.
			...(typeof value === 'number' ? { hozAlign: 'right' as const } : {}),
			headerSort: true,
			formatter: autoFormatter,
		};
		defs.push(def);
	}
	return defs;
}

// =============================================================================
// HEADER POPUP (filter + column show/hide + reset layout)
// =============================================================================

/**
 * Widest a column may come in at when the popup's show toggle content-fits it
 * (`setWidth(true)` measures the loaded cells UNBOUNDED, and a JSON payload
 * cell measures at its full serialized length). Purely the reveal's opening
 * width — the user can drag wider, and cell text ellipsizes at the real
 * column edge either way.
 */
const REVEAL_FIT_MAX_WIDTH = 480;

/**
 * Toggle a column's visibility with the reveal content-fit — shared by the
 * header popup's COLUMNS checklist and the gear menu's column list. A newly
 * revealed column arrives width-less, and the fitColumns layout crushes it to
 * the 40px minimum (unreadable for UUID/date content). `setWidth(true)` is
 * Tabulator's content-fit: verified in tabulator_esm.mjs 6.5.2 —
 * reinitializeWidth(true) clears the width, measures the header and every
 * LOADED cell, applies the max, then re-runs the column layout, which treats
 * the new width as fixed and redistributes the rest. The fit is unbounded — a
 * JSON payload cell measures at its FULL serialized length — so the reveal is
 * clamped at {@link REVEAL_FIT_MAX_WIDTH}; the user can still drag wider.
 *
 * @param col - The column to toggle.
 */
export function toggleColumnWithFit(col: ColumnComponent): void {
	col.toggle();
	if (col.isVisible()) {
		col.setWidth(true);
		if (col.getWidth() > REVEAL_FIT_MAX_WIDTH) col.setWidth(REVEAL_FIT_MAX_WIDTH);
	}
}

/**
 * Filter control of one column's header popup, resolved by the DataGrid from
 * the column's declared {@link GridColumnRRType}: 'text' (contains input),
 * 'values' (distinct-value checklist), 'boolean' (static Yes/No checklist),
 * 'date' (Start / End range inputs), 'number' (Min / Max range inputs), or
 * 'none' (no filter section).
 */
export type HeaderFilterMode = 'text' | 'values' | 'boolean' | 'date' | 'number' | 'none';

/**
 * The DataGrid state bridge the header popup reaches through the
 * {@link IGridInstanceState.__rrHeaderFilter} table-instance stash. All values
 * flow through the grid's normal debounced filter pipeline — the popup never
 * touches Tabulator filtering directly.
 *
 * The write half (setValue / setRange) is a SINGLE-KEY programmatic API and
 * stays that way; the popup's filter section batches its pending edits
 * locally and commits them through exactly one of these calls when the user
 * hits Apply (see {@link IPendingFilterControls}).
 */
export interface IHeaderFilterBridge {
	/** Resolve the filter mode of a field (rrType + fallbacks applied). */
	mode(field: string): HeaderFilterMode;
	/** Current raw filter value of a field ('' when off). */
	getValue(field: string): string | string[];
	/**
	 * Record a filter edit. A string means server-side "contains"; an array
	 * means server-side IN. '' and [] both mean "filter off" (the DataGrid's
	 * compaction step drops them before they reach fetchers).
	 */
	setValue(field: string, value: string | string[]): void;
	/**
	 * Current range bounds of a range-typed ('date' / 'number') column, read
	 * from the column's `${field}__gte` / `${field}__lte` filter keys ('' when
	 * a bound is off). Keyed off the BASE field — the popup never touches the
	 * suffixed keys.
	 */
	getRange(field: string): { start: string; end: string };
	/**
	 * Record a range edit for a range-typed ('date' / 'number') column. Each
	 * PROVIDED bound writes its suffixed filter key (`start` → `${field}__gte`,
	 * `end` → `${field}__lte`) in ONE state update; an omitted bound is left
	 * untouched and '' clears one. Both bounds ride the same debounced
	 * pipeline as {@link IHeaderFilterBridge.setValue}.
	 */
	setRange(field: string, range: { start?: string; end?: string }): void;
	/** Distinct values of a field for the 'values' checklist. */
	getDistinct(field: string): Promise<(string | number | boolean)[]>;
	/**
	 * The field's DECLARED static filter vocabulary (`rrOptions`), normalized
	 * to value/label pairs — or null when the column declares none. When
	 * present, the 'values' checklist renders exactly these options (no
	 * distinct lookup, no dependence on the loaded rows).
	 */
	getOptions(field: string): { value: string; label: string }[] | null;
	/**
	 * True when the field's declared column carries the `rrNoPopup` marker
	 * (actions / icon columns). The marker is stripped before definitions
	 * reach Tabulator, so the popup must ask the DataGrid — which retains the
	 * pre-normalized defs — instead of `table.getColumnDefinitions()`.
	 */
	isPopupExempt(field: string): boolean;
}

/**
 * Display-format override of one column, edited in the header popup's FORMAT
 * section. Every key is optional — an absent key means "the column's own
 * default rendering". Alignment applies to any column type; the date keys
 * only ever get set on 'date' columns and the number keys on 'number'
 * columns (the popup renders type-matched controls).
 */
export interface IColumnFormat {
	/** Cell text alignment; unset = the column's declared hozAlign. */
	align?: 'left' | 'center' | 'right';
	/** Date part of a 'date' column's rendering (exclusive pair). */
	dateFormat?: 'MM/YY' | 'MM/DD/YY';
	/** Time part of a 'date' column's rendering (exclusive pair). */
	timeFormat?: 'HH:MM' | 'HH:MM:SS';
	/** 24-hour clock for the time part (default 12-hour AM/PM). */
	clock24?: boolean;
	/**
	 * Render the picked date/time parts in UTC. Default (unset) converts to
	 * the viewer's LOCAL time — the platform wire contract is that server
	 * datetimes are UTC.
	 */
	utc?: boolean;
	/** Fixed decimal places of a 'number' column (exclusive 0-3). */
	decimals?: 0 | 1 | 2 | 3;
	/** Thousands separators on a 'number' column. */
	thousands?: boolean;
	/** '$' currency prefix on a 'number' column. */
	currency?: boolean;
}

/**
 * The DataGrid format bridge the header popup's FORMAT section drives.
 * Unlike the filter bridge there is no pending state — format picks apply
 * LIVE (like the column show/hide toggles): each set() merges the patch,
 * persists the per-table format blob, and re-renders the loaded cells.
 */
export interface IHeaderFormatBridge {
	/** Current override of a field (undefined when the field has none). */
	get(field: string): IColumnFormat | undefined;
	/** Merge a patch into a field's override; `undefined` values CLEAR keys. */
	set(field: string, patch: Partial<IColumnFormat>): void;
}

/**
 * DataGrid-private state stashed on the Tabulator instance at build time, so
 * the header popup (built outside React) can reach the grid's callbacks.
 */
export interface IGridInstanceState extends Tabulator {
	/** Reset-layout callback; present only when the grid persists its layout. */
	__rrResetLayout?: () => void;
	/** Header-popup filter bridge ({@link IHeaderFilterBridge}). */
	__rrHeaderFilter?: IHeaderFilterBridge;
	/** Header-popup format bridge ({@link IHeaderFormatBridge}). */
	__rrFormat?: IHeaderFormatBridge;
}

/**
 * Synthesize the DEFAULT layout from the declared column contract. Contract
 * mode engages when ANY column declares `rrDefault`: the default view is
 * exactly the flagged columns, in the order they appear in the array; every
 * unflagged column exists hidden (declared and toggleable — the persisted
 * workspace layout, once the user saves one, still overrides all of this
 * through Tabulator persistence). With no flags declared the legacy contract
 * holds and the input is returned untouched (array order + native `visible`
 * flags).
 *
 * @param columns - Caller-declared column definitions.
 * @returns Definitions in default order with visibility applied.
 */
export function applyDefaultLayout(columns: GridColumnDefinition[]): GridColumnDefinition[] {
	// Legacy mode: no column opted into the contract — change nothing.
	if (!columns.some((c) => c.rrDefault === true)) return columns;
	// Contract mode: defaulted columns first (array order, visible), then
	// every other column (array order, hidden).
	const defaulted = columns.filter((c) => c.rrDefault === true);
	const rest = columns.filter((c) => c.rrDefault !== true);
	return [
		...defaulted.map((c) => ({ ...c, visible: true })),
		...rest.map((c) => ({ ...c, visible: false })),
	];
}

/**
 * The grid's declared DEFAULT sort, in Tabulator's sorter shape (`column` =
 * field name — the same shape `initialSort` takes and the persistence module
 * stores). Multiple `rrDefaultSort` declarations compose in array order.
 *
 * @param columns - Caller-declared column definitions.
 * @returns Sorters for `initialSort` / the persisted-sort blob; [] when the
 *     grid declares no default sort.
 */
export function defaultSorters(columns: GridColumnDefinition[]): { column: string; dir: 'asc' | 'desc' }[] {
	return columns
		.filter((c) => c.rrDefaultSort != null && typeof c.field === 'string')
		.map((c) => ({ column: c.field as string, dir: c.rrDefaultSort as 'asc' | 'desc' }));
}

/**
 * Fields the grid groups rows by, by declaration (`rrGroup`), in array
 * order. Feeds Tabulator's `groupBy` option — client-side grouping, so
 * remote grids group within the loaded page.
 *
 * @param columns - Caller-declared column definitions.
 * @returns Group-by field names; [] when the grid declares no grouping.
 */
export function defaultGroupFields(columns: GridColumnDefinition[]): string[] {
	return columns
		.filter((c) => c.rrGroup === true && typeof c.field === 'string')
		.map((c) => c.field as string);
}

/**
 * Prepare caller-declared column definitions for Tabulator: strip the
 * DataGrid-private markers (`rrNoPopup`, `rrType`, `rrDefault`,
 * `rrDefaultSort`, `rrGroup`, `rrDescription`, `rrOptions`), map
 * `rrDescription` onto Tabulator's native `headerTooltip` (unless the caller
 * set one explicitly), and wire the header popup (builder + icon) onto every
 * non-exempt column. This is the single place popup wiring happens — exempt
 * columns simply never receive the `headerPopup` option, so no `false`
 * sentinel is needed anywhere.
 *
 * Accepts the LOOSE marker form (every marker optional) because AUTO-derived
 * columns pass through here too, and an undeclared row key carries no
 * contract — the `rrDescription` requirement binds DECLARED columns only.
 *
 * @param columns - Column definitions (pre-normalized; run
 *     {@link applyDefaultLayout} first so contract-mode order/visibility land).
 * @returns Tabulator-ready definitions without DataGrid-private markers.
 */
export function normalizeColumns(
	columns: (ColumnDefinition & Partial<Pick<GridColumnDefinition, 'rrNoPopup' | 'rrType' | 'rrDefault' | 'rrDefaultSort' | 'rrGroup' | 'rrDescription' | 'rrOptions'>>)[],
): ColumnDefinition[] {
	return columns.map((def) => {
		// Step 1: strip the markers by destructuring so Tabulator never sees
		// unknown options (the DataGrid retains the PRE-normalized defs for
		// its own lookups). Destructuring, not `delete` — rrDescription is a
		// REQUIRED member of the declared contract, and required properties
		// cannot be deleted through the typed reference.
		const { rrNoPopup, rrType, rrDefault, rrDefaultSort, rrGroup, rrDescription, rrOptions, ...rest } = def;
		void rrType;
		void rrDefault;
		void rrDefaultSort;
		void rrGroup;
		void rrOptions;
		// The declared description IS the header tooltip; an explicit
		// caller-provided headerTooltip wins.
		if (rrDescription && rest.headerTooltip === undefined) {
			rest.headerTooltip = rrDescription;
		}
		// Step 2: exempt columns get no popup at all (no affordance rendered).
		if (rrNoPopup) return rest;
		// Step 3: the FORMAT-override layer wraps the cell formatter (popup
		// FORMAT section: alignment / date / number picks). String built-in
		// formatters are left alone — none of our views use them, and they
		// cannot be composed.
		if (rest.field && typeof rest.formatter !== 'string') {
			rest.formatter = wrapFormatter(rest.field, rest.formatter);
		}
		// Step 4: an explicit caller-provided headerPopup wins untouched.
		if (rest.headerPopup !== undefined) return rest;
		// Step 5: default wiring — the combined popup and Tabulator's own
		// vertical-ellipsis glyph (set explicitly for clarity; the theme's
		// hover-reveal keys off the .tabulator-header-popup-button class).
		return { ...rest, headerPopup: buildHeaderPopup, headerPopupIcon: '&#8942;' };
	});
}

/**
 * Build a section label ("FILTER", "COLUMNS") for the header popup.
 *
 * @param text - Label text (rendered uppercase by the theme CSS).
 * @returns The label element.
 */
function popupLabelEl(text: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'rr-grid-hp-label';
	el.textContent = text;
	return el;
}

/**
 * Build a section divider for the header popup (between the Filter, Columns
 * and Reset sections).
 *
 * @returns The divider element.
 */
function popupDividerEl(): HTMLElement {
	const el = document.createElement('div');
	el.className = 'rr-grid-hp-divider';
	return el;
}

/**
 * Build one checkbox row (shared by the values checklist and the column
 * toggles) — a 28px clickable flex row with a `.rr-menu-check` box and an
 * ellipsis-truncating label.
 *
 * @param text - Row label.
 * @param on - Initial checked state.
 * @param onToggle - Click handler; receives the box element to restyle.
 * @returns The row element.
 */
function checkRowEl(text: string, on: boolean, onToggle: (box: HTMLElement) => void): HTMLElement {
	const row = document.createElement('div');
	row.className = 'rr-grid-hp-item';
	const box = document.createElement('span');
	box.className = on ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check';
	const label = document.createElement('span');
	label.className = 'rr-grid-hp-item-label';
	label.textContent = text;
	row.appendChild(box);
	row.appendChild(label);
	row.addEventListener('click', () => onToggle(box));
	return row;
}

/**
 * Close the currently open header popup programmatically (the Apply verb
 * and the panel's Escape handler both end here).
 *
 * Mechanism (verified in tabulator_esm.mjs 6.5.2): Tabulator hands the
 * headerPopup builder no popup instance, so `Popup.hide()` is unreachable
 * directly — but `Popup.hideOnBlur()` binds `hide()` as `click` / `mousedown`
 * listeners on `document.body`, and clicks INSIDE the panel never reach them
 * (`loadPopup` and `Popup.show` stop their propagation). Dispatching a
 * synthetic click on `document.body` therefore runs the exact outside-click
 * code path: the blur listeners unbind, the panel detaches, and Tabulator
 * fires its external `popupClosed` event. (The blur listeners bind ~100ms
 * after open; nothing human can reach Apply inside that window.)
 */
export function closeHeaderPopup(): void {
	document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * Pending-state contract of one filter control block inside the header
 * popup's FILTER section. Edits accumulate locally in the popup DOM and
 * never touch the bridge while the user works; the section footer drives
 * the two verbs — "Clear" resets every control to its empty state (still
 * pending, nothing committed), and "Apply" commits the whole pending state
 * through the bridge in ONE update before the popup closes. Closing any
 * other way (outside click / Escape) throws the popup DOM away — and the
 * pending edits with it.
 */
interface IPendingFilterControls {
	/** Reset every pending control to its empty state (no commit). */
	clear(): void;
	/** Commit the pending state through the bridge in one update. */
	apply(): void;
}

/**
 * Build the 'text' filter controls — an input prefilled with the committed
 * value. Typing stays local (pending); Apply commits the single value
 * through {@link IHeaderFilterBridge.setValue} ('' turns the filter off).
 *
 * @param section - The filter section the controls append into.
 * @param bridge - The grid's filter bridge.
 * @param field - The opened column's field.
 * @param onRendered - Popup render hook (used to focus the input on open).
 * @returns The pending-state verbs for the section footer.
 */
function buildTextFilterControls(
	section: HTMLElement,
	bridge: IHeaderFilterBridge,
	field: string,
	onRendered: (callback: () => void) => void,
): IPendingFilterControls {
	// Step 1: input prefilled from current state (arrays never appear in
	// 'text' mode, but coerce defensively in case the mode was switched).
	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'rr-grid-hp-input';
	input.placeholder = 'Contains...';
	const current = bridge.getValue(field);
	input.value = typeof current === 'string' ? current : '';
	section.appendChild(input);

	// Step 2: focus once the popup is in the DOM so typing starts immediately.
	onRendered(() => input.focus());

	// Pending contract: no input listener — Apply reads the value once.
	return {
		clear: () => {
			input.value = '';
		},
		apply: () => bridge.setValue(field, input.value),
	};
}

/** One row of a checklist filter: the committed wire value and its label. */
interface IChecklistEntry {
	/** Wire value committed into the filter array (always a string). */
	value: string;
	/** Row label rendered next to the checkbox. */
	label: string;
}

/**
 * Static entries of the 'boolean' checklist — the wire values are the
 * stringified booleans (the server coerces them back), labelled Yes / No.
 */
const BOOLEAN_ENTRIES: IChecklistEntry[] = [
	{ value: 'true', label: 'Yes' },
	{ value: 'false', label: 'No' },
];

/**
 * Build a checklist's filter controls. Serves both checklist modes: 'values'
 * loads the column's distinct values asynchronously; 'boolean' passes the
 * static Yes/No pair. Ticks toggle PENDING state only — nothing commits
 * until the footer's Apply, so a "Clear, then tick the few I want" flow is
 * never interrupted by a mid-flight commit.
 *
 * Commit semantics (decided; Excel-adjacent): the meaningful state is a
 * PROPER SUBSET of values checked, committed as an array (server-side IN).
 * A full set admits every row and an empty set is useless as a server
 * filter, so both collapse to OFF ('').
 *
 * @param section - The filter section the controls append into.
 * @param bridge - The grid's filter bridge.
 * @param field - The opened column's field.
 * @param loadEntries - Async provider of the checklist rows (value + label).
 * @returns The pending-state verbs for the section footer.
 */
function buildChecklistFilterControls(
	section: HTMLElement,
	bridge: IHeaderFilterBridge,
	field: string,
	loadEntries: () => Promise<IChecklistEntry[]>,
): IPendingFilterControls {
	// ── Pending checklist state ─────────────────────────────────────────────
	// Wire values are strings; entry values arrive pre-stringified.
	const current = bridge.getValue(field);
	const activeArray = Array.isArray(current) && current.length > 0 ? current.map(String) : null;
	let allValues: string[] = [];
	let checked = new Set<string>();
	let loaded = false;
	const boxes = new Map<string, HTMLElement>();

	/** Restyle every checkbox from the pending `checked` set. */
	const syncBoxes = (): void => {
		for (const [value, box] of boxes) {
			box.className = checked.has(value) ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check';
		}
	};

	// ── Checklist (async) ───────────────────────────────────────────────────
	// A 'Loading...' row shows until the distinct lookup resolves.
	const list = document.createElement('div');
	list.className = 'rr-grid-hp-list';
	const loading = document.createElement('div');
	loading.className = 'rr-grid-hp-empty';
	loading.textContent = 'Loading...';
	list.appendChild(loading);
	section.appendChild(list);

	loadEntries()
		.then((entries) => {
			// Step 1: dedupe by wire value, remembering each value's label.
			const seen = new Set<string>();
			const labels = new Map<string, string>();
			allValues = [];
			for (const entry of entries) {
				if (seen.has(entry.value)) continue;
				seen.add(entry.value);
				labels.set(entry.value, entry.label);
				allValues.push(entry.value);
			}
			loaded = true;
			// Step 2: initial check-set — filter OFF means everything admitted
			// (all checked); an active array checks its (still-known) members.
			checked = activeArray
				? new Set(activeArray.filter((value) => seen.has(value)))
				: new Set(allValues);
			// Step 3: render one toggle row per value.
			list.textContent = '';
			if (allValues.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'rr-grid-hp-empty';
				empty.textContent = 'No values';
				list.appendChild(empty);
				return;
			}
			for (const value of allValues) {
				const row = checkRowEl(labels.get(value) ?? value, checked.has(value), () => {
					// Toggle membership and restyle — PENDING only, no commit.
					if (checked.has(value)) checked.delete(value);
					else checked.add(value);
					syncBoxes();
				});
				boxes.set(value, row.querySelector('.rr-menu-check') as HTMLElement);
				list.appendChild(row);
			}
		})
		.catch(() => {
			// Lookup failure: keep the popup usable, just report the miss.
			loading.textContent = 'Failed to load values';
		});

	return {
		// Clear unchecks everything — the staging point of the "Clear, then
		// tick a few, then Apply" flow (an applied empty set is OFF anyway).
		clear: () => {
			checked.clear();
			syncBoxes();
		},
		// Full set and empty set both collapse to OFF; a proper subset
		// commits as the IN array. Before the async entries resolve there is
		// no meaningful pending state — Apply then leaves the committed
		// filter untouched (the popup still closes).
		apply: () => {
			if (!loaded) return;
			if (checked.size === 0 || checked.size === allValues.length) {
				bridge.setValue(field, '');
			} else {
				bridge.setValue(field, Array.from(checked));
			}
		},
	};
}

/** The two inputs of one date bound (read by Clear / Apply). */
interface IDateBoundInputs {
	/** The bound's date input (date part of the committed value). */
	dateInput: HTMLInputElement;
	/** The bound's optional time TEXT input ('' means date-only). */
	timeInput: HTMLInputElement;
}

/** Matches 24-hour time text: H:MM / HH:MM with an optional :SS tail. */
const TIME_24H_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse pending time text ({@link buildDateFilterControls}'s plain-text time
 * box) into its normalized wire form. Accepts 24-hour `H:MM` / `HH:MM`
 * (optionally `HH:MM:SS`) with surrounding whitespace tolerated; the only
 * normalization needed is padding a 1-digit hour (minutes / seconds are
 * regex-forced to 2 digits already).
 *
 * @param text - Raw time input text.
 * @returns The normalized time (`HH:MM` or `HH:MM:SS`), '' for empty /
 *          whitespace-only text (a date-only bound), or null when the text
 *          is not a valid 24-hour time.
 */
function normalizeTimeText(text: string): string | null {
	// Step 1: empty text is the valid "no time" state, not an error.
	const trimmed = text.trim();
	if (trimmed === '') return '';
	// Step 2: shape check, then range-check each clock component.
	const match = TIME_24H_RE.exec(trimmed);
	if (!match) return null;
	const [, hours, minutes, seconds] = match;
	if (Number(hours) > 23 || Number(minutes) > 59 || (seconds !== undefined && Number(seconds) > 59)) return null;
	// Step 3: reassemble with the hour padded to 2 digits.
	const paddedHours = hours.padStart(2, '0');
	return seconds !== undefined ? `${paddedHours}:${minutes}:${seconds}` : `${paddedHours}:${minutes}`;
}

/**
 * Build the 'date' filter controls — Start / End bounds, each a native date
 * input with an OPTIONAL plain-text time box beside it (empty by default).
 * The time box is deliberately NOT `<input type="time">`: Chromium's time
 * picker drop-down is native chrome that ignores `accent-color` and cannot
 * be themed, so the control is a fully tokenized text input instead. It
 * accepts 24-hour `H:MM` / `HH:MM` (optionally `HH:MM:SS`), normalizes on
 * blur (pads 1-digit hours via {@link normalizeTimeText}), and flags invalid
 * text with the `.rr-grid-hp-input--invalid` error border. (The date input
 * stays native — its calendar panel DOES follow color-scheme/accent-color.)
 *
 * Edits stay pending; Apply serializes both bounds and commits them through
 * the bridge's range API in ONE update (`${field}__gte` / `${field}__lte`;
 * the header's active-filter dot is range-aware — either bound marks the
 * column active). Bound shapes:
 *
 *  - date + time  → `${date}T${time}` (falls through to the server's ISO
 *                   datetime parse, so the bound is time-precise)
 *  - date only    → the date-only string (the server widens a date-only end
 *                   bound to end-of-day inclusive)
 *  - no date      → '' (bound off) — a time without a date is meaningless,
 *                   so a dangling time serializes as OFF too
 *  - invalid time → the date-only string — one bad time box degrades ONLY
 *                   its own bound to date-only instead of blocking the whole
 *                   Apply, so the other bound (and this bound's date part)
 *                   still commit and the popup's close-on-Apply flow is
 *                   never wedged on a half-typed value
 *
 * @param section - The filter section the controls append into.
 * @param bridge - The grid's filter bridge.
 * @param field - The opened column's BASE field (suffixing happens inside
 *                the bridge's range API).
 * @returns The pending-state verbs for the section footer.
 */
function buildDateFilterControls(
	section: HTMLElement,
	bridge: IHeaderFilterBridge,
	field: string,
): IPendingFilterControls {
	// Start / End input pairs prefilled from the committed range.
	const current = bridge.getRange(field);

	/**
	 * Append one captioned date + optional-time input pair. The time box's
	 * listeners are cosmetic only (blur-normalize + invalid flag) — the pair
	 * stays pure pending state read by Clear / Apply.
	 *
	 * @param label - Bound caption ('Start' / 'End').
	 * @param value - Committed bound: '' (off), date-only, or `date`T`time`.
	 * @returns The pair's inputs.
	 */
	const boundInputs = (label: string, value: string): IDateBoundInputs => {
		// Compact caption above the pair.
		const caption = document.createElement('div');
		caption.className = 'rr-grid-hp-sublabel';
		caption.textContent = label;
		section.appendChild(caption);
		// Split a committed bound into its date and optional time parts.
		const [datePart, timePart = ''] = value.split('T');
		// The pair rides one flex row: date takes the remainder, time compact.
		const row = document.createElement('div');
		row.className = 'rr-grid-hp-range-row';
		const dateInput = document.createElement('input');
		dateInput.type = 'date';
		dateInput.className = 'rr-grid-hp-input rr-grid-hp-input--date';
		dateInput.value = datePart;
		// Plain-text time box (not type="time" — see the builder JSDoc): the
		// browser must not fight the tokens, so autofill/spellcheck are off.
		const timeInput = document.createElement('input');
		timeInput.type = 'text';
		timeInput.className = 'rr-grid-hp-input rr-grid-hp-input--time';
		timeInput.placeholder = 'HH:MM';
		timeInput.autocomplete = 'off';
		timeInput.spellcheck = false;
		timeInput.value = timePart;
		// Blur normalizes valid text in place (pads 1-digit hours) and flags
		// invalid text with the error border; Enter-to-Apply never blurs, so
		// Apply re-parses the raw text itself and does not depend on this.
		timeInput.addEventListener('blur', () => {
			const normalized = normalizeTimeText(timeInput.value);
			timeInput.classList.toggle('rr-grid-hp-input--invalid', normalized === null);
			if (normalized !== null) timeInput.value = normalized;
		});
		// Typing clears the flag immediately so the error never nags mid-edit.
		timeInput.addEventListener('input', () => timeInput.classList.remove('rr-grid-hp-input--invalid'));
		row.appendChild(dateInput);
		row.appendChild(timeInput);
		section.appendChild(row);
		return { dateInput, timeInput };
	};
	const start = boundInputs('Start', current.start);
	const end = boundInputs('End', current.end);

	/**
	 * Serialize one pending bound to its wire shape (see the builder JSDoc).
	 * The time text is re-parsed here rather than trusted from the blur
	 * handler (Enter-to-Apply commits without ever blurring the box); both
	 * the empty ('') and invalid (null) parse results are falsy, so either
	 * one degrades this bound to date-only instead of blocking the Apply.
	 *
	 * @param pair - The bound's date + time inputs.
	 * @returns '' (off), the date-only string, or `${date}T${normalized}`.
	 */
	const boundText = (pair: IDateBoundInputs): string => {
		if (!pair.dateInput.value) return '';
		const time = normalizeTimeText(pair.timeInput.value);
		return time ? `${pair.dateInput.value}T${time}` : pair.dateInput.value;
	};

	/** Reset one bound pair to its empty state (values + invalid flag). */
	const clearBound = (pair: IDateBoundInputs): void => {
		pair.dateInput.value = '';
		pair.timeInput.value = '';
		pair.timeInput.classList.remove('rr-grid-hp-input--invalid');
	};

	return {
		clear: () => {
			clearBound(start);
			clearBound(end);
		},
		// One range write commits both bounds together ('' turns one off).
		apply: () => bridge.setRange(field, { start: boundText(start), end: boundText(end) }),
	};
}

/**
 * Build the 'number' filter controls — Min / Max numeric inputs writing the
 * same `${field}__gte` / `${field}__lte` range keys as the date section (the
 * server coerces numeric bounds). Edits stay pending; Apply commits both
 * bounds through the bridge's range API in ONE update, and the header's
 * range-aware active dot lights while either bound is set.
 *
 * @param section - The filter section the controls append into.
 * @param bridge - The grid's filter bridge.
 * @param field - The opened column's BASE field (suffixing happens inside
 *                the bridge's range API).
 * @returns The pending-state verbs for the section footer.
 */
function buildNumberFilterControls(
	section: HTMLElement,
	bridge: IHeaderFilterBridge,
	field: string,
): IPendingFilterControls {
	// Min / Max inputs prefilled from the committed bounds (numeric bounds
	// ride the same suffixed keys as date bounds, so getRange serves both).
	const current = bridge.getRange(field);

	/**
	 * Append one captioned numeric bound input (caption style shared with
	 * the date section's Start / End sublabels).
	 *
	 * @param label - Bound caption ('Min' / 'Max').
	 * @param value - Committed bound ('' when off).
	 * @returns The bound's input.
	 */
	const boundInput = (label: string, value: string): HTMLInputElement => {
		const caption = document.createElement('div');
		caption.className = 'rr-grid-hp-sublabel';
		caption.textContent = label;
		section.appendChild(caption);
		const input = document.createElement('input');
		input.type = 'number';
		input.className = 'rr-grid-hp-input';
		input.value = value;
		section.appendChild(input);
		return input;
	};
	const min = boundInput('Min', current.start);
	const max = boundInput('Max', current.end);

	return {
		clear: () => {
			min.value = '';
			max.value = '';
		},
		// One range write commits both bounds ('' turns one off). A number
		// input's value is already '' while its text is not a valid number,
		// so only real numbers ever reach the wire.
		apply: () => bridge.setRange(field, { start: min.value.trim(), end: max.value.trim() }),
	};
}

/**
 * Build the FILTER section of the header popup: the section label, the
 * mode-specific PENDING controls, and the Clear / Apply footer row.
 *
 * Edits accumulate locally ({@link IPendingFilterControls}) and commit only
 * on Apply — one bridge call for the whole column (setValue for text /
 * checklist modes, setRange for both bounds of a date / number range). The
 * bridge updates the header's active-filter dot synchronously, then the
 * popup closes through {@link closeHeaderPopup}. Enter in any of the
 * section's inputs is an Apply shortcut; Clear only resets the pending
 * controls (applying the cleared state is what turns the filter off).
 *
 * @param bridge - The grid's filter bridge.
 * @param field - The opened column's field.
 * @param mode - The resolved (non-'none') filter mode.
 * @param onRendered - Popup render hook (focuses the 'text' input on open).
 * @returns The section element.
 */
function buildFilterSection(
	bridge: IHeaderFilterBridge,
	field: string,
	mode: Exclude<HeaderFilterMode, 'none'>,
	onRendered: (callback: () => void) => void,
): HTMLElement {
	const section = document.createElement('div');
	section.className = 'rr-grid-hp-section';
	section.appendChild(popupLabelEl('Filter'));

	// Step 1: the mode-specific pending controls append themselves into the
	// section and hand back the Clear / Apply verbs for the footer.
	let controls: IPendingFilterControls;
	switch (mode) {
		case 'values': {
			// Checklist entries are the UNION of the declared vocabulary
			// (rrOptions — curated values with labels) and the live distinct
			// values, so a value that ships in data (a new sys permission, a
			// new enum code) appears without a code change; declared labels
			// win on overlap. Degrades gracefully: declared-only when no
			// distinct source exists or it fails, distinct-only when nothing
			// is declared.
			const declared = bridge.getOptions(field) ?? [];
			controls = buildChecklistFilterControls(section, bridge, field, () =>
				bridge.getDistinct(field).then(
					(values) => {
						const declaredValues = new Set(declared.map((option) => option.value));
						const extras = values
							.map(String)
							.filter((value) => value !== '' && !declaredValues.has(value))
							.map((value) => ({ value, label: value }));
						return [...declared, ...extras];
					},
					() => declared,
				),
			);
			break;
		}
		case 'boolean':
			// Static two-entry checklist — no enumeration source needed.
			controls = buildChecklistFilterControls(section, bridge, field, () => Promise.resolve(BOOLEAN_ENTRIES));
			break;
		case 'date':
			controls = buildDateFilterControls(section, bridge, field);
			break;
		case 'number':
			controls = buildNumberFilterControls(section, bridge, field);
			break;
		default:
			controls = buildTextFilterControls(section, bridge, field, onRendered);
			break;
	}

	/** The Apply verb: commit the pending state, then close the popup. */
	const applyAndClose = (): void => {
		controls.apply();
		closeHeaderPopup();
	};

	// Step 2: the footer row — quiet Clear on the left of a primary Apply.
	const actions = document.createElement('div');
	actions.className = 'rr-grid-hp-actions';
	const clearBtn = document.createElement('button');
	clearBtn.type = 'button';
	clearBtn.className = 'rr-grid-hp-btn';
	clearBtn.textContent = 'Clear';
	clearBtn.addEventListener('click', () => controls.clear());
	const applyBtn = document.createElement('button');
	applyBtn.type = 'button';
	applyBtn.className = 'rr-grid-hp-btn rr-grid-hp-btn--primary';
	applyBtn.textContent = 'Apply';
	applyBtn.addEventListener('click', applyAndClose);
	actions.appendChild(clearBtn);
	actions.appendChild(applyBtn);
	section.appendChild(actions);

	// Step 3: Enter in any of the section's INPUTS applies immediately. The
	// shortcut deliberately skips other targets so a keyboard-focused footer
	// button keeps its native Enter activation (e.g. Enter on Clear clears).
	section.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter') return;
		if (!(event.target instanceof HTMLInputElement)) return;
		event.preventDefault();
		applyAndClose();
	});

	return section;
}

/**
 * Build an MS-Office-style justification icon (four horizontal bars, the
 * narrow ones anchored per direction) as an inline SVG in currentColor.
 *
 * @param dir - The alignment the icon depicts.
 * @returns The SVG element for the button.
 */
function alignIcon(dir: 'left' | 'center' | 'right'): SVGElement {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 12 11');
	svg.setAttribute('width', '12');
	svg.setAttribute('height', '11');
	svg.setAttribute('aria-hidden', 'true');
	// Bars alternate full / narrow; the narrow ones sit flush per direction.
	const narrowX = dir === 'left' ? 0 : dir === 'center' ? 2 : 4;
	const bars: [number, number][] = [[0, 12], [narrowX, 8], [0, 12], [narrowX, 8]];
	bars.forEach(([x, width], i) => {
		const rect = document.createElementNS(NS, 'rect');
		rect.setAttribute('x', String(x));
		rect.setAttribute('y', String(i * 3));
		rect.setAttribute('width', String(width));
		rect.setAttribute('height', '1.6');
		rect.setAttribute('rx', '0.8');
		rect.setAttribute('fill', 'currentColor');
		svg.appendChild(rect);
	});
	return svg;
}

/**
 * Build the popup's FORMAT section: a row of alignment buttons (all column
 * types) plus a type-specific second row — date/time pattern picks on 'date'
 * columns, decimals / thousands / currency picks on 'number' columns.
 *
 * Every pick applies LIVE through {@link IHeaderFormatBridge.set} (like the
 * column show/hide toggles — display concerns have no Apply step): clicking
 * an inactive option selects it (exclusive within its pair/group), clicking
 * the active one clears it back to the column default. The popup stays open,
 * so each click restyles the whole section from the fresh override state.
 *
 * @param bridge - The grid's format bridge.
 * @param field - The opened column's field.
 * @param mode - The column's resolved filter mode (reused as the rrType
 *     signal: 'date' / 'number' select the second row).
 * @returns The section element.
 */
function buildFormatSection(bridge: IHeaderFormatBridge, field: string, mode: HeaderFilterMode): HTMLElement {
	const section = document.createElement('div');
	section.className = 'rr-grid-hp-section';
	section.appendChild(popupLabelEl('Format'));

	// Live restyle pass — every option button re-derives its on/off state
	// from the bridge after any click.
	const refreshers: (() => void)[] = [];
	const refresh = (): void => {
		for (const restyle of refreshers) restyle();
	};
	const current = (): IColumnFormat => bridge.get(field) ?? {};

	/**
	 * One small option button.
	 *
	 * @param content - Text label or icon element.
	 * @param title - Tooltip describing the pick.
	 * @param isOn - Whether the pick is active in the current override.
	 * @param onClick - Applies the pick's patch through the bridge.
	 * @returns The button element.
	 */
	const optionBtn = (
		content: string | SVGElement,
		title: string,
		isOn: () => boolean,
		onClick: () => void,
	): HTMLElement => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'rr-grid-hp-fmt-btn';
		btn.title = title;
		if (typeof content === 'string') btn.textContent = content;
		else btn.appendChild(content);
		btn.addEventListener('click', () => {
			onClick();
			refresh();
		});
		refreshers.push(() => btn.classList.toggle('rr-grid-hp-fmt-btn--on', isOn()));
		return btn;
	};

	// Row 1: alignment (every column type). Clicking the active direction
	// clears the override back to the column's declared alignment.
	const alignRow = document.createElement('div');
	alignRow.className = 'rr-grid-hp-fmt-row';
	for (const dir of ['left', 'center', 'right'] as const) {
		alignRow.appendChild(
			optionBtn(alignIcon(dir), `Align ${dir}`, () => current().align === dir, () =>
				bridge.set(field, { align: current().align === dir ? undefined : dir }),
			),
		);
	}
	section.appendChild(alignRow);

	// Rows 2 + 3 on 'date' columns (user feedback 2026-07-16: date picks and
	// time picks each get their OWN row): the date part and the time part are
	// each an exclusive pair; 24HR is an independent clock toggle riding the
	// time row.
	if (mode === 'date') {
		const dateRow = document.createElement('div');
		dateRow.className = 'rr-grid-hp-fmt-row';
		for (const dateFormat of ['MM/YY', 'MM/DD/YY'] as const) {
			dateRow.appendChild(
				optionBtn(dateFormat, `Date as ${dateFormat}`, () => current().dateFormat === dateFormat, () =>
					bridge.set(field, { dateFormat: current().dateFormat === dateFormat ? undefined : dateFormat }),
				),
			);
		}
		section.appendChild(dateRow);

		const timeRow = document.createElement('div');
		timeRow.className = 'rr-grid-hp-fmt-row';
		for (const timeFormat of ['HH:MM', 'HH:MM:SS'] as const) {
			timeRow.appendChild(
				optionBtn(timeFormat, `Time as ${timeFormat}`, () => current().timeFormat === timeFormat, () =>
					bridge.set(field, { timeFormat: current().timeFormat === timeFormat ? undefined : timeFormat }),
				),
			);
		}
		timeRow.appendChild(
			optionBtn('24HR', '24-hour clock', () => current().clock24 === true, () =>
				bridge.set(field, { clock24: current().clock24 ? undefined : true }),
			),
		);
		timeRow.appendChild(
			optionBtn('UTC', 'Show in UTC (default: your local time)', () => current().utc === true, () =>
				bridge.set(field, { utc: current().utc ? undefined : true }),
			),
		);
		section.appendChild(timeRow);
	}

	// Row 2 on 'number' columns: decimals are exclusive; thousands separator
	// and currency prefix are independent toggles.
	if (mode === 'number') {
		const row = document.createElement('div');
		row.className = 'rr-grid-hp-fmt-row';
		for (const [label, places] of [['.', 0], ['.0', 1], ['.00', 2], ['.000', 3]] as const) {
			row.appendChild(
				optionBtn(label, `${places} decimal place${places === 1 ? '' : 's'}`, () => current().decimals === places, () =>
					bridge.set(field, { decimals: current().decimals === places ? undefined : places }),
				),
			);
		}
		row.appendChild(
			optionBtn(',', 'Thousands separators', () => current().thousands === true, () =>
				bridge.set(field, { thousands: current().thousands ? undefined : true }),
			),
		);
		row.appendChild(
			optionBtn('$', 'Currency prefix', () => current().currency === true, () =>
				bridge.set(field, { currency: current().currency ? undefined : true }),
			),
		);
		section.appendChild(row);
	}

	refresh();
	return section;
}

/**
 * Build the per-column header popup: an Excel-style combined panel with
 * (1) a filter section for the opened column — the control follows the
 * column's declared type via {@link IHeaderFilterBridge.mode}: 'text' input,
 * 'values' / 'boolean' checklist, 'date' Start/End range, or 'number'
 * Min/Max range — edited as PENDING state and committed by the section's
 * Apply button ({@link buildFilterSection}) — (2) a FORMAT section of live
 * display picks ({@link buildFormatSection}: alignment for every type,
 * date/time patterns on 'date' columns, decimals / thousands / currency on
 * 'number' columns) — (3) a show/hide toggle for every titled column (live,
 * not pending) — and (4) a "Reset layout" button when the grid persists its
 * layout.
 *
 * Wired per column by {@link normalizeColumns}; Tabulator invokes it on open
 * so the states are always current. Columns opt out with `rrNoPopup: true` in
 * their declared {@link GridColumnDefinition} (actions / icon columns) — those
 * never receive this builder and never appear in the toggle list.
 *
 * @param _e - The opening click (unused; Tabulator positions the popup).
 * @param column - The opened column.
 * @param onRendered - Registers a callback run once the popup is in the DOM.
 * @returns The popup panel element.
 */
export function buildHeaderPopup(
	this: unknown,
	_e: MouseEvent | TouchEvent,
	column: ColumnComponent,
	onRendered: (callback: () => void) => void,
): HTMLElement {
	// DataGrid-private state stashed on the instance at build time.
	const state = column.getTable() as IGridInstanceState;
	const panel = document.createElement('div');
	panel.className = 'rr-grid-hp';

	// Escape closes the popup (pending filter edits die with the DOM).
	// Tabulator's own Escape path is inert in 6.5.2 — its _escapeCheck
	// compares e.key (the STRING 'Escape') against the number 27 — so the
	// panel wires a document-level listener of its own. Outside-click closes
	// bypass this handler entirely; the listener self-removes on the first
	// keydown after the panel has left the DOM.
	const onKeyDown = (event: KeyboardEvent): void => {
		if (!panel.isConnected) {
			document.removeEventListener('keydown', onKeyDown);
			return;
		}
		if (event.key === 'Escape') {
			document.removeEventListener('keydown', onKeyDown);
			closeHeaderPopup();
		}
	};
	document.addEventListener('keydown', onKeyDown);

	// ── Section 1: filter (mode resolved from the column's declared type) ──
	// Pending-state controls + Clear / Apply footer; see buildFilterSection.
	// Section visibility is INDEPENDENT: 'none' (action pseudo-fields only —
	// LOCAL and REMOTE grids both resolve real modes) hides ONLY this
	// section; the FORMAT and COLUMNS sections below render regardless.
	const bridge = state.__rrHeaderFilter;
	const field = column.getField();
	const mode: HeaderFilterMode = bridge && field ? bridge.mode(field) : 'none';
	if (bridge && field && mode !== 'none') {
		panel.appendChild(buildFilterSection(bridge, field, mode, onRendered));
		panel.appendChild(popupDividerEl());
	}

	// ── Section 2: format (live display picks; see buildFormatSection) ─────
	// Every non-exempt column gets its FORMAT section — the gate is the
	// rrNoPopup exemption alone, never the filter mode (a filterless column
	// keeps its display controls).
	const formatBridge = state.__rrFormat;
	if (formatBridge && field && !(bridge && bridge.isPopupExempt(field))) {
		panel.appendChild(buildFormatSection(formatBridge, field, mode));
		panel.appendChild(popupDividerEl());
	}

	// ── Section 3: column show/hide toggles ────────────────────────────────
	// One toggle row per titled, popup-participating column, inside a
	// scroll-capped list so wide grids stay usable. Toggles apply LIVE (only
	// the filter section is pending). `rrNoPopup` columns (actions / icon)
	// are excluded — the marker lives on the PRE-normalized defs the DataGrid
	// retains, so membership is resolved through the bridge rather than
	// Tabulator's stripped definitions. Hiding the last visible column would
	// leave an unusable grid, so that final toggle is a no-op.
	const columnsSection = document.createElement('div');
	columnsSection.className = 'rr-grid-hp-section';
	columnsSection.appendChild(popupLabelEl('Columns'));
	const columnList = document.createElement('div');
	columnList.className = 'rr-grid-hp-list';
	const titled = state.getColumns().filter((col) => {
		const colField = col.getField();
		if (bridge && colField && bridge.isPopupExempt(colField)) return false;
		return (col.getDefinition().title ?? '') !== '';
	});
	// Alphabetical by title (user feedback 2026-07-16): the list is a lookup
	// ("is X available?"), so dictionary order beats display order — which
	// drifts per user as columns get dragged around and persisted.
	titled.sort((a, b) =>
		String(a.getDefinition().title).localeCompare(String(b.getDefinition().title), undefined, { numeric: true }),
	);
	for (const col of titled) {
		// The declared rrDescription lands on headerTooltip (normalizeColumns),
		// so the toggle row inherits it as its native title tooltip.
		const colTooltip = col.getDefinition().headerTooltip;
		const row = checkRowEl(String(col.getDefinition().title), col.isVisible(), (box) => {
			// Last-visible guard, then toggle and restyle in place (the popup
			// stays open, so the box must track the new state itself).
			const visibleCount = titled.filter((c) => c.isVisible()).length;
			if (col.isVisible() && visibleCount <= 1) return;
			toggleColumnWithFit(col);
			box.className = col.isVisible() ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check';
		});
		if (typeof colTooltip === 'string') row.title = colTooltip;
		columnList.appendChild(row);
	}
	columnsSection.appendChild(columnList);
	panel.appendChild(columnsSection);

	// ── Section 4: reset layout ────────────────────────────────────────────
	// Only meaningful when the grid was built with persistence; the DataGrid
	// stashes its reset callback on the instance in that case. Rendered as a
	// footer-style button row — the same quiet-outline button as the filter
	// section's Clear (user feedback 2026-07-16: a button, not a menu row) —
	// behind a real divider.
	const reset = state.__rrResetLayout;
	if (reset) {
		panel.appendChild(popupDividerEl());
		const resetSection = document.createElement('div');
		resetSection.className = 'rr-grid-hp-section';
		const actions = document.createElement('div');
		actions.className = 'rr-grid-hp-actions';
		const resetBtn = document.createElement('button');
		resetBtn.type = 'button';
		resetBtn.className = 'rr-grid-hp-btn';
		resetBtn.textContent = 'Reset layout';
		// The reset rebuilds the table, which auto-hides this popup.
		resetBtn.addEventListener('click', () => reset());
		actions.appendChild(resetBtn);
		resetSection.appendChild(actions);
		panel.appendChild(resetSection);
	}

	return panel;
}
