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
// SQL-UI — OVERVIEW PANEL (schema summary + tables grid)
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, Card, CardDataGrid, EmptyState, MiniCard, MiniContainer, monoEl, mutedEl } from 'shell';
import type { GridCellComponent } from 'shell';
import type { GridColumnDefinition } from 'shell';
import type { RocketRideClient } from 'shell';
import type { ISqlEndpoint, ISqlSchemaTable } from '../connect';
import type { ISchemaState } from '../schema/schemaStore';
import { refreshSchema } from '../schema/schemaStore';
import { useTableRecordRequest } from '../navigation';
import { designUri, getDocs, tableDataUri } from '../docs';
import TableRecordPanel from '../components/TableRecordPanel';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link OverviewPanel} component. */
export interface IOverviewPanelProps {
	/** The connection's endpoint. */
	endpoint: ISqlEndpoint;
	/** The connection's schema snapshot. */
	snapshot: ISchemaState;
	/** The shell's RocketRide client (null while disconnected). */
	client: RocketRideClient | null;
}

/** One row of the tables grid, derived from the schema snapshot. */
interface ITableRow extends Record<string, unknown> {
	/** Table name (row identity). */
	name: string;
	/** Column count. */
	columns: number;
	/** Primary key columns joined for display ('—' when none). */
	primaryKey: string;
	/** Foreign key count. */
	foreignKeys: number;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Panel column: metric row at natural height, grid fills the rest.
	panel: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
		height: '100%',
		minHeight: 0,
	} as CSSProperties,

	staticRow: {
		flexShrink: 0,
	} as CSSProperties,

	gridFill: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The connection workbench's Overview page: schema metrics as MiniCards and
 * the tables list as a LOCAL CardDataGrid. A row click (or a sidebar tree
 * click routed through the table-record request store) opens the table's
 * record drawer.
 */
export const OverviewPanel: React.FC<IOverviewPanelProps> = ({ endpoint, snapshot, client }) => {
	// The table whose record drawer is open (null = closed).
	const [openTable, setOpenTable] = useState<string | null>(null);

	// Sidebar tree clicks arrive as table-record requests for this connection.
	const request = useTableRecordRequest();
	useEffect(() => {
		if (request && request.key === endpoint.key) {
			setOpenTable(request.table);
		}
	}, [request, endpoint.key]);

	// Derive metric values + grid rows from the snapshot.
	const tables = snapshot.schema?.tables ?? {};
	const rows = useMemo<ITableRow[]>(
		() =>
			Object.entries(tables).map(([name, def]) => ({
				name,
				columns: def.columns.length,
				primaryKey: def.primary_key?.length ? def.primary_key.join(', ') : '—',
				foreignKeys: def.foreign_keys?.length ?? 0,
			})),
		[tables]
	);
	const totalColumns = rows.reduce((sum, r) => sum + r.columns, 0);
	const totalForeignKeys = rows.reduce((sum, r) => sum + r.foreignKeys, 0);

	/**
	 * Full per-column contract for the tables grid (LOCAL mode).
	 */
	const columns = useMemo(
		() =>
			[
				{
					title: 'Table',
					field: 'name',
					rrType: 'string',
					rrDefault: true,
					rrDefaultSort: 'asc',
					rrDescription: 'Table name as reflected from the database.',
					headerSort: true,
					formatter: (cell: GridCellComponent) => monoEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Columns',
					field: 'columns',
					rrType: 'number',
					rrDefault: true,
					rrDescription: 'Number of columns in the table.',
					width: 110,
					hozAlign: 'right',
					headerSort: true,
					sorter: 'number',
				},
				{
					title: 'Primary Key',
					field: 'primaryKey',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'Primary key column(s), or a dash when the table has none.',
					width: 220,
					headerSort: true,
					formatter: (cell: GridCellComponent) => {
						const value = String(cell.getValue() ?? '');
						return value === '—' ? mutedEl(value) : monoEl(value);
					},
				},
				{
					title: 'Foreign Keys',
					field: 'foreignKeys',
					rrType: 'number',
					rrDefault: true,
					rrDescription: 'Number of foreign keys declared on the table.',
					width: 130,
					hozAlign: 'right',
					headerSort: true,
					sorter: 'number',
				},
			] satisfies GridColumnDefinition[],
		[]
	);

	// ── Loading / error framing ──────────────────────────────────────────────

	if (snapshot.status === 'error') {
		return (
			<div style={styles.panel}>
				<Banner variant="error">Schema reflection failed: {snapshot.error}</Banner>
				<div>
					<Button
						variant="primary"
						onClick={() => {
							if (client) void refreshSchema(client, endpoint);
						}}
						disabled={!client}
					>
						Retry
					</Button>
				</div>
			</div>
		);
	}

	if (snapshot.status !== 'ready') {
		// First paint: framed progress state, never bare "Loading..." text.
		return <EmptyState icon={<DatabaseIcon />} title="Reading schema" description={`Reflecting tables, columns, and relations from ${endpoint.nodeName}...`} />;
	}

	// ── Ready ────────────────────────────────────────────────────────────────

	return (
		<div style={styles.panel}>
			{/* Schema metrics. */}
			<div style={styles.staticRow}>
				<MiniContainer columns={4}>
					<MiniCard value={String(rows.length)} label="Tables" />
					<MiniCard value={String(totalColumns)} label="Columns" />
					<MiniCard value={String(totalForeignKeys)} label="Foreign Keys" />
					<MiniCard value={snapshot.dialect} label="Dialect" />
				</MiniContainer>
			</div>

			{/* Tables grid — fills the remaining height; row click inspects. */}
			<div style={styles.gridFill}>
				<Card noBodyPadding fill>
					<CardDataGrid<ITableRow>
						title="Tables"
						actions={
							<Button
								variant="ghost"
								small
								onClick={() => {
									// Fresh create-table draft document for this connection.
									const uri = designUri(endpoint.key, null);
									getDocs()?.openStaticDocument(uri, 'New table', { endpoint, table: null });
								}}
							>
								+ Create Table
							</Button>
						}
						columns={columns}
						data={rows}
						tableId="sql-overview-tables"
						paginate={false}
						height="100%"
						onRowClick={(row) => setOpenTable(row.name)}
						emptyTitle="No tables"
						emptyDescription="The attached database reports no tables."
					/>
				</Card>
			</div>

			{/* Record drawer for the selected table. */}
			<TableRecordPanel
				open={openTable !== null}
				onClose={() => setOpenTable(null)}
				database={snapshot.schema?.database ?? ''}
				table={openTable ?? ''}
				def={openTable ? ((tables[openTable] as ISqlSchemaTable | undefined) ?? null) : null}
				onBrowseData={() => {
					// Open (or focus) the table's data-browser document; the
					// endpoint + table ride as the static doc's content payload.
					if (openTable) {
						getDocs()?.openStaticDocument(tableDataUri(endpoint.key, openTable), `${openTable} - data`, { endpoint, table: openTable });
						setOpenTable(null);
					}
				}}
				onDesign={() => {
					// Open (or focus) the table's designer document.
					if (openTable) {
						getDocs()?.openStaticDocument(designUri(endpoint.key, openTable), `${openTable} - design`, { endpoint, table: openTable });
						setOpenTable(null);
					}
				}}
			/>
		</div>
	);
};

export default OverviewPanel;
