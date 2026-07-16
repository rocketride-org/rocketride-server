// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataGrid helpers — DOM cell factories, the actions column builder, the
 * per-column header menu, and the local-search predicate.
 *
 * Tabulator formatters build DOM outside React, so in-cell primitives are
 * plain elements styled by the token CSS classes in `tabulator-theme.css`
 * (`.rr-cell-badge`, `.rr-cell-btn`, ...). Those classes replicate the VALUES
 * of StatusBadge / Button / commonStyles from the same `--rr-*` tokens, so
 * themes stay in sync automatically.
 */

import type { CellComponent, ColumnDefinition, MenuObject, MenuSeparator, ColumnComponent } from 'tabulator-tables';

// =============================================================================
// TYPES
// =============================================================================

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
// ACTIONS COLUMN
// =============================================================================

/**
 * Build the trailing Actions column — right-aligned small buttons, exempt from
 * sorting / moving / the header menu, and excluded from row-click handling
 * (the DataGrid's rowClick guard skips clicks inside `[data-rr-actions]`).
 *
 * @typeParam Row - Row shape of the grid.
 * @param config - Actions and click router.
 * @returns A Tabulator column definition to append to the columns array.
 */
export function createActionsColumn<Row>(config: IActionsColumnConfig<Row>): ColumnDefinition {
	const { actions, onAction, width = 120 } = config;
	return {
		title: 'Actions',
		field: '__rrActions',
		width,
		hozAlign: 'right',
		headerSort: false,
		headerMenu: false,
		resizable: false,
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
		// `headerMenu: false` (menu-exempt column) predates the @types union, so
		// the object doesn't structurally match ColumnDefinition yet at runtime
		// Tabulator accepts it — hence the two-step cast.
	} as unknown as ColumnDefinition;
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
 * Type-heuristic formatter for an auto-derived column, keyed off the value
 * actually in the cell (auto columns have no declared type):
 * boolean -> yes/no badge, ISO datetime string -> muted local date-time,
 * array -> badge list, object -> truncated JSON, null -> ''.
 *
 * @param cell - The Tabulator cell.
 * @returns The formatted cell content.
 */
function autoFormatter(cell: CellComponent): HTMLElement | string {
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
		const el = document.createElement('span');
		el.className = 'rr-cell-mono rr-cell-truncate';
		el.style.maxWidth = '260px';
		const text = JSON.stringify(value);
		el.textContent = text;
		el.title = text.length > 500 ? `${text.slice(0, 500)}...` : text;
		return el;
	}
	return String(value);
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
		defs.push({
			title: titleFromKey(key),
			field: key,
			visible: saved?.visible ?? false,
			...(saved?.width ? { width: saved.width } : {}),
			// Numbers read best right-aligned; everything else left.
			...(typeof value === 'number' ? { hozAlign: 'right' } : {}),
			headerSort: true,
			formatter: autoFormatter,
		} as ColumnDefinition);
	}
	return defs;
}

// =============================================================================
// HEADER MENU (column show/hide + reset layout)
// =============================================================================

/**
 * Key under which the DataGrid stashes its reset-layout callback on the
 * Tabulator instance, so the menu (built outside React) can reach it.
 */
export const RESET_LAYOUT_KEY = '__rrResetLayout';

/**
 * Build the per-column header menu: a show/hide toggle for every titled
 * column, plus a "Reset layout" item when the grid persists its layout.
 *
 * Passed as `columnDefaults.headerMenu`; Tabulator invokes it on open so the
 * checked states are always current. Columns opt out with `headerMenu: false`
 * in their own definition (actions / icon columns).
 *
 * @returns The menu items for the opened column's table.
 */
export function buildHeaderMenu(this: unknown, _e: MouseEvent | TouchEvent, column: ColumnComponent): (MenuObject<ColumnComponent> | MenuSeparator)[] {
	const table = column.getTable();
	const items: (MenuObject<ColumnComponent> | MenuSeparator)[] = [];

	// One toggle row per titled, menu-participating column (columns that opt
	// out with `headerMenu: false` — actions / icon columns — are excluded).
	// Hiding the last visible column would leave an unusable grid, so that
	// final toggle is a no-op.
	const titled = table.getColumns().filter((col) => {
		const def = col.getDefinition() as unknown as Record<string, unknown>;
		return (def.title ?? '') !== '' && def.headerMenu !== false;
	});
	for (const col of titled) {
		items.push({
			label: () => {
				const label = document.createElement('span');
				label.className = 'rr-menu-toggle';
				const box = document.createElement('span');
				box.className = col.isVisible() ? 'rr-menu-check rr-menu-check--on' : 'rr-menu-check';
				label.appendChild(box);
				label.appendChild(document.createTextNode(String(col.getDefinition().title)));
				return label;
			},
			action: () => {
				const visibleCount = titled.filter((c) => c.isVisible()).length;
				if (col.isVisible() && visibleCount <= 1) return;
				col.toggle();
			},
		});
	}

	// Reset layout — only meaningful when the grid was built with persistence;
	// the DataGrid stashes its reset callback on the instance in that case.
	const reset = (table as unknown as Record<string, unknown>)[RESET_LAYOUT_KEY];
	if (typeof reset === 'function') {
		items.push({ separator: true });
		items.push({
			label: 'Reset layout',
			action: () => (reset as () => void)(),
		});
	}

	return items;
}
