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
// GRAPH-UI - RUN SURFACE (editor, runs, results and the graph, for one query tab)
// =============================================================================
//
// One component serves both the browsing workbench (mode `read`: every statement
// goes through `read_query`) and the write console (mode `write`: every statement
// goes through `execute` with shape 'graph', after a confirmation that lists the
// statements the text check marks as mutating). The two modes differ in exactly
// four places: the tool called, the refusal rule, the confirmation, and the words;
// everything else - editor, drafts, runner, results tabs, the graph - is shared.
// The workbench mounts one surface per query tab (each with its own editor, runs,
// graph session and load slot); the write console mounts one.
//
// The room the results get:
//   - in the workbench the run bar sits in the row under the tabs (the host
//     hands a `barHost` and the bar is portalled there), so a query tab adds
//     only its editor above the results; the bar also holds the Graph / Table /
//     Raw switch, so the results have no row of their own for it;
//   - a divider (SplitPane.tsx) sets the editor's height, kept in the prefs
//     (graph.editorHeight), and can hide the editor, leaving the run bar with
//     the statement's first line;
//   - the graph can fill the whole document (an in-document full screen, not the
//     browser's Fullscreen API, which VS Code panels and dev-tool frames may not
//     allow): its area is positioned over the document, nothing remounts, and
//     Escape (that nothing inside used) or the graph's own button leaves it. The
//     host hides everything it covers (`onFullScreen`: visibility hidden on the
//     document, visible on the graph), so the keyboard and screen readers cannot
//     reach what is not on screen, and the hidden editor runs nothing;
//   - only the shown tab draws its results: a hidden tab keeps its runs, result
//     and graph session, and draws the canvas or the grid again when shown.
//
// Every request goes through the host's gate (graph/requestGate.ts): the
// workbench's, one at a time across its tabs, or the write console's own. While
// it is held, Run waits and says why; a statement the gate refused was never
// sent, so it is not recorded and its banner gives no pipeline hint.
//
// The statement runner and strip are the shared Explorer ones; this file only
// configures them for Cypher. A row opens in an inline panel (RowPanel), not the
// shared row drawer, which listens for Escape on the whole page.
//
// Everything engine-facing comes from the GraphEnv (env.ts): the session (the
// store's own in the full app, a remote one over controller ops in a dev-tool
// frame), the write count, the data versions, history, the drafts prefs
// (session-only in a dev-tool mount) and the connection's style, which holds the
// captions. The runner, the graph session, path search and the editor stay HERE
// in every mount.
// =============================================================================

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Banner, Button, EmptyState, StatusBadge, ToggleGroup, isInVSCode } from 'shell';
import { ExplorerToolError, clock, createGeneration, formatBatchOutcome, formatPriorStatements, useStatementRunner } from 'shared/explorer';
import type { IExplorerEndpoint, IRunTarget, IStatementRunBase } from 'shared/explorer';
import StatementStrip from 'shared/explorer/components/StatementStrip';
import { DRAFTS_PREF_KEY, TOOL, announcer } from '../adapters/explorer';
import { useConnectionStyle, useDataVersion, useGraphEndpoints, useGraphEnv, useSchemaLabels, useSchemaView } from '../env';
import { describeSnapshot, targetsFromEditor } from '../cypher/targets';
import type { IEditorSnapshot } from '../cypher/targets';
import { DEFAULT_ROW_LIMIT, ROW_LIMIT_CHOICES } from '../graph/budgets';
import { canWrite as dialectCanWrite, parseDialect, rowLimitChip } from '../graph/dialect';
import { describeFailureOf, describeWriteFailure } from '../graph/failures';
import type { IFailureNotice } from '../graph/failures';
import { isAbandonedWrite } from '../graph/dataVersion';
import { locateFailure } from '../graph/errorPosition';
import { createGraphSession } from '../graph/graphSession';
import type { IGraphSession } from '../graph/graphSession';
import { describeWrites } from '../graph/writeConfirm';
import type { IWriteConfirmation } from '../graph/writeConfirm';
import { GRAPH_BATCH_WORDS, affectedNotReported, historySummaryOf, limitPatch, prepareStatement, refuseNonReads, runRefusal, settleRun, toHistoryEntry } from '../graph/runConfig';
import { chooseTab, summarizeResult } from '../graph/results';
import type { ResultTab } from '../graph/results';
import type { ILoadSlot } from '../graph/loadSlot';
import { gateRefusalNotice, gateWaitingTitle, isGateRefusal, isGateRefusalText } from '../graph/requestGate';
import type { IRequestGate } from '../graph/requestGate';
import { inspectorTextOfRow } from '../graph/rowInspect';
import { EDITOR_HEIGHT_PREF_KEY, clampEditorHeight, splitToggled, storedEditorHeight } from '../graph/splitPane';
import type { IEditorSplit } from '../graph/splitPane';
import type { ReadQueryResult } from '../graph/types';
import { AGE_AFFECTED_NOT_REPORTED, CHANGES_NOTE, FULL_SCREEN_TEXT, NOTICE_HEADLINE_MAX, STOP_WAITING_NOTE, changesText, graphRunLabel, num, resultAnnouncement, resultMeta, resultNotes, splitNotice, truncationText } from '../graph/wording';
import type { IResultNote } from '../graph/wording';
import { GraphFailureBanner } from './GraphFailureBanner';
import { GraphView } from './GraphView';
import type { LayoutMode } from '../canvas/GraphCanvas';
import QueryEditor from './QueryEditor';
import type { IQueryEditorHandle } from './QueryEditor';
import { RawView, ResultTable } from './ResultViews';
import RowPanel from './RowPanel';
import { SplitDivider } from './SplitPane';
import { WriteConfirmDialog } from './WriteConfirmDialog';
import { GraphIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** One statement's run. */
export interface IGraphRun extends IStatementRunBase {
	cypher: string;
	result?: ReadQueryResult;
}

/** What the surface needs from its host. */
export interface IRunSurfaceProps {
	endpoint: IExplorerEndpoint;
	mode: 'read' | 'write';
	/**
	 * Why running is paused while the surface stays on screen (the connection is being checked again, was stopped,
	 * or no longer allows this mode), or null/absent when it can run. Nothing is sent while it is set.
	 */
	paused?: string | null;
	/** The host's mailbox for text the editor should hold (history load, Ask draft, label preview); each request is taken once. */
	loadSlot: ILoadSlot;
	/** Changes whenever the host puts a request in the slot. */
	loadSeq: number;
	/** Which tab of its document this surface is: part of the results grid key, so two tabs never share a layout. */
	tabId?: string;
	/** The prefs key the draft is kept under; null for a tab whose text lasts the session only. Default `<mode>:<connection>`. */
	draftKey?: string | null;
	/** The text the editor starts with when no draft is kept. */
	defaultText?: string;
	/** False while the surface's tab is hidden (it leaves full screen). */
	active?: boolean;
	/** Told whenever the editor text changes, and once with the text it starts with. */
	onTextChange?(text: string): void;
	/** Shows or hides the history panel. */
	onOpenHistory?(): void;
	historyOpen?: boolean;
	/** Shows or hides the saved queries panel (the workbench only). */
	onOpenSaved?(): void;
	savedOpen?: boolean;
	/** Shows or hides the Ask bar (the workbench only). */
	onAsk?(): void;
	askOpen?: boolean;
	/** Open a new query tab with this text, not run (the workbench only). */
	onNewQuery?(cypher: string, title: string): void;
	/**
	 * Where the run bar goes: an element in the host's control row (the workbench), or null while it is not there yet.
	 * Absent: the bar sits under the editor (the write console).
	 */
	barHost?: HTMLElement | null;
	/** The host's gate: one request at a time (across the workbench's tabs, or the write console's). */
	gate?: IRequestGate;
	/** Told when the graph starts or stops filling the document, so the host can hide what it covers. */
	onFullScreen?(on: boolean): void;
}

/** The space the divider and the paddings take from the surface; the editor and the results share the rest. */
const SURFACE_CHROME = 48;

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as CSSProperties,
	editorRegion: (hidden: boolean): CSSProperties => ({ flex: '0 0 auto', padding: '6px 24px 0', display: hidden ? 'none' : 'flex', flexDirection: 'column', gap: 6 }),
	editorBox: (height: number, hidden: boolean): CSSProperties => ({ flex: '0 0 auto', height, display: hidden ? 'none' : undefined }),
	runBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as CSSProperties,
	// In the workbench's control row: the same controls, right-aligned, filling the row, so its lines break on the row's
	// width (not on a measured width of its own, which Chrome takes from the items' content, not their flex basis) and
	// it wraps only when the row is too narrow.
	runBarInRow: { flex: '1 1 auto', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end', minWidth: 0 } as CSSProperties,
	// The hidden editor's first line takes the room left on its line (up to 40%): line breaking counts only its 60 px.
	firstLine: { flex: '1 1 0', maxWidth: '40%', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, padding: '4px 8px', border: '1px solid var(--rr-border)', borderRadius: 4, background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', cursor: 'pointer', textAlign: 'left' } as CSSProperties,
	// Run and Run all, or Stop waiting in their place: one slot, at least as wide while a run is out as before it.
	runSlot: (minWidth: number | undefined): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 'inherit', minWidth }),
	// The Graph / Table / Raw switch, at least as wide while a run is out (its counts gone) as before it.
	views: (minWidth: number | undefined): CSSProperties => ({ minWidth }),
	// The run bar's state text ("Will run…", "Running…", "Waiting…"): line breaking counts only its 120 px minimum,
	// whatever it says, and it takes the room left on its line (up to 260 px). It can hold the focus (see the run slot).
	runState: (focused: boolean): CSSProperties => ({
		flex: '1 1 0',
		minWidth: 120,
		maxWidth: 260,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		// Holding the focus (parked from the run slot), it shows the focus ring like a control.
		outline: focused ? '2px solid var(--rr-border-focus)' : 'none',
		outlineOffset: 2,
		borderRadius: 3,
	}),
	willRun: { flex: '0 1 auto', maxWidth: 260, fontSize: 12, color: 'var(--rr-text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	notices: { padding: '6px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	resultsRow: { flex: 1, minHeight: 0, display: 'flex' } as CSSProperties,
	results: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '2px 24px 6px' } as CSSProperties,
	body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', outline: 'none' } as CSSProperties,
	// Full screen: the graph's area covers the whole document (the host document root is the positioned ancestor). The
	// host hides the document meanwhile (onFullScreen); this area alone is visible again.
	maximized: { position: 'absolute', inset: 0, zIndex: 20, display: 'flex', flexDirection: 'column', background: 'var(--rr-bg-default)', outline: 'none', visibility: 'visible' } as CSSProperties,
	fill: { flex: 1, minHeight: 0 } as CSSProperties,
	footer: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 } as CSSProperties,
	notes: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } as CSSProperties,
	notesHeadlines: { fontSize: 12, color: 'var(--rr-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as CSSProperties,
	notesList: { margin: '2px 0 0', paddingLeft: 20, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
};

/** The row-limit choices as the toggle shows them. */
const LIMIT_OPTIONS = ROW_LIMIT_CHOICES.map((choice) => ({ id: choice === null ? 'all' : String(choice), label: choice === null ? 'All' : choice.toLocaleString('en-US') }));

/**
 * How a tab's graph is shown. The graph view is mounted only while its tab is shown, so the tab keeps these and hands
 * them to it (DA-R1 I-2): a tab switch no longer resets Tree to Force, unpins nodes or reopens the legend.
 */
export interface IGraphViewState {
	layoutMode: LayoutMode;
	keepPinned: boolean;
	legendOpen: boolean;
}

/** A new tab's graph: Force, dragged nodes kept pinned, the legend closed. */
export const DEFAULT_GRAPH_VIEW: IGraphViewState = Object.freeze({ layoutMode: 'force', keepPinned: true, legendOpen: false });

/** A gate's subscription and state for a surface that has none. */
const NO_GATE = { subscribe: (): (() => void) => () => undefined, busy: (): string | null => null };


/**
 * A short, unique id for a history entry.
 *
 * @returns A string.
 */
function entryId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The first line with text, for the one-line editor.
 *
 * @param text - The editor text.
 * @returns The line, trimmed ('' for an empty editor).
 */
export function firstLineOf(text: string): string {
	return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

// =============================================================================
// SMALL PARTS
// =============================================================================

/**
 * A banner whose long text shows its first sentence, with the rest behind Details.
 *
 * @param props - The variant and the text.
 * @returns The banner.
 */
export const NoticeBanner: React.FC<{ variant: 'info' | 'warning' | 'error'; text: string }> = ({ variant, text }) => {
	const [open, setOpen] = useState(false);
	const { headline, details } = splitNotice(text);
	if (text.length <= NOTICE_HEADLINE_MAX || details === '') return <Banner variant={variant}>{text}</Banner>;
	return (
		<Banner variant={variant}>
			{headline}{' '}
			<Button variant="ghost" small ariaExpanded={open} onClick={() => setOpen((value) => !value)}>
				{open ? 'Hide details' : 'Details'}
			</Button>
			{open && <div style={{ marginTop: 4 }}>{details}</div>}
		</Banner>
	);
};

/**
 * The result's notes: one line with a count and the headlines, the full sentences behind it.
 *
 * @param props - The notes.
 * @returns The line.
 */
const NotesLine: React.FC<{ notes: readonly IResultNote[] }> = ({ notes }) => {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<div style={styles.notes}>
				<Button variant="ghost" small ariaExpanded={open} onClick={() => setOpen((value) => !value)}>
					{`Notes (${notes.length})`}
				</Button>
				{!open && <span style={styles.notesHeadlines}>{notes.map((note) => note.headline).join(' · ')}</span>}
			</div>
			{open && (
				<ul style={styles.notesList}>
					{notes.map((note) => (
						<li key={note.id}>{note.details}</li>
					))}
				</ul>
			)}
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The run surface.
 *
 * @param props - See {@link IRunSurfaceProps}.
 * @returns The surface.
 */
export const RunSurface: React.FC<IRunSurfaceProps> = ({ endpoint, mode, paused = null, loadSlot, loadSeq, tabId = 'main', draftKey: draftKeyProp, defaultText, active = true, onTextChange, onOpenHistory, historyOpen, onOpenSaved, savedOpen, onAsk, askOpen, onNewQuery, barHost, gate, onFullScreen }) => {
	const env = useGraphEnv();
	const prefs = env.prefs;
	const { probes } = useGraphEndpoints();
	const schemaLabels = useSchemaLabels(endpoint.key);
	const schemaView = useSchemaView(endpoint.key);
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const writable = dialectCanWrite(dialect);
	// Apache AGE reports result rows where the others report a count of changes: the write console says so.
	const notReported = affectedNotReported(mode, dialect?.dialect);
	const announce = useCallback((text: string) => announcer.announce(text), []);
	// Why nothing may be sent right now (statements and graph actions alike), or null.
	const blocked = !env.ready ? 'The shell is not connected to the engine.' : paused;

	// ── The session on this endpoint (the token never leaves the store) ──────
	// Keyed on the endpoint's KEY, not its object: background discovery hands back a new object for the same
	// connection, and a new session here would rebuild the graph session below and drop what the user is looking at.
	const endpointRef = useRef(endpoint);
	endpointRef.current = endpoint;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const session = useMemo(() => env.session(endpointRef.current), [env, endpoint.key]);
	// Recipes (expand, connect, inspect) get their own ticket, so they never expire a statement in flight.
	const recipeGeneration = useRef(createGeneration());
	useEffect(() => {
		const current = recipeGeneration.current;
		return () => current.invalidate();
	}, [endpoint.key]);

	// ── Editor, limit, drafts ────────────────────────────────────────────────
	const draftKey = draftKeyProp === undefined ? `${mode}:${endpoint.key}` : draftKeyProp;
	const [text, setText] = useState<string>(() => {
		const bag = draftKey === null ? null : prefs.getPref(DRAFTS_PREF_KEY);
		const saved = bag && typeof bag === 'object' && draftKey !== null ? (bag as Record<string, unknown>)[draftKey] : undefined;
		return typeof saved === 'string' ? saved : defaultText ?? (mode === 'read' ? 'MATCH (n) RETURN n LIMIT 25' : '');
	});
	const [limitId, setLimitId] = useState<string>(String(DEFAULT_ROW_LIMIT));
	const limitChoice = limitId === 'all' ? null : Number(limitId);
	const editor = useRef<IQueryEditorHandle | null>(null);
	const [view, setView] = useState<IEditorSnapshot | null>(null);
	const latestText = useRef(text);
	latestText.current = text;
	// The write console is also offered the write clauses.
	const completion = useMemo(() => ({ schema: schemaView, dialect: dialect?.dialect ?? null, ...(mode === 'write' ? { writes: true } : {}) }), [schemaView, dialect, mode]);

	// The host hears every text, the first one included (what "Save current query" saves).
	const textListener = useRef(onTextChange);
	textListener.current = onTextChange;
	useEffect(() => {
		textListener.current?.(text);
	}, [text]);

	// Save drafts per connection (text only), debounced. A tab without a draft key keeps its text for the session.
	const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The write still waiting for its timer: done at once if the surface goes (Query 1's tab closed right after typing).
	const pendingDraft = useRef<(() => void) | null>(null);
	const changeText = useCallback((next: string) => {
		setText(next);
		if (draftKey === null) return;
		if (draftTimer.current) clearTimeout(draftTimer.current);
		const write = (): void => {
			pendingDraft.current = null;
			const bag = prefs.getPref(DRAFTS_PREF_KEY);
			const base = bag && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
			prefs.setPref(DRAFTS_PREF_KEY, { ...base, [draftKey]: next.slice(0, 20_000) });
		};
		pendingDraft.current = write;
		draftTimer.current = setTimeout(write, 600);
	}, [prefs, draftKey]);
	useEffect(() => () => {
		if (draftTimer.current) clearTimeout(draftTimer.current);
		pendingDraft.current?.();
	}, []);

	// What the "Will run" sentence describes: one live read of the editor, taken when the caret settles or the text changes.
	const syncCursor = useCallback(() => {
		const handle = editor.current;
		if (handle) setView(handle.snapshot());
	}, []);
	// Typing moves the caret, but a text that is replaced from outside (History, a label preview, a draft) may not.
	useEffect(() => {
		const timer = setTimeout(syncCursor, 200);
		return () => clearTimeout(timer);
	}, [text, syncCursor]);

	// ── The editor's height (the divider), kept in the prefs ─────────────────
	const rootRef = useRef<HTMLDivElement | null>(null);
	const editorId = `graph-editor${useId().replace(/:/g, '')}`;
	const [surfaceHeight, setSurfaceHeight] = useState<number | null>(null);
	useEffect(() => {
		const el = rootRef.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		// A hidden tab measures 0: its last real size stands until it is shown again.
		const observer = new ResizeObserver(() => {
			if (el.clientHeight > 0) setSurfaceHeight(el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const available = surfaceHeight === null ? null : Math.max(0, surfaceHeight - SURFACE_CHROME);
	const [split, setSplitState] = useState<IEditorSplit>(() => ({ height: storedEditorHeight(prefs.getPref(EDITOR_HEIGHT_PREF_KEY)), collapsed: false }));
	const heightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const focusEditorNext = useRef(false);
	const changeSplit = useCallback((next: IEditorSplit) => {
		setSplitState(next);
		if (heightTimer.current) clearTimeout(heightTimer.current);
		heightTimer.current = setTimeout(() => prefs.setPref(EDITOR_HEIGHT_PREF_KEY, next.height), 600);
	}, [prefs]);
	useEffect(() => () => { if (heightTimer.current) clearTimeout(heightTimer.current); }, []);
	useEffect(() => {
		if (split.collapsed || !focusEditorNext.current) return;
		focusEditorNext.current = false;
		editor.current?.focus();
	}, [split.collapsed]);
	// Within the bounds of the space there is now (the document may have shrunk since the height was kept).
	const editorHeight = clampEditorHeight(split.height, available);

	// ── The runner (shared) configured for Cypher ────────────────────────────
	// The write confirmation waiting for an answer. WriteConfirmDialog is mounted while it is set, and puts the focus on
	// Cancel from its own mount effect (see its header for why the effect lives there).
	const [confirm, setConfirm] = useState<{ content: IWriteConfirmation; targets: IRunTarget[] } | null>(null);
	const failureNotes = useRef<IFailureNotice | null>(null);
	const runner = useStatementRunner<IGraphRun, { cypher: string; limit: number }, ReadQueryResult, IFailureNotice & { verbatim: string }>({
		canRun: () => env.ready && session !== null && paused == null,
		initRun: (target, index) => {
			const prepared = prepareStatement(target.text, limitChoice, dialect);
			return { index, cypher: target.text, kind: prepared.kind, verb: prepared.verb, outcome: 'pending', ...(target.start !== undefined ? { start: target.start } : {}), ...(target.end !== undefined ? { end: target.end } : {}), ...(target.startLine !== undefined ? { startLine: target.startLine } : {}), ...(target.endLine !== undefined ? { endLine: target.endLine } : {}) };
		},
		textOf: (run) => run.cypher,
		refuse: mode === 'read' ? (runs) => refuseNonReads(runs.map((r) => prepareStatement(r.cypher, limitChoice, dialect)), writable) : undefined,
		prepare: (run) => {
			const p = prepareStatement(run.cypher, limitChoice, dialect);
			return { send: { cypher: p.cypher, limit: p.limit }, patch: limitPatch(mode, p.limit) };
		},
		execute: async (_run, send, ticket) => {
			if (!session) throw new ExplorerToolError({ kind: 'unavailable', tool: mode === 'read' ? TOOL.readQuery : TOOL.execute, message: 'This connection is not available.' });
			const read = (): Promise<ReadQueryResult> => session.invoke<ReadQueryResult>(TOOL.readQuery, { cypher: send.cypher, params: {}, limit: send.limit }, { generation: ticket });
			const write = (): Promise<ReadQueryResult> => session.invoke<ReadQueryResult>(TOOL.execute, { query: send.cypher, shape: 'graph' }, { generation: ticket });
			return mode === 'read'
				? (gate ? gate.send(TOOL.readQuery, read) : read())
				// Counted in the call (the dev-tool controller counts it itself), so a write that lands after this console
				// closed still marks drawn graphs out of date. The gate is inside the count: a write it refused was never
				// sent, and changes nothing.
				: env.countWrite(endpoint.key, () => (gate ? gate.send(TOOL.execute, write) : write()));
		},
		settle: (_run, result) => settleRun(mode, result, dialect?.dialect ?? null),
		describeFailure: (message, error) => {
			const notice = isGateRefusal(error) ? gateRefusalNotice(message) : mode === 'write' ? describeWriteFailure(message, error) : describeFailureOf(message, error, writable);
			failureNotes.current = notice;
			return notice as IFailureNotice & { verbatim: string };
		},
		formatPrior: (runs, index) => formatPriorStatements(runs, index, GRAPH_BATCH_WORDS),
		record: (run) => {
			// A write is counted where it is sent (countWrite); one the user stopped waiting for may still complete, so it
			// makes every graph drawn from this connection out of date now, in every document.
			if (isAbandonedWrite(mode, run.outcome)) env.markAbandonedWrite(endpoint.key);
			// A statement the gate refused was never sent: History keeps only what ran.
			if (run.outcome === 'error' && isGateRefusalText(run.error)) return;
			env.history.record(endpoint.key, toHistoryEntry(historySummaryOf(run, Date.now(), { affectedNotReported: notReported }), entryId()));
		},
		summarize: ({ shown, runs }) => {
			if (shown?.result) {
				const s = summarizeResult(shown.result);
				const affected = shown.outcome === 'affected' ? `${changesText(shown.affected ?? 0)} (${CHANGES_NOTE}). ` : notReported ? `${AGE_AFFECTED_NOT_REPORTED}. ` : '';
				const said = `${affected}${resultAnnouncement(shown.result.rows.length, s.nodeCount, s.relationshipCount, truncationText(shown.result))}`;
				return runs.length > 1 ? `${formatBatchOutcome(runs, GRAPH_BATCH_WORDS)}. ${said}` : said;
			}
			return null;
		},
		announce,
		batchWords: GRAPH_BATCH_WORDS,
	});

	// ── The selected run's result drives the tabs and the graph ───────────────
	const displayed: IGraphRun | null = runner.selectedRun !== null ? runner.runs[runner.selectedRun] ?? null : null;
	const result = displayed?.result ?? null;
	const summary = useMemo(() => (result ? summarizeResult(result) : null), [result]);
	// A tab that has not run opens on Graph (with its "Run a query" state), never on an empty Table.
	const [tab, setTab] = useState<ResultTab>('graph');
	const resultKey = useRef(0);
	useEffect(() => {
		if (!summary) return;
		resultKey.current += 1;
		setTab(chooseTab(summary));
	}, [result, summary]);
	const notes = useMemo(() => (summary ? resultNotes(summary) : []), [summary]);

	// The graph session lives as long as the connection: a new result replaces what it draws (load), but nothing that
	// merely re-probes the node, refreshes discovery or re-renders this component may rebuild it, because that would
	// silently drop the selection, the inspector, every expansion and the stale marks. What changes over time is read
	// through refs.
	const latest = useRef({ dialect, writable, session, announce, blocked, gate });
	latest.current = { dialect, writable, session, announce, blocked, gate };
	// `endpoint.key` is the whole dependency on purpose: one graph session per connection.
	const graphSession = useMemo<IGraphSession>(() => createGraphSession({
		engine: () => (latest.current.dialect ? { dialect: latest.current.dialect.dialect, version: latest.current.dialect.engineVersion, shortestPath: latest.current.dialect.capabilities.shortest_path === true } : null),
		invoke: (recipe) => {
			const current = latest.current.session;
			if (!current) throw new ExplorerToolError({ kind: 'unavailable', tool: TOOL.readQuery, message: 'This connection is not available.' });
			const read = (): Promise<ReadQueryResult> => current.invoke<ReadQueryResult>(TOOL.readQuery, { cypher: recipe.cypher, params: recipe.params, limit: recipe.limit }, { generation: recipeGeneration.current.next() });
			const through = latest.current.gate;
			return through ? through.send(TOOL.readQuery, read) : read();
		},
		describe: (error) => (isGateRefusal(error) ? gateRefusalNotice((error as Error).message) : describeFailureOf(error instanceof Error ? error.message : String(error), error, latest.current.writable)),
		announce: (text) => latest.current.announce(text),
		captionChoice: (label) => captionsRef.current.get(label),
		paused: () => latest.current.blocked,
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}), [endpoint.key]);
	// Dispose once, when the session is replaced or the surface goes away: NOT on every new result. `dispose` ends
	// everything in flight; a result change only needs `load`.
	useEffect(() => () => graphSession.dispose(), [graphSession]);
	// The version of this connection's data when the graph was drawn: a later write marks the drawing out of date.
	const version = useDataVersion(endpoint.key);
	const drawnAt = useRef(version);
	// Read through a ref: the env is rebuilt when the connection flag flips, and that must not reload the result.
	const versions = useRef(env.dataVersions);
	versions.current = env.dataVersions;
	useEffect(() => {
		drawnAt.current = versions.current.get(endpoint.key);
		graphSession.load(result);
	}, [graphSession, result, endpoint.key]);
	useEffect(() => {
		if (version !== drawnAt.current) graphSession.markStale();
	}, [version, graphSession]);

	// ── Captions: kept with the connection's style (env.userData, a label's `caption`) ──
	// The graph view shows and edits them there; the session reads them for the names it says out loud.
	const styleView = useConnectionStyle(endpoint.key);
	const captions = useMemo<ReadonlyMap<string, string>>(() => {
		const out = new Map<string, string>();
		for (const [label, style] of Object.entries(styleView.style.labels)) if (style.caption) out.set(label, style.caption);
		return out;
	}, [styleView]);
	const captionsRef = useRef(captions);
	captionsRef.current = captions;

	// ── Running ──────────────────────────────────────────────────────────────
	// How the last batch was taken: the whole editor (Run all), part of it, or text from elsewhere (a rerun).
	const lastBatch = useRef<'all' | 'editor' | 'other'>('other');
	// The editor text the last batch was taken from (null when it came from elsewhere): a failure is placed in it.
	const batchBuffer = useRef<string | null>(null);
	// Why the last press sent nothing, shown until the next one starts (a gate refusal: until the gate frees).
	const [startRefusal, setStartRefusal] = useState<string | null>(null);
	const gateBusy = useSyncExternalStore(gate ? gate.subscribe : NO_GATE.subscribe, gate ? gate.busy : NO_GATE.busy, gate ? gate.busy : NO_GATE.busy);
	useEffect(() => {
		if (gateBusy === null) setStartRefusal((current) => (isGateRefusalText(current) ? null : current));
	}, [gateBusy]);
	const startRun = useCallback((targets: IRunTarget[], fromEditor: boolean) => {
		// A press while a batch runs (keyboard, History), while the surface is paused, or while another request of the
		// workbench is still on the database is refused out loud, never dropped.
		const refusal = runRefusal({ running: runner.running, blocked, busy: gate?.busy() ?? null });
		setStartRefusal(refusal);
		if (refusal !== null) {
			announce(refusal);
			return;
		}
		if (targets.length === 0) {
			announce('Nothing to run.');
			return;
		}
		if (mode === 'write') {
			const content = describeWrites(targets);
			if (content.needed) {
				setConfirm({ content, targets });
				return;
			}
		}
		void runner.runTargets(targets, { fromEditor });
	}, [mode, runner, announce, blocked, gate]);

	// Run reads the buffer, the selection and the caret from the LIVE editor in one call. The `text` state is a copy that
	// lags a render behind fast typing; a caret taken from the editor against that copy points past its end and the run
	// would send a truncated statement.
	// While the graph fills the document the editor is hidden: a run key that still reaches it sends nothing.
	const fullScreenNow = useRef(false);
	// The run bar's Run / Run all slot, and whether the focus is in it (see the layout effect by the run bar).
	const runSlot = useRef<HTMLSpanElement | null>(null);
	const runSlotFocused = useRef(false);
	const run = useCallback((all: boolean) => {
		if (fullScreenNow.current) return;
		const handle = editor.current;
		const targets = handle ? targetsFromEditor(handle, all) : targetsFromEditor({ snapshot: () => ({ text: latestText.current, start: 0, end: 0, caret: latestText.current.length }) }, all);
		lastBatch.current = all ? 'all' : 'editor';
		batchBuffer.current = handle ? handle.snapshot().text : latestText.current;
		startRun(targets, true);
	}, [startRun]);

	// "Run from statement N" in the failure banner: after a Run all, the editor's statements from N on as they are now
	// (the failed one may have been fixed); after any other batch, that batch's own statements from N on.
	const runFrom = useCallback((index: number) => {
		const handle = editor.current;
		const fromEditor = lastBatch.current === 'all' && handle !== null;
		const targets: IRunTarget[] = fromEditor ? targetsFromEditor(handle, true) : runner.runs.map((r) => ({ text: r.cypher }));
		batchBuffer.current = fromEditor ? handle.snapshot().text : null;
		startRun(targets.slice(index), fromEditor);
	}, [runner.runs, startRun]);

	// The status line's Rerun: the statement shown, as it was sent.
	const rerun = useCallback(() => {
		if (!displayed) return;
		lastBatch.current = 'other';
		batchBuffer.current = null;
		startRun([{ text: displayed.cypher }], false);
	}, [displayed, startRun]);

	// A request from the host: put text in the editor (or insert it at the caret), and for a click on a label run it.
	// The request is TAKEN from the host's slot, so a surface that mounts again finds nothing to replay.
	useEffect(() => {
		const request = loadSlot.take();
		if (!request) return;
		let next = request.text;
		if (request.insert) {
			// The live buffer when the editor holds the text the surface knows; otherwise (not mounted yet) the end of the text.
			const live = editor.current?.snapshot();
			const base = live && live.text === latestText.current ? live : { text: latestText.current, start: latestText.current.length, end: latestText.current.length };
			next = base.text.slice(0, base.start) + request.text + base.text.slice(base.end);
		}
		editor.current?.setText(next);
		changeText(next);
		if (request.run && !request.insert) {
			lastBatch.current = 'other';
			batchBuffer.current = null;
			startRun([{ text: next }], false);
		}
	}, [loadSlot, loadSeq]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Where the database's error text puts the failure (graph/errorPosition.ts) ──
	// Placed only while the editor still holds the text the batch was taken from; the editor drops the mark on the next
	// edit, and a new run starts without one.
	const location = useMemo(() => {
		const failure = runner.failure;
		const buffer = batchBuffer.current;
		if (!failure || buffer === null || buffer !== text) return null;
		const failed = runner.runs[failure.index];
		if (!failed || failed.start === undefined || failed.end === undefined) return null;
		return locateFailure(buffer, { start: failed.start, end: failed.end }, failure.notice.verbatim, dialect?.dialect ?? null);
	}, [runner.failure, runner.runs, text, dialect]);
	const markers = useMemo(() => {
		if (!location || !runner.failure) return undefined;
		const said = runner.failure.notice.verbatim.split('\n')[0] || runner.failure.notice.headline;
		return [{ start: location.start, end: location.end, message: said, severity: 'error' as const }];
	}, [location, runner.failure]);

	// ── Full screen (in the document) ────────────────────────────────────────
	const [maximizeWanted, setMaximizeWanted] = useState(false);
	// How this tab's graph is shown: kept here, so it outlives the graph view, which a hidden tab does not mount.
	const [graphView, setGraphView] = useState<IGraphViewState>(DEFAULT_GRAPH_VIEW);
	const setLayoutMode = useCallback((layoutMode: LayoutMode) => setGraphView((current) => ({ ...current, layoutMode })), []);
	const setKeepPinned = useCallback((keepPinned: boolean) => setGraphView((current) => ({ ...current, keepPinned })), []);
	const setLegendOpen = useCallback((legendOpen: boolean) => setGraphView((current) => ({ ...current, legendOpen })), []);
	// Only the graph of a shown tab fills the document; anything else (a new result opening as a Table, the tab
	// hidden) leaves full screen.
	const maximized = maximizeWanted && active && tab === 'graph' && result !== null;
	useEffect(() => {
		if (maximizeWanted && !maximized) setMaximizeWanted(false);
	}, [maximizeWanted, maximized]);
	fullScreenNow.current = maximized;
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const wasMaximized = useRef(false);
	const fullScreenListener = useRef(onFullScreen);
	fullScreenListener.current = onFullScreen;
	useEffect(() => {
		if (maximized === wasMaximized.current) return;
		wasMaximized.current = maximized;
		// The host hides what the graph covers, and shows it again on the way out.
		fullScreenListener.current?.(maximized);
		announce(maximized ? FULL_SCREEN_TEXT : 'Left full screen.');
		// The Exit button goes away with full screen: keep the focus in the results rather than lose it to the page.
		const focused = document.activeElement;
		if (!maximized && (focused === null || focused === document.body)) bodyRef.current?.focus();
	}, [maximized, announce]);
	// A surface that goes while it fills the document (its tab closed) gives the document back.
	useEffect(() => () => {
		if (wasMaximized.current) fullScreenListener.current?.(false);
	}, []);
	const toggleMaximized = useCallback(() => setMaximizeWanted((value) => !value), []);

	// ── Row inspector (Table) ────────────────────────────────────────────────
	const [openRow, setOpenRow] = useState<number | null>(null);
	useEffect(() => setOpenRow(null), [result]);
	useEffect(() => {
		if (!active) setOpenRow(null);
	}, [active]);
	const rowView = result && openRow !== null && result.rows[openRow] ? inspectorTextOfRow(result.columns, result.rows[openRow]) : null;

	// ── Meta line ────────────────────────────────────────────────────────────
	const metaText = result ? resultMeta(displayed, result, notReported) : '';
	const truncation = result ? truncationText(result) : null;
	const metaLine = `${metaText}${truncation ? ` · ${truncation}` : ''}`;
	const willRun = describeSnapshot(view ?? { text, start: 0, end: 0, caret: 0 });
	const strip = runner.runs.length > 1;
	const showNotices = blocked !== null || startRefusal !== null || runner.refusal !== null || runner.failure !== null || runner.abandonNotice !== null || strip;
	// Run waits while the gate is held (another tab's request, or one this tab stopped waiting for), and says why.
	const waiting = gateBusy !== null && !runner.running;

	// How the result is shown, with its counts: one compact switch in the run bar.
	const views: { id: ResultTab; label: string }[] = useMemo(() => [
		{ id: 'graph', label: summary && summary.drawable ? `Graph (${num(summary.nodeCount)})` : 'Graph' },
		{ id: 'table', label: result ? `Table (${num(result.rows.length)})` : 'Table' },
		{ id: 'raw', label: 'Raw' },
	], [summary, result]);
	// In the control row the controls are the compact size, so the row stays one line of small buttons.
	const inRow = barHost !== undefined;

	const emptyTitle = runner.running ? 'Waiting for the node' : runner.failure ? 'Statement failed' : runner.refusal ? 'Nothing ran' : mode === 'read' ? 'Run a query' : 'Nothing executed yet';
	const emptyText = runner.running
		? 'The statement has been sent.'
		: runner.failure
			? 'The error is above. Fix the statement and run it again.'
			: runner.refusal
				? 'Change the statement to a read, then run it again.'
				: mode === 'read'
					? 'Run sends the statement as a read (read_query). Results with nodes open as a graph; everything else opens as a table.'
					: 'Execute sends the statements through execute. The ones that look like they change data are listed for you to confirm first.';
	const showEditor = (): void => {
		focusEditorNext.current = true;
		changeSplit(splitToggled(split));
	};

	// The focus was in the run slot (Run, Run all, or Stop waiting) when this tab's run changed: the button it was on is
	// gone or disabled, so the slot's button takes it when it can be pressed, and otherwise the state text beside it,
	// which says why (parked). Parked focus moves back to Run once Run can be pressed again. Only this tab's run moves a
	// lost focus, so another tab's request freeing the gate never takes the focus from the page.
	const runState = useRef<HTMLSpanElement | null>(null);
	const parkedFromSlot = useRef(false);
	const [runStateFocused, setRunStateFocused] = useState(false);
	const lastRun = useRef({ canStop: runner.canStop, running: runner.running });
	useLayoutEffect(() => {
		const runChanged = lastRun.current.canStop !== runner.canStop || lastRun.current.running !== runner.running;
		lastRun.current = { canStop: runner.canStop, running: runner.running };
		const focused = document.activeElement;
		const lost = focused === null || focused === document.body || !focused.isConnected;
		const stuck = focused instanceof HTMLButtonElement && focused.disabled && runSlot.current?.contains(focused) === true;
		const parked = parkedFromSlot.current && focused === runState.current;
		if (!parked && !(runChanged && runSlotFocused.current && (lost || stuck))) return;
		const button = runSlot.current?.querySelector<HTMLButtonElement>('button');
		if (button && !button.disabled) {
			parkedFromSlot.current = false;
			button.focus();
		} else if (!parked && runState.current) {
			parkedFromSlot.current = true;
			runState.current.focus();
		}
	}, [runner.canStop, runner.running, gateBusy]);
	// While a run is out, the run slot (Stop waiting in place of Run and Run all) and the result switch (no counts until
	// the result) keep at least the widths they had before it, measured here while none is: every other control has a
	// width a run does not change, so the bar's lines break where they did and a run never moves a control to another line.
	const viewsGroup = useRef<HTMLSpanElement | null>(null);
	const [held, setHeld] = useState<{ slot: number; views: number } | null>(null);
	const runOut = runner.running || runner.canStop;
	useLayoutEffect(() => {
		if (runOut || !runSlot.current || !viewsGroup.current) return;
		const next = { slot: runSlot.current.getBoundingClientRect().width, views: viewsGroup.current.getBoundingClientRect().width };
		// In a hidden document or panel (display: none) everything measures 0: keep what was measured while shown.
		if (next.slot === 0 || next.views === 0) return;
		setHeld((prev) => (prev !== null && prev.slot === next.slot && prev.views === next.views ? prev : next));
	}, [runOut, views, mode, inRow, active, barHost]);
	// What the state text says; also its title, since its width can cut it.
	const runStateText = runner.running ? 'Running…' : waiting ? 'Waiting for an earlier request to finish…' : willRun;
	const runBar = (
		<div style={barHost === undefined ? styles.runBar : styles.runBarInRow}>
			{split.collapsed && (
				<button type="button" style={styles.firstLine} title="Show the editor" onClick={showEditor}>
					{firstLineOf(text) || '(empty)'}
				</button>
			)}
			<span
				ref={runSlot}
				style={styles.runSlot(runOut ? held?.slot : undefined)}
				onFocus={() => {
					runSlotFocused.current = true;
				}}
				onBlur={(event) => {
					// Focus going nowhere (its button removed or disabled) still belongs to the slot; focus going elsewhere does not.
					if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget as Node)) runSlotFocused.current = false;
				}}
			>
				{runner.canStop ? (
					<Button variant="ghost" small={inRow} title={STOP_WAITING_NOTE} onClick={() => runner.stopWaiting()}>
						Stop waiting
					</Button>
				) : (
					<>
						<Button variant="primary" disabled={runner.running || blocked !== null || gateBusy !== null} onClick={() => run(false)} small={inRow} title={waiting ? gateWaitingTitle(mode === 'read' ? 'Run' : 'Execute') : 'Run the selection or the statement at the caret (Ctrl/Cmd+Enter)'}>
							{mode === 'read' ? 'Run' : 'Execute'}
						</Button>
						<Button variant="ghost" disabled={runner.running || blocked !== null || gateBusy !== null} onClick={() => run(true)} small={inRow} title={waiting ? gateWaitingTitle(mode === 'read' ? 'Run all' : 'Execute all') : 'Run every statement in order (Ctrl/Cmd+Shift+Enter)'}>
							{mode === 'read' ? 'Run all' : 'Execute all'}
						</Button>
					</>
				)}
			</span>
			{mode === 'read' && (
				// The shell's ToggleGroup drops aria-label, so the group's name is on a wrapper.
				<span role="group" aria-label="Row limit">
					<ToggleGroup options={LIMIT_OPTIONS} value={limitId} onChange={(id) => setLimitId(id)} />
				</span>
			)}
			{onOpenHistory && <Button variant="ghost" small={inRow} ariaExpanded={historyOpen === true} onClick={onOpenHistory}>History</Button>}
			{onOpenSaved && <Button variant="ghost" small={inRow} ariaExpanded={savedOpen === true} onClick={onOpenSaved}>Saved</Button>}
			{onAsk && (
				<span data-ask-toggle="">
					<Button variant="ghost" small={inRow} ariaExpanded={askOpen === true} title="Ask the node's language model to draft Cypher; the draft opens in a new tab, not run" onClick={onAsk}>Ask</Button>
				</span>
			)}
			{mode === 'read' && dialect && (() => {
				const chip = rowLimitChip(limitChoice, dialect);
				return <span title={chip.title ?? undefined}><StatusBadge variant="muted">{chip.text}</StatusBadge></span>;
			})()}
			<span
				ref={runState}
				tabIndex={-1}
				style={styles.runState(runStateFocused)}
				title={runStateText}
				onFocus={() => setRunStateFocused(true)}
				onBlur={() => {
					parkedFromSlot.current = false;
					setRunStateFocused(false);
				}}
			>
				{runStateText}
			</span>
			<span ref={viewsGroup} role="group" aria-label="Show the result as" style={styles.views(runOut ? held?.views : undefined)}>
				<ToggleGroup options={views} value={tab} onChange={(id) => setTab(id)} />
			</span>
			<Button variant="ghost" small ariaExpanded={!split.collapsed} title={split.collapsed ? 'Show the editor' : 'Hide the editor; the run bar stays'} onClick={() => (split.collapsed ? showEditor() : changeSplit(splitToggled(split)))}>
				{split.collapsed ? 'Show editor' : 'Hide editor'}
			</Button>
		</div>
	);

	return (
		<div ref={rootRef} style={styles.root}>
			{/* In the row under the tabs while this tab is shown (the workbench); under the editor otherwise (the write console). */}
			{barHost !== undefined && active && barHost !== null && createPortal(runBar, barHost)}
			<div style={styles.editorRegion(split.collapsed && barHost !== undefined)}>
				<div id={editorId} style={styles.editorBox(editorHeight, split.collapsed)}>
					<QueryEditor ref={editor} value={text} onChange={changeText} onRun={() => run(false)} onRunAll={() => run(true)} onCursorChange={syncCursor} label={mode === 'read' ? 'Cypher query' : 'Cypher statements to execute'} completion={completion} markers={markers} warnWrites={mode === 'read'} />
				</div>
				{barHost === undefined && runBar}
			</div>
			{/* Mounted while the editor is hidden too, so Home keeps the focus here and End shows the editor again. */}
			{/* With the editor hidden in the workbench, the bar sits 3 px over the control row's 4 px bottom padding (no
			    control reaches it), so the hidden editor costs 6 px, not 11. */}
			<SplitDivider split={{ height: editorHeight, collapsed: split.collapsed }} available={available} onChange={changeSplit} label="Editor and results" controls={editorId} overlap={split.collapsed && barHost !== undefined ? 3 : 0} />

			{showNotices && (
				<div style={styles.notices}>
					{blocked && <NoticeBanner key={blocked} variant="warning" text={blocked} />}
					{startRefusal && <NoticeBanner key={startRefusal} variant="warning" text={startRefusal} />}
					{runner.refusal && <NoticeBanner key={runner.refusal} variant="warning" text={runner.refusal} />}
					{runner.failure && <GraphFailureBanner failure={runner.failure} genericText="The node's message was not returned. The pipeline node's log has it." extra={runner.failure.notice.hint ? <div style={{ marginTop: 4 }}>{runner.failure.notice.hint}</div> : null} total={runner.runs.length} position={location ? { line: location.line, column: location.column } : null} onRunFrom={mode === 'read' ? runFrom : undefined} />}
					{runner.abandonNotice && <NoticeBanner key={runner.abandonNotice} variant="warning" text={runner.abandonNotice} />}
					{strip && <StatementStrip runs={runner.runs} selected={runner.selectedRun} onSelect={(i) => runner.setSelectedRun(i)} labelOf={(r) => graphRunLabel(r)} ariaLabel="Statements in the last run" />}
					{strip && !runner.running && <div style={styles.willRun}>{formatBatchOutcome(runner.runs, GRAPH_BATCH_WORDS)}</div>}
				</div>
			)}

			<div style={styles.resultsRow}>
				<div style={styles.results}>
					<div
						ref={bodyRef}
						tabIndex={-1}
						style={maximized ? styles.maximized : styles.body}
						onKeyDown={(event) => {
							// Escape that nothing inside used (the inspector, a menu, the canvas's own selection) leaves full screen.
							if (event.defaultPrevented || !maximized || event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return;
							event.preventDefault();
							setMaximizeWanted(false);
						}}
					>
						{/* Only the shown tab draws: a hidden tab keeps its result and graph session, not a canvas or a grid. */}
						{active && (
							<div style={styles.fill}>
								{!result ? (
									<EmptyState icon={<GraphIcon />} title={emptyTitle} description={emptyText} />
								) : tab === 'graph' ? (
									<GraphView
										session={graphSession}
										schemaLabels={schemaLabels}
										captions={captions}
										onInspect={(id) => graphSession.inspect({ kind: 'node', id })}
										seedKey={`${endpoint.key}:${resultKey.current}`}
										announce={announce}
										endpointKey={endpoint.key}
										meta={metaLine}
										onRerun={rerun}
										onNewQuery={onNewQuery}
										maximized={maximized}
										onToggleMaximized={toggleMaximized}
										layoutMode={graphView.layoutMode}
										onLayoutModeChange={setLayoutMode}
										keepPinned={graphView.keepPinned}
										onKeepPinnedChange={setKeepPinned}
										legendOpen={graphView.legendOpen}
										onLegendOpenChange={setLegendOpen}
										exportMode={isInVSCode() ? 'copy' : 'download'}
									/>
								) : tab === 'table' ? (
									<ResultTable result={result} tableKey={`${endpoint.key}-${tabId}-${resultKey.current}`} onRowOpen={setOpenRow} announce={announce} meta={<>{metaText}{truncation && <StatusBadge variant="warning">{truncation}</StatusBadge>}</>} />
								) : (
									<RawView result={result} announce={announce} />
								)}
							</div>
						)}
					</div>
					{(result && tab === 'raw') || notes.length > 0 ? (
						<div style={styles.footer}>
							{result && tab === 'raw' && <div style={styles.willRun}>{metaLine}</div>}
							{notes.length > 0 && <NotesLine key={resultKey.current} notes={notes} />}
						</div>
					) : null}
				</div>
				{rowView && <RowPanel title={`Row ${(openRow ?? 0) + 1} of ${result?.rows.length ?? 0}`} subtitle={displayed ? `statement ${displayed.index + 1}${displayed.ms !== undefined ? ` · ${clock(Date.now() - displayed.ms)}` : ''}` : ''} view={rowView} announce={announce} onClose={() => setOpenRow(null)} />}
			</div>

			{confirm && (
				<WriteConfirmDialog
					content={confirm.content}
					onConfirm={() => {
						const targets = confirm.targets;
						setConfirm(null);
						const refusal = runRefusal({ running: runner.running, blocked, busy: gate?.busy() ?? null });
						if (refusal !== null) {
							announce(refusal);
							return;
						}
						void runner.runTargets(targets, { fromEditor: true });
					}}
					onCancel={() => {
						setConfirm(null);
						announce('Cancelled. Nothing was sent.');
					}}
				/>
			)}
		</div>
	);
};

export default RunSurface;
