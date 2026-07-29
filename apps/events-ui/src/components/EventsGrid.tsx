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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EVENTS-UI — EVENT STREAM GRID (LOCAL CardDataGrid)
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Card, CardDataGrid, monoEl, mutedEl } from 'shared';
import type { GridColumnDefinition } from 'shared';
import type { EventRow } from '../types';
import { eventColor } from '../styles';
import { formatTime } from '../format';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link EventsGrid} component. */
export interface IEventsGridProps {
	/** Current captured events as grid rows (newest-first via the default sort). */
	rows: EventRow[];
	/** Fired with the clicked row so the host can open the detail panel. */
	onRowClick: (row: EventRow) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Muted live count in the grid's card-header action slot.
	headerCount: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// CELL FACTORIES
// =============================================================================

/**
 * Build the colored event-name cell: the DAP name in its chart-token color at
 * semibold weight. A token-referenced inline color (never raw hex) keeps the
 * nine-way coloring legible across every theme, mirroring the stock cell
 * factories' token approach for a dimension the five semantic badges can't cover.
 *
 * @param name - The DAP event name.
 * @returns The colored span element.
 */
function eventNameEl(name: string): HTMLElement {
	const el = document.createElement('span');
	el.textContent = name;
	el.style.color = eventColor(name);
	el.style.fontWeight = '600';
	return el;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The live event stream as a LOCAL-mode CardDataGrid: each new `rows` array
 * applies silently in place, the built-in bar carries search + gear export, and
 * a row click opens the detail panel. Layout persists via the 'events-monitor'
 * grid-config channel.
 *
 * @param props - {@link IEventsGridProps}.
 * @returns The card-hosted grid.
 */
export const EventsGrid: React.FC<IEventsGridProps> = ({ rows, onRowClick }) => {
	/**
	 * Full per-column contract. Declared with `satisfies` (not a generic
	 * useMemo) so a missing `rrDescription` or a typo'd rr* marker fails to
	 * compile instead of silently passing through the generic return position.
	 * `rrDefault` marks the default columns (array order = display order);
	 * `rrDefaultSort: 'desc'` on time keeps the stream newest-first.
	 */
	const columns = useMemo(
		() =>
			[
				{
					title: '#',
					field: 'id',
					rrType: 'number',
					rrDescription: 'Monotonic capture sequence number assigned locally on receipt; hidden by default, addable from the columns menu.',
					width: 70,
					hozAlign: 'right',
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => mutedEl(`#${cell.getValue()}`),
				},
				{
					title: 'Time',
					field: 'time',
					rrType: 'date',
					rrDefault: true,
					rrDefaultSort: 'desc',
					rrDescription: 'Local wall-clock time the event was captured (millisecond precision); drives the newest-first default sort.',
					width: 120,
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => mutedEl(formatTime(cell.getValue() as number)),
				},
				{
					title: 'Event',
					field: 'eventName',
					rrType: 'enum',
					rrDefault: true,
					rrDescription: 'DAP event name (e.g. apaevt_task, apaevt_flow); colored per event kind and filterable by the distinct captured names.',
					width: 190,
					headerSort: true,
					formatter: (cell) => eventNameEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Token',
					field: 'token',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'Task token the event belongs to, or a dash when the event carries none.',
					width: 120,
					headerSort: true,
					formatter: (cell) => {
						const token = String(cell.getValue() ?? '');
						return token ? monoEl(token) : mutedEl('—');
					},
				},
				{
					title: 'Seq',
					field: 'seq',
					rrType: 'number',
					rrDescription: 'DAP protocol sequence number carried on the event; hidden by default, addable from the columns menu.',
					width: 80,
					hozAlign: 'right',
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Summary',
					field: 'summary',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'One-line digest of the event body: the leading action/state/status field, or a preview of the first keys.',
					headerSort: false,
					formatter: (cell) => mutedEl(String(cell.getValue() ?? '')),
				},
			] satisfies GridColumnDefinition[],
		[],
	);

	return (
		// The grid IS the card: its two-row header carries the title and the live
		// count. `fill` makes the card fill the remaining page height, and the
		// grid's height="100%" + paginate={false} turns it into an internally
		// scrolling log (virtualized) rather than a paginated table.
		<Card noBodyPadding fill>
			<CardDataGrid<EventRow>
				title="Event Stream"
				actions={<span style={styles.headerCount}>{rows.length.toLocaleString()} events</span>}
				columns={columns}
				data={rows}
				tableId="events-monitor"
				paginate={false}
				height="100%"
				onRowClick={onRowClick}
				emptyTitle="No events captured"
				emptyDescription="Start monitoring to capture live DAP events from the connected engine."
			/>
		</Card>
	);
};
