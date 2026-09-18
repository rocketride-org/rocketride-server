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
//
// The runner's three load-bearing honesty rules, all of which come from how
// the node actually executes (packages/ai/.../db_instance_base.py):
//
//   1. ONE STATEMENT PER CALL, EACH IN ITS OWN TRANSACTION. A buffer is split
//      client-side and sent statement by statement; plain `execute` wraps each
//      call in its own `engine.begin()`. A batch that fails on statement 3
//      therefore leaves 1 and 2 COMMITTED, and the status strip and the error
//      banner both say so.
//
//   2. THERE IS NO CANCEL. Nothing in the tool protocol stops a running
//      statement, so "Stop waiting" is exactly that: the run sequence is
//      bumped so the late answer is ignored, and the banner says the database
//      may still be running it.
//
//   3. TRANSACTION CONTROL DOES NOTHING HERE. `BEGIN` / `COMMIT` / `ROLLBACK`
//      would each land in a separate autocommit call, so they are refused
//      before anything is sent rather than run into a false sense of safety.
//
// The confirmation dialog is likewise a TEXT CHECK and says so in its own
// words; it prevents nothing and is not called a safe mode anywhere.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection, usePrefs } from 'shell';
import type { GridCellComponent, GridColumnDefinition } from 'shell';
import { Banner, Button, Card, CardDataGrid, ConfirmDialog, ContentHeader, EmptyState, StatusBadge, ToggleGroup, commonStyles, monoEl, mutedEl } from 'shell';
import type { ISqlEndpoint, SqlDialect } from '../connect';
import { getSession, useSchema } from '../schema/schemaStore';
import SqlEditor from '../components/SqlEditor';
import type { IDecorationRange, IEditorCursorState, ISqlEditorHandle } from '../components/SqlEditor';
import StatementStrip from '../components/StatementStrip';
import CellInspector from '../components/CellInspector';
import HistoryPanel from '../components/HistoryPanel';
import ExplainPanel from '../components/ExplainPanel';
import { announce } from '../a11y/announce';
import { splitStatements, splitStatementsIn, statementAtOffset } from '../sql/split';
import { classifyStatement, patternCheck } from '../sql/classify';
import type { IPatternFinding } from '../sql/classify';
import { applyRowLimit, formatBatchOutcome, formatElapsed, formatPriorStatements, hasStatementInFlight, leadingVerb } from '../sql/batch';
import type { IStatementRun, RunOutcome } from '../sql/batch';
import {
	ALLOW_EXECUTE_OFF_TEXT,
	DATABASE_SAID_LABEL,
	GENERIC_ERROR_TEXT,
	TRANSACTION_REFUSAL_TEXT,
	describeFailure,
	maxRowsText,
} from '../sql/failure';
import type { IFailureNotice } from '../sql/failure';
import { inferColumnTypes } from '../sql/resultTypes';
import { buildCompletionModel } from '../sql/completion';
import { buildExplain } from '../sql/explain';
import { emitRun } from '../history/runEvents';
import type { IHistoryEntry } from '../history/types';
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
	/** Text to seed the editor with (a generated query, a reloaded entry). */
	initialSql?: string;
	/** `generated` marks SQL the app wrote, which is previewed before it runs. */
	origin?: 'generated';
}

/**
 * One statement to send.
 *
 * The position fields are OPTIONAL because not every run comes from the
 * editor: a rerun from the history drawer has no place in the buffer, and
 * inventing line 1 for it would decorate and name unrelated text.
 */
interface IRunTarget {
	/** The statement text. */
	sql: string;
	/** Start offset in the editor buffer, when it has one. */
	start?: number;
	/** End offset in the editor buffer, when it has one. */
	end?: number;
	/** One-based first line, when it has one. */
	startLine?: number;
	/** One-based last line, when it has one. */
	endLine?: number;
}

/** A pending pattern-check confirmation, and the resolver waiting on it. */
interface IPatternPrompt {
	/** The statement the check fired on. */
	run: IStatementRun;
	/** What the check saw. */
	finding: IPatternFinding;
}

/** A failed statement, and where in the batch it was. */
interface IFailureState {
	/** What the failure means and what to show. */
	notice: IFailureNotice;
	/** Zero-based index of the statement that failed. */
	index: number;
	/** Line range of the failing statement; '' when it has no editor position. */
	lines: string;
	/** What is true of everything before the failure ('' when it failed first). */
	prior: string;
}

/** Row-limit options offered by the header toggle. */
const LIMIT_OPTIONS = ['200', '1000', 'All'] as const;

/** Prefs key holding the per-connection pattern-check switch. */
const PATTERN_CHECK_PREF = 'sql.patternChecks';

/** How long a run must last before "Stop waiting" is offered. */
const STOP_WAITING_AFTER_MS = 1000;

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

	// The pre-run truth line under the editor.
	willRun: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		paddingTop: 6,
	} as CSSProperties,

	// Result meta line in the grid card's action slot.
	meta: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Verbatim driver text inside the error banner.
	verbatim: {
		margin: '6px 0 0',
		padding: 8,
		maxHeight: 180,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,

	// Statement excerpt inside the confirmation dialog.
	excerpt: {
		margin: '8px 0',
		padding: 8,
		maxHeight: 120,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Describe a line range the way the pre-run line and the strip do.
 *
 * @param from - First line (one-based), or undefined for a statement with no
 *               position in the editor (a rerun from the history drawer).
 * @param to - Last line (one-based).
 * @returns e.g. `line 4` or `lines 4–6`; '' when there is no position.
 */
function lineRange(from?: number, to?: number): string {
	if (from === undefined || to === undefined) return '';
	return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/**
 * Clock time for the meta and history lines.
 *
 * @param at - Unix ms.
 * @returns `HH:MM`.
 */
function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Why Explain cannot run on a statement, or null when it can.
 *
 * Both the button's disabled state and the click/keybinding path go through
 * this, so they can never offer different answers — and the keybinding, which
 * has no tooltip to read, announces the same sentence the button would show.
 *
 * @param dialect - The engine dialect.
 * @param sql - The statement exactly as it would be sent.
 * @param connected - Whether the shell connection is live.
 * @returns The reason, or null when the statement can be explained.
 */
function explainRefusal(dialect: SqlDialect, sql: string, connected: boolean): string | null {
	if (!connected) return 'Not connected.';
	if (!sql.trim()) return 'Write a statement to explain.';
	if (buildExplain(dialect, sql) === null) return `EXPLAIN is not available for this engine (${dialect}).`;
	return null;
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

/**
 * Turn a finished statement into the history entry the drawer stores.
 *
 * @param run - The finished statement.
 * @returns The entry.
 */
function toHistoryEntry(run: IStatementRun): IHistoryEntry {
	const outcome: IHistoryEntry['outcome'] =
		run.outcome === 'rows' || run.outcome === 'affected' || run.outcome === 'abandoned' ? run.outcome : 'error';
	return {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		sql: run.sql,
		at: Date.now() - (run.ms ?? 0),
		ms: run.ms ?? 0,
		outcome,
		rows: run.outcome === 'rows' ? run.rows?.length ?? 0 : undefined,
		affected: run.outcome === 'affected' ? run.affected ?? 0 : undefined,
		error: run.error,
		kind: run.kind,
		// Only a limit the APP appended is reported; a statement's own LIMIT is
		// already visible in the stored text.
		limit: run.limitState === 'applied' ? run.limitApplied ?? undefined : undefined,
	};
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * One SQL editor document: Monaco on top, the selected statement's rows in a
 * LOCAL CardDataGrid below.
 *
 * Run sends the selection, or the statement the caret is in; Run all sends
 * every statement in order and stops at the first error. What a run WOULD send
 * is named in text under the editor before the key is pressed, because a
 * decoration alone is not an answer for anyone who cannot see it.
 *
 * @param props - {@link IQueryViewProps}.
 * @returns The query document element.
 */
export const QueryView: React.FC<IQueryViewProps> = ({ endpoint, label, initialSql, origin }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);
	const prefs = usePrefs();

	// ── Editor + run state ───────────────────────────────────────────────────
	const [sql, setSql] = useState(initialSql ?? '');
	const [limit, setLimit] = useState<string>('1000');
	const [running, setRunning] = useState(false);
	const [runs, setRuns] = useState<IStatementRun[]>([]);
	const [selectedRun, setSelectedRun] = useState<number | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [cursor, setCursor] = useState<IEditorCursorState>({ offset: 0, selectionText: '', selectionStart: 0, selectionEnd: 0 });
	const [lastRun, setLastRun] = useState<{ index: number; at: number; start?: number; end?: number } | null>(null);

	// ── Notices ──────────────────────────────────────────────────────────────
	const [failure, setFailure] = useState<IFailureState | null>(null);
	const [showVerbatim, setShowVerbatim] = useState(false);
	const [abandonNotice, setAbandonNotice] = useState<string | null>(null);
	const [txRefused, setTxRefused] = useState(false);
	const [allowExecuteOff, setAllowExecuteOff] = useState(false);
	const [canStop, setCanStop] = useState(false);
	const [untouchedGenerated, setUntouchedGenerated] = useState(origin === 'generated');

	// ── Drawers + dialogs ────────────────────────────────────────────────────
	const [historyOpen, setHistoryOpen] = useState(false);
	const [explainOpen, setExplainOpen] = useState(false);
	const [explainSql, setExplainSql] = useState('');
	const [pendingLoad, setPendingLoad] = useState<string | null>(null);
	const [inspected, setInspected] = useState<{ row: Record<string, unknown>; number: number } | null>(null);
	const [patternPrompt, setPatternPrompt] = useState<IPatternPrompt | null>(null);
	const [patternChecksOn, setPatternChecksOn] = useState<boolean>(() => {
		const bag = prefs.getPref(PATTERN_CHECK_PREF) as Record<string, boolean> | undefined;
		return bag?.[endpoint.key] !== false;
	});

	// ── Refs ─────────────────────────────────────────────────────────────────
	const editorRef = useRef<ISqlEditorHandle>(null);
	// Monotonic run id. Every await re-checks it: a response whose sequence has
	// moved on belongs to a run the user abandoned and is DROPPED, never landed.
	const runSeqRef = useRef(0);
	const runningRef = useRef(false);
	const runStartedRef = useRef(0);
	const runsRef = useRef<IStatementRun[]>([]);
	const activeIndexRef = useRef(0);
	const mountedRef = useRef(true);
	const patternResolverRef = useRef<((answer: 'run' | 'always' | 'cancel') => void) | null>(null);
	const patternChecksOnRef = useRef(patternChecksOn);
	// The buffer text as of the last run or the last load: anything else in the
	// editor is unsaved work that must not be replaced without asking.
	const committedTextRef = useRef(initialSql ?? '');

	// Set on EVERY setup, not only by `useRef(true)`: under StrictMode React
	// runs setup, cleanup and setup again on the same instance, and a flag the
	// cleanup cleared would otherwise stay false for the life of that
	// instance — silently dropping every later statement from history.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			// A dialog open at unmount would otherwise leave the run loop
			// awaiting a promise nobody can settle.
			patternResolverRef.current?.('cancel');
			patternResolverRef.current = null;
		};
	}, []);
	useEffect(() => { patternChecksOnRef.current = patternChecksOn; }, [patternChecksOn]);

	const dialect = snapshot.dialect;
	const statements = useMemo(() => splitStatements(sql, dialect), [sql, dialect]);

	// Suggestions are rebuilt only when the snapshot changes, not per keystroke.
	const completion = useMemo(
		() => buildCompletionModel(snapshot.schema, snapshot.refreshedAt || Date.now()),
		[snapshot.schema, snapshot.refreshedAt],
	);

	// ── Preferences ──────────────────────────────────────────────────────────

	/**
	 * Turn the pattern check on or off for THIS connection, in the workspace
	 * prefs (server-side, per user) and in local state.
	 *
	 * @param on - Whether the check should run.
	 */
	const setPatternChecks = useCallback((on: boolean): void => {
		const bag = (prefs.getPref(PATTERN_CHECK_PREF) as Record<string, boolean> | undefined) ?? {};
		prefs.setPref(PATTERN_CHECK_PREF, { ...bag, [endpoint.key]: on });
		// Written HERE, not only by the effect that mirrors the state below:
		// the run loop resumes from `await askPatternConfirm(...)` in a
		// microtask and reads this ref for the NEXT statement, which happens
		// before React runs that passive effect. Leaving it to the effect made
		// "Run and stop asking" ask again for every further match in the batch.
		patternChecksOnRef.current = on;
		setPatternChecksOn(on);
		announce(on ? 'Pattern checks on for this connection' : 'Pattern checks off for this connection');
	}, [prefs, endpoint.key]);

	// ── Editor wiring ────────────────────────────────────────────────────────

	/**
	 * Take the editor's new text; the first edit retires the generated-preview
	 * banner and the decoration left over from the last run.
	 *
	 * @param next - The new buffer text.
	 */
	const handleChange = useCallback((next: string): void => {
		setSql(next);
		setUntouchedGenerated(false);
		setLastRun(null);
	}, []);

	// ── What a run would send ────────────────────────────────────────────────

	/**
	 * The statements the Run button would send right now: the selection when
	 * there is one, otherwise the statement holding the caret.
	 *
	 * Reads the live editor handle rather than the debounced preview state, so
	 * a keypress that lands between a caret move and its settle still sends
	 * what the user is looking at.
	 *
	 * @returns The statements to run (possibly empty).
	 */
	const currentTarget = useCallback((): IRunTarget[] => {
		const selection = editorRef.current?.getSelection();
		if (selection && selection.text.trim()) {
			// A selection is NOT necessarily one statement — `SELECT …; DELETE …`
			// can be dragged in one gesture. Sending it whole would classify it
			// by its first keyword alone, so the pattern check would never see
			// the DELETE, a trailing ROLLBACK would never be refused, and the
			// whole thing would be marked read-only and become eligible for the
			// session's retry. Split it exactly like the buffer.
			return splitStatementsIn(sql, selection.start, selection.end, dialect);
		}
		const offset = editorRef.current?.getCursorOffset() ?? cursor.offset;
		const statement = statementAtOffset(sql, offset, dialect);
		return statement ? [statement] : [];
	}, [sql, dialect, cursor.offset]);

	// The pre-run line and the editor decoration, always saying the same thing.
	const preview = useMemo((): { text: string; decorations: IDecorationRange[] } => {
		if (running) {
			const run = runs[activeIndex];
			const decorations: IDecorationRange[] = run?.start !== undefined && run.end !== undefined
				? [{ start: run.start, end: run.end, className: 'sql-ui-stmt-running' }]
				: [];
			return { text: `Running statement ${activeIndex + 1} of ${runs.length}…`, decorations };
		}
		if (cursor.selectionText.trim()) {
			const selected = splitStatementsIn(sql, cursor.selectionStart, cursor.selectionEnd, dialect);
			if (selected.length === 0) return { text: 'Will run: nothing — no statement found', decorations: [] };
			const span = lineRange(selected[0].startLine, selected[selected.length - 1].endLine);
			// Say how many, so a multi-statement selection is never mistaken for
			// a single statement before it runs.
			const count = selected.length > 1 ? `, ${selected.length} statements` : '';
			return {
				text: `Will run: selection${count} (${span})`,
				decorations: [{ start: cursor.selectionStart, end: cursor.selectionEnd, className: 'sql-ui-stmt-active' }],
			};
		}
		// An empty buffer and a buffer holding only comments are different
		// things, and the second one is the confusing one.
		if (!sql.trim()) return { text: 'Will run: nothing — editor is empty', decorations: [] };
		const statement = statements.length > 0 ? statementAtOffset(sql, cursor.offset, dialect) : null;
		if (!statement) return { text: 'Will run: nothing — no statement found', decorations: [] };
		const decorations: IDecorationRange[] = [{ start: statement.start, end: statement.end, className: 'sql-ui-stmt-active' }];
		if (lastRun?.start !== undefined && lastRun.end !== undefined && lastRun.start !== statement.start) {
			decorations.push({ start: lastRun.start, end: lastRun.end, className: 'sql-ui-stmt-last' });
		}
		const of = statements.length > 1 ? ` of ${statements.length}` : '';
		return {
			text: `Will run: statement ${statement.index + 1}${of} (${lineRange(statement.startLine, statement.endLine)})`,
			decorations,
		};
	}, [running, runs, activeIndex, cursor, sql, statements, dialect, lastRun]);

	useEffect(() => {
		editorRef.current?.setDecorations(preview.decorations);
	}, [preview]);

	// Whether a statement is at the database, which is NOT the same as the
	// batch running: `running` is already true while a pattern-check dialog
	// waits for an answer and nothing has been sent.
	const inFlight = useMemo(() => hasStatementInFlight(runs), [runs]);

	// "Stop waiting" only appears once a statement IN FLIGHT has been slow.
	// Keying this on `running` offered it while a confirmation was open, and
	// clicking it then announced that the database might still be running a
	// statement that had never been sent.
	//
	// The timer measures an uninterrupted STRETCH of statements, not each one:
	// the publish that resolves statement i and the publish that dispatches
	// i + 1 happen in the same microtask continuation, and React 18 batches
	// them into one render (the app mounts with `createRoot`,
	// packages/shell/src/bootstrap.tsx:94), so `inFlight` never observes false
	// in between and the effect does not re-run. What does reset it is a
	// confirmation dialog: nothing is at the database while one is open, so
	// the next statement starts the second again. Both are correct for what
	// the button says.
	useEffect(() => {
		if (!inFlight) {
			setCanStop(false);
			return undefined;
		}
		const timer = setTimeout(() => setCanStop(true), STOP_WAITING_AFTER_MS);
		return () => clearTimeout(timer);
	}, [inFlight]);

	// ── Pattern-check confirmation ───────────────────────────────────────────

	/**
	 * Open the confirmation dialog and wait for the answer.
	 *
	 * @param run - The statement being confirmed.
	 * @param finding - What the pattern check saw.
	 * @returns The user's choice.
	 */
	const askPatternConfirm = useCallback((run: IStatementRun, finding: IPatternFinding): Promise<'run' | 'always' | 'cancel'> => {
		return new Promise((resolve) => {
			patternResolverRef.current = resolve;
			setPatternPrompt({ run, finding });
		});
	}, []);

	/**
	 * Answer the open confirmation dialog.
	 *
	 * @param answer - The user's choice.
	 */
	const answerPattern = useCallback((answer: 'run' | 'always' | 'cancel'): void => {
		setPatternPrompt(null);
		const resolve = patternResolverRef.current;
		patternResolverRef.current = null;
		resolve?.(answer);
	}, []);

	// ── Running ──────────────────────────────────────────────────────────────

	/**
	 * Publish a finished statement to the history subscribers, but only while
	 * this document is still mounted — a closed tab must not write.
	 *
	 * @param run - The finished statement.
	 */
	const record = useCallback((run: IStatementRun): void => {
		if (!mountedRef.current) return;
		emitRun(endpoint.key, toHistoryEntry(run));
	}, [endpoint.key]);

	/**
	 * Commit a run list to state and to the ref the abandon path reads.
	 *
	 * @param next - The new run list.
	 */
	const publishRuns = useCallback((next: IStatementRun[]): void => {
		runsRef.current = next;
		setRuns(next);
	}, []);

	/**
	 * Run a list of statements in order, stopping at the first error.
	 *
	 * @param targets - The statements to send, in order.
	 */
	const runTargets = useCallback(async (targets: IRunTarget[], opts?: { fromEditor?: boolean }): Promise<void> => {
		if (!client || runningRef.current || targets.length === 0) return;

		// Transaction control cannot work through per-call autocommit, so it is
		// refused before anything is sent rather than run and misunderstood.
		if (targets.some((target) => classifyStatement(target.sql, dialect) === 'tx')) {
			// No announce(): the Banner below is already a polite live region
			// (Banner.tsx:75-76), and mirroring it would read the refusal twice.
			setTxRefused(true);
			return;
		}

		const seq = runSeqRef.current + 1;
		runSeqRef.current = seq;
		runningRef.current = true;
		setRunning(true);
		setTxRefused(false);
		setFailure(null);
		setShowVerbatim(false);
		setAbandonNotice(null);
		setUntouchedGenerated(false);
		setSelectedRun(null);
		setInspected(null);

		const list: IStatementRun[] = targets.map((target, index) => ({
			index,
			sql: target.sql,
			kind: classifyStatement(target.sql, dialect),
			verb: leadingVerb(target.sql, dialect),
			start: target.start,
			end: target.end,
			startLine: target.startLine,
			endLine: target.endLine,
			outcome: 'pending' as RunOutcome,
		}));
		publishRuns(list);

		const session = getSession(client, endpoint);
		const results = [...list];
		let failedAt = -1;

		for (let i = 0; i < results.length; i++) {
			if (runSeqRef.current !== seq) return;

			// One confirmation per matching statement, asked before it is sent.
			if (patternChecksOnRef.current) {
				const finding = patternCheck(results[i].sql, dialect);
				if (finding) {
					const answer = await askPatternConfirm(results[i], finding);
					if (runSeqRef.current !== seq) return;
					if (answer === 'cancel') {
						for (let j = i; j < results.length; j++) results[j] = { ...results[j], outcome: 'skipped' };
						publishRuns([...results]);
						break;
					}
					if (answer === 'always') setPatternChecks(false);
				}
			}

			const prepared = applyRowLimit(results[i].sql, limit, dialect);
			results[i] = { ...results[i], outcome: 'running', limitApplied: prepared.limit, limitState: prepared.state };
			publishRuns([...results]);
			setActiveIndex(i);
			activeIndexRef.current = i;
			const started = performance.now();
			runStartedRef.current = started;

			try {
				// `idempotent` gates the session's one retry with a fresh token:
				// a read may be sent twice harmlessly, a write may NOT.
				const response = await session.execute(prepared.sql, { idempotent: results[i].kind === 'read' });
				if (runSeqRef.current !== seq) return;
				const rows = response.rows ?? [];
				const affected = response.affected_rows ?? 0;
				const outcome: RunOutcome = rows.length > 0 || results[i].kind === 'read' ? 'rows' : 'affected';
				results[i] = { ...results[i], outcome, rows, affected, ms: performance.now() - started };
				publishRuns([...results]);
				record(results[i]);
			} catch (error) {
				if (runSeqRef.current !== seq) return;
				const message = error instanceof Error ? error.message : String(error);
				const notice = describeFailure(message);
				results[i] = { ...results[i], outcome: 'error', error: message, ms: performance.now() - started };
				for (let j = i + 1; j < results.length; j++) results[j] = { ...results[j], outcome: 'skipped' };
				publishRuns([...results]);
				failedAt = i;
				setFailure({
					notice,
					index: i,
					lines: lineRange(results[i].startLine, results[i].endLine),
					// Says "ran" or "committed" per the kinds that preceded the
					// failure — the sentence that stops a reader assuming the
					// batch rolled back.
					prior: formatPriorStatements(results, i),
				});
				if (notice.allowExecuteOff) setAllowExecuteOff(true);
				record(results[i]);
				break;
			}
		}

		if (runSeqRef.current !== seq) return;
		runningRef.current = false;
		setRunning(false);

		// Show the last statement that returned rows; failing that, the last
		// one that resolved at all.
		const withRows = [...results].reverse().find((run) => run.outcome === 'rows');
		const resolved = [...results].reverse().find((run) => run.outcome === 'rows' || run.outcome === 'affected');
		const shown = withRows ?? resolved ?? null;
		setSelectedRun(shown ? shown.index : null);
		if (shown) setLastRun({ index: shown.index, at: Date.now(), start: shown.start, end: shown.end });
		// Only an editor run makes the buffer "already run". A rerun from the
		// history drawer must not mark untouched editor text as run, or the
		// next Load-into-editor would silently discard it.
		if (opts?.fromEditor) committedTextRef.current = sql;
		// A statement that actually ran is the only proof the node's execute
		// gate is open again, so a successful run retires the warning.
		if (resolved) setAllowExecuteOff(false);

		// Only outcomes that have NO live region of their own are announced. A
		// failure is not one: the error Banner is an assertive alert already
		// (Banner.tsx:75-76), so announcing it here would read it twice. The
		// batch summary and the row counts live in the strip and the meta line,
		// which are ordinary text.
		if (results.length > 1) announce(`${results.length} statements: ${formatBatchOutcome(results)}`);
		else if (failedAt < 0 && shown?.outcome === 'rows') announce(`Statement returned ${(shown.rows?.length ?? 0).toLocaleString()} rows`);
		else if (failedAt < 0 && shown?.outcome === 'affected') announce(`Statement affected ${(shown.affected ?? 0).toLocaleString()} rows`);
	}, [client, dialect, endpoint, limit, sql, askPatternConfirm, publishRuns, record, setPatternChecks]);

	/** Run the selection, or the statement at the caret. */
	const runOne = useCallback((): void => { void runTargets(currentTarget(), { fromEditor: true }); }, [runTargets, currentTarget]);

	/** Run every statement in the buffer, in order. */
	const runAll = useCallback((): void => { void runTargets(splitStatements(sql, dialect), { fromEditor: true }); }, [runTargets, sql, dialect]);

	/**
	 * Stop waiting for the statement in flight.
	 *
	 * There is NO server-side cancel: this bumps the run sequence so the late
	 * answer is discarded, and says plainly that the database may still be
	 * running the statement.
	 */
	const stopWaiting = useCallback((): void => {
		if (!runningRef.current) return;
		runSeqRef.current += 1;
		runningRef.current = false;
		const ms = performance.now() - runStartedRef.current;
		setRunning(false);
		const next = runsRef.current.map((run) => {
			if (run.outcome === 'running') return { ...run, outcome: 'abandoned' as RunOutcome, ms };
			if (run.outcome === 'pending') return { ...run, outcome: 'skipped' as RunOutcome };
			return run;
		});
		publishRuns(next);
		const abandoned = next.find((run) => run.outcome === 'abandoned');
		if (abandoned) record(abandoned);
		setAbandonNotice(
			`Stopped waiting after ${(ms / 1000).toFixed(1)} s. The statement may still be running on the database; this tool cannot cancel it.`,
		);
		// The warning Banner carries this; it is a live region already.
		editorRef.current?.focus();
	}, [publishRuns, record]);

	// ── Explain, history, and loading a statement back in ────────────────────

	/**
	 * The statement a run would send, rendered exactly as it would be sent —
	 * including the header's LIMIT, so an EXPLAIN describes the real plan and
	 * not a different, unlimited statement.
	 *
	 * @returns The statement text, or '' when there is nothing to run.
	 */
	const targetSqlAsSent = useCallback((): string => {
		const [target] = currentTarget();
		if (!target) return '';
		return applyRowLimit(target.sql, limit, dialect).sql;
	}, [currentTarget, limit, dialect]);

	/**
	 * Open the plan drawer for whatever Run would send.
	 *
	 * The panel is handed the statement EXACTLY as it would run, applied LIMIT
	 * included, so the plan describes the real statement and not a different,
	 * unlimited one.
	 */
	const openExplain = useCallback((): void => {
		// The LIVE handle decides what is explained, so a caret move that has
		// not settled yet cannot send the previous statement. When it turns out
		// nothing can be explained, say why: Ctrl/Cmd+Shift+E has no tooltip,
		// and a keybinding that does nothing at all reads as a broken app.
		const sent = targetSqlAsSent();
		const refusal = explainRefusal(dialect, sent, Boolean(client) && isConnected);
		if (refusal) {
			announce(refusal);
			return;
		}
		setExplainSql(sent);
		setExplainOpen(true);
	}, [targetSqlAsSent, dialect, client, isConnected]);

	/**
	 * Whether Explain can run right now, and why not when it cannot. Derived
	 * from the settled caret rather than the live handle, because it only
	 * drives a disabled state.
	 */
	const explainState = useMemo((): { disabled: boolean; title: string } => {
		const selected = cursor.selectionText.trim()
			? splitStatementsIn(sql, cursor.selectionStart, cursor.selectionEnd, dialect)[0]?.sql ?? ''
			: '';
		const statement = selected || statementAtOffset(sql, cursor.offset, dialect)?.sql || '';
		const candidate = statement ? applyRowLimit(statement, limit, dialect).sql : '';
		const refusal = explainRefusal(dialect, candidate, Boolean(client) && isConnected);
		return {
			disabled: refusal !== null,
			title: refusal ?? "Show the database's plan for the statement Run would send (Ctrl+Shift+E)",
		};
	}, [client, isConnected, cursor, sql, dialect, limit]);

	/**
	 * Put a statement into the editor, asking first when doing so would throw
	 * away text the user has typed since the last run.
	 *
	 * @param next - The statement to load.
	 */
	const loadIntoEditor = useCallback((next: string): void => {
		const dirty = sql.trim().length > 0 && sql !== committedTextRef.current;
		if (dirty) {
			setPendingLoad(next);
			return;
		}
		committedTextRef.current = next;
		setSql(next);
		setUntouchedGenerated(false);
		setLastRun(null);
		announce('Loaded the statement into the editor');
		editorRef.current?.focus();
	}, [sql]);

	/** Replace the editor text with the statement the user confirmed. */
	const confirmLoad = useCallback((): void => {
		const next = pendingLoad;
		setPendingLoad(null);
		if (next === null) return;
		committedTextRef.current = next;
		setSql(next);
		setUntouchedGenerated(false);
		setLastRun(null);
		announce('Loaded the statement into the editor');
		editorRef.current?.focus();
	}, [pendingLoad]);

	/**
	 * Run one statement from the history drawer. The drawer has already
	 * confirmed anything that changed data last time; the pattern check still
	 * applies, because it is about this statement's text, not its past.
	 *
	 * @param entry - The history entry to run again.
	 */
	const rerunEntry = useCallback((entry: IHistoryEntry): void => {
		// No start/end/line: this statement has no place in the editor buffer.
		void runTargets([{ sql: entry.sql }]);
	}, [runTargets]);

	// ── Results ──────────────────────────────────────────────────────────────

	const displayed = selectedRun !== null ? runs[selectedRun] ?? null : null;
	const rows = displayed?.rows ?? [];

	const columnTypes = useMemo(
		() => (rows.length > 0 && displayed ? inferColumnTypes(rows, snapshot.schema, displayed.sql, dialect) : {}),
		[rows, displayed, snapshot.schema, dialect],
	);

	const columns = useMemo<GridColumnDefinition[]>(() => {
		const first = rows[0];
		if (!first) return [];
		return Object.keys(first).map((key) => {
			const info = columnTypes[key];
			return {
				title: key,
				field: key,
				rrType: info?.rrType ?? 'string',
				rrDefault: true,
				rrDescription: info ? `${key} — ${info.description}` : `Result column ${key}.`,
				headerSort: true,
				hozAlign: info?.rrType === 'number' ? 'right' : undefined,
				formatter: (cell: GridCellComponent) => resultCellEl(cell.getValue()),
			} satisfies GridColumnDefinition;
		});
	}, [rows, columnTypes]);

	/** True when at least one shown column is numeric (float-precision note). */
	const hasNumeric = useMemo(() => Object.values(columnTypes).some((info) => info.rrType === 'number'), [columnTypes]);

	/** The result meta line's parts. */
	const meta = useMemo((): { text: string; limitReached: boolean } => {
		if (!displayed) return { text: '', limitReached: false };
		const applied = displayed.limitApplied ?? null;
		const elapsed = displayed.ms === undefined ? '' : ` · ${formatElapsed(displayed.ms)}`;
		const executed = lastRun ? ` · executed ${clock(lastRun.at)}` : '';
		if (displayed.outcome === 'error') return { text: `Statement ${displayed.index + 1} failed${elapsed}`, limitReached: false };
		if (displayed.outcome === 'abandoned') return { text: `Statement ${displayed.index + 1} abandoned${elapsed}`, limitReached: false };
		if (displayed.outcome === 'affected') {
			return { text: `${(displayed.affected ?? 0).toLocaleString()} affected${executed}${elapsed}`, limitReached: false };
		}
		// Three states, because "no limit applied" on a statement that limits
		// ITSELF invites the reader to conclude the table holds exactly this
		// many rows.
		const state = displayed.limitState ?? 'none';
		const limitText = state === 'applied'
			? `limit ${(applied ?? 0).toLocaleString()}`
			: state === 'in-statement'
				? 'limit in statement'
				: 'no limit applied';
		return {
			text: `${rows.length.toLocaleString()} rows returned (${limitText})${executed}${elapsed}`,
			limitReached: state === 'applied' && applied !== null && rows.length === applied,
		};
	}, [displayed, rows.length, lastRun]);

	/** Title for the results region when there is no grid to show. */
	const emptyTitle = !displayed
		? 'No results yet'
		: displayed.outcome === 'error'
			? 'Statement failed'
			: displayed.outcome === 'abandoned'
				? 'Stopped waiting'
				: 'Statement executed';

	const batchLine = runs.length > 1 ? formatBatchOutcome(runs) : '';
	const canRun = Boolean(client) && isConnected && !running && sql.trim().length > 0;

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<div style={styles.root}>
			<ContentHeader
				title={label}
				subtitle={`${snapshot.schema?.database ?? endpoint.nodeName} · statements execute on ${endpoint.pipelineName} / ${endpoint.nodeId}`}
				actions={
					<>
						<ToggleGroup
							options={LIMIT_OPTIONS.map((option) => ({ id: option, label: option }))}
							value={limit}
							onChange={setLimit}
						/>
						<Button
							variant="ghost"
							pressed={historyOpen}
							ariaExpanded={historyOpen}
							title="Show the statements run on this connection"
							onClick={() => setHistoryOpen((open) => !open)}
						>
							History
						</Button>
						<Button
							variant="secondary"
							onClick={openExplain}
							disabled={explainState.disabled}
							ariaExpanded={explainOpen}
							title={explainState.title}
						>
							Explain
						</Button>
						{inFlight && canStop && (
							<Button variant="ghost" title="Stop waiting for the answer. This does not cancel the statement." onClick={stopWaiting}>
								Stop waiting
							</Button>
						)}
						<Button
							variant="secondary"
							onClick={runAll}
							disabled={!canRun}
							title="Run every statement in order, stop at the first error (Ctrl+Shift+Enter)"
						>
							Run all
						</Button>
						<Button
							variant="primary"
							onClick={runOne}
							disabled={!canRun}
							title="Run selection, or the statement at the cursor (Ctrl+Enter)"
						>
							{running ? 'Running…' : 'Run'}
						</Button>
					</>
				}
			/>

			<div style={styles.body}>
				{/* The node refuses to execute anything — schema browsing still works. */}
				{allowExecuteOff && <Banner variant="warning">{ALLOW_EXECUTE_OFF_TEXT}</Banner>}

				{/* SQL the app wrote, shown before it runs. */}
				{untouchedGenerated && <Banner variant="info">Generated preview — review, then Run</Banner>}

				{/* Editor. */}
				<div style={styles.editorRegion}>
					<SqlEditor
						ref={editorRef}
						value={sql}
						onChange={handleChange}
						dialect={dialect}
						onRun={runOne}
						onRunAll={runAll}
						onExplain={openExplain}
						onCursorChange={setCursor}
						completion={completion}
					/>
				</div>

				{/* The pre-run truth line: what Run would send, in words. */}
				<div style={styles.willRun}>
					<span>{preview.text}</span>
					{!patternChecksOn && (
						<Button
							variant="ghost"
							small
							title="Confirmations for unbounded UPDATE/DELETE, an UPDATE/DELETE inside a WITH clause, TRUNCATE, DROP and ALTER are off for this connection. Click to turn them on."
							onClick={() => setPatternChecks(true)}
						>
							Pattern checks off
						</Button>
					)}
				</div>

				{/* Transaction control was refused before anything was sent. */}
				{txRefused && <Banner variant="warning">{TRANSACTION_REFUSAL_TEXT}</Banner>}

				{/* The user stopped waiting; the statement may still be running. */}
				{abandonNotice && <Banner variant="warning">{abandonNotice}</Banner>}

				{/* Execution failure. */}
				{failure && (
					<Banner variant="error">
						<div>{failure.notice.generic ? GENERIC_ERROR_TEXT : failure.notice.headline}</div>
						<div>
							{`Statement ${failure.index + 1}${failure.lines ? ` (${failure.lines})` : ''}.`}
							{failure.prior && ` ${failure.prior}`}
						</div>
						{failure.notice.maxExecuteRows !== null && <div>{maxRowsText(failure.notice.maxExecuteRows)}</div>}
						{!failure.notice.generic && failure.notice.verbatim && (
							<>
								<Button
									variant="ghost"
									small
									ariaExpanded={showVerbatim}
									onClick={() => setShowVerbatim((open) => !open)}
								>
									{showVerbatim ? `Hide “${DATABASE_SAID_LABEL}”` : DATABASE_SAID_LABEL}
								</Button>
								{showVerbatim && <pre style={styles.verbatim}>{failure.notice.verbatim}</pre>}
							</>
						)}
					</Banner>
				)}

				{/* Per-statement outcomes of the last batch. */}
				{runs.length > 1 && (
					<div>
						<StatementStrip runs={runs} selected={selectedRun} onSelect={setSelectedRun} />
						{batchLine && <div style={styles.meta}>{batchLine}</div>}
					</div>
				)}

				{/* Results. */}
				<div style={styles.resultsRegion}>
					{displayed && rows.length > 0 ? (
						<Card noBodyPadding fill>
							<CardDataGrid<Record<string, unknown>>
								title="Results"
								actions={
									<span style={styles.meta}>
										{meta.text}
										{meta.limitReached && <StatusBadge variant="warning">Limit reached — more rows may exist</StatusBadge>}
										<span title="The grid's gear menu exports the rows this run returned.">Export: grid menu (gear)</span>
									</span>
								}
								columns={columns}
								data={rows}
								tableId="sql-query-results"
								paginate={false}
								height="100%"
								emptyTitle="No rows"
								emptyDescription="The statement returned no rows."
								onRowClick={(row) => setInspected({ row, number: Math.max(1, rows.indexOf(row) + 1) })}
							/>
						</Card>
					) : (
						<EmptyState
							icon={<DatabaseIcon />}
							title={emptyTitle}
							description={
								displayed
									? meta.text
									: 'Write a statement above and press Run (Ctrl+Enter). Ctrl+Shift+Enter runs every statement.'
							}
						/>
					)}
					{hasNumeric && rows.length > 0 && (
						<div style={styles.meta}>Decimal values arrive as floating point; integers above 2^53 lose precision.</div>
					)}
				</div>
			</div>

			{/* One row of the result, in full. */}
			<CellInspector
				open={inspected !== null}
				row={inspected?.row ?? null}
				rowNumber={inspected?.number ?? 0}
				rowCount={rows.length}
				subtitle={displayed ? `statement ${displayed.index + 1}${lastRun ? ` · executed ${clock(lastRun.at)}` : ''}` : ''}
				onClose={() => setInspected(null)}
			/>

			{/* Statements run on this connection. */}
			<HistoryPanel
				endpoint={endpoint}
				open={historyOpen}
				onClose={() => setHistoryOpen(false)}
				onLoadIntoEditor={loadIntoEditor}
				onRerun={rerunEntry}
			/>

			{/* The database's plan for the statement Run would send. Mounted
			    always and driven by `open`: the panel runs its own EXPLAIN when
			    that turns true, and again whenever the statement changes. */}
			<ExplainPanel
				endpoint={endpoint}
				dialect={dialect}
				sql={explainSql}
				open={explainOpen}
				onClose={() => setExplainOpen(false)}
			/>

			{/* Loading a statement would discard unsaved editor text. */}
			{pendingLoad !== null && (
				<ConfirmDialog
					title="Replace editor text?"
					message="The editor holds text that has not been run. Loading this statement replaces it."
					confirmLabel="Replace"
					onConfirm={confirmLoad}
					onCancel={() => setPendingLoad(null)}
				/>
			)}

			{/* Pattern check — a TEXT check, and it says so. */}
			{patternPrompt && (
				<ConfirmDialog
					title="Run this statement?"
					destructive
					message={
						<>
							<div>{`Pattern check: ${patternPrompt.finding.kind} detected. This is a text check, not a database safeguard.`}</div>
							<pre style={styles.excerpt}>{patternPrompt.run.sql.split('\n').slice(0, 3).join('\n')}</pre>
							<div>It runs immediately and commits on its own.</div>
						</>
					}
					confirmLabel="Run statement"
					secondaryLabel="Run and stop asking on this connection"
					onConfirm={() => answerPattern('run')}
					onSecondary={() => answerPattern('always')}
					onCancel={() => answerPattern('cancel')}
				/>
			)}
		</div>
	);
};

export default QueryView;
