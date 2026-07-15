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
 * own `ColumnDefinition` objects and the `options` prop passes any native
 * option through. The component only adds platform defaults:
 *
 *  - the token theme (tabulator-theme.css) and EmptyState-styled placeholder
 *  - column drag-reorder, edge-drag resize, and the header menu with
 *    per-column show/hide toggles + "Reset layout"
 *  - per-user layout persistence via {@link IDataGridPersistence}
 *  - the footer contract: footer renders only when the set spans >1 page
 *  - remote paging through `fetchPage` (DAP fetchers, not URLs)
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
	type ForwardedRef,
	type ReactElement,
	type Ref,
} from 'react';
import type { ColumnDefinition, Options } from 'tabulator-tables';
import { Tabulator } from './modules';
import { buildHeaderMenu, RESET_LAYOUT_KEY } from './defaults';
import type { IDataGridPersistence } from './persistence';
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
	/** Tabulator-native column definitions. Memoize; identity change re-applies. */
	columns: ColumnDefinition[];
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
	/** Clear the persisted layout for `tableId` and rebuild with defaults. */
	resetLayout(): void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default page-size options (first entry = initial size). */
const DEFAULT_PAGE_SIZES = [10, 25, 50];

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build the EmptyState-styled placeholder element Tabulator shows for a
 * zero-row set.
 *
 * @param title - Headline (defaults to 'No results').
 * @param description - Optional secondary line.
 * @returns The placeholder element.
 */
function buildPlaceholder(title?: string, description?: string): HTMLElement {
	const wrap = document.createElement('div');
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

	/** The Reset layout action (also reachable from the header menu). */
	const resetLayout = (): void => {
		if (tableId) persistenceRef.current?.clear(tableId);
		builtRef.current = false;
		setEpoch((e) => e + 1);
	};

	// ── Build / destroy ─────────────────────────────────────────────────────
	useEffect(() => {
		if (!containerRef.current) return undefined;
		const remote = !!fetchRef.current;
		const persist = !!(tableId && persistenceRef.current);

		// Step 1: assemble the option set — platform defaults, then the mode
		// block (local vs remote), then persistence, then the caller's
		// escape-hatch options merged last (columnDefaults merged one level).
		const built: Options = {
			layout: 'fitColumns',
			columns,
			placeholder: buildPlaceholder(emptyTitle, emptyDescription),
			movableColumns: true,
			columnDefaults: {
				headerSort: false,
				vertAlign: 'middle',
				resizable: 'header',
				headerMenu: buildHeaderMenu,
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
							return fetchRef.current!({ page, size, sort }).then((result) => ({
								data: result.rows,
								last_page: Math.max(1, Math.ceil(result.total / size)),
								last_row: result.total,
							}));
						},
				  }
				: { data: (dataRef.current ?? []) as Record<string, unknown>[] }),
			...(persist
				? {
						persistence: { sort: true, columns: ['width', 'visible'], page: { size: true, page: false } },
						persistenceID: tableId,
						persistenceMode: true,
						persistenceReaderFunc: (id: string, type: string) => persistenceRef.current?.read(id, type) ?? false,
						persistenceWriterFunc: (id: string, type: string, blob: unknown) =>
							persistenceRef.current?.write(id, type, blob),
				  }
				: {}),
			...options,
			// columnDefaults from `options` was already folded in above; make
			// sure a plain `...options` spread doesn't clobber the merge.
			...(options?.columnDefaults
				? { columnDefaults: { headerSort: false, vertAlign: 'middle', resizable: 'header', headerMenu: buildHeaderMenu, ...options.columnDefaults } }
				: {}),
		} as Options;

		// Step 2: create the instance and wire events.
		const table = new Tabulator(containerRef.current, built);
		tableRef.current = table;

		// Expose the reset action to the header menu (built outside React).
		if (persist) {
			(table as unknown as Record<string, unknown>)[RESET_LAYOUT_KEY] = resetLayout;
		}

		table.on('tableBuilt', () => {
			builtRef.current = true;
			// Flush calls parked while Tabulator was still building.
			const queued = queueRef.current.splice(0);
			for (const fn of queued) fn(table);
			syncFooter();
		});
		table.on('rowClick', (e, row) => {
			if (isActionTarget(e as UIEvent)) return;
			rowClickRef.current?.(row.getData() as Row);
		});
		table.on('dataProcessed', syncFooter);
		table.on('pageLoaded', syncFooter);
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
		whenBuilt((table) => {
			void table.replaceData(data as Record<string, unknown>[]).then(clampPage);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data]);

	// Column identity change: re-apply definitions (views memoize columns, so
	// this fires only when they genuinely change).
	const columnsInitRef = useRef(true);
	useEffect(() => {
		if (columnsInitRef.current) {
			columnsInitRef.current = false;
			return;
		}
		whenBuilt((table) => table.setColumns(columns));
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

	return (
		<div
			ref={containerRef}
			className={onRowClick ? 'rr-grid rr-grid--clickable' : 'rr-grid'}
		/>
	);
}

/**
 * The platform's stock table. See the module doc above for behavior; see
 * {@link IDataGridProps} for the API.
 */
export const DataGrid = forwardRef(DataGridInner) as <Row extends Record<string, unknown>>(
	props: IDataGridProps<Row> & { ref?: Ref<IDataGridHandle> },
) => ReactElement;
