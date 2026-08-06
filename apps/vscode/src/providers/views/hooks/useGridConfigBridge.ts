// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useGridConfigBridge — VS Code webview host bridge for the DataGrid config
 * channel.
 *
 * Shared-ui DataGrids persist their per-user layouts (Tabulator's
 * sort/columns/page blobs plus the platform display/format blobs) over
 * same-window CustomEvents on `document` (the grid config channel). In the
 * web shell the workspace provider answers them from workspace prefs; inside
 * a VS Code webview THIS hook is the answering side:
 *
 *  - `rr:grid-config:get`  — answered SYNCHRONOUSLY from a local cache
 *    (Tabulator's persistence reader is sync), which the extension host seeds
 *    with one `grid:config:init` message in its view:ready reply — BEFORE the
 *    first dashboard snapshot, so the cache is primed before any grid mounts.
 *  - `rr:grid-config:set` / `rr:grid-config:clear` — merged into the cache
 *    and forwarded to the extension host (`grid:config:set` /
 *    `grid:config:clear`), which persists them in the project's
 *    workspaceState via GridConfigStore.
 *
 * Mount it ONCE per webview, BEFORE useMessaging, so the init listener is
 * attached before the view:ready handshake fires.
 */

import { useEffect } from 'react';
import { GRID_CONFIG_GET, GRID_CONFIG_SET, GRID_CONFIG_CLEAR } from 'shell/src/components/data-grid/gridConfigChannel';
import type { IGridConfigGetDetail, IGridConfigSetDetail, IGridConfigClearDetail } from 'shell/src/components/data-grid/gridConfigChannel';
import type { DataGridLayout } from 'shell/src/components/data-grid/persistence';
import { getVsCodeApi } from './useMessaging';

// =============================================================================
// HOOK
// =============================================================================

/**
 * Mount the webview-side grid config bridge: answer the channel's get events
 * from the host-seeded cache and forward writes to the extension host.
 */
export function useGridConfigBridge(): void {
	useEffect(() => {
		// Per-mount layout cache: tableId -> { persistence type -> blob }.
		// Seeded by grid:config:init; kept current by the set/clear handlers
		// so later synchronous reads see this session's writes.
		let cache: Record<string, DataGridLayout> = {};

		/** Seed the cache from the extension host's grid:config:init message. */
		const onHostMessage = (event: MessageEvent): void => {
			const message = event.data as { type?: string; layouts?: Record<string, DataGridLayout> } | undefined;
			if (message?.type === 'grid:config:init') {
				cache = { ...(message.layouts ?? {}) };
			}
		};

		/** Answer a synchronous layout read from the cache. */
		const onGet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigGetDetail>).detail;
			// reply must run before dispatchEvent returns (sync DOM dispatch);
			// undefined means "nothing stored" and the grid applies defaults.
			detail.reply(cache[detail.tableId]);
		};

		/** Merge one blob into the cache and persist it via the host. */
		const onSet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigSetDetail>).detail;
			cache[detail.tableId] = { ...cache[detail.tableId], [detail.type]: detail.blob };
			getVsCodeApi()?.postMessage({ type: 'grid:config:set', tableId: detail.tableId, blobType: detail.type, blob: detail.blob });
		};

		/** Drop a table's blobs from the cache and the host store (Reset layout). */
		const onClear = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigClearDetail>).detail;
			delete cache[detail.tableId];
			getVsCodeApi()?.postMessage({ type: 'grid:config:clear', tableId: detail.tableId });
		};

		// Attach: host messages on window, channel CustomEvents on document.
		window.addEventListener('message', onHostMessage);
		document.addEventListener(GRID_CONFIG_GET, onGet);
		document.addEventListener(GRID_CONFIG_SET, onSet);
		document.addEventListener(GRID_CONFIG_CLEAR, onClear);
		return () => {
			window.removeEventListener('message', onHostMessage);
			document.removeEventListener(GRID_CONFIG_GET, onGet);
			document.removeEventListener(GRID_CONFIG_SET, onSet);
			document.removeEventListener(GRID_CONFIG_CLEAR, onClear);
		};
	}, []);
}
