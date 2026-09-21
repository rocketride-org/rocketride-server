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
// SQL-UI — TABLE RECORD PANEL (record drawer: one table's reflected schema)
// =============================================================================
//
// Everything in this drawer comes from ONE schema snapshot — no extra
// database round-trips, and nothing inferred from names. Sections derived
// from the snapshot say when it was read, because a snapshot taken at task
// start can be older than the database it describes.
// =============================================================================

import React, { useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, DetailPanel, LabelValue, Section, StatusBadge } from 'shell';
import type { ISqlSchemaTable, SqlDialect } from '../connect';
import type { IJoinPath, IRelationGraph } from '../schema/relations';
import { MAX_JOIN_PATHS, describeHop, findJoinPaths, generateJoinSql, inboundReferences } from '../schema/relations';
import { quoteIdent } from '../sql/paging';
import { announce } from '../a11y/announce';
import { TableIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TableRecordPanel} component. */
export interface ITableRecordPanelProps {
	/** Whether the drawer is open. */
	open: boolean;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
	/** Database name (drawer subtitle). */
	database: string;
	/** Table name (drawer title). */
	table: string;
	/** The table's reflected schema (null renders an empty body). */
	def: ISqlSchemaTable | null;
	/** Engine dialect — drives identifier quoting and the no-keys wording. */
	dialect: SqlDialect;
	/** The connection's declared-foreign-key graph. */
	graph: IRelationGraph;
	/** Unix ms the snapshot was read (0 = never). */
	refreshedAt: number;
	/** Fired when the user opens the table's data browser. */
	onBrowseData: () => void;
	/** Fired when the user opens the table's designer. */
	onDesign: () => void;
	/** Fired with another table to inspect (opens a stacked drawer). */
	onOpenTable: (table: string) => void;
	/** Fired to open generated SQL in a NEW query document. */
	onOpenQuery: (sql: string, label: string) => void;
}

/** What the join-path finder has to say right now. */
interface IPathResult {
	/** The destination that was searched for. */
	to: string;
	/** The shortest paths found (empty = none within the depth cap). */
	paths: IJoinPath[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** First line of every generated preview statement. */
const PREVIEW_HEADER = '-- Generated preview — review, then Run.';

/** Said when the schema declares no foreign keys at all. */
const NO_KEYS_GENERIC = 'This schema declares no foreign keys; join paths are unavailable.';

/** Said instead when the engine itself has no concept of one. */
const NO_KEYS_CLICKHOUSE = 'ClickHouse declares no foreign keys; join paths are unavailable.';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// 42px round avatar slot content for the EntityHeader.
	avatar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 42,
		height: 42,
		borderRadius: '50%',
		background: 'var(--rr-bg-widget)',
		color: 'var(--rr-brand)',
		padding: 10,
	} as CSSProperties,

	// One column row: name left, datatype right.
	columnRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 0',
		fontSize: 12.5,
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	columnName: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	columnType: {
		marginLeft: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Foreign key row: local columns -> referred table (columns).
	fkRow: {
		padding: '6px 0',
		fontSize: 12.5,
		fontFamily: 'var(--rr-font-mono, monospace)',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	fkArrow: {
		color: 'var(--rr-text-secondary)',
		padding: '0 6px',
	} as CSSProperties,

	// Inbound reference row: the mono relation, then the table as a button.
	inboundRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '4px 0',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	inboundText: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12.5,
	} as CSSProperties,

	inboundAction: {
		marginLeft: 'auto',
	} as CSSProperties,

	snapshotNote: {
		padding: '6px 0 2px',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	actionRow: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 6,
		padding: '6px 0',
	} as CSSProperties,

	pathControls: {
		display: 'flex',
		alignItems: 'flex-end',
		gap: 8,
		padding: '6px 0',
		flexWrap: 'wrap',
	} as CSSProperties,

	label: {
		display: 'block',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		paddingBottom: 4,
	} as CSSProperties,

	select: {
		height: 34,
		minWidth: 180,
		padding: '0 8px',
		borderRadius: 7,
		border: '1px solid var(--rr-border-default, var(--rr-bg-widget))',
		background: 'var(--rr-bg-default)',
		color: 'var(--rr-text-primary)',
		font: 'inherit',
		fontSize: 12.5,
	} as CSSProperties,

	pathList: {
		margin: '6px 0',
		paddingLeft: 20,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		lineHeight: 1.7,
	} as CSSProperties,

	pathOption: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 8,
		padding: '6px 0',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	summary: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		padding: '4px 0',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Clock time of the snapshot, e.g. `14:02`.
 *
 * @param at - Unix ms (0 = never read).
 * @returns The local time of day, or '—'.
 */
function clock(at: number): string {
	return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Record drawer for one table: columns with datatypes, primary key, foreign
 * keys, the tables that reference it, one-click preview queries, and a join
 * path to any other table — all from the connection's schema snapshot.
 *
 * @param props - {@link ITableRecordPanelProps}.
 * @returns The drawer element.
 */
export const TableRecordPanel: React.FC<ITableRecordPanelProps> = (props) => {
	const {
		open, onClose, database, table, def, dialect, graph, refreshedAt,
		onBrowseData, onDesign, onOpenTable, onOpenQuery,
	} = props;

	// Primary key membership for the per-column PK badge.
	const pkColumns = new Set(def?.primary_key ?? []);

	// Tables this one can be joined to (itself excluded — a self join is not
	// what "find a path" means here).
	const otherTables = useMemo(
		() => graph.tables.filter((name) => name !== table).sort((a, b) => a.localeCompare(b)),
		[graph.tables, table],
	);

	const inbound = useMemo(() => inboundReferences(graph, table), [graph, table]);

	const [target, setTarget] = useState('');
	const [result, setResult] = useState<IPathResult | null>(null);
	const [chosen, setChosen] = useState(0);
	const selectId = useId();

	const snapshotNote = `from schema snapshot ${clock(refreshedAt)}`;
	const hasKeys = graph.edges.length > 0;

	// ── Generated statements ─────────────────────────────────────────────────

	/** Open a `SELECT *` preview for this table in a new query document. */
	const openTopRows = (): void => {
		onOpenQuery(
			`${PREVIEW_HEADER}\nSELECT * FROM ${quoteIdent(dialect, table)} LIMIT 100`,
			`${table} — top 100`,
		);
	};

	/** Open a row count for this table in a new query document. */
	const openCount = (): void => {
		onOpenQuery(
			`${PREVIEW_HEADER}\nSELECT COUNT(*) AS total FROM ${quoteIdent(dialect, table)}`,
			`${table} — count`,
		);
	};

	// ── Join path ────────────────────────────────────────────────────────────

	/** Search for every shortest path from this table to the chosen one. */
	const findPath = (): void => {
		if (!target) return;
		const paths = findJoinPaths(graph, table, target);
		setResult({ to: target, paths });
		setChosen(0);
		if (paths.length === 0) announce(`No declared path from ${table} to ${target}`);
		else if (paths.length === 1) announce(`Path found: ${paths[0]?.hops.length} joins`);
		else announce(`${paths.length} paths found, choose one`);
	};

	/** Open the selected path as a generated query document. */
	const openPathAsQuery = (): void => {
		const path = result?.paths[chosen];
		if (!path) return;
		onOpenQuery(generateJoinSql(dialect, path, quoteIdent), `${path.from} → ${path.to}`);
	};

	/**
	 * The path results region: nothing, an explanation, or the paths found.
	 *
	 * @returns The results content.
	 */
	const renderPathResult = (): React.ReactNode => {
		if (!result) return null;
		if (result.paths.length === 0) {
			return <LabelValue label="Result">No declared path within 4 joins.</LabelValue>;
		}

		const selected = result.paths[chosen];

		return (
			<>
				{result.paths.length > 1 && (
					// At the cap the list is a sample, not the answer. Saying
					// "25 paths found" would claim there are exactly 25.
					<div style={styles.summary}>
						{result.paths.length >= MAX_JOIN_PATHS
							? `${result.paths.length} paths shown (cap reached — more may exist)`
							: `${result.paths.length} paths found — choose one`}
					</div>
				)}

				{result.paths.length > 1
					? result.paths.map((path, index) => (
						<label key={index} style={styles.pathOption}>
							<input
								type="radio"
								name={`${selectId}-path`}
								checked={chosen === index}
								onChange={() => setChosen(index)}
							/>
							<span>
								<ol style={styles.pathList}>
									{path.hops.map((hop, hopIndex) => <li key={hopIndex}>{describeHop(hop)}</li>)}
								</ol>
								<span style={styles.summary}>{`${path.hops.length} joins · declared foreign keys`}</span>
							</span>
						</label>
					))
					: (
						<>
							<ol style={styles.pathList}>
								{selected?.hops.map((hop, hopIndex) => <li key={hopIndex}>{describeHop(hop)}</li>)}
							</ol>
							<div style={styles.summary}>{`${selected?.hops.length ?? 0} joins · declared foreign keys`}</div>
						</>
					)}

				<div style={styles.actionRow}>
					<Button variant="secondary" small onClick={openPathAsQuery}>Open as query</Button>
				</div>
			</>
		);
	};

	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			avatar={<span style={styles.avatar}><TableIcon /></span>}
			title={table}
			subtitle={database}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>Close</Button>
					<Button variant="secondary" onClick={onDesign}>Design</Button>
					<Button variant="primary" onClick={onBrowseData}>Browse Data</Button>
				</>
			}
		>
			{/* ── Columns ────────────────────────────────────────────────────── */}
			<Section label={`Columns (${def?.columns.length ?? 0})`}>
				{(def?.columns ?? []).map((col) => (
					<div key={col.column} style={styles.columnRow}>
						<span style={styles.columnName}>{col.column}</span>
						{pkColumns.has(col.column) && <StatusBadge variant="info">PK</StatusBadge>}
						<span style={styles.columnType}>{col.type}</span>
					</div>
				))}
			</Section>

			{/* ── Primary key ────────────────────────────────────────────────── */}
			<Section label="Primary key">
				<LabelValue label="Columns" mono>
					{def?.primary_key?.length ? def.primary_key.join(', ') : '—'}
				</LabelValue>
			</Section>

			{/* ── Foreign keys ───────────────────────────────────────────────── */}
			<Section label={`Foreign keys (${def?.foreign_keys?.length ?? 0})`}>
				{(def?.foreign_keys ?? []).map((fk, i) => (
					<div key={`${fk.referred_table}-${i}`} style={styles.fkRow}>
						{fk.columns.join(', ')}
						<span style={styles.fkArrow}>-&gt;</span>
						{fk.referred_table} ({fk.referred_columns.join(', ')})
					</div>
				))}
				{!def?.foreign_keys?.length && (
					<LabelValue label="None">This table declares no foreign keys.</LabelValue>
				)}
			</Section>

			{/* ── Referenced by ──────────────────────────────────────────────── */}
			<Section label={`Referenced by (${inbound.length})`}>
				<div style={styles.snapshotNote}>{snapshotNote}</div>
				{inbound.map((edge) => (
					<div key={edge.id} style={styles.inboundRow}>
						<span style={styles.inboundText}>
							{`${edge.columns.map((column) => `${edge.table}.${column}`).join(', ')} -> ${edge.refColumns.join(', ')}`}
						</span>
						<span style={styles.inboundAction}>
							<Button variant="ghost" small onClick={() => onOpenTable(edge.table)}>
								{edge.table}
							</Button>
						</span>
					</div>
				))}
				{inbound.length === 0 && <LabelValue label="None">No table references this one.</LabelValue>}
			</Section>

			{/* ── Query ──────────────────────────────────────────────────────── */}
			<Section label="Query">
				<div style={styles.actionRow}>
					<Button variant="secondary" small onClick={openTopRows}>Select top 100</Button>
					<Button variant="secondary" small onClick={openCount}>Count rows</Button>
				</div>
				<div style={styles.snapshotNote}>Opens a new query document. Nothing runs until you run it.</div>
			</Section>

			{/* ── Join path ──────────────────────────────────────────────────── */}
			<Section label="Join path">
				{!hasKeys
					? <LabelValue label="Unavailable">{dialect === 'clickhouse' ? NO_KEYS_CLICKHOUSE : NO_KEYS_GENERIC}</LabelValue>
					: (
						<>
							<div style={styles.pathControls}>
								<span>
									<label htmlFor={selectId} style={styles.label}>To table</label>
									<select
										id={selectId}
										style={styles.select}
										value={target}
										onChange={(event) => { setTarget(event.target.value); setResult(null); }}
									>
										<option value="">Choose a table</option>
										{otherTables.map((name) => <option key={name} value={name}>{name}</option>)}
									</select>
								</span>
								<Button variant="secondary" small disabled={!target} onClick={findPath}>Find path</Button>
							</div>
							<div style={styles.snapshotNote}>{snapshotNote}</div>
							{renderPathResult()}
						</>
					)}
			</Section>
		</DetailPanel>
	);
};

export default TableRecordPanel;
