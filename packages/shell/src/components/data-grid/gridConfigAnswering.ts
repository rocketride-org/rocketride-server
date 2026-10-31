// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// GRID CONFIG ANSWERING — the channel's store-backed answering side
// =============================================================================
//
// DataGrids persist layouts by firing synchronous CustomEvents on
// `document` (gridConfigChannel.ts); SOMEONE in the realm must answer.
// In the web shell that someone is the workspace provider; any OTHER realm
// that hosts grids (a VS Code webview, an isolated frame) mounts this hook
// over its PrefsStore instead. Layouts live under the system partition's
// `tableLayouts` key — one storage shape in every host.
//
// Mount ONCE per realm, and only after the store's `ready` has been
// awaited by the realm's bootstrap where first-paint reads matter
// (Tabulator's persistence reader is synchronous).
// =============================================================================

import { useEffect } from 'react';
import { GRID_CONFIG_GET, GRID_CONFIG_SET, GRID_CONFIG_CLEAR } from './gridConfigChannel';
import type { IGridConfigGetDetail, IGridConfigSetDetail, IGridConfigClearDetail } from './gridConfigChannel';
import type { DataGridLayout } from './persistence';
import type { PrefsStore, ShellPrefsMap } from '../workspace/prefsStore';
import { typedPrefs } from '../workspace/prefsStore';

/**
 * Answers the realm's grid-config channel from a prefs store.
 *
 * @param store - The realm's SYSTEM-partition store (holds `tableLayouts`).
 */
export function useGridConfigAnswering(store: PrefsStore): void {
	useEffect(() => {
		const prefs = typedPrefs<ShellPrefsMap>(store);
		const layoutMap = (): Record<string, DataGridLayout> => ({ ...(prefs.get('tableLayouts') as Record<string, DataGridLayout> | undefined ?? {}) });

		const onGet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigGetDetail>).detail;
			// Sync reply before dispatchEvent returns; undefined = defaults.
			detail.reply(layoutMap()[detail.tableId]);
		};
		const onSet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigSetDetail>).detail;
			const map = layoutMap();
			map[detail.tableId] = { ...map[detail.tableId], [detail.type]: detail.blob };
			prefs.set('tableLayouts', map);
		};
		const onClear = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigClearDetail>).detail;
			const map = layoutMap();
			delete map[detail.tableId];
			prefs.set('tableLayouts', map);
		};

		document.addEventListener(GRID_CONFIG_GET, onGet);
		document.addEventListener(GRID_CONFIG_SET, onSet);
		document.addEventListener(GRID_CONFIG_CLEAR, onClear);
		return () => {
			document.removeEventListener(GRID_CONFIG_GET, onGet);
			document.removeEventListener(GRID_CONFIG_SET, onSet);
			document.removeEventListener(GRID_CONFIG_CLEAR, onClear);
		};
	}, [store]);
}
