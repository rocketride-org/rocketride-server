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
//
// STAGED EDITS (sql/rowEdits.ts). The record drawer edits a row, deletes it,
// or adds one, and the change is STAGED: nothing is written until Apply.
// Staged rows are marked in the grid (a tint, plus "✎" on an edited value
// and "Deleted" on a deleted row), read from the pristine fetched rows by
// position, never from the objects the grid was handed. The bar above the
// grid counts the changes; Review SQL shows the statements; Apply confirms
// (with the words sql/applyMode.ts allows: one transaction, each on its own,
// or hedged for a MySQL table whose engine could not be read), sends them in
// one `applyBatch`, records each statement in history, drops what was
// settled, and refetches the page. Editing is off, with the reason, on a
// table without a primary key, on ClickHouse, on a schema-only node, and
// while the engine (in the dev tool, the sidebar) is not reachable.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGeneration } from 'shared/explorer/generation';
import type { CSSProperties } from 'react';
import type { GridCellComponent } from 'shell';
import { Banner, Button, Card, ConfirmDialog, ContentHeader, DataGrid, EmptyState, monoEl, mutedEl } from 'shell';
import type { GridColumnDefinition, IDataGridHandle, IDataGridPage, IDataGridPageRequest } from 'shell';
import { commonStyles } from 'shell';
import { isTransactionsUnavailable } from '../connect';
import type { SqlApplyStatement, SqlEndpoint } from '../connect';
import { announce } from '../a11y/announce';
import { noteExecuteFailure, useExecuteState, useSchema } from '../schema/schemaStore';
import { executeGateReason, schemaOnlyExplanation } from '../executeGate';
import { useSqlEnv } from '../sqlEnv';
import { buildPageStatements, countKey } from '../sql/paging';
import {
	applyProbeResult,
	applyTotalIfCurrent,
	emptyCountCache,
	estimateStatement,
	invalidateTotals,
	overfetchPage,
	planCount,
} from '../sql/estimate';
import type { CountCache } from '../sql/estimate';
import type { FilterChip } from '../sql/filters';
import { buildRelationGraph, fkMarker } from '../schema/relations';
import { FilterChips } from '../components/FilterChips';
import type { SortChip } from '../components/FilterChips';
import { RecordDrawer, RowEditForm } from '../components/RecordDrawer';
import type { RecordEditingProps } from '../components/RecordDrawer';
import { PendingChangesBar, discardConfirmText, discardNeedsConfirm, pendingCountText } from '../components/PendingChangesBar';
import { ApplyConfirmDialog, MAY_HAVE_RUN_REASON, ReviewSqlDialog, applyResultText, mayHaveRunWarning, rowStatementLabels } from '../components/ReviewSqlDialog';
import type { ApplyResultText } from '../components/ReviewSqlDialog';
import { knownNoTransactions, noteNoTransactions, perStatementConfirmText, readTableEngine, rowApplyMode, thrownApplyMayHaveRun } from '../sql/applyMode';
import type { RowApplyMode } from '../sql/applyMode';
import { applyHistoryEntries } from '../sql/applyHistory';
import { guardLayouts, layoutRulesFor } from '../sql/gridLayout';
import { registerStagedCount } from '../sql/stagedGuard';
import {
	RowEditError,
	buildRowStatements,
	changesFromForm,
	describeRowEdit,
	dropKeys,
	editFormFields,
	emptyRowEdits,
	pendingCell,
	pendingOf,
	rowEditCounts,
	rowEditGate,
	rowKey,
	settledCount,
	stageDelete,
	stageInsert,
	stageUpdate,
	uncheckedColumns,
	unstage,
	valuesFromForm,
} from '../sql/rowEdits';
import type { FormField, PendingCell, RowEditTarget, RowEdits, RowValues } from '../sql/rowEdits';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TableDataView} component. */
export interface TableDataViewProps {
	/** The connection the table lives on. */
	endpoint: SqlEndpoint;
	/** The table to browse. */
	table: string;
	/**
	 * Whether the connection can run statements. False = schema only: the
	 * browser sends no page, count or estimate statement (default true).
	 */
	executeAllowed?: boolean;
	/** Filter chips the page opens with (a foreign key's "Show rows"). */
	presetFilters?: readonly FilterChip[];
	/**
	 * Bump this after a write to the table (a staged apply, say): the cached
	 * totals are forgotten and the current page is requested again, so the
	 * pager does not keep an old count. The catalog estimate is kept.
	 */
	countEpoch?: number;
	/** Opens another table's Data page with chips preset; absent = no "Show rows". */
	onOpenTable?: (table: string, chips: FilterChip[]) => void;
}

/** What the count line says when the pager's total is not an exact count. */
type CountNote = { kind: 'estimate'; rows: number } | { kind: 'more'; estimate: number | null } | null;

/** An apply the user is about to confirm (or confirm again without a transaction). */
interface ApplyAsk {
	/** The statements, built when Apply was chosen. */
	statements: SqlApplyStatement[];
	/** The staged change each statement came from (its key), in the same order. */
	keys: string[];
	/** What the confirmation may promise, and what Apply asks for. */
	mode: RowApplyMode;
	/** One line per change, for the confirmation. */
	lines: string[];
	/** How many of the changes are deletes. */
	deletes: number;
}

/** The row drawer's state: a snapshot of the page the row was clicked on. */
interface OpenRow {
	/** The page's rows as fetched (the grid is handed copies). */
	rows: Record<string, unknown>[];
	/** Index of the open row. */
	index: number;
	/** Rows before the page. */
	offset: number;
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

	// The count line: the estimate or "more rows" note with its button.
	countNote: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		margin: '0 0 8px',
		fontSize: 12,
		opacity: 0.85,
	} as CSSProperties,

	// The load-failure banner sits above the grid, inside the body padding.
	banner: {
		marginBottom: 8,
	} as CSSProperties,

	// The database's own words under an apply's outcome.
	said: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11.5,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		margin: '6px 0 0',
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

/**
 * Render a cell of a staged row: a tint, plus a mark that does not rely on
 * colour (an edited value leads with "✎" and says what it was; a deleted row
 * is struck through and says "Deleted" in its first column).
 *
 * @param mark - What is staged for the cell's row (sql/rowEdits.ts pendingCell).
 * @param value - The value the database returned.
 * @param first - Whether this is the row's first column.
 * @returns The cell element.
 */
function pendingCellEl(mark: PendingCell | null, value: unknown, first: boolean): HTMLElement {
	if (mark === null) return dataCellEl(value);
	const el = document.createElement('span');
	el.style.display = 'block';
	// A light tint the value stays readable on, in either theme.
	el.style.background = 'color-mix(in srgb, var(--rr-color-info) 12%, transparent)';
	if (mark.kind === 'deleted') {
		el.style.textDecoration = 'line-through';
		el.title = 'Deleted (not saved until Apply)';
		el.setAttribute('aria-description', 'Staged for deletion');
		if (first) el.append('Deleted · ');
		el.append(dataCellEl(value));
	} else if (mark.kind === 'edited') {
		const was = mark.was === null || mark.was === undefined ? 'NULL' : typeof mark.was === 'object' ? JSON.stringify(mark.was) : String(mark.was);
		el.title = `Edited, was ${was} (not saved until Apply)`;
		el.setAttribute('aria-description', `Edited, was ${was}`);
		el.append('✎ ', dataCellEl(mark.value));
	} else {
		el.append(dataCellEl(value));
	}
	return el;
}

/**
 * A row's key, or null when it cannot be read exactly (sql/rowEdits.ts rowKey).
 *
 * @param target - The table.
 * @param row - The pristine row.
 * @returns The key, or null.
 */
function keyOrNull(target: RowEditTarget, row: RowValues): string | null {
	try {
		return rowKey(target, row);
	} catch {
		return null;
	}
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
export const TableDataView: React.FC<TableDataViewProps> = ({ endpoint, table, executeAllowed = true, presetFilters, countEpoch, onOpenTable }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);
	const executeState = useExecuteState(endpoint.key);
	// The prop and the per-connection state both have to allow statements (unknown counts as allowed).
	const sendAllowed = executeAllowed && executeState !== 'off';

	// Last page-load failure, surfaced as a banner. The grid keeps showing the
	// previous rows on failure, so without this the error is invisible.
	const [loadError, setLoadError] = useState<string | null>(null);

	// The grid's current sorters. Read from the page requests themselves —
	// remote sorting is the only way sorters reach here.
	const [gridSort, setGridSort] = useState<SortChip[]>([]);

	const gridRef = useRef<IDataGridHandle>(null);

	// Filter chips. The ref is what a page request reads, so changing a chip
	// does not change `fetchPage`'s identity (which would rebuild the grid);
	// the effect below asks the grid for page 1 again.
	const [chips, setChipsState] = useState<FilterChip[]>(() => [...(presetFilters ?? [])]);
	const chipsRef = useRef<FilterChip[]>(chips);
	const setChips = useCallback((next: FilterChip[]): void => {
		chipsRef.current = next;
		setChipsState(next);
	}, []);
	const chipsMounted = useRef(false);
	useEffect(() => {
		// The first fetch already reads the preset chips.
		if (!chipsMounted.current) {
			chipsMounted.current = true;
			return;
		}
		gridRef.current?.refetch({ resetPage: true });
	}, [chips]);

	// What is known about this table's size and the total shown for the
	// current filter (see sql/estimate.ts). "Count exactly" sets the flag the
	// next request reads.
	const countRef = useRef<CountCache>(emptyCountCache(table));
	const forceExactRef = useRef(false);
	const [countNote, setCountNote] = useState<CountNote>(null);

	// A write changed the table: forget the totals and ask for the page again.
	const epochSeen = useRef(countEpoch);
	useEffect(() => {
		if (epochSeen.current === countEpoch) return;
		epochSeen.current = countEpoch;
		countRef.current = invalidateTotals(countRef.current);
		gridRef.current?.refetch();
	}, [countEpoch]);

	// This page's own Apply is a write too: it bumps its own epoch, and the
	// same happens.
	const [writeEpoch, setWriteEpoch] = useState(0);
	useEffect(() => {
		if (writeEpoch === 0) return;
		countRef.current = invalidateTotals(countRef.current);
		gridRef.current?.refetch();
	}, [writeEpoch]);

	// The page the grid shows, for the row drawer: the rows as fetched, and
	// the copies the grid was handed (Tabulator writes into those).
	const pageRef = useRef<{ rows: Record<string, unknown>[]; gridRows: Record<string, unknown>[]; offset: number }>({ rows: [], gridRows: [], offset: 0 });
	const [openRow, setOpenRow] = useState<OpenRow | null>(null);

	// Stale-response guard. Two page requests can be in flight (a fast typist
	// on the search box, a double page click), and the grid applies whichever
	// resolves LAST — so a slow earlier answer can overwrite a newer one. Each
	// request takes a sequence number; a request that has been superseded by
	// the time it resolves adopts the newest answer instead of landing its own.
	const seqRef = useRef(0);
	const newestRef = useRef<Promise<IDataGridPage<Record<string, unknown>>> | null>(null);

	// The same rule, carried down to the session (port of 740b69c6d): each page
	// request takes a ticket, which the next request (or closing the view)
	// expires. The session then sends nothing more for a superseded request,
	// its one retry after a restart included, and its late answer is dropped.
	const [generation] = useState(createGeneration);
	useEffect(() => () => generation.invalidate(), [generation]);

	// The row drawer's foreign-key lookups have a ticket sequence of their own:
	// opening another key expires the lookup before it, and a page request's
	// ticket never expires a lookup (nor the other way round).
	const [lookupGeneration] = useState(createGeneration);
	useEffect(() => () => lookupGeneration.invalidate(), [lookupGeneration]);

	// The table's reflected schema drives columns, search targets, and the
	// default sort (primary key).
	const tableDef = snapshot.schema?.tables?.[table] ?? null;
	const dialect = snapshot.dialect;

	const graph = useMemo(() => buildRelationGraph(snapshot.schema), [snapshot.schema]);

	// ── Staged edits ─────────────────────────────────────────────────────────

	const editTarget = useMemo<RowEditTarget | null>(() => (tableDef ? { dialect, table, def: tableDef } : null), [dialect, table, tableDef]);
	const editGate = rowEditGate({ dialect, def: tableDef, table, executeState, ready: env.ready });
	const [edits, setEdits] = useState<RowEdits>(emptyRowEdits);
	const counts = rowEditCounts(edits);
	// The formatter reads these (its identity must not change, or the grid rebuilds).
	const editsRef = useRef<RowEdits>(edits);
	const targetRef = useRef<RowEditTarget | null>(editTarget);
	// The new-row form (its fields), an apply being confirmed, the per-statement
	// question after a refusal for want of transactions, Discard's question,
	// Review SQL, and the last apply's outcome.
	const [newRow, setNewRow] = useState<{ fields: readonly FormField[]; error: string | null } | null>(null);
	const [applyAsk, setApplyAsk] = useState<ApplyAsk | null>(null);
	const [noTransactionAsk, setNoTransactionAsk] = useState<{ reason: string; ask: ApplyAsk } | null>(null);
	const [discardAsk, setDiscardAsk] = useState(false);
	const [review, setReview] = useState<{ statements: SqlApplyStatement[]; mode: RowApplyMode } | null>(null);
	const [applying, setApplying] = useState(false);
	const [applyOutcome, setApplyOutcome] = useState<ApplyResultText | null>(null);
	const [editProblem, setEditProblem] = useState<string | null>(null);
	// The last apply may have run (its answer never came, review P4 R2-I1):
	// Apply waits until Review SQL was opened again ('blocked' -> 'reviewed'),
	// and both the review and the confirmation say rows may already be saved.
	const [uncertain, setUncertain] = useState<'blocked' | 'reviewed' | null>(null);
	// The engine (in the dev tool, the sidebar) went away during the apply (R2-M3).
	const [lostDuringApply, setLostDuringApply] = useState(false);
	// A MySQL table's storage engine, read once (undefined: not read yet).
	const engineRef = useRef<string | null | undefined>(undefined);

	/**
	 * Mark one grid cell. The grid's row object is matched by position to the
	 * pristine row it was copied from (Tabulator writes into its own copies).
	 *
	 * @param cell - The cell.
	 * @param column - Its column.
	 * @param first - Whether it is the row's first column.
	 * @returns The cell element.
	 */
	const markCell = useCallback((cell: GridCellComponent, column: string, first: boolean): HTMLElement => {
		const { rows, gridRows } = pageRef.current;
		const position = gridRows.indexOf(cell.getRow().getData() as Record<string, unknown>);
		const source = position >= 0 ? rows[position] : undefined;
		const target = targetRef.current;
		const mark = source && target ? pendingCell(editsRef.current, target, source, column) : null;
		return pendingCellEl(mark, cell.getValue(), first);
	}, []);

	// The workbench asks before another table's data replaces this page while
	// changes are staged (sql/stagedGuard.ts).
	useEffect(() => registerStagedCount(endpoint.key, () => editsRef.current.entries.length), [endpoint.key]);

	// The marks follow the staged changes: re-run the formatters.
	useEffect(() => {
		editsRef.current = edits;
		targetRef.current = editTarget;
		try {
			gridRef.current?.table?.getRows().forEach((row) => row.reformat());
		} catch {
			// Not rendered yet: the first render formats with these refs.
		}
	}, [edits, editTarget]);

	// The engine (in the dev tool, the sidebar) went away while an apply was
	// out: its outcome is unknown from now on, said at once rather than after
	// the call's whole timeout. A reply that still arrives replaces this.
	useEffect(() => {
		if (!applying || env.ready) return;
		setLostDuringApply(true);
		setUncertain('blocked');
		setApplyOutcome({ variant: 'warning', title: 'Lost the connection while applying.', detail: 'The outcome is unknown until it is back; check the data then. The changes stay staged.', message: null });
		announce('Lost the connection while applying. The outcome is unknown.');
	}, [applying, env.ready]);

	// Grid columns straight from the reflected schema.
	const columns = useMemo<GridColumnDefinition[]>(() => {
		if (!tableDef) return [];
		const pk = new Set(tableDef.primary_key ?? []);
		const firstColumn = tableDef.columns[0]?.column;
		return tableDef.columns.map((col) => {
			const fk = fkMarker(graph, table, col.column);
			return {
				title: col.column,
				field: col.column,
				rrType: /int|dec|num|float|double/i.test(col.type) ? 'number' : 'string',
				rrDefault: true,
				rrDescription: `${col.type}${pk.has(col.column) ? ' - primary key' : ''}${fk ? ` ${fk}` : ''}`,
				headerSort: true,
				formatter: (cell: GridCellComponent) => markCell(cell, col.column, col.column === firstColumn),
			} satisfies GridColumnDefinition;
		});
	}, [tableDef, graph, table, markCell]);
	// Saved layouts keep no width for a flexible column (sql/gridLayout.ts), so a
	// grid built while hidden can never freeze one at 40 px.
	const gridLayouts = useMemo(() => guardLayouts(env.gridPersistence, layoutRulesFor(columns)), [env.gridPersistence, columns]);

	/**
	 * Run a bound SELECT for the row drawer's foreign-key links, on the
	 * lookups' own ticket sequence.
	 *
	 * @param sql - The statement.
	 * @param params - Its bind values.
	 * @returns The rows.
	 */
	const lookup = useCallback(async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
		const ticket = lookupGeneration.next();
		const result = await env.getSession(endpoint).execute(sql, { params, idempotent: true, generation: ticket });
		return result.rows;
	}, [env, endpoint, lookupGeneration]);

	/**
	 * REMOTE page fetcher: the page SELECT, plus whatever the count planner says
	 * the total needs (nothing for another page of a counted filter, the
	 * catalog estimate for a big unfiltered table, one extra row for a big
	 * filtered one, an exact COUNT otherwise). Every filter, chip and search
	 * value is bound as a `$n` parameter.
	 *
	 * @param req - The grid's page request.
	 * @returns The page rows and the matching total.
	 */
	const fetchPage = useCallback((req: IDataGridPageRequest): Promise<IDataGridPage<Record<string, unknown>>> => {
		setGridSort(req.sort.map((s) => ({ field: s.field, dir: s.dir })));
		const seq = ++seqRef.current;
		// The banner describes ONE request. A new search, sort or page is a
		// different question, so the previous answer's failure stops being
		// shown the moment this one starts rather than the moment it lands.
		setLoadError(null);
		const ticket = generation.next();

		const run = async (): Promise<{ page: IDataGridPage<Record<string, unknown>>; note: CountNote; source: Record<string, unknown>[] }> => {
			const empty = { page: { rows: [], total: 0 }, note: null, source: [] };
			if (!env.ready || !tableDef) return empty;
			const session = env.getSession(endpoint);
			const exec = (sql: string, params: unknown[]) => session.execute(sql, { params, idempotent: true, generation: ticket });
			if (countRef.current.table !== table) countRef.current = emptyCountCache(table);

			let stmts = buildPageStatements(dialect, table, tableDef, req, { chips: chipsRef.current });
			const key = countKey(table, stmts);
			// Read, not cleared: "Count exactly" survives a request that is
			// replaced or fails, and is cleared where the exact total lands.
			const forceExact = forceExactRef.current;
			// A write after this point invalidates the totals; this request's
			// total is then out of date and must not land (see applyTotalIfCurrent).
			const epoch = countRef.current.epoch;
			const probe = estimateStatement(dialect, table);
			const countReq = { key, filtered: stmts.where !== '', executeAllowed: sendAllowed, forceExact, canProbe: probe !== null };

			// A schema-only node runs nothing, so nothing is sent.
			let plan = planCount(countRef.current, countReq);
			if (plan === 'none') return empty;

			// The table's size is read once from the catalog; no estimate means
			// an exact count. A catalog the role cannot read is the same answer.
			if (plan === 'probe' && probe) {
				const settled = applyProbeResult(
					countRef.current,
					await exec(probe.sql, probe.params).then(
						(r) => ({ rows: r.rows }),
						// A probe replaced by a newer request says nothing about the
						// table: do not cache "no estimate" for it, just stop.
						() => ({ error: true as const, superseded: !ticket.isCurrent() }),
					),
				);
				if (!settled) throw new Error('superseded');
				countRef.current = settled;
				plan = planCount(countRef.current, countReq);
			}

			// A big filtered table is not counted: ask for one row past the page.
			if (plan === 'overfetch') {
				stmts = buildPageStatements(dialect, table, tableDef, req, { chips: chipsRef.current, overfetch: true });
				const result = await exec(stmts.select, stmts.params);
				const over = overfetchPage(result.rows, req.page, req.size);
				return {
					page: { rows: over.rows.map((r) => ({ ...r })), total: over.total },
					note: over.hasMore ? { kind: 'more', estimate: countRef.current.estimate ?? null } : null,
					source: over.rows,
				};
			}

			// Page rows (+ the exact total over the same WHERE, when planned). The
			// statements are independent, so one round trip. Both are SELECTs, so
			// they opt in to the session's one retry, which follows only a
			// TASK_STOPPED refusal raised before the statement reaches the node
			// (the task may be restarting since this view last paged).
			const [pageResult, countResult] = await Promise.all([
				exec(stmts.select, stmts.params),
				plan === 'count' ? exec(stmts.count, stmts.params) : Promise.resolve(null),
			]);

			let total: number;
			let note: CountNote = null;
			if (plan === 'count') {
				total = Number((countResult?.rows[0] as { total?: unknown } | undefined)?.total ?? pageResult.rows.length);
				forceExactRef.current = false;
				countRef.current = applyTotalIfCurrent(countRef.current, epoch, key, total, true);
			} else if (plan === 'estimate') {
				total = countRef.current.estimate ?? pageResult.rows.length;
				countRef.current = applyTotalIfCurrent(countRef.current, epoch, key, total, false);
				note = { kind: 'estimate', rows: total };
			} else {
				// Another page of a filter already counted.
				total = countRef.current.total ?? pageResult.rows.length;
				if (!countRef.current.exact) note = { kind: 'estimate', rows: total };
			}
			// The grid is handed copies: Tabulator writes a key into each row
			// object for every column it renders, so a row it has seen is not
			// a record of the result's columns.
			return { page: { rows: pageResult.rows.map((r) => ({ ...r })), total }, note, source: pageResult.rows };
		};

		const attempt = run();
		// `newest` is assigned BEFORE any await settles, so a superseded
		// request always finds the newer chain here — which in turn resolves
		// to the newest of all (each link applies the same rule).
		const chain = attempt.then(
			({ page, note, source }) => {
				if (seq !== seqRef.current) return newestRef.current ?? page;
				setLoadError(null);
				setCountNote(note);
				pageRef.current = { rows: source, gridRows: page.rows, offset: (req.page - 1) * req.size };
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
	}, [env, endpoint, table, tableDef, dialect, generation, sendAllowed]);

	/**
	 * Count the rows exactly (the user asked, after an estimate or a "more
	 * rows" page) and show the current page again with the exact total.
	 */
	const countExactly = useCallback((): void => {
		forceExactRef.current = true;
		gridRef.current?.refetch();
	}, []);

	/**
	 * Open the row drawer on a clicked row. The grid reports its own row
	 * object; the drawer reads the pristine copy of the same position.
	 *
	 * @param row - The row the grid reports.
	 */
	const handleRowClick = useCallback((row: Record<string, unknown>): void => {
		const { rows, gridRows, offset } = pageRef.current;
		const index = gridRows.indexOf(row);
		if (index >= 0 && rows[index]) setOpenRow({ rows, index, offset });
		else setOpenRow({ rows: [row], index: 0, offset });
	}, []);

	/**
	 * Mirror a removed sort chip onto the grid's sorters; the grid re-requests.
	 *
	 * @param next - The sorters that remain.
	 */
	const handleSortChange = useCallback((next: SortChip[]): void => {
		const grid = gridRef.current?.table;
		if (!grid) return;
		if (next.length === 0) grid.clearSort();
		else grid.setSort(next.map((s) => ({ column: s.field, dir: s.dir })));
	}, []);

	/**
	 * Surface a page-load failure (the grid itself only shows a transient
	 * toast and keeps the previous rows on screen).
	 *
	 * @param error - The error the page fetcher rejected with.
	 */
	const handleLoadError = useCallback((error: Error): void => {
		setLoadError(error.message || String(error));
		noteExecuteFailure(endpoint.key, error.message || String(error));
	}, [endpoint.key]);

	// ── Staging (nothing is written until Apply) ─────────────────────────────

	/**
	 * Stage a change, or say why it was refused.
	 *
	 * @param change - Builds the next staged changes (throws RowEditError with the reason).
	 * @returns The reason it was refused, or null.
	 */
	const stage = (change: () => RowEdits): string | null => {
		if (applying) return 'An apply is running.';
		try {
			const next = change();
			setEdits(next);
			setApplyOutcome(null);
			announce(`Staged. ${pendingCountText(rowEditCounts(next).total)}.`);
			return null;
		} catch (error) {
			if (error instanceof RowEditError) return error.message;
			throw error;
		}
	};

	const pendingOfRow = (row: Record<string, unknown>) => {
		const key = editTarget ? keyOrNull(editTarget, row) : null;
		return key === null ? undefined : pendingOf(edits, key);
	};

	const editing: RecordEditingProps | null = editTarget ? {
		disabledReason: applying ? 'An apply is running.' : editGate,
		busy: applying,
		formFor: (row) => editFormFields(editTarget, row, pendingOfRow(row)),
		stagedLine: (row) => {
			const edit = pendingOfRow(row);
			return edit ? describeRowEdit(edit, editTarget) : null;
		},
		isDeleted: (row) => pendingOfRow(row)?.kind === 'delete',
		stage: (row, before, after) => stage(() => stageUpdate(edits, editTarget, row, changesFromForm(before, after))),
		remove: (row) => stage(() => stageDelete(edits, editTarget, row)),
		undo: (row) => {
			const key = keyOrNull(editTarget, row);
			if (key !== null && !applying) setEdits(unstage(edits, key));
		},
	} : null;

	/**
	 * What an apply may promise here: reads a MySQL table's storage engine
	 * once (as a read), then asks sql/applyMode.ts.
	 *
	 * @returns The mode.
	 */
	const applyMode = async (): Promise<RowApplyMode> => {
		if (dialect === 'mysql' && engineRef.current === undefined) engineRef.current = await readTableEngine(env.getSession(endpoint), table);
		return rowApplyMode(dialect, { engine: engineRef.current ?? null, noTransactions: knownNoTransactions(endpoint.key, snapshot.refreshedAt) });
	};

	/**
	 * The statements for the staged changes, or null (the reason is shown).
	 *
	 * @returns The statements.
	 */
	const statementsNow = (): SqlApplyStatement[] | null => {
		if (!editTarget) return null;
		try {
			setEditProblem(null);
			return buildRowStatements(edits, editTarget);
		} catch (error) {
			if (!(error instanceof RowEditError)) throw error;
			setEditProblem(error.message);
			return null;
		}
	};

	const openReview = async (): Promise<void> => {
		const statements = statementsNow();
		if (!statements) return;
		// Reviewing again is what lets Apply run after an apply that may have run.
		if (uncertain === 'blocked') setUncertain('reviewed');
		setReview({ statements, mode: await applyMode() });
	};

	const askApply = async (): Promise<void> => {
		const statements = statementsNow();
		if (!statements || !editTarget) return;
		const mode = await applyMode();
		setApplyAsk({ statements, keys: edits.entries.map((edit) => edit.key), mode, lines: edits.entries.map((edit) => describeRowEdit(edit, editTarget)), deletes: counts.deleted });
	};

	/**
	 * Send the confirmed apply, record each statement in history, drop what
	 * was settled, and refetch. A refusal for want of transactions applied
	 * nothing: it asks again in the per-statement words.
	 *
	 * @param ask - What was confirmed.
	 * @param atomic - Ask for one transaction.
	 */
	const runApply = async (ask: ApplyAsk, atomic: boolean): Promise<void> => {
		setApplying(true);
		setApplyOutcome(null);
		const startedAt = Date.now();
		try {
			let result;
			try {
				result = await env.getSession(endpoint).applyBatch(ask.statements, { atomic });
			} catch (error) {
				if (isTransactionsUnavailable(error)) {
					noteNoTransactions(endpoint.key, snapshot.refreshedAt);
					setNoTransactionAsk({ reason: error instanceof Error ? error.message : String(error), ask: { ...ask, mode: { atomic: false, wording: 'each' } } });
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (thrownApplyMayHaveRun(error)) {
					// No reply, and it may still have run (a lost connection, a
					// timeout): the table is read again, the changes stay staged,
					// and Apply waits for Review SQL, which says rows may be saved.
					setUncertain('blocked');
					setApplyOutcome({ variant: 'warning', title: 'The last Apply may have run.', detail: 'Its answer did not arrive, so these changes may or may not have been saved; check the data. They stay staged: open Review SQL before you apply again.', message });
					announce('The last Apply may have run. Check the data.');
					setOpenRow(null);
					setWriteEpoch((n) => n + 1);
					return;
				}
				setApplyOutcome({ variant: 'error', title: 'Nothing was applied.', detail: 'Your edits are still staged.', message });
				announce(`Apply failed: ${message}`);
				return;
			}
			const total = ask.statements.length;
			for (const entry of applyHistoryEntries(ask.statements, result, { dialect, at: startedAt, ms: Date.now() - startedAt, wording: ask.mode.wording })) env.history.record(endpoint, entry);
			// Only what was settled leaves the staged changes, by the keys that
			// were sent (a rolled-back transaction leaves them all; a change that
			// may have run never stays).
			const settled = settledCount(result, total);
			setEdits((current) => dropKeys(current, ask.keys.slice(0, settled)));
			const outcome = applyResultText(result, { total, table, at: Date.now(), wording: ask.mode.wording });
			setApplyOutcome(outcome);
			announce(outcome.title);
			// A lost commit answer leaves every change staged and maybe saved.
			setUncertain(result.failure?.unknown && result.transactional ? 'blocked' : null);
			if (result.failure === null || settled > 0 || result.failure.unknown) {
				// The table changed (or may have): the open row is stale, and the
				// page and its total are read again.
				setOpenRow(null);
				setWriteEpoch((n) => n + 1);
			}
		} finally {
			setApplying(false);
			setLostDuringApply(false);
			setApplyAsk(null);
			setReview(null);
		}
	};

	const discardAll = (): void => {
		setEdits(emptyRowEdits());
		setDiscardAsk(false);
		setReview(null);
		setEditProblem(null);
		announce('All pending changes discarded.');
	};

	const askDiscard = (): void => {
		if (discardNeedsConfirm(counts.total)) setDiscardAsk(true);
		else discardAll();
	};

	const copySql = (script: string): void => {
		if (!navigator.clipboard) {
			announce('Could not copy the SQL');
			return;
		}
		void navigator.clipboard.writeText(script).then(() => announce('Copied the SQL'), () => announce('Could not copy the SQL'));
	};

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
						Table {table} is not in the current schema snapshot. Refresh the schema from the connection overview.
					</Banner>
				</div>
			</div>
		);
	}

	// A node with execute off cannot read a single row, and neither can this
	// page: say so up front instead of showing an empty grid and a load error.
	if (executeGateReason(executeState)) {
		return (
			<div style={styles.root}>
				<ContentHeader title={table} subtitle="data" />
				<div style={styles.body}>
					<EmptyState
						icon={<DatabaseIcon />}
						title="Schema only"
						description={`${schemaOnlyExplanation(endpoint.nodeName)} Columns and keys are on the Overview; once the node is fixed, use Check again there.`}
					/>
				</div>
			</div>
		);
	}

	// Without a primary key AND without a user sort, the page SELECT carries no
	// ORDER BY at all, and SQL does not promise a stable row order between
	// calls — rows can repeat or vanish across pages. Say so rather than let
	// the pager look authoritative.
	const unordered = (tableDef.primary_key ?? []).length === 0 && gridSort.length === 0;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={table}
				subtitle={`${snapshot.schema?.database ?? ''} - browsing via ${endpoint.pipelineName} / ${endpoint.nodeId}`}
				actions={
					editTarget ? (
						<Button
							variant="secondary"
							disabled={editGate !== null || applying}
							{...(editGate !== null ? { title: editGate } : {})}
							onClick={() => setNewRow({ fields: editFormFields(editTarget, null, undefined), error: null })}
						>
							Insert row
						</Button>
					) : undefined
				}
			/>

			<div style={styles.body}>
				{loadError && (
					<div style={styles.banner}>
						{/* Clears itself on the next page that loads. */}
						<Banner variant="error">Could not load this page: {loadError}</Banner>
					</div>
				)}
				{unordered && (
					<div style={styles.note}>No primary key: page order is not guaranteed by the database</div>
				)}
				<FilterChips
					columns={tableDef.columns.map((c) => c.column)}
					chips={chips}
					onChipsChange={setChips}
					sort={gridSort}
					onSortChange={handleSortChange}
					dialect={dialect}
				/>
				{countNote && (
					<div style={styles.countNote}>
						<span>
							{countNote.kind === 'estimate'
								? `About ${countNote.rows.toLocaleString()} rows (estimate)`
								: 'More rows match. They are not counted because the table is large.'}
						</span>
						<Button variant="ghost" small onClick={countExactly}>Count exactly</Button>
					</div>
				)}
				{editProblem && (
					<div style={styles.banner}>
						<Banner variant="error">{editProblem}</Banner>
					</div>
				)}
				{applyOutcome && (
					<div style={styles.banner} role={applyOutcome.variant === 'error' ? 'alert' : 'status'}>
						<Banner variant={applyOutcome.variant}>
							<strong>{applyOutcome.title}</strong> {applyOutcome.detail}
							{applyOutcome.message && <pre style={styles.said}>{applyOutcome.message}</pre>}
						</Banner>
					</div>
				)}
				<PendingChangesBar
					table={table}
					counts={counts}
					busy={applying}
					busyLabel={lostDuringApply ? 'Outcome unknown' : 'Applying...'}
					applyDisabledReason={editGate ?? (uncertain === 'blocked' ? MAY_HAVE_RUN_REASON : null)}
					onDiscard={askDiscard}
					onReview={() => { void openReview(); }}
					onApply={() => { void askApply(); }}
				/>
				<Card noBodyPadding fill>
					<DataGrid<Record<string, unknown>>
						ref={gridRef}
						title={table}
						columns={columns}
						fetchPage={env.ready ? fetchPage : undefined}
						remoteSort
						onRowClick={handleRowClick}
						onLoadError={handleLoadError}
						tableId={`sql-data-${endpoint.provider}`}
						persistence={gridLayouts}
						height="100%"
						emptyTitle="No rows"
						emptyDescription="The table is empty (or nothing matches the current search/filters)."
					/>
				</Card>
			</div>

			<RecordDrawer
				dialect={dialect}
				graph={graph}
				tables={snapshot.schema?.tables ?? {}}
				table={table}
				rows={openRow?.rows ?? []}
				index={openRow?.index ?? null}
				offset={openRow?.offset ?? 0}
				onIndexChange={(index) => setOpenRow((current) => (current ? { ...current, index } : current))}
				onClose={() => setOpenRow(null)}
				lookup={env.ready && sendAllowed ? lookup : null}
				onShowRows={onOpenTable}
				editing={editing}
			/>

			{newRow && editTarget && (
				<RowEditForm
					title="New row"
					subtitle={table}
					fields={newRow.fields}
					lockKeys={false}
					submitLabel="Stage new row"
					error={newRow.error}
					busy={applying}
					onSubmit={(after) => {
						const refused = stage(() => stageInsert(edits, editTarget, valuesFromForm(after)));
						setNewRow(refused === null ? null : { fields: after, error: refused });
					}}
					onCancel={() => setNewRow(null)}
				/>
			)}

			{review && (
				<ReviewSqlDialog
					table={table}
					connectionName={endpoint.nodeName}
					dialect={dialect}
					statements={review.statements}
					labels={rowStatementLabels(edits)}
					wording={review.mode.wording}
					busy={applying}
					applyDisabledReason={editGate}
					uncheckedColumns={editTarget ? uncheckedColumns(edits, editTarget) : []}
					warning={uncertain ? mayHaveRunWarning(counts.inserted) : null}
					onClose={() => setReview(null)}
					onApply={() => { void askApply(); }}
					onDiscardAll={askDiscard}
					onCopySql={copySql}
				/>
			)}

			{applyAsk && (
				<ApplyConfirmDialog
					total={applyAsk.statements.length}
					table={table}
					connection={endpoint.nodeName}
					wording={applyAsk.mode.wording}
					deletes={applyAsk.deletes}
					lines={applyAsk.lines}
					warning={uncertain ? mayHaveRunWarning(counts.inserted) : null}
					busy={applying}
					onConfirm={() => { void runApply(applyAsk, applyAsk.mode.atomic); }}
					onCancel={() => setApplyAsk(null)}
				/>
			)}

			{noTransactionAsk && (() => {
				const words = perStatementConfirmText(noTransactionAsk.reason);
				return (
					<ConfirmDialog
						title={words.title}
						message={<div>{words.text}</div>}
						confirmLabel={applying ? 'Applying...' : words.confirmLabel}
						destructive
						confirmDisabled={applying}
						onConfirm={() => {
							const { ask } = noTransactionAsk;
							setNoTransactionAsk(null);
							void runApply(ask, false);
						}}
						onCancel={() => setNoTransactionAsk(null)}
					/>
				);
			})()}

			{discardAsk && (
				<ConfirmDialog
					title="Discard pending changes?"
					message={discardConfirmText(counts.total)}
					confirmLabel="Discard"
					destructive
					onConfirm={discardAll}
					onCancel={() => setDiscardAsk(false)}
				/>
			)}
		</div>
	);
};

export default TableDataView;
