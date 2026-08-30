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
// SQL-UI — QUERY VIEW (one SQL editor document: Monaco + results grid)
// =============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import type { GridCellComponent } from 'shell';
import { Banner, Button, Card, CardDataGrid, ContentHeader, EmptyState, ToggleGroup, monoEl, mutedEl } from 'shell';
import type { GridColumnDefinition } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint } from '../connect';
import { getSession, useSchema } from '../schema/schemaStore';
import SqlEditor from '../components/SqlEditor';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link QueryView} component. */
export interface IQueryViewProps {
	/** The connection this query document executes against. */
	endpoint: ISqlEndpoint;
	/** Tab label ("Query 3") for the page header. */
	label: string;
}

/** One finished execution's result, kept until the next run. */
interface IQueryResult {
	/** Result rows (possibly empty). */
	rows: Record<string, unknown>[];
	/** Rows affected (non-SELECT statements). */
	affectedRows: number;
	/** Execution wall time in milliseconds. */
	elapsedMs: number;
}

/** Row-limit options offered by the header toggle. */
const LIMIT_OPTIONS = ['200', '1000', 'All'] as const;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Column below the header: editor at a fixed share, results fill the rest.
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		gap: 12,
		padding: '16px 24px 24px',
	} as CSSProperties,

	editorRegion: {
		flex: '0 0 38%',
		minHeight: 120,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	resultsRegion: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	// Result meta line in the grid card's action slot.
	meta: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Apply the header row limit to a statement: SELECTs without their own LIMIT
 * get one appended; everything else passes through untouched.
 *
 * @param sql - The statement to run.
 * @param limit - The selected limit option.
 * @returns The statement to send.
 */
function applyLimit(sql: string, limit: string): string {
	if (limit === 'All') return sql;
	const trimmed = sql.trim().replace(/;\s*$/, '');
	// Row-returning statements only: SELECT, parenthesised set expressions,
	// and read-only WITH chains. Data-modifying CTEs (WITH ... INSERT/UPDATE/
	// DELETE) must stay untouched — appending LIMIT there is invalid SQL.
	const returnsRows = /^select\b/i.test(trimmed) || trimmed.startsWith('(') || (/^with\b/i.test(trimmed) && !/\b(insert|update|delete)\b/i.test(trimmed));
	if (!returnsRows) return sql;
	if (/\blimit\s+\d+/i.test(trimmed)) return sql;
	return `${trimmed} LIMIT ${limit}`;
}

/**
 * Render one result cell: NULL muted, objects as JSON, everything else mono.
 *
 * @param value - The raw cell value.
 * @returns The formatted cell element.
 */
function resultCellEl(value: unknown): HTMLElement {
	if (value === null || value === undefined) return mutedEl('NULL');
	if (typeof value === 'object') return monoEl(JSON.stringify(value));
	return monoEl(String(value));
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * One SQL editor document: Monaco on top, the last execution's rows in a
 * LOCAL CardDataGrid below. Run executes through the connection's session
 * (Ctrl/Cmd+Enter or the header button); the row-limit toggle guards SELECTs.
 */
export const QueryView: React.FC<IQueryViewProps> = ({ endpoint, label }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);

	// Editor text, limit selection, and the last run's outcome.
	const [sql, setSql] = useState('');
	const [limit, setLimit] = useState<string>('1000');
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<IQueryResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	/**
	 * Execute the editor's statement through the bound session.
	 */
	const run = useCallback(async (): Promise<void> => {
		if (!client || running || !sql.trim()) return;
		setRunning(true);
		setError(null);
		const started = performance.now();
		try {
			const session = getSession(client, endpoint);
			const res = await session.execute(applyLimit(sql, limit));
			setResult({
				rows: res.rows ?? [],
				affectedRows: res.affected_rows ?? 0,
				elapsedMs: performance.now() - started,
			});
		} catch (err) {
			setResult(null);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	}, [client, running, sql, limit, endpoint]);

	// Result grid columns, derived from the first row's keys.
	const columns = useMemo<GridColumnDefinition[]>(() => {
		const first = result?.rows[0];
		if (!first) return [];
		return Object.keys(first).map(
			(key) =>
				({
					title: key,
					field: key,
					rrType: 'string',
					rrDefault: true,
					rrDescription: `Result column ${key}.`,
					headerSort: true,
					formatter: (cell: GridCellComponent) => resultCellEl(cell.getValue()),
				}) satisfies GridColumnDefinition
		);
	}, [result]);

	// Result meta line: rows/affected + elapsed.
	const meta = result ? (result.rows.length > 0 ? `${result.rows.length.toLocaleString()} rows - ${(result.elapsedMs / 1000).toFixed(3)} s` : `${result.affectedRows.toLocaleString()} affected - ${(result.elapsedMs / 1000).toFixed(3)} s`) : '';

	return (
		<div style={styles.root}>
			<ContentHeader
				title={label}
				subtitle={`${snapshot.schema?.database ?? endpoint.nodeName} - statements execute on ${endpoint.pipelineName} / ${endpoint.nodeId}`}
				actions={
					<>
						<ToggleGroup options={LIMIT_OPTIONS.map((o) => ({ id: o, label: o }))} value={limit} onChange={setLimit} />
						<Button
							variant="primary"
							onClick={() => {
								void run();
							}}
							disabled={!client || !isConnected || running || !sql.trim()}
						>
							{running ? 'Running...' : 'Run'}
						</Button>
					</>
				}
			/>

			<div style={styles.body}>
				{/* Editor. */}
				<div style={styles.editorRegion}>
					<SqlEditor
						value={sql}
						onChange={setSql}
						dialect={snapshot.dialect}
						onRun={() => {
							void run();
						}}
					/>
				</div>

				{/* Execution failure. */}
				{error && <Banner variant="error">{error}</Banner>}

				{/* Results. */}
				<div style={styles.resultsRegion}>
					{result && result.rows.length > 0 ? (
						<Card noBodyPadding fill>
							<CardDataGrid<Record<string, unknown>> title="Results" actions={<span style={styles.meta}>{meta}</span>} columns={columns} data={result.rows} tableId="sql-query-results" paginate={false} height="100%" emptyTitle="No rows" emptyDescription="The statement returned no rows." />
						</Card>
					) : (
						<EmptyState icon={<DatabaseIcon />} title={result ? 'Statement executed' : 'No results yet'} description={result ? meta : 'Write a statement above and press Run (Ctrl+Enter) to execute it on the database node.'} />
					)}
				</div>
			</div>
		</div>
	);
};

export default QueryView;
