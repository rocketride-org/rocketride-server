// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tabulator modular build registration for the DataGrid.
 *
 * Tabulator ships a core class plus opt-in feature modules. Registering only
 * the modules the platform actually uses lets the bundler tree-shake the rest
 * (the package marks only CSS as side-effectful), keeping the shared singleton
 * bundle lean versus importing `TabulatorFull`.
 *
 * Registration is module-scoped and runs once on first import. Import the
 * `Tabulator` class from THIS file, never from 'tabulator-tables' directly.
 */

import {
	Tabulator,
	AjaxModule,
	FilterModule,
	FormatModule,
	InteractionModule,
	MenuModule,
	MoveColumnsModule,
	PageModule,
	PersistenceModule,
	PopupModule,
	ResizeColumnsModule,
	ResizeTableModule,
	SortModule,
	TooltipModule,
} from 'tabulator-tables';
import type { CellComponent, ColumnComponent } from 'tabulator-tables';

// =============================================================================
// TYPE AUGMENTATION
// =============================================================================

// @types/tabulator-tables does not model the Popup module's per-column header
// popup options yet, although the runtime (registered below) supports them.
// Augment ColumnDefinition with the real option shapes so DataGrid code can
// wire popups with correct types instead of casting.
declare module 'tabulator-tables' {
	interface ColumnDefinition {
		/**
		 * Per-column header popup: an HTML string, an element, or a builder
		 * invoked on open (event, column, onRendered) returning the panel.
		 * Supported by the Popup module at runtime; missing from @types.
		 */
		headerPopup?:
			| string
			| HTMLElement
			| ((
					e: MouseEvent | TouchEvent,
					column: ColumnComponent,
					onRendered: (callback: () => void) => void,
			  ) => HTMLElement | string);
		/**
		 * Icon of the header-popup button: HTML string, element, or a builder
		 * from the column component. Supported at runtime; missing from @types.
		 */
		headerPopupIcon?: string | HTMLElement | ((component: ColumnComponent) => HTMLElement | string);
	}

	interface EventCallBackMethods {
		/**
		 * Popup-open lifecycle event — dispatched by the 6.5.2 runtime
		 * (verified in tabulator_esm.mjs); missing from @types 6.2.11, which
		 * declares only `popupClosed`. Typed to match that declaration. The
		 * DataGrid pairs them to close body-anchored popups when an ancestor
		 * container scrolls.
		 */
		popupOpened: (cell: CellComponent) => void;
	}
}

// One-time registration of the platform's feature set:
//  - Ajax + Page: remote/local pagination and the fetchPage bridge
//  - Sort: header-click sorting (local or remote)
//  - Filter: the grid-local search (DataGrid installs a predicate through
//    setFilter; filterMode stays 'local', so with paginationMode 'remote'
//    the predicate narrows only the LOADED page rows — refreshFilter() only
//    calls reloadData when filterMode is 'remote')
//  - Format: custom cell formatter functions
//  - Interaction: row/cell click events
//  - Menu: supports caller-provided header menus and avoids invalid-option
//    warnings for any headerMenu escape-hatch usage
//  - Popup: per-column header popup (filter + column show/hide + reset layout)
//  - MoveColumns + ResizeColumns: drag reorder and edge-drag resize
//  - ResizeTable: re-layout when the container resizes (split panels)
//  - Persistence: layout save/restore through IDataGridPersistence
//  - Tooltip: truncated-cell hover tooltips
//
// Guarded: under the node:test smoke runner (tsx/CJS, no DOM) the
// tabulator-tables UMD interop yields an undefined Tabulator binding. No
// grid ever renders there, so registration is safely skipped; every real
// bundle (rspack ESM) resolves Tabulator and registers as before.
if (Tabulator) {
	Tabulator.registerModule([
		AjaxModule,
		FilterModule,
		FormatModule,
		InteractionModule,
		MenuModule,
		MoveColumnsModule,
		PageModule,
		PersistenceModule,
		PopupModule,
		ResizeColumnsModule,
		ResizeTableModule,
		SortModule,
		TooltipModule,
	]);
}

export { Tabulator };
