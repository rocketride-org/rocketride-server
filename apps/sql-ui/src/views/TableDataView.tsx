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

import React, { useCallback, useMemo, useRef, useState } from 'react';
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

	// One-line caveat above the grid (no primary key = no stable page order).
	note: {
		margin: '0 0 8px',
		fontSize: 12,
		opacity: 0.7,
	} as CSSProperties,

	// The load-failure banner sits above the grid, inside the body padding.
	banner: {
		marginBottom: 8,
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

	// Last page-load failure, surfaced as a banner. The grid keeps showing the
	// previous rows on failure, so without this the error is invisible.
	const [loadError, setLoadError] = useState<string | null>(null);

	// Whether the grid is currently sorted by the user. Read from the page
	// requests themselves — remote sorting is the only way sorters reach here.
	const [gridSorted, setGridSorted] = useState(false);

	// Stale-response guard. Two page requests can be in flight (a fast typist
	// on the search box, a double page click), and the grid applies whichever
	// resolves LAST — so a slow earlier answer can overwrite a newer one. Each
	// request takes a sequence number; a request that has been superseded by
	// the time it resolves adopts the newest answer instead of landing its own.
	const seqRef = useRef(0);
	const newestRef = useRef<Promise<IDataGridPage<Record<string, unknown>>> | null>(null);

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
	 * REMOTE page fetcher: SELECT + COUNT per request through the session,
	 * with every filter and search value bound as a `$n` parameter.
	 *
	 * @param req - The grid's page request.
	 * @returns The page rows and the matching total.
	 */
	const fetchPage = useCallback((req: IDataGridPageRequest): Promise<IDataGridPage<Record<string, unknown>>> => {
		setGridSorted(req.sort.length > 0);
		const seq = ++seqRef.current;
		// The banner describes ONE request. A new search, sort or page is a
		// different question, so the previous answer's failure stops being
		// shown the moment this one starts rather than the moment it lands.
		setLoadError(null);

		const run = (async (): Promise<IDataGridPage<Record<string, unknown>>> => {
			if (!client || !tableDef) return { rows: [], total: 0 };
			const session = getSession(client, endpoint);
			const { select, count, params } = buildPageStatements(dialect, table, tableDef, req);

			// Page rows + total over the same WHERE (drives the pager). The two
			// statements are independent, so one round trip instead of two.
			// Both statements are SELECTs: safe to re-run, so they opt in to the
			// session's one retry with a re-resolved token (the task may have
			// restarted since this view last paged).
			const [pageResult, countResult] = await Promise.all([
				session.execute(select, { params, idempotent: true }),
				session.execute(count, { params, idempotent: true }),
			]);
			const total = Number((countResult.rows[0] as { total?: unknown } | undefined)?.total ?? pageResult.rows.length);
			return { rows: pageResult.rows, total };
		})();

		// `newest` is assigned BEFORE any await settles, so a superseded
		// request always finds the newer chain here — which in turn resolves
		// to the newest of all (each link applies the same rule).
		const chain = run.then(
			(page) => {
				if (seq !== seqRef.current) return newestRef.current ?? page;
				setLoadError(null);
				return page;
			},
			(err: unknown) => {
				// A superseded request's failure is not the user's problem; the
				// request that replaced it reports its own outcome.
				if (seq !== seqRef.current && newestRef.current) return newestRef.current;
				throw err;
			},
		);
		newestRef.current = chain;
		return chain;
	}, [client, endpoint, table, tableDef, dialect]);

	/**
	 * Surface a page-load failure (the grid itself only shows a transient
	 * toast and keeps the previous rows on screen).
	 *
	 * @param error - The error the page fetcher rejected with.
	 */
	const handleLoadError = useCallback((error: Error): void => {
		setLoadError(error.message || String(error));
	}, []);

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

	// Without a primary key AND without a user sort, the page SELECT carries no
	// ORDER BY at all, and SQL does not promise a stable row order between
	// calls — rows can repeat or vanish across pages. Say so rather than let
	// the pager look authoritative.
	const unordered = (tableDef.primary_key ?? []).length === 0 && !gridSorted;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={table}
				subtitle={`${snapshot.schema?.database ?? ''} - browsing via ${endpoint.pipelineName} / ${endpoint.nodeId}`}
			/>

			<div style={styles.body}>
				{loadError && (
					<div style={styles.banner}>
						{/* Clears itself on the next page that loads. */}
						<Banner variant="error">Could not load this page: {loadError}</Banner>
					</div>
				)}
				{unordered && (
					<div style={styles.note}>No primary key — page order is not guaranteed by the database</div>
				)}
				<Card noBodyPadding fill>
					<DataGrid<Record<string, unknown>>
						title={table}
						columns={columns}
						fetchPage={isConnected ? fetchPage : undefined}
						remoteSort
						onLoadError={handleLoadError}
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
