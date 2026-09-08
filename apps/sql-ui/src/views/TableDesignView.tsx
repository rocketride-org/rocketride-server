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
// SQL-UI — TABLE DESIGN VIEW (staged designer: columns, foreign keys, DDL)
// =============================================================================
//
// Workbench model: every gesture stages an operation onto the AlterPlan —
// nothing touches the database until Apply, and the DDL page always shows
// exactly what Apply will run. Create mode (table = null) builds a CREATE
// TABLE from the drafted column list instead.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import { Banner, Button, Card, ConfirmDialog, ContentHeader, EmptyState, InputField, StatusBadge, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint, ISqlSchemaColumn } from '../connect';
import { getSession, refreshSchema, useSchema } from '../schema/schemaStore';
import type { AlterOp, IColumnSpec } from '../sql/ddl';
import { FK_ACTIONS, describeOp, generateAlterStatements, generateCreateTable } from '../sql/ddl';
import type { INamedForeignKey } from '../sql/introspect';
import { fetchForeignKeyNames } from '../sql/introspect';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TableDesignView} component. */
export interface ITableDesignViewProps {
	/** The connection the table lives on. */
	endpoint: ISqlEndpoint;
	/** The table being altered, or null for create-table mode. */
	table: string | null;
}

/** One display row of the columns page (snapshot + staged ops applied). */
interface IEffectiveColumn {
	/** Stable row identity (survives renames; React keys must not shift). */
	id: string;
	/** Current (possibly renamed) column name. */
	name: string;
	/** Current (possibly retyped) datatype. */
	type: string;
	/** Part of the primary key. */
	primaryKey: boolean;
	/** Pending-change marker shown as a badge ('' = unchanged). */
	pending: '' | 'added' | 'renamed' | 'retyped' | 'dropped';
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	body: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '16px 24px 24px',
	} as CSSProperties,

	// Columns/FK pages: list on the left, editor card on the right.
	split: {
		display: 'grid',
		gridTemplateColumns: '1fr 340px',
		gap: 16,
		alignItems: 'start',
	} as CSSProperties,

	// Plain list table (designer rows are interactive, not a DataGrid).
	table: {
		width: '100%',
		borderCollapse: 'collapse' as const,
		fontSize: 12.5,
	} as CSSProperties,

	th: {
		...commonStyles.tableHeader,
		textAlign: 'left' as const,
		padding: '8px 12px',
	} as CSSProperties,

	td: {
		...commonStyles.tableCell,
		padding: '7px 12px',
	} as CSSProperties,

	rowSelectable: (selected: boolean): CSSProperties => ({
		cursor: 'pointer',
		background: selected ? 'var(--rr-bg-list-hover)' : 'transparent',
	}),

	mono: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
	} as CSSProperties,

	// Editor card form field row.
	field: {
		marginBottom: 12,
	} as CSSProperties,

	fieldLabel: {
		...commonStyles.labelUppercase,
		display: 'block',
		marginBottom: 5,
	} as CSSProperties,

	select: {
		...commonStyles.inputField,
		width: '100%',
	} as CSSProperties,

	checkboxRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 12.5,
		marginBottom: 12,
	} as CSSProperties,

	// DDL preview block.
	ddl: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12.5,
		lineHeight: 1.7,
		whiteSpace: 'pre-wrap' as const,
		margin: 0,
	} as CSSProperties,

	pendingList: {
		fontSize: 12.5,
		lineHeight: 1.9,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	cardGap: {
		marginBottom: 16,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** Blank column spec for the add/create forms. */
function blankSpec(): IColumnSpec {
	return { name: '', type: '', nullable: true, defaultExpr: '', primaryKey: false };
}

/**
 * Apply the staged ops to the snapshot columns to get the display rows.
 *
 * @param base - The snapshot's columns (empty in create mode).
 * @param pk - The snapshot's primary key column names.
 * @param ops - The staged operations.
 * @returns The effective display rows (dropped rows stay, marked).
 */
function effectiveColumns(base: ISqlSchemaColumn[], pk: string[], ops: AlterOp[]): IEffectiveColumn[] {
	// Snapshot rows carry a base: identity keyed by the ORIGINAL name so the
	// row keeps its React key across staged renames.
	const rows: IEffectiveColumn[] = base.map((c) => ({
		id: `base:${c.column}`,
		name: c.column,
		type: c.type,
		primaryKey: pk.includes(c.column),
		pending: '',
	}));
	ops.forEach((op, i) => {
		if (op.kind === 'dropColumn') {
			const row = rows.find((r) => r.name === op.name);
			if (row) row.pending = 'dropped';
		} else if (op.kind === 'renameColumn') {
			const row = rows.find((r) => r.name === op.name);
			if (row) { row.name = op.newName; row.pending = row.pending || 'renamed'; }
		} else if (op.kind === 'changeType') {
			const row = rows.find((r) => r.name === op.name);
			if (row) { row.type = op.type; row.pending = row.pending || 'retyped'; }
		} else if (op.kind === 'addColumn') {
			// Staged adds are identified by their op index (names may repeat).
			rows.push({ id: `op:${i}`, name: op.spec.name, type: op.spec.type, primaryKey: false, pending: 'added' });
		}
	});
	return rows;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The table designer document. Alter mode stages rename/retype/drop/add
 * column and FK operations against the schema snapshot; create mode drafts a
 * column list for a new table. The DDL page previews exactly what Apply runs.
 */
export const TableDesignView: React.FC<ITableDesignViewProps> = ({ endpoint, table }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);
	const createMode = table === null;

	// ── Designer state ───────────────────────────────────────────────────────

	const [activePage, setActivePage] = useState('columns');
	const [ops, setOps] = useState<AlterOp[]>([]);
	const [createName, setCreateName] = useState('');
	const [createColumns, setCreateColumns] = useState<IColumnSpec[]>([]);
	const [selected, setSelected] = useState<string | null>(null);

	// Column form (add in both modes; doubles as the edit target in alter mode).
	const [draft, setDraft] = useState<IColumnSpec>(blankSpec());
	const [editName, setEditName] = useState('');
	const [editType, setEditType] = useState('');

	// FK form + fetched constraint names.
	const [fkNames, setFkNames] = useState<INamedForeignKey[] | null>(null);
	const [fkError, setFkError] = useState<string | null>(null);
	const [fkDraft, setFkDraft] = useState({ name: '', column: '', refTable: '', refColumn: '', onUpdate: 'CASCADE', onDelete: 'RESTRICT' });

	// Apply lifecycle.
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);

	// ── Derived data ─────────────────────────────────────────────────────────

	const tableDef = !createMode ? snapshot.schema?.tables?.[table] ?? null : null;
	const columns = useMemo<IEffectiveColumn[]>(() => {
		if (createMode) {
			// Drafts are positional: identity by index, not (possibly duplicated) name.
			return createColumns.map((c, i) => ({ id: `draft:${i}`, name: c.name, type: c.type, primaryKey: c.primaryKey, pending: 'added' as const }));
		}
		return effectiveColumns(tableDef?.columns ?? [], tableDef?.primary_key ?? [], ops);
	}, [createMode, createColumns, tableDef, ops]);

	// Statements the DDL page previews and Apply runs.
	const statements = useMemo<string[]>(() => {
		if (createMode) {
			if (!createName.trim() || createColumns.length === 0) return [];
			return [generateCreateTable(snapshot.dialect, createName.trim(), createColumns)];
		}
		return generateAlterStatements(snapshot.dialect, table, ops);
	}, [createMode, createName, createColumns, snapshot.dialect, table, ops]);

	const pendingCount = createMode ? (statements.length > 0 ? 1 : 0) : ops.length;
	const otherTables = Object.keys(snapshot.schema?.tables ?? {}).filter((t) => t !== table);

	// ── Foreign key names (alter mode, lazy on first FK page visit) ──────────

	useEffect(() => {
		if (createMode || activePage !== 'fks' || fkNames !== null || !client || snapshot.status !== 'ready') return;
		// Cancellation flag: a response landing after unmount/re-run must not
		// set state for the wrong table.
		let cancelled = false;
		setFkError(null);
		const session = getSession(client, endpoint);
		fetchForeignKeyNames(session, snapshot.dialect, table)
			.then((names) => { if (!cancelled) setFkNames(names); })
			.catch((err) => { if (!cancelled) setFkError(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; };
	}, [createMode, activePage, fkNames, client, snapshot.status, snapshot.dialect, endpoint, table]);

	// ── Gestures ─────────────────────────────────────────────────────────────

	/**
	 * Stage the add-column form (alter mode) or append to the draft (create).
	 */
	const addColumn = useCallback((): void => {
		if (!draft.name.trim() || !draft.type.trim()) return;
		const spec = { ...draft, name: draft.name.trim(), type: draft.type.trim() };
		if (createMode) {
			setCreateColumns((prev) => [...prev, spec]);
		} else {
			setOps((prev) => [...prev, { kind: 'addColumn', spec }]);
		}
		setDraft(blankSpec());
	}, [draft, createMode]);

	/**
	 * Stage rename/retype for the selected column (alter mode).
	 */
	const applyEdit = useCallback((): void => {
		if (!selected) return;
		const next: AlterOp[] = [];
		// Ops execute sequentially against the mutated table — address the
		// column by its CURRENT display name, never a snapshot-time name.
		if (editName.trim() && editName.trim() !== selected) {
			next.push({ kind: 'renameColumn', name: selected, newName: editName.trim() });
		}
		const current = columns.find((c) => c.name === selected);
		if (editType.trim() && editType.trim() !== current?.type) {
			// Retype targets the FINAL name (rename runs first in op order).
			next.push({ kind: 'changeType', name: editName.trim() || selected, type: editType.trim() });
		}
		if (next.length > 0) setOps((prev) => [...prev, ...next]);
		setSelected(null);
	}, [selected, editName, editType, columns]);

	/**
	 * Execute the staged statements in order, then re-reflect the schema.
	 */
	const apply = useCallback(async (): Promise<void> => {
		if (!client || statements.length === 0) return;
		setApplying(true);
		setApplyError(null);
		// No transaction: MySQL/ClickHouse DDL auto-commits statement by
		// statement, so a failed batch leaves a committed prefix behind.
		let done = 0;
		try {
			const session = getSession(client, endpoint);
			// Statements run in op order; the first failure stops the batch and
			// `done` counts what committed so the plan can drop it.
			for (const sql of statements) {
				await session.execute(sql);
				done++;
			}
			// Success: clear the plan and re-reflect.
			setOps([]);
			setCreateColumns([]);
			setFkNames(null);
			await refreshSchema(client, endpoint);
		} catch (err) {
			setApplyError(err instanceof Error ? err.message : String(err));
			if (done > 0) {
				// Drop the committed prefix so the remaining plan matches what
				// is actually left to run, then re-reflect the mutated schema.
				setOps((prev) => prev.slice(done));
				setFkNames(null);
				await refreshSchema(client, endpoint).catch(() => undefined);
			}
		} finally {
			setApplying(false);
			setConfirmOpen(false);
		}
	}, [client, statements, endpoint]);

	// ── Page menu ────────────────────────────────────────────────────────────

	// FK badge follows the Columns badge's Apply-projection contract: the
	// keys the table declares AFTER Apply — fetched names (falling back to
	// the snapshot before the first FK-page visit) minus staged drops plus
	// staged adds.
	const fkCount =
		(fkNames?.length ?? tableDef?.foreign_keys?.length ?? 0) -
		ops.filter((op) => op.kind === 'dropForeignKey').length +
		ops.filter((op) => op.kind === 'addForeignKey').length;

	const menu: ViewMenu = {
		entries: [
			// The badge reflects the table Apply would produce: dropped rows out.
			{ id: 'columns', label: 'Columns', count: columns.filter((c) => c.pending !== 'dropped').length || undefined },
			// Create mode has no FK page: constraints ride the CREATE later.
			...(!createMode ? [{ id: 'fks', label: 'Foreign Keys', count: fkCount || undefined }] : []),
			{ id: 'ddl', label: 'DDL', ...(pendingCount > 0 ? { count: pendingCount } : {}) },
		],
	};

	// ── Framing ──────────────────────────────────────────────────────────────

	if (!createMode && snapshot.status !== 'ready') {
		return (
			<div style={styles.root}>
				<ContentHeader title={table ?? ''} subtitle="design" />
				<div style={styles.body}>
					<EmptyState icon={<DatabaseIcon />} title="Reading schema" description="The table's schema is still loading..." />
				</div>
			</div>
		);
	}

	return (
		<div style={styles.root}>
			<TabControl menu={menu} activeId={activePage} onSelect={setActivePage} />

			<ContentHeader
				title={createMode ? (createName.trim() || 'New table') : table}
				subtitle={
					pendingCount > 0
						? `${pendingCount} pending change${pendingCount === 1 ? '' : 's'} — review on the DDL page, then Apply`
						: 'No pending changes'
				}
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => { setOps([]); setCreateColumns([]); setSelected(null); setApplyError(null); }}
							disabled={pendingCount === 0 || applying}
						>
							Discard
						</Button>
						<Button
							variant="primary"
							onClick={() => setConfirmOpen(true)}
							disabled={pendingCount === 0 || applying || !client || !isConnected}
						>
							{applying ? 'Applying...' : 'Apply'}
						</Button>
					</>
				}
			/>

			<div style={styles.body}>
				{applyError && <div style={styles.cardGap}><Banner variant="error">Apply failed: {applyError}</Banner></div>}

				<TabPanel
					activeId={activePage}
					panels={{
						// ── COLUMNS ─────────────────────────────────────────────
						columns: {
							content: (
								<div style={styles.split}>
									<Card noBodyPadding>
										<table style={styles.table}>
											<thead>
												<tr>
													<th style={styles.th}>Column</th>
													<th style={styles.th}>Datatype</th>
													<th style={styles.th}>PK</th>
													<th style={styles.th}>Status</th>
													<th style={styles.th}></th>
												</tr>
											</thead>
											<tbody>
												{columns.map((col, rowIndex) => (
													<tr
														key={col.id}
														style={styles.rowSelectable(selected === col.name)}
														onClick={() => {
															// Select for rename/retype (alter mode, not dropped rows).
															if (createMode || col.pending === 'dropped') return;
															setSelected(col.name);
															setEditName(col.name);
															setEditType(col.type);
														}}
													>
														<td style={{ ...styles.td, ...styles.mono, textDecoration: col.pending === 'dropped' ? 'line-through' : 'none' }}>{col.name}</td>
														<td style={{ ...styles.td, ...styles.mono }}>{col.type}</td>
														<td style={styles.td}>{col.primaryKey ? <StatusBadge variant="info">PK</StatusBadge> : null}</td>
														<td style={styles.td}>
															{col.pending && (
																<StatusBadge variant={col.pending === 'dropped' ? 'error' : 'warning'}>{col.pending}</StatusBadge>
															)}
														</td>
														<td style={styles.td}>
															<Button
																variant="danger"
																small
																onClick={() => {
																	if (createMode) {
																		// Drafts map 1:1 to rows — drop by index so
																		// duplicate names cannot remove each other.
																		setCreateColumns((prev) => prev.filter((_, i) => i !== rowIndex));
																	} else if (col.pending !== 'dropped') {
																		// Ops execute sequentially — address by CURRENT name.
																		setOps((prev) => [...prev, { kind: 'dropColumn', name: col.name }]);
																	}
																	if (selected === col.name) setSelected(null);
																}}
															>
																Drop
															</Button>
														</td>
													</tr>
												))}
												{columns.length === 0 && (
													<tr><td style={styles.td} colSpan={5}>No columns yet — add the first one on the right.</td></tr>
												)}
											</tbody>
										</table>
									</Card>

									{/* Right card: edit selection, else add column. */}
									{selected && !createMode ? (
										<Card header={`Column: ${selected}`}>
											<div style={styles.field}>
												<span style={styles.fieldLabel}>Name</span>
												<InputField value={editName} onChange={(e) => setEditName(e.target.value)} />
											</div>
											<div style={styles.field}>
												<span style={styles.fieldLabel}>Datatype</span>
												<InputField value={editType} onChange={(e) => setEditType(e.target.value)} />
											</div>
											<Button variant="primary" small onClick={applyEdit}>Stage Change</Button>
											{' '}
											<Button variant="ghost" small onClick={() => setSelected(null)}>Cancel</Button>
										</Card>
									) : (
										<Card header="Add column">
											{createMode && (
												<div style={styles.field}>
													<span style={styles.fieldLabel}>Table name</span>
													<InputField value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="new_table" />
												</div>
											)}
											<div style={styles.field}>
												<span style={styles.fieldLabel}>Name</span>
												<InputField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="column_name" />
											</div>
											<div style={styles.field}>
												<span style={styles.fieldLabel}>Datatype</span>
												<InputField value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} placeholder="VARCHAR(255)" />
											</div>
											<div style={styles.field}>
												<span style={styles.fieldLabel}>Default (optional)</span>
												<InputField value={draft.defaultExpr} onChange={(e) => setDraft({ ...draft, defaultExpr: e.target.value })} placeholder="e.g. 0, 'draft', CURRENT_TIMESTAMP" />
											</div>
											<label style={styles.checkboxRow}>
												<input type="checkbox" checked={!draft.nullable} onChange={(e) => setDraft({ ...draft, nullable: !e.target.checked })} />
												NOT NULL
											</label>
											{createMode && (
												<label style={styles.checkboxRow}>
													<input type="checkbox" checked={draft.primaryKey} onChange={(e) => setDraft({ ...draft, primaryKey: e.target.checked })} />
													Primary key
												</label>
											)}
											<Button variant="primary" small onClick={addColumn} disabled={!draft.name.trim() || !draft.type.trim()}>
												{createMode ? 'Add to Table' : 'Stage Add Column'}
											</Button>
										</Card>
									)}
								</div>
							),
						},

						// ── FOREIGN KEYS (alter mode only) ──────────────────────
						...(!createMode ? {
							fks: {
								content: (
									<div style={styles.split}>
										<Card noBodyPadding>
											{fkError && <Banner variant="warning">Constraint names unavailable: {fkError}</Banner>}
											<table style={styles.table}>
												<thead>
													<tr>
														<th style={styles.th}>Key</th>
														<th style={styles.th}>Column</th>
														<th style={styles.th}>References</th>
														<th style={styles.th}></th>
													</tr>
												</thead>
												<tbody>
													{(fkNames ?? []).map((fk) => {
														const dropped = ops.some((op) => op.kind === 'dropForeignKey' && op.name === fk.name);
														return (
															<tr key={fk.name}>
																<td style={{ ...styles.td, ...styles.mono, textDecoration: dropped ? 'line-through' : 'none' }}>{fk.name}</td>
																<td style={{ ...styles.td, ...styles.mono }}>{fk.column}</td>
																<td style={{ ...styles.td, ...styles.mono }}>{fk.referredTable}</td>
																<td style={styles.td}>
																	{dropped ? (
																		<StatusBadge variant="error">dropped</StatusBadge>
																	) : (
																		<Button variant="danger" small onClick={() => setOps((prev) => [...prev, { kind: 'dropForeignKey', name: fk.name }])}>Drop</Button>
																	)}
																</td>
															</tr>
														);
													})}
													{/* Staged (not yet applied) foreign keys — keyed by op index. */}
													{ops.map((op, i) => op.kind === 'addForeignKey' ? (
														<tr key={`staged:${i}`}>
															<td style={{ ...styles.td, ...styles.mono }}>{op.name}</td>
															<td style={{ ...styles.td, ...styles.mono }}>{op.column}</td>
															<td style={{ ...styles.td, ...styles.mono }}>{op.refTable}</td>
															<td style={styles.td}><StatusBadge variant="warning">added</StatusBadge></td>
														</tr>
													) : null)}
													{fkNames !== null && fkNames.length === 0 && (
														<tr><td style={styles.td} colSpan={4}>This table declares no foreign keys.</td></tr>
													)}
													{fkNames === null && !fkError && (
														<tr><td style={styles.td} colSpan={4}>Reading constraint names...</td></tr>
													)}
												</tbody>
											</table>
										</Card>

										<Card header="Add foreign key">
											<div style={styles.field}>
													<span style={styles.fieldLabel}>Name</span>
													<InputField value={fkDraft.name} onChange={(e) => setFkDraft({ ...fkDraft, name: e.target.value })} placeholder={`fk_${table}_...`} />
												</div>
												<div style={styles.field}>
													<span style={styles.fieldLabel}>Column</span>
													<select style={styles.select} value={fkDraft.column} onChange={(e) => setFkDraft({ ...fkDraft, column: e.target.value })}>
														<option value="">Select column...</option>
														{columns.filter((c) => c.pending !== 'dropped').map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
													</select>
												</div>
												<div style={styles.field}>
													<span style={styles.fieldLabel}>Referenced table</span>
													<select style={styles.select} value={fkDraft.refTable} onChange={(e) => setFkDraft({ ...fkDraft, refTable: e.target.value, refColumn: '' })}>
														<option value="">Select table...</option>
														{otherTables.map((t) => <option key={t} value={t}>{t}</option>)}
													</select>
												</div>
												<div style={styles.field}>
													<span style={styles.fieldLabel}>Referenced column</span>
													<select style={styles.select} value={fkDraft.refColumn} onChange={(e) => setFkDraft({ ...fkDraft, refColumn: e.target.value })}>
														<option value="">Select column...</option>
														{(snapshot.schema?.tables?.[fkDraft.refTable]?.columns ?? []).map((c) => (
															<option key={c.column} value={c.column}>{c.column}</option>
														))}
													</select>
												</div>
												<div style={styles.field}>
													<span style={styles.fieldLabel}>On update</span>
													<select style={styles.select} value={fkDraft.onUpdate} onChange={(e) => setFkDraft({ ...fkDraft, onUpdate: e.target.value })}>
														{FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
													</select>
												</div>
												<div style={styles.field}>
													<span style={styles.fieldLabel}>On delete</span>
													<select style={styles.select} value={fkDraft.onDelete} onChange={(e) => setFkDraft({ ...fkDraft, onDelete: e.target.value })}>
														{FK_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
													</select>
												</div>
												<Button
													variant="primary"
													small
													disabled={!fkDraft.name.trim() || !fkDraft.column || !fkDraft.refTable || !fkDraft.refColumn}
													onClick={() => {
														setOps((prev) => [...prev, {
															kind: 'addForeignKey',
															name: fkDraft.name.trim(),
															column: fkDraft.column,
															refTable: fkDraft.refTable,
															refColumn: fkDraft.refColumn,
															onUpdate: fkDraft.onUpdate,
															onDelete: fkDraft.onDelete,
														}]);
														setFkDraft({ name: '', column: '', refTable: '', refColumn: '', onUpdate: 'CASCADE', onDelete: 'RESTRICT' });
													}}
												>
													Stage Foreign Key
												</Button>
										</Card>
									</div>
								),
							},
						} : {}),

						// ── DDL ─────────────────────────────────────────────────
						ddl: {
							content: (
								<>
									{!createMode && ops.length > 0 && (
										<Card header="Pending changes">
											<div style={styles.pendingList}>
												{ops.map((op, i) => <div key={i}>{i + 1}. {describeOp(op)}</div>)}
											</div>
										</Card>
									)}
									<div style={styles.cardGap} />
									<Card header="Generated DDL">
										{statements.length > 0 ? (
											<pre style={styles.ddl}>{statements.map((s) => `${s};`).join('\n\n')}</pre>
										) : (
											<span style={commonStyles.textMuted}>
												{createMode
													? 'Name the table and add at least one column to generate its CREATE TABLE.'
													: 'No pending changes — stage edits on the Columns or Foreign Keys pages.'}
											</span>
										)}
									</Card>
								</>
							),
						},
					}}
				/>
			</div>

			{/* Apply confirmation — destructive, shows the exact statement count. */}
			{confirmOpen && (
				<ConfirmDialog
					title={createMode ? 'Create table?' : `Apply ${statements.length} statement${statements.length === 1 ? '' : 's'}?`}
					message={
						createMode
							? `CREATE TABLE ${createName.trim()} will run on ${snapshot.schema?.database ?? endpoint.nodeName}.`
							: `The staged DDL will run against ${snapshot.schema?.database ?? endpoint.nodeName} in order. Review the DDL page first — schema changes cannot be undone from here.`
					}
					confirmLabel={applying ? 'Applying...' : 'Apply'}
					destructive
					confirmDisabled={applying}
					onConfirm={() => { void apply(); }}
					onCancel={() => setConfirmOpen(false)}
				/>
			)}
		</div>
	);
};

export default TableDesignView;
