// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * GridConfigStore — project-local persistence for DataGrid layouts.
 *
 * The extension-host side of the grid config channel: webview bridges
 * (useGridConfigBridge) forward `grid:config:set` / `grid:config:clear`
 * messages here, and providers include the whole stored map in their
 * view:ready reply (`grid:config:init`) so the webview cache is primed
 * before any grid mounts.
 *
 * Storage is `context.workspaceState` under one key — project-local (each
 * workspace keeps its own layouts) and it survives window reloads.
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';

// =============================================================================
// CONSTANTS
// =============================================================================

/** workspaceState key holding the map: tableId -> { persistence type -> blob }. */
const STORAGE_KEY = 'rr.gridLayouts';

// =============================================================================
// STORE
// =============================================================================

/**
 * Small persistence wrapper over `context.workspaceState` for the grid
 * config channel's layout blobs.
 */
export class GridConfigStore {
	private logger = getLogger();

	/**
	 * @param context - The extension context owning the workspaceState.
	 */
	constructor(private context: vscode.ExtensionContext) {}

	/**
	 * Read the whole persisted layout map.
	 *
	 * @returns tableId -> { persistence type -> blob }; {} when none stored.
	 */
	public getAll(): Record<string, Record<string, unknown>> {
		return this.context.workspaceState.get<Record<string, Record<string, unknown>>>(STORAGE_KEY) ?? {};
	}

	/**
	 * Merge ONE layout blob into a table's entry and persist the updated map
	 * (fire-and-forget; failures are logged, the webview cache stays current).
	 *
	 * @param tableId - The grid's stable persistence key.
	 * @param type - Tabulator persistence type ('sort' | 'columns' | 'page' | ...).
	 * @param blob - The blob to store verbatim.
	 */
	public set(tableId: string, type: string, blob: unknown): void {
		// Step 1: copy-on-write merge so the stored object graph is replaced.
		const map = { ...this.getAll() };
		map[tableId] = { ...map[tableId], [type]: blob };
		// Step 2: persist asynchronously; log (not throw) on failure.
		this.context.workspaceState.update(STORAGE_KEY, map).then(undefined, (err: unknown) => {
			this.logger.error(`[GridConfigStore] Failed to persist grid layout '${tableId}': ${err}`);
		});
	}

	/**
	 * Drop every persisted blob for one table (the "Reset layout" action).
	 *
	 * @param tableId - The grid's stable persistence key.
	 */
	public clear(tableId: string): void {
		// Step 1: remove the table's entry entirely — next read sees defaults.
		const map = { ...this.getAll() };
		delete map[tableId];
		// Step 2: persist asynchronously; log (not throw) on failure.
		this.context.workspaceState.update(STORAGE_KEY, map).then(undefined, (err: unknown) => {
			this.logger.error(`[GridConfigStore] Failed to clear grid layout '${tableId}': ${err}`);
		});
	}
}
