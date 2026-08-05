// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Grid config channel — host-agnostic persistence for DataGrid layouts.
 *
 * The DataGrid's per-user customizations (Tabulator's sort/columns/page blobs
 * plus the platform's display/format blobs) need a store, but shared must
 * not import shell, and grids also render inside hosts with no workspace
 * at all (the VSCode webview). This channel decouples them: grids speak a
 * tiny message protocol, and WHATEVER host is present answers it —
 *
 *   - web shell: a bridge inside WorkspaceProvider answers from the active
 *     app's workspace prefs (`prefs.tableLayouts`),
 *   - VSCode webview: a bridge answers from a cache seeded by the extension
 *     host (persisted in the project's workspaceState),
 *   - no host bridge: reads report nothing (declared defaults apply) and
 *     writes drop silently.
 *
 * Transport is same-window CustomEvents on `document`. Dispatch is
 * SYNCHRONOUS in the DOM, which is what makes this compatible with
 * Tabulator's synchronous persistence reader (see persistence.ts): the
 * bridge's listener runs — and calls `reply` — before dispatchEvent returns.
 *
 * Events:
 *   - 'rr:grid-config:get'   detail {@link IGridConfigGetDetail}
 *   - 'rr:grid-config:set'   detail {@link IGridConfigSetDetail}
 *   - 'rr:grid-config:clear' detail {@link IGridConfigClearDetail}
 */

import type { DataGridLayout, IDataGridPersistence } from './persistence';

// =============================================================================
// PROTOCOL
// =============================================================================

/** Event name: synchronous read of one table's persisted layout blobs. */
export const GRID_CONFIG_GET = 'rr:grid-config:get';

/** Event name: persist one layout blob for a table (fire-and-forget). */
export const GRID_CONFIG_SET = 'rr:grid-config:set';

/** Event name: drop every persisted blob for a table (Reset layout). */
export const GRID_CONFIG_CLEAR = 'rr:grid-config:clear';

/** Detail of {@link GRID_CONFIG_GET}. */
export interface IGridConfigGetDetail {
	/** The grid's stable persistence key. */
	tableId: string;
	/**
	 * Called SYNCHRONOUSLY by the host bridge with the table's stored blobs
	 * (keyed by Tabulator persistence type), or undefined when none exist.
	 * Never called when no bridge is listening.
	 */
	reply: (layouts: DataGridLayout | undefined) => void;
}

/** Detail of {@link GRID_CONFIG_SET}. */
export interface IGridConfigSetDetail {
	/** The grid's stable persistence key. */
	tableId: string;
	/** Tabulator persistence type ('sort' | 'columns' | 'page' | ...). */
	type: string;
	/** The blob to store verbatim. */
	blob: unknown;
}

/** Detail of {@link GRID_CONFIG_CLEAR}. */
export interface IGridConfigClearDetail {
	/** The grid's stable persistence key. */
	tableId: string;
}

// =============================================================================
// ADAPTER
// =============================================================================

/**
 * Create an {@link IDataGridPersistence} speaking the grid config channel.
 *
 * Reads seed a per-instance cache with ONE synchronous `get` per tableId
 * (the host bridge answers before dispatch returns); writes and clears
 * update the cache and notify the host fire-and-forget. With no bridge
 * present, reads return false (Tabulator applies the declared defaults)
 * and writes are dropped — the grid works, just without persistence.
 *
 * @returns A persistence adapter for one or more DataGrids.
 */
export function createMessageGridPersistence(): IDataGridPersistence {
	// Per-table blob cache; `null` marks "asked the host, nothing stored".
	const cache = new Map<string, DataGridLayout | null>();

	/** Fetch (once) and cache a table's stored blobs from the host bridge. */
	const load = (tableId: string): DataGridLayout | null => {
		const cached = cache.get(tableId);
		if (cached !== undefined) return cached;
		let received: DataGridLayout | undefined;
		const detail: IGridConfigGetDetail = {
			tableId,
			reply: (layouts) => {
				received = layouts;
			},
		};
		document.dispatchEvent(new CustomEvent(GRID_CONFIG_GET, { detail }));
		const loaded = received ? { ...received } : null;
		cache.set(tableId, loaded);
		return loaded;
	};

	return {
		read(tableId: string, type: string): unknown | false {
			const layout = load(tableId);
			if (!layout || !(type in layout)) return false;
			return layout[type];
		},

		write(tableId: string, type: string, blob: unknown): void {
			// Merge into the cache so later sync reads see this session's
			// writes even if the host is absent or slow to persist.
			const layout = load(tableId) ?? {};
			layout[type] = blob;
			cache.set(tableId, layout);
			const detail: IGridConfigSetDetail = { tableId, type, blob };
			document.dispatchEvent(new CustomEvent(GRID_CONFIG_SET, { detail }));
		},

		clear(tableId: string): void {
			cache.set(tableId, null);
			const detail: IGridConfigClearDetail = { tableId };
			document.dispatchEvent(new CustomEvent(GRID_CONFIG_CLEAR, { detail }));
		},
	};
}
