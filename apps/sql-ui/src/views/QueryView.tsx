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
import type { GridCellComponent, GridColumnDefinition } from 'shell';
import { Banner, Button, Card, CardDataGrid, ConfirmDialog, ContentHeader, EmptyState, StatusBadge, ToggleGroup, commonStyles, monoEl, mutedEl } from 'shell';
import type { SqlEndpoint, SqlExecuteResult, SqlDialect } from '../connect';
import { useSchema } from '../schema/schemaStore';
import { useSqlEnv } from '../sqlEnv';
import SqlEditor from '../components/SqlEditor';
import type { DecorationRange, EditorCursorState, SqlEditorHandle } from '../components/SqlEditor';
import StatementStrip from '../components/StatementStrip';
import CellInspector from '../components/CellInspector';
import { FailureBanner } from 'shared/explorer/components/FailureBanner';
import { PatternConfirmDialog } from 'shared/explorer/components/PatternConfirmDialog';
import { lineRange, clock } from 'shared/explorer/runner/format';
import { useStatementRunner } from 'shared/explorer/runner/useStatementRunner';
import HistoryPanel from '../components/HistoryPanel';
import ExplainPanel from '../components/ExplainPanel';
import { announce } from '../a11y/announce';
import { splitStatements, splitStatementsIn, statementAtOffset } from '../sql/split';
import { liveBufferText, selectRunTargets } from '../sql/targets';
import { classifyStatement, patternCheck } from '../sql/classify';
import { applyRowLimit, formatBatchOutcome, formatElapsed, formatPriorStatements, leadingVerb } from '../sql/batch';
import type { StatementRun } from '../sql/batch';
import {
	ALLOW_EXECUTE_OFF_TEXT,
	GENERIC_ERROR_TEXT,
	TRANSACTION_REFUSAL_TEXT,
	describeFailure,
	maxRowsText,
} from '../sql/failure';
import type { FailureNotice } from '../sql/failure';
import { inferColumnTypes } from '../sql/resultTypes';
import { buildCompletionModel } from '../sql/completion';
import { buildExplain } from '../sql/explain';
import type { HistoryEntry } from '../history/types';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link QueryView} component. */
export interface QueryViewProps {
	/** The connection this query document executes against. */
	endpoint: SqlEndpoint;
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
interface RunTarget {
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

/** Row-limit options offered by the header toggle. */
const LIMIT_OPTIONS = ['200', '1000', 'All'] as const;

/** Prefs key holding the per-connection pattern-check switch. */
const PATTERN_CHECK_PREF = 'sql.patternChecks';

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
};

// =============================================================================
// HELPERS
// =============================================================================

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
function toHistoryEntry(run: StatementRun): HistoryEntry {
	const outcome: HistoryEntry['outcome'] =
		run.outcome === 'rows' || run.outcome === 'affected' || run.outcome === 'abandoned' ? run.outcome : 'error';
	return {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		sql: run.sql,
		at: Date.now() - (run.ms ?? 0),
		ms: run.ms ?? 0,
		outcome,
		kind: run.kind,
		// Absent fields are left out rather than set to undefined: the entry may
		// cross to a dev tool's controller as JSON.
		...(run.outcome === 'rows' ? { rows: run.rows?.length ?? 0 } : {}),
		...(run.outcome === 'affected' ? { affected: run.affected ?? 0 } : {}),
		...(run.error !== undefined ? { error: run.error } : {}),
		// Only a limit the APP appended is reported; a statement's own LIMIT is
		// already visible in the stored text.
		...(run.limitState === 'applied' && typeof run.limitApplied === 'number' ? { limit: run.limitApplied } : {}),
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
 * @param props - {@link QueryViewProps}.
 * @returns The query document element.
 */
export const QueryView: React.FC<QueryViewProps> = ({ endpoint, label, initialSql, origin }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);
	// The pattern-check switch: workspace preferences in the full app, this
	// session only in a dev-tool frame (SqlEnv prefs; never usePrefs here).
	const prefs = env.prefs;

	// ── Editor + run state ───────────────────────────────────────────────────
	const [sql, setSql] = useState(initialSql ?? '');
	const [limit, setLimit] = useState<string>('1000');
	const [cursor, setCursor] = useState<EditorCursorState>({ offset: 0, selectionText: '', selectionStart: 0, selectionEnd: 0 });
	const [lastRun, setLastRun] = useState<{ index: number; at: number; start?: number; end?: number } | null>(null);

	// ── Notices ──────────────────────────────────────────────────────────────
	const [allowExecuteOff, setAllowExecuteOff] = useState(false);
	const [untouchedGenerated, setUntouchedGenerated] = useState(origin === 'generated');

	// ── Drawers + dialogs ────────────────────────────────────────────────────
	const [historyOpen, setHistoryOpen] = useState(false);
	const [explainOpen, setExplainOpen] = useState(false);
	const [explainSql, setExplainSql] = useState('');
	const [pendingLoad, setPendingLoad] = useState<string | null>(null);
	const [inspected, setInspected] = useState<{ row: Record<string, unknown>; number: number } | null>(null);
	const [patternChecksOn, setPatternChecksOn] = useState<boolean>(() => {
		const bag = prefs.getPref(PATTERN_CHECK_PREF) as Record<string, boolean> | undefined;
		return bag?.[endpoint.key] !== false;
	});

	// ── Refs ─────────────────────────────────────────────────────────────────
	const editorRef = useRef<SqlEditorHandle>(null);
	const patternChecksOnRef = useRef(patternChecksOn);
	// The buffer text as of the last run or the last load: anything else in the
	// editor is unsaved work that must not be replaced without asking.
	const committedTextRef = useRef(initialSql ?? '');
	// The editor text an editor run is cut from. runFromEditor offers it,
	// onStart takes it (the runner calls onStart synchronously, and only when
	// the batch really starts), and onFinished marks it as run. The `sql` state
	// can lag the editor by a render after a fast Ctrl+Enter, so it is never
	// that text.
	const editorRunTextRef = useRef<string | null>(null);
	const startedRunTextRef = useRef<string | null>(null);

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
	 * Turn the pattern check on or off for THIS connection, in the mount's
	 * preferences (the full app's workspace preferences, server-side and per
	 * user; a dev-tool frame's session) and in local state.
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

	// ── The runner ───────────────────────────────────────────────────────────
	//
	// The batch's rules (one statement per call, the first failure ends it, a
	// late answer after Stop waiting is dropped, a pattern check asks first) are
	// shared with the other Explorers (shared/explorer/runner); everything SQL
	// decides is handed in here. The runner lives in the document: in a dev-tool
	// frame its session is the REMOTE one (every statement an op on the
	// controller), in the full app the engine core's.
	const {
		runs,
		running,
		inFlight,
		canStop,
		selectedRun,
		setSelectedRun,
		activeIndex,
		failure,
		abandonNotice,
		refusal: txRefusal,
		patternPrompt,
		answerPattern,
		runTargets: runStatements,
		stopWaiting,
	} = useStatementRunner<StatementRun, { sql: string }, SqlExecuteResult, FailureNotice>({
		canRun: () => env.ready,
		initRun: (target, index): StatementRun => ({
			index,
			sql: target.text,
			kind: classifyStatement(target.text, dialect),
			verb: leadingVerb(target.text, dialect),
			start: target.start,
			end: target.end,
			startLine: target.startLine,
			endLine: target.endLine,
			outcome: 'pending',
		}),
		textOf: (run) => run.sql,
		// Transaction control cannot work through per-call autocommit, so it is
		// refused before anything is sent rather than run and misunderstood. No
		// announce(): the Banner is already a polite live region (Banner.tsx:75-76),
		// and mirroring it would read the refusal twice.
		refuse: (list) => (list.some((run) => run.kind === 'tx') ? TRANSACTION_REFUSAL_TEXT : null),
		patternChecksOn: () => patternChecksOnRef.current,
		patternCheck: (run) => patternCheck(run.sql, dialect),
		disablePatternChecks: () => setPatternChecks(false),
		prepare: (run) => {
			const prepared = applyRowLimit(run.sql, limit, dialect);
			return { send: { sql: prepared.sql }, patch: { limitApplied: prepared.limit, limitState: prepared.state } };
		},
		// `idempotent` gates the session's one retry after a restart: a read may be
		// sent twice harmlessly, a write may NOT (the controller checks again).
		// The batch's ticket goes down too (port of 740b69c6d), so a read the
		// user stopped waiting for (or whose tab closed) is not sent again by the
		// full app's retry, and a frame drops its late answer.
		execute: (run, send, ticket) => env.getSession(endpoint).execute(send.sql, { idempotent: run.kind === 'read', generation: ticket }),
		settle: (run, response) => {
			const rows = response.rows ?? [];
			const affected = response.affected_rows ?? 0;
			const outcome: StatementRun['outcome'] = rows.length > 0 || run.kind === 'read' ? 'rows' : 'affected';
			return { outcome, rows, rowCount: rows.length, affected };
		},
		describeFailure: (message) => describeFailure(message),
		// Says "ran" or "committed" per the kinds that preceded the failure — the
		// sentence that stops a reader assuming the batch rolled back.
		formatPrior: (list, failedIndex) => formatPriorStatements(list, failedIndex),
		// The runner records only while this document is mounted.
		record: (run) => env.history.record(endpoint, toHistoryEntry(run)),
		onFailure: (notice) => { if (notice.allowExecuteOff) setAllowExecuteOff(true); },
		onStart: () => {
			startedRunTextRef.current = editorRunTextRef.current;
			setUntouchedGenerated(false);
			setInspected(null);
		},
		onFinished: (info, opts) => {
			if (info.shown) setLastRun({ index: info.shown.index, at: Date.now(), start: info.shown.start, end: info.shown.end });
			// Only an editor run makes the buffer "already run". A rerun from the
			// history drawer must not mark untouched editor text as run, or the
			// next Load-into-editor would silently discard it. What is marked is the
			// live text the run was cut from, not the (possibly lagging) `sql` state.
			if (opts.fromEditor && startedRunTextRef.current !== null) committedTextRef.current = startedRunTextRef.current;
			// A statement that actually ran is the only proof the node's execute
			// gate is open again, so a successful run retires the warning.
			if (info.resolved) setAllowExecuteOff(false);
		},
		// Only outcomes that have NO live region of their own are announced. A
		// failure is not one: the error Banner is an assertive alert already
		// (Banner.tsx:75-76), so announcing it here would read it twice.
		summarize: ({ runs: finished, shown, failedAt }) => {
			if (finished.length > 1) return `${finished.length} statements: ${formatBatchOutcome(finished)}`;
			if (failedAt < 0 && shown?.outcome === 'rows') return `Statement returned ${(shown.rows?.length ?? 0).toLocaleString()} rows`;
			if (failedAt < 0 && shown?.outcome === 'affected') return `Statement affected ${(shown.affected ?? 0).toLocaleString()} rows`;
			return null;
		},
		announce,
		// The warning Banner carries the notice; it is a live region already.
		onStopped: () => editorRef.current?.focus(),
	});

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
	 * Reads the live editor handle for the TEXT as well as the caret and the
	 * selection. The `sql` state can lag the editor by a render when the run
	 * action fires right after the last keystrokes; pairing that stale copy with
	 * the live caret selected a truncated statement. The state copy is only the
	 * fallback when there is no editor to ask.
	 *
	 * @returns The statements to run (possibly empty).
	 */
	const currentTarget = useCallback((): RunTarget[] => {
		const editor = editorRef.current;
		return selectRunTargets(
			liveBufferText(editor, sql),
			editor?.getSelection() ?? null,
			editor?.getCursorOffset() ?? cursor.offset,
			dialect,
		);
	}, [sql, dialect, cursor.offset]);

	// The pre-run line and the editor decoration, always saying the same thing.
	const preview = useMemo((): { text: string; decorations: DecorationRange[] } => {
		if (running) {
			const run = runs[activeIndex];
			const decorations: DecorationRange[] = run?.start !== undefined && run.end !== undefined
				? [{ start: run.start, end: run.end, className: 'sql-ui-stmt-running' }]
				: [];
			return { text: `Running statement ${activeIndex + 1} of ${runs.length}…`, decorations };
		}
		if (cursor.selectionText.trim()) {
			const selected = splitStatementsIn(sql, cursor.selectionStart, cursor.selectionEnd, dialect);
			if (selected.length === 0) return { text: 'Will run: nothing (no statement found)', decorations: [] };
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
		if (!sql.trim()) return { text: 'Will run: nothing (editor is empty)', decorations: [] };
		const statement = statements.length > 0 ? statementAtOffset(sql, cursor.offset, dialect) : null;
		if (!statement) return { text: 'Will run: nothing (no statement found)', decorations: [] };
		const decorations: DecorationRange[] = [{ start: statement.start, end: statement.end, className: 'sql-ui-stmt-active' }];
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

	/**
	 * Run a list of statements in order, stopping at the first error (the shared
	 * runner; SQL's targets carry their text under `sql`).
	 *
	 * @param targets - The statements to send, in order.
	 * @param opts - `fromEditor` marks the buffer as run.
	 */
	const runTargets = useCallback((targets: RunTarget[], opts?: { fromEditor?: boolean }): Promise<void> => {
		return runStatements(targets.map(({ sql: text, ...position }) => ({ text, ...position })), opts);
	}, [runStatements]);

	/**
	 * Run statements cut from the editor's text, and offer that text to be marked
	 * as run once the batch ends (see editorRunTextRef).
	 *
	 * @param text - The live editor text the targets were cut from.
	 * @param targets - The statements to send.
	 */
	const runFromEditor = useCallback((text: string, targets: RunTarget[]): void => {
		editorRunTextRef.current = text;
		void runTargets(targets, { fromEditor: true });
		editorRunTextRef.current = null;
	}, [runTargets]);

	/** Run the selection, or the statement at the caret. */
	const runOne = useCallback((): void => {
		const text = liveBufferText(editorRef.current, sql);
		runFromEditor(text, currentTarget());
	}, [runFromEditor, currentTarget, sql]);

	/** Run every statement in the buffer, in order. */
	const runAll = useCallback((): void => {
		const text = liveBufferText(editorRef.current, sql);
		runFromEditor(text, splitStatements(text, dialect));
	}, [runFromEditor, sql, dialect]);

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
		const refusal = explainRefusal(dialect, sent, env.ready);
		if (refusal) {
			announce(refusal);
			return;
		}
		setExplainSql(sent);
		setExplainOpen(true);
	}, [targetSqlAsSent, dialect, env.ready]);

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
		const refusal = explainRefusal(dialect, candidate, env.ready);
		return {
			disabled: refusal !== null,
			title: refusal ?? "Show the database's plan for the statement Run would send (Ctrl+Shift+E)",
		};
	}, [env.ready, cursor, sql, dialect, limit]);

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
	const rerunEntry = useCallback((entry: HistoryEntry): void => {
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
				rrDescription: info ? `${key}: ${info.description}` : `Result column ${key}.`,
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
	const canRun = env.ready && !running && sql.trim().length > 0;

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
				{untouchedGenerated && <Banner variant="info">Generated preview: review, then Run</Banner>}

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
				{txRefusal && <Banner variant="warning">{txRefusal}</Banner>}

				{/* The user stopped waiting; the statement may still be running. */}
				{abandonNotice && <Banner variant="warning">{abandonNotice}</Banner>}

				{/* Execution failure. */}
				{failure && (
					<FailureBanner
						failure={failure}
						genericText={GENERIC_ERROR_TEXT}
						extra={failure.notice.maxExecuteRows !== null ? <div>{maxRowsText(failure.notice.maxExecuteRows)}</div> : undefined}
					/>
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
										{meta.limitReached && <StatusBadge variant="warning">Limit reached, more rows may exist</StatusBadge>}
										<span title="The grid's gear menu exports the rows this run returned.">Export: grid menu (gear)</span>
									</span>
								}
								columns={columns}
								data={rows}
								tableId="sql-query-results"
								persistence={env.gridPersistence}
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
				<PatternConfirmDialog
					kind={patternPrompt.finding.kind}
					excerpt={patternPrompt.run.sql.split('\n').slice(0, 3).join('\n')}
					consequence="It runs immediately and commits on its own."
					onAnswer={answerPattern}
				/>
			)}
		</div>
	);
};

export default QueryView;
