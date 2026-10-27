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
// words; it prevents nothing and is not called a safe mode anywhere. What it
// asks about is the SAVED CONNECTION's safety level, set in the connection's
// editor; the dialog itself has no answer that turns asking off.
// =============================================================================

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GridCellComponent, GridColumnDefinition } from 'shell';
import { AnchoredPopup, Banner, Button, Card, CardDataGrid, ConfirmDialog, ContentHeader, EmptyState, StatusBadge, ToggleGroup, commonStyles, isInVSCode, monoEl, mutedEl } from 'shell';
import type { SqlEndpoint, SqlExecuteResult, SqlDialect } from '../connect';
import { noteExecuteFailure, noteExecuteSuccess, probeExecute, useExecuteState, useSchema } from '../schema/schemaStore';
import { SCHEMA_ONLY_REASON } from '../executeGate';
import GatedButton from '../components/GatedButton';
import { useSqlEnv } from '../sqlEnv';
import SqlEditor from '../components/SqlEditor';
import type { DecorationRange, EditorCursorState, SqlEditorHandle } from '../components/SqlEditor';
import StatementStrip from '../components/StatementStrip';
import CellInspector from '../components/CellInspector';
import WriteConfirmDialog from '../components/WriteConfirmDialog';
import SafetyDowngradeDialog from '../components/SafetyDowngradeDialog';
import { FailureBanner } from 'shared/explorer/components/FailureBanner';
import { createGeneration } from 'shared/explorer/generation';
import { lineRange, clock } from 'shared/explorer/runner/format';
import { useStatementRunner } from 'shared/explorer/runner/useStatementRunner';
import HistoryPanel from '../components/HistoryPanel';
import { SaveQueryButton, SavedQueriesButton } from '../components/SavedQueriesPanel';
import AskBar from '../components/AskBar';
import ExplainPanel from '../components/ExplainPanel';
import { announce } from '../a11y/announce';
import { menuKeyTarget } from '../a11y/menuKeys';
import { splitStatements, splitStatementsIn, statementAtOffset } from '../sql/split';
import { liveBufferText, selectRunTargets } from '../sql/targets';
import { classifyStatement } from '../sql/classify';
import { isSafetyDowngrade, needsConfirmation, parseRowEstimate, rowEstimateStatement, toWriteConfirmation } from '../sql/safety';
import type { RowEstimate } from '../sql/safety';
import { SAFETY_LEVELS, enforcedSafety, safetyLevelOf } from '../connect/savedConnections';
import type { AskedSafety, SafetyLevel } from '../connect/savedConnections';
import { useConnectionRecord } from '../connectionRecord';
import { ALL_ROWS_WARNING, applyRowLimit, formatBatchOutcome, formatElapsed, formatPriorStatements, gridCopies, leadingVerb, mayHaveChangedRows, runSummary, settleStatement } from '../sql/batch';
import type { StatementRun } from '../sql/batch';
import { guardLayouts, layoutRulesFor } from '../sql/gridLayout';
import {
	ALLOW_EXECUTE_OFF_TEXT,
	GENERIC_ERROR_TEXT,
	TRANSACTION_REFUSAL_TEXT,
	describeFailure,
	maxRowsText,
} from '../sql/failure';
import type { FailureNotice } from '../sql/failure';
import { MERGED_COLUMNS_NOTE, inferColumnTypes, mayMergeColumns, precisionNoteApplies } from '../sql/resultTypes';
import { CSV_FORMULA_NOTE, browserCopy, browserDownload, deliverExport, exportFileName, exportResult } from '../sql/export';
import type { ExportFormat } from '../sql/export';
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
	/**
	 * Told once a batch (or a History rerun) ends that may have changed rows,
	 * so the workbench's other pages stop trusting what they counted.
	 */
	onWrite?: () => void;
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

/** Shown on the results header line when a value may not be the number the database holds. */
const PRECISION_NOTE = 'Decimal values arrive as floating point; integers above 2^53 lose precision.';

/** The safety levels as the line under the editor offers them (the editor's own names). */
const SAFETY_CHOICES: Record<SafetyLevel, string> = {
	off: "Don't ask",
	risky: 'Ask before risky writes',
	every: 'Ask before every write',
};

/**
 * How long a saved level is shown as pending when the stored record has not
 * caught up (a dev tool's copy of it arrives a moment after the save).
 */
const SAFETY_SYNC_GRACE_MS = 3000;

/** How the export announcements name each format. */
const EXPORT_NAMES: Record<ExportFormat, string> = { csv: 'CSV', json: 'JSON', markdown: 'Markdown' };

/** The column list of a result that has none (a stable empty array for memos). */
const EMPTY_COLUMNS: readonly string[] = [];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Column below the header: the editor and the results share it. Tight
	// padding and gaps, because at 1440x900 every pixel here is a row of
	// results or a line of editor (live L2).
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		padding: '8px 24px 8px',
	} as CSSProperties,

	// 13 lines of editor (Monaco's line is 20 px), never fewer than 10; it
	// shares any height beyond its basis with the results.
	editorRegion: {
		flex: '1 1 262px',
		minHeight: 200,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	// Ten result rows: the card header (51 px), the grid header (34) and
	// 10 rows of 23 px, so `SELECT ... LIMIT 10` shows whole at 1440x900.
	resultsRegion: {
		flex: '1 1 317px',
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	// The pre-run truth line under the editor: one line of 11 px text, as
	// tall as the text, so the editor keeps 13 lines and the results 10 rows.
	willRun: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Never wraps onto a second line: a long preview ellipsizes, and the
	// full text is the span's title.
	willRunText: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	// The safety level's button keeps the shell's 26 px small size (a click
	// target over 24 px) but counts 14 px in the line: it reaches into the
	// gaps above and below instead of making the line taller.
	safetyAnchor: {
		display: 'inline-flex',
		flexShrink: 0,
		margin: '-6px 0',
	} as CSSProperties,

	// Result meta line in the grid card's action slot.
	meta: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// A button's menu (Export, and the safety level).
	popupMenu: {
		...commonStyles.popupMenu,
		minWidth: 200,
	} as CSSProperties,

	menuItems: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'stretch',
		gap: 2,
	} as CSSProperties,

	menuNote: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		padding: '4px 8px',
		maxWidth: 260,
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
 * @param executeOff - Whether the node is schema only (its execute is off).
 * @returns The reason, or null when the statement can be explained.
 */
function explainRefusal(dialect: SqlDialect, sql: string, connected: boolean, executeOff: boolean): string | null {
	if (!connected) return 'Not connected.';
	if (executeOff) return SCHEMA_ONLY_REASON;
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
 * Move focus between the buttons of a popup menu with Up, Down, Home and End.
 *
 * @param event - The key event on the menu's container.
 */
function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>): void {
	const items = Array.from(event.currentTarget.querySelectorAll('button'));
	const target = menuKeyTarget(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
	if (target === null) return;
	event.preventDefault();
	items[target]?.focus();
}

/**
 * After a popup menu closes, give focus back to the button that opened it,
 * but only when focus was lost with the menu: a click that put focus somewhere
 * else (the editor, another control) keeps it there.
 *
 * @param anchor - The element holding the menu's button.
 */
function refocusIfLost(anchor: React.RefObject<HTMLElement | null>): void {
	requestAnimationFrame(() => {
		if (document.activeElement === null || document.activeElement === document.body) anchor.current?.querySelector('button')?.focus();
	});
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
export const QueryView: React.FC<QueryViewProps> = ({ endpoint, label, initialSql, origin, onWrite }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);
	// What asks before it runs is the saved connection's safety level: the
	// same per-user record in both mounts. Until the record is known it reads
	// as the default, which asks.
	const { record: connectionRecord, status: connectionStatus } = useConnectionRecord(endpoint.connId ?? null);
	// The owner's answer, asked once when this realm's copy of the record is
	// slow to show a saved level (see commitSafety). It holds only for the copy
	// it was asked against: any newer copy retires it, even one with the same
	// value, since a second writer may have changed the level back meanwhile.
	const [askedSafety, setAskedSafety] = useState<AskedSafety | null>(null);
	const connectionRecordRef = useRef(connectionRecord);
	connectionRecordRef.current = connectionRecord;
	const safety = enforcedSafety(connectionRecord, askedSafety);
	// The runner copies its hooks once per batch; they read the level here,
	// so each statement is checked at the level set when it is reached.
	const safetyRef = useRef(safety);
	safetyRef.current = safety;

	// ── The safety level, changed in place ───────────────────────────────────
	//
	// The line under the editor opens a menu of the three levels. Only a choice
	// made there is saved, and a LOWER level asks first, so no keystroke on the
	// control can turn asking down. Only the id and the level are sent: the
	// record's owner sets that one field, so the stored config (a direct
	// connection's password included) is never re-typed, rebuilt or sent again.
	const [safetyMenuOpen, setSafetyMenuOpen] = useState(false);
	const [confirmSafety, setConfirmSafety] = useState<SafetyLevel | null>(null);
	// A level being saved, shown until the stored record says the same (a dev
	// tool's copy arrives a moment later) or, at the latest, a short grace after
	// the save succeeded, so a copy that never arrives cannot hold it.
	const [pendingSafety, setPendingSafety] = useState<SafetyLevel | null>(null);
	const savingSafety = pendingSafety !== null;
	const shownSafety = pendingSafety ?? safety;
	const safetyAnchorRef = useRef<HTMLSpanElement>(null);
	const safetyMenuRef = useRef<HTMLDivElement>(null);
	const safetySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (pendingSafety === null || pendingSafety !== safety) return;
		setPendingSafety(null);
		if (safetySyncTimerRef.current !== null) clearTimeout(safetySyncTimerRef.current);
	}, [pendingSafety, safety]);
	useEffect(() => {
		return () => { if (safetySyncTimerRef.current !== null) clearTimeout(safetySyncTimerRef.current); };
	}, []);

	// Why the level cannot be changed here: there is no saved record to change.
	const safetyGate = connectionRecord !== null
		? null
		: connectionStatus === 'ready' ? 'This connection is not saved, so its level cannot be changed here.' : 'Reading the saved connection…';

	/**
	 * Put focus back on the safety button, on the next frame: the menu (a
	 * portal) and the downgrade dialog have unmounted by then.
	 */
	const focusSafetyButton = useCallback((): void => {
		requestAnimationFrame(() => safetyAnchorRef.current?.querySelector('button')?.focus());
	}, []);

	/**
	 * Save a level the user chose (and, for a lower one, confirmed).
	 *
	 * @param next - The level.
	 */
	const commitSafety = useCallback((next: SafetyLevel): void => {
		const connId = endpoint.connId;
		if (!connId) return;
		setPendingSafety(next);
		env.setConnectionSafety(connId, next).then(
			() => {
				announce(`Safety level for this connection: ${SAFETY_CHOICES[next]}`);
				if (safetySyncTimerRef.current !== null) clearTimeout(safetySyncTimerRef.current);
				// Still not in this realm's copy after the grace: ask the owner once,
				// rather than fall back to showing the old level.
				safetySyncTimerRef.current = setTimeout(() => {
					void env.getConnection(connId).then(
						(record) => setAskedSafety(record === null ? null : { level: safetyLevelOf(record), against: connectionRecordRef.current }),
						() => undefined,
					).finally(() => setPendingSafety(null));
				}, SAFETY_SYNC_GRACE_MS);
			},
			(error: unknown) => {
				setPendingSafety(null);
				announce(`The safety level was not changed. ${error instanceof Error ? error.message : String(error)}`);
			},
		).finally(() => {
			// Focus stays where the user put it; only focus the page lost comes back here.
			if (document.activeElement === null || document.activeElement === document.body) focusSafetyButton();
		});
	}, [endpoint.connId, env, focusSafetyButton]);

	/**
	 * A level picked in the menu: a higher one is saved at once, a lower one
	 * asks first.
	 *
	 * @param level - The level picked.
	 */
	const chooseSafety = useCallback((level: SafetyLevel): void => {
		setSafetyMenuOpen(false);
		if (savingSafety || level === safety) {
			focusSafetyButton();
			return;
		}
		// A lower level asks first. The dialog takes focus (on Cancel) and gives
		// it back when it closes, so the button is not focused under it.
		if (isSafetyDowngrade(safety, level)) {
			setConfirmSafety(level);
			return;
		}
		focusSafetyButton();
		commitSafety(level);
	}, [focusSafetyButton, savingSafety, safety, commitSafety]);

	// The menu renders in a portal: focus moves to the level in force when it
	// opens (on the next frame, once it has been measured and shown).
	useEffect(() => {
		if (!safetyMenuOpen) return undefined;
		const frame = requestAnimationFrame(() => {
			const menu = safetyMenuRef.current;
			(menu?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? menu?.querySelector('button'))?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [safetyMenuOpen]);

	// ── Editor + run state ───────────────────────────────────────────────────
	const [sql, setSql] = useState(initialSql ?? '');
	const [limit, setLimit] = useState<string>('1000');
	const [cursor, setCursor] = useState<EditorCursorState>({ offset: 0, selectionText: '', selectionStart: 0, selectionEnd: 0 });
	const [lastRun, setLastRun] = useState<{ index: number; at: number; start?: number; end?: number } | null>(null);

	// ── Notices ──────────────────────────────────────────────────────────────
	// Whether the node refuses to execute: learned by the workbench's probe and
	// by what runs here (see schemaStore).
	const allowExecuteOff = useExecuteState(endpoint.key) === 'off';
	const gateReason = allowExecuteOff ? SCHEMA_ONLY_REASON : null;
	// One id per mounted query: several instances stay mounted at once.
	const gateNoteId = useId();
	const [untouchedGenerated, setUntouchedGenerated] = useState(origin === 'generated');

	// ── Drawers + dialogs ────────────────────────────────────────────────────
	const [historyOpen, setHistoryOpen] = useState(false);
	const [explainOpen, setExplainOpen] = useState(false);
	const [explainSql, setExplainSql] = useState('');
	const [pendingLoad, setPendingLoad] = useState<string | null>(null);
	// The inspected row, by its index in the shown statement's own rows.
	const [inspected, setInspected] = useState<number | null>(null);
	// Bumped when a batch starts: with the shown statement's index it keys the
	// grid, so a new result gets a new grid rather than new data under old columns.
	const [batchSeq, setBatchSeq] = useState(0);
	// The affected-row estimate, with the statement it is for: a batch can ask
	// about two statements in a row, and the second must not show the first's.
	const [estimate, setEstimate] = useState<{ run: StatementRun; value: RowEstimate } | null>(null);
	const [estimateGeneration] = useState(createGeneration);
	const [exportOpen, setExportOpen] = useState(false);

	// ── Refs ─────────────────────────────────────────────────────────────────
	const editorRef = useRef<SqlEditorHandle>(null);
	const exportAnchorRef = useRef<HTMLSpanElement>(null);
	const exportMenuRef = useRef<HTMLDivElement>(null);
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
	// Set when a statement of the running batch may have changed rows;
	// reported (and cleared) when the batch ends.
	const wroteRef = useRef(false);
	const onWriteRef = useRef(onWrite);
	onWriteRef.current = onWrite;
	const reportWrite = useCallback((): void => {
		if (!wroteRef.current) return;
		wroteRef.current = false;
		onWriteRef.current?.();
	}, []);

	const dialect = snapshot.dialect;
	const statements = useMemo(() => splitStatements(sql, dialect), [sql, dialect]);

	// Suggestions are rebuilt only when the snapshot changes, not per keystroke.
	const completion = useMemo(
		() => buildCompletionModel(snapshot.schema, snapshot.refreshedAt || Date.now()),
		[snapshot.schema, snapshot.refreshedAt],
	);

	// ── The runner ───────────────────────────────────────────────────────────
	//
	// The batch's rules (one statement per call, the first failure ends it, a
	// late answer after Stop waiting is dropped, a flagged statement asks first) are
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
		// Nothing is sent to a node that is schema only: not by the keyboard
		// (Ctrl/Cmd+Enter, Ctrl/Cmd+Shift+Enter) nor by History's Rerun, which
		// the gated buttons do not cover. The reason is said, since a key press
		// has no tooltip to show it.
		canRun: () => {
			if (allowExecuteOff) {
				announce(SCHEMA_ONLY_REASON);
				return false;
			}
			return env.ready;
		},
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
		// Read before every statement, so a level changed in the connection's
		// editor applies from the next statement on. No answer in the dialog
		// turns asking off: the level is the connection's, changed in its editor.
		patternChecksOn: () => safetyRef.current !== 'off',
		patternCheck: (run) => needsConfirmation(run.sql, dialect, safetyRef.current),
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
		// Captures the result's columns before any grid has seen its rows.
		settle: (run, response) => settleStatement(run, response),
		describeFailure: (message) => describeFailure(message),
		// Says "ran" or "committed" per the kinds that preceded the failure — the
		// sentence that stops a reader assuming the batch rolled back.
		formatPrior: (list, failedIndex) => formatPriorStatements(list, failedIndex),
		// The runner records only while this document is mounted.
		// A statement that may have changed rows is noted here, and reported
		// once when the batch ends (finished, or Stop waiting), so the
		// workbench's Data page counts again.
		record: (run) => {
			if (mayHaveChangedRows(run)) wroteRef.current = true;
			env.history.record(endpoint, toHistoryEntry(run));
		},
		onFailure: (notice) => noteExecuteFailure(endpoint.key, notice.verbatim),
		onStart: () => {
			startedRunTextRef.current = editorRunTextRef.current;
			setUntouchedGenerated(false);
			setInspected(null);
			setBatchSeq((seq) => seq + 1);
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
			if (info.resolved) noteExecuteSuccess(endpoint.key);
			reportWrite();
		},
		// Only outcomes that have NO live region of their own are announced. A
		// failure is not one: the error Banner is an assertive alert already
		// (Banner.tsx:75-76), so announcing it here would read it twice. A
		// declined confirmation is announced, or the last run's sentence stays.
		summarize: (info) => runSummary(info),
		announce,
		// The warning Banner carries the notice; it is a live region already.
		onStopped: () => {
			reportWrite();
			editorRef.current?.focus();
		},
	});

	// ── The write confirmation's row estimate ────────────────────────────────
	//
	// While a confirmation is open, a plain EXPLAIN (no ANALYZE: it plans and
	// runs nothing) asks the planner how many rows the write would change. It
	// goes on the document's session, not through the runner, so it is never
	// recorded in history; the dialog shows "Estimating…" meanwhile and never
	// waits for it. Closing the dialog drops a late answer.
	useEffect(() => {
		if (!patternPrompt) return undefined;
		const { run } = patternPrompt;
		const statement = rowEstimateStatement(run.sql, dialect);
		// A schema-only node is sent nothing, the estimate included.
		if (statement === null || !env.ready || allowExecuteOff) {
			setEstimate({ run, value: { state: 'none' } });
			return undefined;
		}
		setEstimate({ run, value: { state: 'estimating' } });
		let alive = true;
		const ticket = estimateGeneration.next();
		env.getSession(endpoint).execute(statement, { idempotent: true, generation: ticket }).then(
			(result) => {
				if (!alive) return;
				const rows = parseRowEstimate(dialect, result.rows ?? []);
				setEstimate({ run, value: rows === null ? { state: 'none' } : { state: 'rows', rows } });
			},
			() => { if (alive) setEstimate({ run, value: { state: 'none' } }); },
		);
		return () => {
			alive = false;
			estimateGeneration.invalidate();
		};
	}, [patternPrompt, dialect, env, endpoint, estimateGeneration, allowExecuteOff]);

	// The open confirmation's own estimate; before its effect has run, what it
	// is about to be.
	const promptEstimate = useMemo((): RowEstimate => {
		if (!patternPrompt) return { state: 'none' };
		if (estimate !== null && estimate.run === patternPrompt.run) return estimate.value;
		return env.ready && !allowExecuteOff && rowEstimateStatement(patternPrompt.run.sql, dialect) !== null ? { state: 'estimating' } : { state: 'none' };
	}, [patternPrompt, estimate, env.ready, dialect, allowExecuteOff]);

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
		const refusal = explainRefusal(dialect, sent, env.ready, allowExecuteOff);
		if (refusal) {
			announce(refusal);
			return;
		}
		setExplainSql(sent);
		setExplainOpen(true);
	}, [targetSqlAsSent, dialect, env.ready, allowExecuteOff]);

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
		const refusal = explainRefusal(dialect, candidate, env.ready, allowExecuteOff);
		return {
			disabled: refusal !== null,
			title: refusal ?? "Show the database's plan for the statement Run would send (Ctrl+Shift+E)",
		};
	}, [env.ready, cursor, sql, dialect, limit, allowExecuteOff]);

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
	 * confirmed anything that changed data last time; the connection's safety
	 * level still applies, because it is about this statement's text, not its
	 * past.
	 *
	 * @param entry - The history entry to run again.
	 */
	const rerunEntry = useCallback((entry: HistoryEntry): void => {
		// No start/end/line: this statement has no place in the editor buffer.
		void runTargets([{ sql: entry.sql }]);
	}, [runTargets]);

	// ── Results ──────────────────────────────────────────────────────────────

	const displayed = selectedRun !== null ? runs[selectedRun] ?? null : null;
	const rows = useMemo(() => displayed?.rows ?? [], [displayed]);

	// The inspector holds an index into the shown statement's rows, so showing
	// another statement closes it rather than pointing it at that one's rows.
	useEffect(() => { setInspected(null); }, [selectedRun]);
	// The shown statement's columns, as captured when it settled. Never read
	// off a row: the grid writes its columns' keys into the rows it renders.
	const resultCols = displayed?.columns ?? EMPTY_COLUMNS;
	// The grid renders (and writes into) copies; the statement's rows stay as
	// the node returned them.
	const gridRows = useMemo(() => gridCopies(rows), [rows]);

	const columnTypes = useMemo(
		() => (rows.length > 0 && displayed ? inferColumnTypes(rows, snapshot.schema, displayed.sql, dialect, resultCols) : {}),
		[rows, displayed, snapshot.schema, dialect, resultCols],
	);

	const columns = useMemo<GridColumnDefinition[]>(() => {
		if (rows.length === 0) return [];
		return resultCols.map((key) => {
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
	}, [rows, resultCols, columnTypes]);
	// Saved layouts keep no width for a flexible column (sql/gridLayout.ts), so a
	// grid built while hidden can never freeze one at 40 px.
	const gridLayouts = useMemo(() => guardLayouts(env.gridPersistence, layoutRulesFor(columns)), [env.gridPersistence, columns]);

	// The precision note, only when a value could have lost digits on the way
	// (a DECIMAL/NUMERIC column, a long float, an integer beyond 2^53).
	const showPrecisionNote = useMemo(() => precisionNoteApplies(resultCols, rows, columnTypes), [resultCols, rows, columnTypes]);
	// Rows arrive as objects, so two columns with one name merge into one.
	const showMergedNote = useMemo(() => displayed !== null && rows.length > 0 && mayMergeColumns(displayed.sql, dialect), [displayed, rows.length, dialect]);

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

	// A VS Code webview refuses downloads, so there an export is copied.
	const copiesExports = useMemo(() => isInVSCode(), []);

	/**
	 * Export the shown statement's rows: CSV and JSON download (or are copied
	 * where downloads are refused), Markdown is copied. The rows are the
	 * statement's own, by its captured columns, as the run returned them.
	 *
	 * @param format - The format.
	 */
	const exportRows = useCallback((format: ExportFormat): void => {
		setExportOpen(false);
		// The menu was a portal: give focus back to the button that opened it.
		exportAnchorRef.current?.querySelector('button')?.focus();
		if (!displayed) return;
		const payload = { ...exportResult(format, resultCols, rows), fileName: exportFileName(label, displayed.index, format) };
		const what = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} as ${EXPORT_NAMES[format]}`;
		void deliverExport(payload, { downloadsRefused: copiesExports, download: browserDownload, copy: browserCopy }).then((outcome) => {
			// A page that blocks downloads quietly cannot be told apart, so this
			// says the download started, not that it finished.
			if (outcome === 'downloaded') announce(`Download started: ${what}`);
			else if (outcome === 'failed') announce(`Could not export ${what}`);
			else announce(format === 'markdown' ? `Copied ${what}` : `Downloads are not available here, so ${what} was copied`);
		});
	}, [displayed, resultCols, rows, label, copiesExports]);

	// The menu renders in a portal at the end of the page, so Tab from the
	// button would never reach it: focus moves to its first item when it opens
	// (on the next frame, once it has been measured and shown).
	useEffect(() => {
		if (!exportOpen) return undefined;
		const frame = requestAnimationFrame(() => exportMenuRef.current?.querySelector('button')?.focus());
		return () => cancelAnimationFrame(frame);
	}, [exportOpen]);

	/** Title for the results region when there is no grid to show. */
	const emptyTitle = !displayed
		? 'No results yet'
		: displayed.outcome === 'error'
			? 'Statement failed'
			: displayed.outcome === 'abandoned'
				? 'Stopped waiting'
				: 'Statement executed';

	const batchLine = runs.length > 1 ? formatBatchOutcome(runs) : '';
	const canRun = env.ready && !running && sql.trim().length > 0 && !allowExecuteOff;

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
							onChange={(next) => {
								setLimit(next);
								if (next === 'All') announce(ALL_ROWS_WARNING);
							}}
						/>
						<SaveQueryButton endpoint={endpoint} sql={sql} />
						<SavedQueriesButton endpoint={endpoint} />
						<Button
							variant="ghost"
							pressed={historyOpen}
							ariaExpanded={historyOpen}
							title="Show the statements run on this connection"
							onClick={() => setHistoryOpen((open) => !open)}
						>
							History
						</Button>
						<GatedButton
							variant="secondary"
							onClick={openExplain}
							disabled={explainState.disabled}
							ariaExpanded={explainOpen}
							title={explainState.title}
							gateReason={gateReason}
							reasonId={gateNoteId}
						>
							Explain
						</GatedButton>
						{inFlight && canStop && (
							<Button variant="ghost" title="Stop waiting for the answer. This does not cancel the statement." onClick={stopWaiting}>
								Stop waiting
							</Button>
						)}
						<GatedButton
							variant="secondary"
							onClick={runAll}
							disabled={!canRun}
							title="Run every statement in order, stop at the first error (Ctrl+Shift+Enter)"
							gateReason={gateReason}
							reasonId={gateNoteId}
						>
							Run all
						</GatedButton>
						<GatedButton
							variant="primary"
							onClick={runOne}
							disabled={!canRun}
							title="Run selection, or the statement at the cursor (Ctrl+Enter)"
							gateReason={gateReason}
							reasonId={gateNoteId}
						>
							{running ? 'Running…' : 'Run'}
						</GatedButton>
					</>
				}
			/>

			<div style={styles.body}>
				{/* A question becomes SQL in a new query; nothing runs. */}
				<AskBar endpoint={endpoint} />

				{/* The node refuses to execute anything — schema browsing still works. */}
				{allowExecuteOff && (
					<div id={gateNoteId}>
						<Banner variant="warning">
							{ALLOW_EXECUTE_OFF_TEXT}{' '}
							<Button variant="ghost" small onClick={() => { if (env.ready) void probeExecute(env.getSession(endpoint)); }}>Check again</Button>
						</Banner>
					</div>
				)}

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
					<span style={styles.willRunText} title={preview.text}>{preview.text}</span>
					<span ref={safetyAnchorRef} style={styles.safetyAnchor}>
						<GatedButton
							variant="ghost"
							small
							ariaExpanded={safetyMenuOpen}
							title="How much this connection asks before a statement that changes something. A check on the statement text, not a database permission."
							onClick={() => setSafetyMenuOpen((open) => !open)}
							gateReason={safetyGate}
						>
							{`Safety: ${SAFETY_CHOICES[shownSafety]}`}{savingSafety ? ' (saving…)' : ''}
						</GatedButton>
					</span>
					<AnchoredPopup
						anchorRef={safetyAnchorRef}
						open={safetyMenuOpen}
						onClose={() => {
							setSafetyMenuOpen(false);
							refocusIfLost(safetyAnchorRef);
						}}
						align="end"
						style={styles.popupMenu}
					>
						<div
							ref={safetyMenuRef}
							role="group"
							aria-label="Safety level for this connection"
							style={styles.menuItems}
							onKeyDown={(event) => {
								// Escape closes the menu (the popup's own listener); focus goes back to the button.
								if (event.key === 'Escape') focusSafetyButton();
								else moveMenuFocus(event);
							}}
						>
							{SAFETY_LEVELS.map((level) => (
								<Button key={level} variant="ghost" small pressed={level === shownSafety} onClick={() => chooseSafety(level)}>
									{SAFETY_CHOICES[level]}
								</Button>
							))}
							<div style={styles.menuNote}>Lowering the level asks first. A check on the statement text, not a database permission.</div>
						</div>
					</AnchoredPopup>
				</div>

				{/* All has a cost the toggle cannot show. */}
				{limit === 'All' && (
					<div style={styles.meta}>
						<StatusBadge variant="warning">No row limit</StatusBadge>
						<span>{ALL_ROWS_WARNING}</span>
					</div>
				)}

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
								key={`${batchSeq}:${displayed.index}`}
								title="Results"
								actions={
									<span style={styles.meta}>
										{meta.text}
										{meta.limitReached && <StatusBadge variant="warning">Limit reached, more rows may exist</StatusBadge>}
										{/* On this line rather than under the grid, which would cost a row. */}
										{showPrecisionNote && <span>{PRECISION_NOTE}</span>}
										{showMergedNote && <span>{MERGED_COLUMNS_NOTE}</span>}
										<span ref={exportAnchorRef}>
											<Button
												variant="secondary"
												small
												ariaExpanded={exportOpen}
												title="Export the rows this statement returned"
												onClick={() => setExportOpen((open) => !open)}
											>
												Export
											</Button>
										</span>
										<AnchoredPopup
											anchorRef={exportAnchorRef}
											open={exportOpen}
											onClose={() => {
												setExportOpen(false);
												refocusIfLost(exportAnchorRef);
											}}
											align="end"
											style={styles.popupMenu}
										>
											<div
												ref={exportMenuRef}
												role="group"
												aria-label="Export"
												style={styles.menuItems}
												onKeyDown={(event) => {
													// Escape closes the menu (the popup's own listener); focus goes back to the button.
													if (event.key === 'Escape') exportAnchorRef.current?.querySelector('button')?.focus();
													else moveMenuFocus(event);
												}}
											>
												<div style={styles.menuNote}>{`Rows this statement returned (${rows.length.toLocaleString()})`}</div>
												<Button variant="ghost" small onClick={() => exportRows('csv')}>{copiesExports ? 'Copy as CSV' : 'Download CSV'}</Button>
												<Button variant="ghost" small onClick={() => exportRows('json')}>{copiesExports ? 'Copy as JSON' : 'Download JSON'}</Button>
												<Button variant="ghost" small onClick={() => exportRows('markdown')}>Copy as Markdown</Button>
												<div style={styles.menuNote}>{CSV_FORMULA_NOTE}</div>
											</div>
										</AnchoredPopup>
									</span>
								}
								columns={columns}
								data={gridRows}
								tableId="sql-query-results"
								persistence={gridLayouts}
								paginate={false}
								height="100%"
								emptyTitle="No rows"
								emptyDescription="The statement returned no rows."
								onRowClick={(row) => {
									const index = gridRows.indexOf(row);
									if (index >= 0) setInspected(index);
								}}
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
				</div>
			</div>

			{/* One row of the result, in full. */}
			<CellInspector
				open={inspected !== null}
				row={inspected === null ? null : rows[inspected] ?? null}
				columns={resultCols}
				rowNumber={(inspected ?? 0) + 1}
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

			{/* Lowering the connection's safety level asks first; Cancel changes nothing. */}
			{confirmSafety !== null && (
				<SafetyDowngradeDialog
					level={confirmSafety}
					connection={connectionRecord?.name ?? endpoint.nodeName}
					onConfirm={() => {
						const level = confirmSafety;
						setConfirmSafety(null);
						focusSafetyButton();
						commitSafety(level);
					}}
					onCancel={() => {
						setConfirmSafety(null);
						focusSafetyButton();
					}}
				/>
			)}

			{/* The connection's safety level asks first — a TEXT check, and it says so. */}
			{patternPrompt && (
				<WriteConfirmDialog
					key={patternPrompt.run.index}
					confirmation={toWriteConfirmation(patternPrompt.finding)}
					sql={patternPrompt.run.sql}
					connection={connectionRecord?.name ?? endpoint.nodeName}
					estimate={promptEstimate}
					onAnswer={answerPattern}
				/>
			)}
		</div>
	);
};

export default QueryView;
