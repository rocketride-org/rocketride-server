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
// SQL-UI — INSIGHTS PANEL (how the schema is shaped, and what it says wrong)
// =============================================================================
//
// A read-only page over ONE schema snapshot. It changes nothing, queries
// nothing, and sees nothing the snapshot does not contain — so the
// limitations footer is not boilerplate, it is the scope of every claim the
// page makes.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, Card, CardDataGrid, EmptyState, StatusBadge, monoEl, mutedEl } from 'shell';
import type { GridCellComponent, GridColumnDefinition } from 'shell';
import type { ISqlEndpoint } from '../connect';
import type { ISchemaState } from '../schema/schemaStore';
import { buildRelationGraph, orientation } from '../schema/relations';
import { RULE_LABELS, runSchemaChecks } from '../schema/quality';
import type { IFinding } from '../schema/quality';
import { requestTableRecord } from '../navigation';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link InsightsPanel} component. */
export interface IInsightsPanelProps {
	/** The connection's endpoint. */
	endpoint: ISqlEndpoint;
	/** The connection's schema snapshot. */
	snapshot: ISchemaState;
}

/** One row of the findings grid. */
interface IFindingRow extends Record<string, unknown> {
	/** Row identity. */
	id: string;
	/** Severity label (`warning` or `info`). */
	severity: string;
	/** The rule's name, in words. */
	rule: string;
	/** `table` or `table.column`. */
	target: string;
	/** The table alone, for the row-click drawer. */
	table: string;
	/** Short mono evidence. */
	evidence: string;
	/** The sentence. */
	message: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** How many hubs the orientation strip names before it stops. */
const MAX_HUBS = 5;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
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

	group: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 6,
		padding: '4px 0',
	} as CSSProperties,

	groupLabel: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		minWidth: 170,
	} as CSSProperties,

	empty: {
		fontSize: 12,
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The connection workbench's Insights page: how the schema is shaped, and
 * what the snapshot-only rules have to say about it.
 *
 * @param props - {@link IInsightsPanelProps}.
 * @returns The panel element.
 */
export const InsightsPanel: React.FC<IInsightsPanelProps> = ({ endpoint, snapshot }) => {
	const graph = useMemo(() => buildRelationGraph(snapshot.schema), [snapshot.schema]);
	const shape = useMemo(() => orientation(graph), [graph]);
	const findings = useMemo(
		() => runSchemaChecks(snapshot.schema, snapshot.dialect),
		[snapshot.schema, snapshot.dialect],
	);

	// The tab badge counts WARNINGS only. An `info` finding is something to
	// know, not something to do, and a badge that counts both would show a
	// number on every healthy ClickHouse schema.
	const warningCount = useMemo(
		() => findings.filter((finding) => finding.severity === 'warning').length,
		[findings],
	);

	const rows = useMemo<IFindingRow[]>(
		() => findings.map((finding: IFinding, index) => ({
			id: `${finding.rule}-${finding.table}-${finding.column ?? ''}-${index}`,
			severity: finding.severity,
			rule: RULE_LABELS[finding.rule],
			target: finding.column ? `${finding.table}.${finding.column}` : finding.table,
			table: finding.table,
			evidence: finding.evidence,
			message: finding.message,
		})),
		[findings],
	);

	const readAt = snapshot.refreshedAt
		? new Date(snapshot.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		: '—';

	const columns = useMemo(
		() =>
			[
				{
					title: 'Severity',
					field: 'severity',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'warning = worth fixing; info = worth knowing, not a verdict.',
					width: 120,
					headerSort: true,
				},
				{
					title: 'Rule',
					field: 'rule',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'Which rule produced the finding.',
					width: 180,
					headerSort: true,
				},
				{
					title: 'Table.column',
					field: 'target',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'What the finding is about.',
					width: 240,
					headerSort: true,
					formatter: (cell: GridCellComponent) => monoEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Evidence',
					field: 'evidence',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'The snapshot detail the rule read.',
					width: 220,
					formatter: (cell: GridCellComponent) => mutedEl(String(cell.getValue() ?? '')),
				},
				{
					title: 'Message',
					field: 'message',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'What the finding means.',
					headerSort: false,
				},
			] satisfies GridColumnDefinition[],
		[],
	);

	// ── Loading / error framing, matching the Overview page ──────────────────

	if (snapshot.status !== 'ready') {
		return (
			<EmptyState
				icon={<DatabaseIcon />}
				title="Reading schema"
				description={`Reflecting tables, columns, and relations from ${endpoint.nodeName}...`}
			/>
		);
	}

	/**
	 * One row of the orientation strip: a label and the table names as
	 * buttons that open each table's record drawer.
	 *
	 * @param label - The row's label.
	 * @param names - The table names.
	 * @param badge - Optional suffix naming what the number counts. A bare
	 *                number beside a table name could be anything.
	 * @returns The strip row.
	 */
	const renderGroup = (label: string, names: string[], badge?: (name: string) => string): React.ReactElement => (
		<div style={styles.group}>
			<span style={styles.groupLabel}>{label}</span>
			{names.length === 0 && <span style={styles.empty}>none</span>}
			{names.map((name) => (
				<Button
					key={name}
					variant="ghost"
					small
					title={badge ? `${name} — ${badge(name)}` : name}
					onClick={() => requestTableRecord(endpoint.key, name)}
				>
					{badge ? `${name} · ${badge(name)}` : name}
				</Button>
			))}
		</div>
	);

	const hubNames = shape.hubs.slice(0, MAX_HUBS).map((hub) => hub.table);
	const inboundByTable = new Map(shape.hubs.map((hub) => [hub.table, hub.inbound]));

	return (
		<div style={styles.panel}>
			{/* How the schema is shaped, by declared foreign keys alone. */}
			<div style={styles.staticRow}>
				<Card header={`Orientation · schema snapshot read ${readAt}`}>
					{graph.edges.length === 0
						? (
							<div style={styles.empty}>
								{snapshot.dialect === 'clickhouse'
									? 'ClickHouse declares no foreign keys, so this schema has no relationships to describe.'
									: 'This schema declares no foreign keys, so it has no relationships to describe.'}
							</div>
						)
						: (
							<>
								{renderGroup('Hubs (most referenced)', hubNames, (name) => {
									const count = inboundByTable.get(name) ?? 0;
									return `${count} referencing ${count === 1 ? 'table' : 'tables'}`;
								})}
								{renderGroup('Leaves (reference only)', shape.leaves)}
								{renderGroup('Isolated (no relationships)', shape.isolated)}
							</>
						)}
				</Card>
			</div>

			{/* What the rules found. */}
			<div style={styles.gridFill}>
				<Card noBodyPadding fill>
					<CardDataGrid<IFindingRow>
						title="Review"
						actions={<StatusBadge variant={warningCount ? 'warning' : 'success'}>{`${warningCount} warnings · ${findings.length} findings`}</StatusBadge>}
						columns={columns}
						data={rows}
						tableId="sql-insights-findings"
						paginate={false}
						height="100%"
						onRowClick={(row) => requestTableRecord(endpoint.key, row.table)}
						emptyTitle="No findings"
						emptyDescription="Rules found nothing to report."
					/>
				</Card>
			</div>

			{/* The scope of every claim above. */}
			<div style={styles.staticRow}>
				<Banner variant="info">
					{`Based on the schema snapshot read ${readAt}. Rules inspect columns, primary keys and declared foreign keys only — indexes, other constraints and data are not inspected. Type comparison is textual after normalisation. Nothing is changed by this page.`}
				</Banner>
			</div>
		</div>
	);
};

export default InsightsPanel;
