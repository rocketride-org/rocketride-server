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
// SQL-UI — TABLE DATA VIEW (server-paged data browser for one table)
// =============================================================================

import React, { useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import type { GridCellComponent } from 'shell';
import { Banner, Card, ContentHeader, DataGrid, EmptyState, monoEl, mutedEl } from 'shell';
import type { GridColumnDefinition, IDataGridPage, IDataGridPageRequest } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint } from '../connect';
import { getSession, useSchema } from '../schema/schemaStore';
import { buildPageStatements } from '../sql/paging';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TableDataView} component. */
export interface ITableDataViewProps {
	/** The connection the table lives on. */
	endpoint: ISqlEndpoint;
	/** The table to browse. */
	table: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Grid region below the header — the grid pages internally.
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		padding: '16px 24px 24px',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Render one data cell: NULL muted, objects as JSON, everything else mono.
 *
 * @param value - The raw cell value.
 * @returns The formatted cell element.
 */
function dataCellEl(value: unknown): HTMLElement {
	if (value === null || value === undefined) return mutedEl('NULL');
	if (typeof value === 'object') return monoEl(JSON.stringify(value));
	return monoEl(String(value));
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Server-paged browser for one table: a REMOTE-mode DataGrid whose fetchPage
 * turns each page request into SELECT + COUNT statements (LIMIT/OFFSET,
 * ORDER BY from the grid's sorters, WHERE from search + column filters) and
 * executes them through the connection's session.
 */
export const TableDataView: React.FC<ITableDataViewProps> = ({ endpoint, table }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);

	// The table's reflected schema drives columns, search targets, and the
	// default sort (primary key).
	const tableDef = snapshot.schema?.tables?.[table] ?? null;
	const dialect = snapshot.dialect;

	// Grid columns straight from the reflected schema.
	const columns = useMemo<GridColumnDefinition[]>(() => {
		if (!tableDef) return [];
		const pk = new Set(tableDef.primary_key ?? []);
		return tableDef.columns.map((col) => ({
			title: col.column,
			field: col.column,
			rrType: /int|dec|num|float|double/i.test(col.type) ? 'number' : 'string',
			rrDefault: true,
			rrDescription: `${col.type}${pk.has(col.column) ? ' - primary key' : ''}`,
			headerSort: true,
			formatter: (cell: GridCellComponent) => dataCellEl(cell.getValue()),
		} satisfies GridColumnDefinition));
	}, [tableDef]);

	/**
	 * REMOTE page fetcher: SELECT + COUNT per request through the session.
	 */
	const fetchPage = useCallback(async (req: IDataGridPageRequest): Promise<IDataGridPage<Record<string, unknown>>> => {
		if (!client || !tableDef) return { rows: [], total: 0 };
		const session = getSession(client, endpoint);
		const statements = buildPageStatements(dialect, table, tableDef, req);

		// Page rows + total over the same WHERE (drives the pager).
		const pageResult = await session.execute(statements.select);
		const countResult = await session.execute(statements.count);
		const total = Number((countResult.rows[0] as { total?: unknown } | undefined)?.total ?? pageResult.rows.length);
		return { rows: pageResult.rows, total };
	}, [client, endpoint, table, tableDef, dialect]);

	// ── Framing states ───────────────────────────────────────────────────────

	if (snapshot.status !== 'ready') {
		return (
			<div style={styles.root}>
				<ContentHeader title={table} subtitle="data" />
				<div style={styles.body}>
					<EmptyState icon={<DatabaseIcon />} title="Reading schema" description="The table's schema is still loading..." />
				</div>
			</div>
		);
	}

	if (!tableDef) {
		return (
			<div style={styles.root}>
				<ContentHeader title={table} subtitle="data" />
				<div style={styles.body}>
					<Banner variant="warning">
						Table {table} is not in the current schema snapshot — refresh the schema from the connection overview.
					</Banner>
				</div>
			</div>
		);
	}

	return (
		<div style={styles.root}>
			<ContentHeader
				title={table}
				subtitle={`${snapshot.schema?.database ?? ''} - browsing via ${endpoint.pipelineName} / ${endpoint.nodeId}`}
			/>

			<div style={styles.body}>
				<Card noBodyPadding fill>
					<DataGrid<Record<string, unknown>>
						title={table}
						columns={columns}
						fetchPage={isConnected ? fetchPage : undefined}
						tableId={`sql-data-${endpoint.provider}`}
						height="100%"
						emptyTitle="No rows"
						emptyDescription="The table is empty (or nothing matches the current search/filters)."
					/>
				</Card>
			</div>
		</div>
	);
};

export default TableDataView;
