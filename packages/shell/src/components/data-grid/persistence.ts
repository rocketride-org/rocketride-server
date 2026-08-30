// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DataGrid layout persistence — the storage contract behind Tabulator's
 * persistence module.
 *
 * Tabulator persists layout state (column widths / order / visibility, sort,
 * page size) through a SYNCHRONOUS reader/writer pair;
 * {@link IDataGridPersistence} is that contract plus `clear` for the grid's
 * "Reset layout" action.
 *
 * Views do NOT wire an adapter themselves. Whenever a DataGrid has a
 * `tableId` and no explicit `persistence` prop, it defaults to the
 * message-channel adapter (see gridConfigChannel.ts): the grid speaks a tiny
 * CustomEvent protocol and whatever host is present answers it — the web
 * shell from the active app's workspace prefs, the VSCode webview from the
 * extension host's project workspaceState; with no bridge listening the grid
 * simply renders its declared defaults. The `persistence` prop remains only
 * as an override for hosts that need a custom store.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Persisted layout blobs for one table, keyed by Tabulator persistence type. */
export type DataGridLayout = Record<string, unknown>;

/**
 * Storage adapter consumed by {@link DataGrid}. Implementations must be
 * synchronous on `read` (Tabulator's persistence reader is sync).
 */
export interface IDataGridPersistence {
	/**
	 * Read one persisted blob.
	 *
	 * @param tableId - The grid's stable persistence key.
	 * @param type - Tabulator persistence type ('sort' | 'columns' | 'page' ...).
	 * @returns The stored blob, or false when nothing is stored.
	 */
	read(tableId: string, type: string): unknown | false;

	/**
	 * Write one persisted blob.
	 *
	 * @param tableId - The grid's stable persistence key.
	 * @param type - Tabulator persistence type.
	 * @param data - The blob Tabulator wants stored (persisted verbatim).
	 */
	write(tableId: string, type: string, data: unknown): void;

	/**
	 * Drop every persisted blob for one table (the "Reset layout" action).
	 *
	 * @param tableId - The grid's stable persistence key.
	 */
	clear(tableId: string): void;
}

// =============================================================================
// WORKSPACE ADAPTER
// =============================================================================

/** Shape of the `tableLayouts` map stored under workspace prefs. */
type TableLayoutsMap = Record<string, DataGridLayout>;

/** Prefs key holding every grid layout for the hosting app. */
const PREFS_KEY = 'tableLayouts';

/**
 * Create an {@link IDataGridPersistence} backed by workspace prefs
 * (`prefs.tableLayouts[tableId][type]`).
 *
 * The adapter seeds an in-memory cache from the live prefs at creation and
 * funnels every write through it, so concurrent writes from multiple grids in
 * the same view are last-writer-safe; the workspace store's own debounce
 * batches the disk writes.
 *
 * @internal Not exported from the package barrel. Views rely on the
 * tableId-default message adapter instead (gridConfigChannel.ts); the web
 * shell's WorkspaceProvider bridge inlines these prefs semantics on the host
 * side of that channel. Retained for direct-path import by a host that needs
 * a prefs-backed adapter as an explicit `persistence` override.
 *
 * @param getPrefs - Getter over the LIVE workspace prefs object (use a ref).
 * @param updatePrefs - The workspace `updatePrefs` patch function.
 * @returns A persistence adapter to pass to one or more DataGrids in a view.
 */
export function createWorkspaceGridPersistence(getPrefs: () => Record<string, unknown>, updatePrefs: (patch: Record<string, unknown>) => void): IDataGridPersistence {
	// Seed the cache from whatever the store has hydrated; clone one level so
	// grid writes never mutate the store's own object graph in place.
	const stored = getPrefs()[PREFS_KEY];
	const cache: TableLayoutsMap = {};
	if (stored && typeof stored === 'object') {
		for (const [id, layout] of Object.entries(stored as TableLayoutsMap)) {
			cache[id] = { ...layout };
		}
	}

	/** Push the whole cached map back through the workspace store. */
	const flush = (): void => {
		updatePrefs({ [PREFS_KEY]: { ...cache } });
	};

	return {
		read(tableId: string, type: string): unknown | false {
			// Prefer the cache (has this session's writes); fall back to false so
			// Tabulator applies its defaults for anything never persisted.
			const layout = cache[tableId];
			if (!layout || !(type in layout)) return false;
			return layout[type];
		},

		write(tableId: string, type: string, data: unknown): void {
			// Merge into the per-table blob, then persist the full map.
			cache[tableId] = { ...cache[tableId], [type]: data };
			flush();
		},

		clear(tableId: string): void {
			// Remove the table's entry entirely — the next build sees defaults.
			delete cache[tableId];
			flush();
		},
	};
}
