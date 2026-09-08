// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CardDataGrid — a synonym for {@link DataGrid} whose ONLY difference is the
 * type contract: `title` is REQUIRED (design decision 2026-07-16).
 *
 * It is the name to reach for when a grid IS a card on the page: the title
 * (plus optional `actions`) puts the grid's header into its two-row
 * card-header form — identity row over tool row, one fill, one border — so
 * the card never stacks a separate header on top of the grid bar. There is
 * no wrapper and no runtime of its own: CardDataGrid IS DataGrid, re-typed.
 * Use bare {@link DataGrid} for full-page grids where the page header names
 * the view (e.g. Audit Logs).
 */

import type { ReactElement, Ref } from 'react';
import { DataGrid } from './DataGrid';
import type { IDataGridHandle, IDataGridProps } from './DataGrid';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for {@link CardDataGrid}: the full DataGrid API with `title` made
 * REQUIRED — a card must be named. Everything else, `actions` included,
 * is inherited verbatim.
 */
export type ICardDataGridProps<Row extends Record<string, unknown>> = IDataGridProps<Row> & {
	/** Card title, rendered in the header's identity row (required). */
	title: string;
};

// =============================================================================
// COMPONENT (type-level alias — same component, narrower props)
// =============================================================================

/**
 * The card-titled grid. Identical to {@link DataGrid} at runtime; the alias
 * exists purely so call sites that present a grid AS a card cannot omit the
 * title.
 */
export const CardDataGrid = DataGrid as <Row extends Record<string, unknown>>(
	props: ICardDataGridProps<Row> & { ref?: Ref<IDataGridHandle> },
) => ReactElement;
