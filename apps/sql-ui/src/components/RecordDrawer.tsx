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
// SQL-UI — RECORD DRAWER (one row of the data browser, in full)
// =============================================================================
//
// A row click in the data browser opens this drawer on the shell's
// DetailPanel. Fields follow the table's reflected column order (the row
// object's own keys are not a column list; see `sql/record.ts`), with Prev and
// Next across the page, and a copy button per value and for the whole row.
//
// A foreign-key value is a link. It looks the referenced row up (bound values,
// LIMIT 2) and opens it in a drawer stacked on this one; the shell's back
// arrow, or Back, returns. "Rows that reference this one" lists the child
// tables, and Show rows opens a child's Data page with filter chips preset.
//
// EDITING (staged; sql/rowEdits.ts): with `editing`, the open row offers
// Edit (a form with one input and a NULL toggle per field, key columns read
// only), Delete (marks the row) and Undo. Nothing is written: the data page
// stages the change, and Apply sends it. The same form, empty, adds a new
// row (RowEditForm). Where rows cannot be changed, the buttons are off and
// the drawer says why.
// =============================================================================

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { inspectorText } from 'shared/explorer/components/RowInspector';
import { Banner, Button, DetailPanel, InputField, LabelValue, Section, StatusBadge } from 'shell';
import { announce } from '../a11y/announce';
import type { SqlDialect, SqlSchemaTable } from '../connect';
import type { RelationEdge, RelationGraph } from '../schema/relations';
import type { FilterChip } from '../sql/filters';
import type { FormField } from '../sql/rowEdits';
import { childRowsPreset, fallbackDef, hasKeyValues, linkRefusal, recordFields, recordJson, referencedRowStatement, referencingEdges, showRowsRefusal } from '../sql/record';
import GatedButton from './GatedButton';

/** What a row of SQL values loses on the way to the browser. */
const NOTE = 'Very large numbers and decimals may be shown rounded.';

/** Props for the {@link RecordDrawer} component. */
export interface RecordDrawerProps {
	/** The engine dialect (quotes the lookup). */
	dialect: SqlDialect;
	/** The connection's declared foreign keys. */
	graph: RelationGraph;
	/** The reflected tables, for the fields of a looked-up row. */
	tables: Record<string, SqlSchemaTable>;
	/** The table being browsed. */
	table: string;
	/** The current page's rows. */
	rows: readonly Record<string, unknown>[];
	/** Index of the open row within `rows`, or null when the drawer is closed. */
	index: number | null;
	/** Rows before this page, so the title reads "Row N" across pages. */
	offset: number;
	/** Fired with the row Prev or Next moved to. */
	onIndexChange: (index: number) => void;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
	/** Runs a bound SELECT; null when the connection cannot run statements. */
	lookup: ((sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) | null;
	/** Opens a table's Data page with these chips preset; absent = no Show rows. */
	onShowRows?: (table: string, chips: FilterChip[]) => void;
	/** Staged editing of the open row; absent = the drawer only reads. */
	editing?: RecordEditingProps | null;
}

/** What the drawer needs to stage changes to the open row (the data page holds the staged changes). */
export interface RecordEditingProps {
	/** Why rows cannot be changed now, or null (sql/rowEdits.ts rowEditGate). */
	disabledReason: string | null;
	/** An apply is running: nothing is staged or undone until it ends. */
	busy: boolean;
	/** The form's fields for a row, with any staged edit showing through. */
	formFor: (row: Record<string, unknown>) => readonly FormField[];
	/** The row's staged change in one line, or null when nothing is staged. */
	stagedLine: (row: Record<string, unknown>) => string | null;
	/** Whether the row is staged for deletion. */
	isDeleted: (row: Record<string, unknown>) => boolean;
	/** Stage the user's changes; returns why they were refused, or null. */
	stage: (row: Record<string, unknown>, before: readonly FormField[], after: readonly FormField[]) => string | null;
	/** Stage the row's deletion; returns why it was refused, or null. */
	remove: (row: Record<string, unknown>) => string | null;
	/** Undo the row's staged change. */
	undo: (row: Record<string, unknown>) => void;
}

/** One row opened by following a foreign key. */
interface Followed {
	/** The table the row belongs to. */
	table: string;
	/** The row. */
	row: Record<string, unknown>;
	/** Its columns: the schema's, or the row's own when the schema lacks the table. */
	def: SqlSchemaTable;
	/** Where it was reached from, e.g. `orders.customer_id`. */
	from: string;
	/** Set when the lookup matched more than one row. */
	ambiguous: boolean;
}

const styles = {
	valueRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 8,
	} as CSSProperties,

	value: {
		flex: 1,
		minWidth: 0,
		margin: 0,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	link: {
		background: 'none',
		border: 'none',
		padding: 0,
		font: 'inherit',
		color: 'var(--rr-color-info)',
		textDecoration: 'underline',
		cursor: 'pointer',
		textAlign: 'left',
	} as CSSProperties,

	/** A link that cannot be followed: still a link, focusable, plainly off. */
	linkOff: {
		color: 'var(--rr-text-secondary)',
		textDecoration: 'underline dotted',
		cursor: 'not-allowed',
	} as CSSProperties,

	type: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	note: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		padding: '8px 0 0',
	} as CSSProperties,

	child: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		padding: '4px 0',
		fontSize: 12,
	} as CSSProperties,

	status: {
		marginBottom: 8,
	} as CSSProperties,

	formRow: {
		marginBottom: 10,
	} as CSSProperties,

	formLabel: {
		display: 'block',
		fontSize: 12,
		fontWeight: 600,
		marginBottom: 4,
	} as CSSProperties,

	formInput: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	nullToggle: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		fontSize: 12,
		whiteSpace: 'nowrap',
	} as CSSProperties,

	formNote: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginBottom: 10,
	} as CSSProperties,

	// The footer's verbs, wrapped onto a second line inside the drawer: the
	// shell's footer row does not wrap, and six verbs are wider than 460 px.
	footer: {
		flex: '1 1 auto',
		minWidth: 0,
		display: 'flex',
		flexWrap: 'wrap',
		justifyContent: 'flex-end',
		gap: 8,
	} as CSSProperties,
};

// =============================================================================
// THE EDIT FORM
// =============================================================================

/** Props for the {@link RowEditForm} component. */
export interface RowEditFormProps {
	/** Drawer title ("Edit row 12", "New row"). */
	title: string;
	/** Drawer subtitle (the table). */
	subtitle: string;
	/** The fields the form opens with (sql/rowEdits.ts editFormFields). */
	fields: readonly FormField[];
	/** Key columns are read only (an existing row); a new row may set them. */
	lockKeys: boolean;
	/** The submit button's label. */
	submitLabel: string;
	/** Why the last submit was refused (a value the column cannot take), or null. */
	error: string | null;
	/** An apply is running: submitting waits for it. */
	busy?: boolean;
	/** Submit: the fields as the user left them. */
	onSubmit: (fields: FormField[]) => void;
	/** Cancel: nothing is staged. */
	onCancel: () => void;
}

/**
 * The edit form: one input and a NULL toggle per field, in table order.
 * Submitting stages the change; nothing is written until Apply.
 *
 * @param props - {@link RowEditFormProps}.
 * @returns The drawer.
 */
export const RowEditForm: React.FC<RowEditFormProps> = ({ title, subtitle, fields, lockKeys, submitLabel, error, busy = false, onSubmit, onCancel }) => {
	const [values, setValues] = useState<FormField[]>(() => fields.map((field) => ({ ...field })));
	const set = (index: number, patch: Partial<FormField>): void => {
		setValues((current) => current.map((field, i) => (i === index ? { ...field, ...patch } : field)));
	};
	return (
		<DetailPanel
			open
			onClose={onCancel}
			title={title}
			subtitle={subtitle}
			modeless
			width={460}
			footer={
				<>
					<Button variant="primary" disabled={busy} onClick={() => onSubmit(values)}>{submitLabel}</Button>
					<Button variant="ghost" onClick={onCancel}>Cancel</Button>
				</>
			}
		>
			{error && <div style={styles.status} role="alert"><Banner variant="error">{error}</Banner></div>}
			<div style={styles.formNote}>
				Nothing is saved until you apply.{lockKeys ? ' Key columns cannot be changed here.' : ' An empty field takes the column\'s default.'} Tick NULL to store NULL.
			</div>
			<Section label={`Fields (${values.length})`}>
				{values.map((field, index) => {
					const locked = lockKeys && field.key;
					const id = `rr-sql-edit-${index}`;
					return (
						<div key={field.column} style={styles.formRow}>
							<label htmlFor={id} style={styles.formLabel}>{field.column}{field.key ? ' (key)' : ''}</label>
							<div style={styles.valueRow}>
								<InputField
									id={id}
									style={styles.formInput}
									value={field.isNull ? '' : field.text}
									placeholder={field.isNull ? 'NULL' : ''}
									disabled={locked || field.isNull}
									aria-describedby={`${id}-type`}
									onChange={(event) => set(index, { text: event.target.value })}
								/>
								<label style={styles.nullToggle}>
									<input type="checkbox" checked={field.isNull} disabled={locked} onChange={(event) => set(index, { isNull: event.target.checked })} />
									NULL
								</label>
							</div>
							<div id={`${id}-type`} style={styles.type}>{field.type}{locked ? ' · key column, read only' : ''}</div>
						</div>
					);
				})}
			</Section>
		</DetailPanel>
	);
};

/**
 * Copy text to the clipboard and announce the outcome. A missing Clipboard
 * API or a refusal announces a failure rather than passing silently.
 *
 * @param text - The text to copy.
 * @param what - What was copied, for the announcement.
 */
function copy(text: string, what: string): void {
	if (!navigator.clipboard) {
		announce(`Could not copy ${what}`);
		return;
	}
	void navigator.clipboard.writeText(text).then(
		() => { announce(`Copied ${what}`); },
		() => { announce(`Could not copy ${what}`); },
	);
}

/** Props for one drawer level. */
interface LevelProps {
	/** Reflected schema of the row's table. */
	def: SqlSchemaTable;
	/** The row's table. */
	table: string;
	/** The row. */
	row: Record<string, unknown>;
	title: string;
	subtitle: string;
	/** Footer buttons before Copy/Close (Prev, Next on the first level). */
	nav?: React.ReactNode;
	closeLabel: string;
	onClose: () => void;
	ambiguous?: boolean;
	/** Following a key; null disables the links (a schema-only node). */
	onFollow: ((edge: RelationEdge, row: Record<string, unknown>, table: string) => void) | null;
	graph: RelationGraph;
	/** The reflected tables, for the key columns' types (a binary key is not followed). */
	tables: Record<string, SqlSchemaTable>;
	onShowRows?: (table: string, chips: FilterChip[]) => void;
	/** Lookup state shown above the fields. */
	status?: React.ReactNode;
}

/**
 * One drawer: the fields of one row, its links, and the tables that
 * reference it.
 *
 * @param props - {@link LevelProps}.
 * @returns The drawer element.
 */
const Level: React.FC<LevelProps> = ({ def, table, row, title, subtitle, nav, closeLabel, onClose, ambiguous, onFollow, graph, tables, onShowRows, status }) => {
	const fields = recordFields(def, row, graph, table);
	const children = referencingEdges(graph, table);
	// One id per drawer level; each refused link and button points at its reason.
	const baseId = useId();
	const reasonId = (key: string): string => `${baseId}-${encodeURIComponent(key)}`;
	return (
		<DetailPanel
			open
			onClose={onClose}
			title={title}
			subtitle={subtitle}
			modeless
			width={460}
			footer={
				<div style={styles.footer}>
					{nav}
					<Button variant="secondary" onClick={() => copy(recordJson(def, row), 'row as JSON')}>Copy row as JSON</Button>
					<Button variant="ghost" onClick={onClose}>{closeLabel}</Button>
				</div>
			}
		>
			{status && <div style={styles.status}>{status}</div>}
			{ambiguous && (
				<div style={styles.status}>
					<Banner variant="warning">More than one row matches this key. Showing the first.</Banner>
				</div>
			)}
			<Section label={`Fields (${fields.length})`}>
				{fields.map((field) => {
					const text = inspectorText(field.value);
					// The first key the column belongs to; a NULL key has nothing to open.
					const link = field.links.find((edge) => hasKeyValues(edge, row));
					// A key the browser does not hold exactly (rounded, or binary sent as text) is not looked up.
					const linkOff = link ? linkRefusal(link, row, tables) : null;
					return (
						<LabelValue key={field.column} label={field.column} mono>
							<div style={styles.valueRow}>
								{link && onFollow && linkOff ? (
									<button
										type="button"
										style={{ ...styles.link, ...styles.value, ...styles.linkOff }}
										aria-disabled="true"
										aria-describedby={reasonId(field.column)}
										title={linkOff}
										onClick={() => undefined}
									>
										{text}
									</button>
								) : link && onFollow ? (
									<button
										type="button"
										style={{ ...styles.link, ...styles.value }}
										title={`Open ${link.refTable} row`}
										onClick={() => onFollow(link, row, table)}
									>
										{text}
									</button>
								) : (
									<pre style={styles.value}>{text}</pre>
								)}
								{field.pk && <StatusBadge variant="info">PK</StatusBadge>}
								<Button variant="ghost" small title={`Copy ${field.column}`} onClick={() => copy(text, field.column)}>Copy</Button>
							</div>
							<div style={styles.type}>{field.type}{field.links.length > 0 ? ` → ${field.links.map((e) => e.refTable).join(', ')}` : ''}</div>
							{link && onFollow && linkOff && <div id={reasonId(field.column)} style={styles.type}>{linkOff}</div>}
						</LabelValue>
					);
				})}
			</Section>
			{children.length > 0 && (
				<Section label="Rows that reference this one">
					{children.map((edge) => {
						const chips = childRowsPreset(edge, row, tables);
						// A key the browser does not hold exactly would filter on another row's key.
						const showOff = showRowsRefusal(edge, row, tables);
						return (
							<div key={edge.id}>
								<div style={styles.child}>
									<span>{edge.table}.{edge.columns.join(', ')}</span>
									{onShowRows && (
										<GatedButton
											variant="secondary"
											small
											disabled={!chips}
											onClick={() => chips && onShowRows(edge.table, chips)}
											gateReason={showOff}
											reasonId={reasonId(`show:${edge.id}`)}
										>
											Show rows
										</GatedButton>
									)}
								</div>
								{onShowRows && showOff && <div id={reasonId(`show:${edge.id}`)} style={styles.type}>{showOff}</div>}
							</div>
						);
					})}
				</Section>
			)}
			<div style={styles.note}>{NOTE}</div>
		</DetailPanel>
	);
};

/**
 * The record drawer for the data browser.
 *
 * @param props - {@link RecordDrawerProps}.
 * @returns The drawer stack, or null when closed.
 */
export const RecordDrawer: React.FC<RecordDrawerProps> = ({ dialect, graph, tables, table, rows, index, offset, onIndexChange, onClose, lookup, onShowRows, editing }) => {
	// Rows reached by following keys, outermost first.
	const [followed, setFollowed] = useState<Followed[]>([]);
	// The lookup in flight or its failure, shown on the level it was started from.
	const [status, setStatus] = useState<{ depth: number; kind: 'busy' | 'none' | 'error'; text: string } | null>(null);
	const seqRef = useRef(0);
	// The open row's edit form (the fields it opened with), and why staging was refused.
	const [form, setForm] = useState<readonly FormField[] | null>(null);
	const [editError, setEditError] = useState<string | null>(null);

	// Another row (or closing) drops the stack: it belonged to the previous row.
	useEffect(() => {
		seqRef.current++;
		setFollowed([]);
		setStatus(null);
		setForm(null);
		setEditError(null);
	}, [index, table]);

	const follow = useCallback((depth: number) => (edge: RelationEdge, row: Record<string, unknown>, fromTable: string): void => {
		const stmt = referencedRowStatement(dialect, edge, row, tables);
		if (!stmt || !lookup) return;
		const seq = ++seqRef.current;
		const where = edge.refColumns.map((c, i) => `${c} = ${String(row[edge.columns[i]!])}`).join(', ');
		setStatus({ depth, kind: 'busy', text: `Looking up ${edge.refTable}...` });
		lookup(stmt.sql, stmt.params).then(
			(found) => {
				if (seq !== seqRef.current) return;
				const first = found[0];
				if (!first) {
					setStatus({ depth, kind: 'none', text: `No row in ${edge.refTable} where ${where}.` });
					return;
				}
				setStatus(null);
				setFollowed((current) => [
					...current.slice(0, depth),
					{ table: edge.refTable, row: first, def: tables[edge.refTable] ?? fallbackDef(first), from: `${fromTable}.${edge.columns.join(', ')}`, ambiguous: found.length > 1 },
				]);
			},
			(err: unknown) => {
				if (seq !== seqRef.current) return;
				setStatus({ depth, kind: 'error', text: `Could not open the ${edge.refTable} row: ${err instanceof Error ? err.message : String(err)}` });
			},
		);
	}, [dialect, lookup, tables]);

	const row = index === null ? undefined : rows[index];
	const def = tables[table];
	if (index === null || !row || !def) return null;

	const statusFor = (depth: number): React.ReactNode => {
		if (!status || status.depth !== depth) return undefined;
		return <Banner variant={status.kind === 'error' ? 'error' : status.kind === 'none' ? 'warning' : 'info'}>{status.text}</Banner>;
	};

	const rowTitle = `Row ${(offset + index + 1).toLocaleString()}`;
	if (editing && form) {
		return (
			<RowEditForm
				key={`${table}-${index}`}
				title={`Edit ${rowTitle.toLowerCase()}`}
				subtitle={table}
				fields={form}
				lockKeys
				submitLabel="Stage changes"
				error={editError}
				busy={editing.busy}
				onSubmit={(after) => {
					const refused = editing.stage(row, form, after);
					setEditError(refused);
					if (refused === null) setForm(null);
				}}
				onCancel={() => { setForm(null); setEditError(null); }}
			/>
		);
	}

	// The open row's staged change, and its buttons (Edit, Delete, Undo).
	const staged = editing ? editing.stagedLine(row) : null;
	const deleted = editing ? editing.isDeleted(row) : false;
	const off = editing?.disabledReason ?? null;
	const editStatus = editing ? (
		<>
			{statusFor(0)}
			{staged !== null && <Banner variant="info">Staged, not saved yet: {staged}</Banner>}
			{editError !== null && <Banner variant="error">{editError}</Banner>}
			{off !== null && <div style={styles.type}>Editing is off: {off}</div>}
		</>
	) : statusFor(0);

	return (
		<>
			<Level
				def={def}
				table={table}
				row={row}
				title={rowTitle}
				subtitle={table}
				nav={
					<>
						<Button variant="ghost" disabled={index <= 0} onClick={() => onIndexChange(index - 1)}>Prev</Button>
						<Button variant="ghost" disabled={index >= rows.length - 1} onClick={() => onIndexChange(index + 1)}>Next</Button>
						{editing && staged !== null && <Button variant="secondary" disabled={editing.busy} onClick={() => { editing.undo(row); setEditError(null); }}>Undo</Button>}
						{editing && !deleted && (
							<>
								<Button variant="secondary" disabled={off !== null} {...(off !== null ? { title: off } : {})} onClick={() => { setEditError(null); setForm(editing.formFor(row)); }}>Edit</Button>
								<Button variant="danger" disabled={off !== null} {...(off !== null ? { title: off } : {})} onClick={() => setEditError(editing.remove(row))}>Delete</Button>
							</>
						)}
					</>
				}
				closeLabel="Close"
				onClose={onClose}
				onFollow={lookup ? follow(0) : null}
				graph={graph}
				tables={tables}
				onShowRows={onShowRows}
				status={editStatus}
			/>
			{followed.map((level, depth) => {
				return (
					<Level
						key={`${level.table}-${depth}`}
						def={level.def}
						table={level.table}
						row={level.row}
						title={level.table}
						subtitle={`from ${level.from}`}
						closeLabel="Back"
						onClose={() => setFollowed((current) => current.slice(0, depth))}
						ambiguous={level.ambiguous}
						onFollow={lookup ? follow(depth + 1) : null}
						graph={graph}
						tables={tables}
						onShowRows={onShowRows}
						status={statusFor(depth + 1)}
					/>
				);
			})}
		</>
	);
};

export default RecordDrawer;
