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

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, DetailPanel, LabelValue, Section, StatusBadge } from 'shell';
import type { ISqlSchemaTable } from '../connect';
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
	/** Fired when the user opens the table's data browser. */
	onBrowseData: () => void;
	/** Fired when the user opens the table's designer. */
	onDesign: () => void;
}

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
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Record drawer for one table: columns with datatypes, primary key, and
 * foreign keys — all straight from the connection's schema snapshot (no
 * extra database round-trips).
 */
export const TableRecordPanel: React.FC<ITableRecordPanelProps> = (props) => {
	const { open, onClose, database, table, def, onBrowseData, onDesign } = props;

	// Primary key membership for the per-column PK badge.
	const pkColumns = new Set(def?.primary_key ?? []);

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
		</DetailPanel>
	);
};

export default TableRecordPanel;
