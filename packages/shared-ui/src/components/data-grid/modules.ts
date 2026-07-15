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
	FormatModule,
	InteractionModule,
	MenuModule,
	MoveColumnsModule,
	PageModule,
	PersistenceModule,
	ResizeColumnsModule,
	ResizeTableModule,
	SortModule,
	TooltipModule,
} from 'tabulator-tables';

// One-time registration of the platform's feature set:
//  - Ajax + Page: remote/local pagination and the fetchPage bridge
//  - Sort: header-click sorting (local or remote)
//  - Format: custom cell formatter functions
//  - Interaction: row/cell click events
//  - Menu: per-column header menu (column show/hide + reset layout)
//  - MoveColumns + ResizeColumns: drag reorder and edge-drag resize
//  - ResizeTable: re-layout when the container resizes (split panels)
//  - Persistence: layout save/restore through IDataGridPersistence
//  - Tooltip: truncated-cell hover tooltips
Tabulator.registerModule([
	AjaxModule,
	FormatModule,
	InteractionModule,
	MenuModule,
	MoveColumnsModule,
	PageModule,
	PersistenceModule,
	ResizeColumnsModule,
	ResizeTableModule,
	SortModule,
	TooltipModule,
]);

export { Tabulator };
