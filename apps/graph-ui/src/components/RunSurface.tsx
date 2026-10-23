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
// GRAPH-UI - RUN SURFACE (editor, runs, results and the graph, for one connection)
// =============================================================================
//
// One component serves both the browsing workbench (mode `read`: every statement
// goes through `read_query`) and the write console (mode `write`: every statement
// goes through `execute` with shape 'graph', after a confirmation that lists the
// statements the text check marks as mutating). The two modes differ in exactly
// four places: the tool called, the refusal rule, the confirmation, and the words;
// everything else - editor, drafts, runner, results tabs, the graph - is shared.
//
// The statement runner, strip, failure banner and row inspector are the shared
// Explorer ones; this file only configures them for Cypher.
//
// Everything engine-facing comes from the GraphEnv (env.ts): the session (the
// store's own in the full app, a remote one over controller ops in a dev-tool
// frame), the write count, the data versions, history and the drafts/captions
// prefs (session-only in a dev-tool mount). The runner, the graph session, path
// search and the editor stay HERE in every mount.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, EmptyState, StatusBadge, TabControl, ToggleGroup } from 'shell';
import type { ViewMenu } from 'shell';
import { ExplorerToolError, clock, createGeneration, formatBatchOutcome, formatPriorStatements, formatRunLabel, useStatementRunner } from 'shared/explorer';
import type { IExplorerEndpoint, IRunTarget, IStatementRunBase } from 'shared/explorer';
import FailureBanner from 'shared/explorer/components/FailureBanner';
import RowInspector from 'shared/explorer/components/RowInspector';
import StatementStrip from 'shared/explorer/components/StatementStrip';
import { CAPTIONS_PREF_KEY, DRAFTS_PREF_KEY, TOOL, announcer } from '../adapters/explorer';
import { useDataVersion, useGraphEndpoints, useGraphEnv, useSchemaLabels } from '../env';
import { describeSnapshot, targetsFromEditor } from '../cypher/targets';
import type { IEditorSnapshot } from '../cypher/targets';
import { DEFAULT_ROW_LIMIT, ROW_LIMIT_CHOICES } from '../graph/budgets';
import { canWrite as dialectCanWrite, parseDialect, rowLimitChip } from '../graph/dialect';
import { describeFailureOf, describeWriteFailure } from '../graph/failures';
import type { IFailureNotice } from '../graph/failures';
import { isAbandonedWrite } from '../graph/dataVersion';
import { createGraphSession } from '../graph/graphSession';
import type { IGraphSession } from '../graph/graphSession';
import { describeWrites } from '../graph/writeConfirm';
import type { IWriteConfirmation } from '../graph/writeConfirm';
import { GRAPH_BATCH_WORDS, historySummaryOf, limitPatch, prepareStatement, refuseNonReads, runRefusal, settleRun, toHistoryEntry } from '../graph/runConfig';
import { chooseTab, summarizeResult } from '../graph/results';
import type { ResultTab } from '../graph/results';
import type { ILoadSlot } from '../graph/loadSlot';
import { inspectorTextOfRow } from '../graph/rowInspect';
import type { ReadQueryResult } from '../graph/types';
import { STOP_WAITING_NOTE, num, resultAnnouncement, resultMeta, truncationText } from '../graph/wording';
import { GraphView } from './GraphView';
import InspectorPanel from './InspectorPanel';
import QueryEditor from './QueryEditor';
import type { IQueryEditorHandle } from './QueryEditor';
import { RawView, ResultTable } from './ResultViews';
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
	/** The host's mailbox for text the editor should hold (history load, Ask preview, label preview); each request is taken once. */
	loadSlot: ILoadSlot;
	/** Changes whenever the host puts a request in the slot. */
	loadSeq: number;
	/** Extra content above the editor (the Ask bar). */
	topSlot?: React.ReactNode;
	/** Told when the editor text changes (so the host can know a preview was edited). */
	onTextChange?(text: string): void;
	/** Opens the history panel. */
	onOpenHistory?(): void;
}

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as CSSProperties,
	editorRegion: { flex: '0 0 auto', padding: '12px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	editorBox: { height: 190, minHeight: 120 } as CSSProperties,
	runBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as CSSProperties,
	willRun: { fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	notices: { padding: '8px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	results: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '8px 24px 16px' } as CSSProperties,
	body: { flex: 1, minHeight: 0 } as CSSProperties,
};

/** The row-limit choices as the toggle shows them. */
const LIMIT_OPTIONS = ROW_LIMIT_CHOICES.map((choice) => ({ id: choice === null ? 'all' : String(choice), label: choice === null ? 'All' : choice.toLocaleString('en-US') }));

/**
 * A short, unique id for a history entry.
 *
 * @returns A string.
 */
function entryId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The run surface.
 *
 * @param props - See {@link IRunSurfaceProps}.
 * @returns The surface.
 */
export const RunSurface: React.FC<IRunSurfaceProps> = ({ endpoint, mode, paused = null, loadSlot, loadSeq, topSlot, onTextChange, onOpenHistory }) => {
	const env = useGraphEnv();
	const prefs = env.prefs;
	const { probes } = useGraphEndpoints();
	const schemaLabels = useSchemaLabels(endpoint.key);
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const writable = dialectCanWrite(dialect);
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
	const draftKey = `${mode}:${endpoint.key}`;
	const [text, setText] = useState<string>(() => {
		const bag = prefs.getPref(DRAFTS_PREF_KEY);
		const saved = bag && typeof bag === 'object' ? (bag as Record<string, unknown>)[draftKey] : undefined;
		return typeof saved === 'string' ? saved : mode === 'read' ? 'MATCH (n) RETURN n LIMIT 25' : '';
	});
	const [limitId, setLimitId] = useState<string>(String(DEFAULT_ROW_LIMIT));
	const limitChoice = limitId === 'all' ? null : Number(limitId);
	const editor = useRef<IQueryEditorHandle | null>(null);
	const [view, setView] = useState<IEditorSnapshot | null>(null);
	const latestText = useRef(text);
	latestText.current = text;

	// Save drafts per connection (text only), debounced.
	const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const changeText = useCallback((next: string) => {
		setText(next);
		onTextChange?.(next);
		if (draftTimer.current) clearTimeout(draftTimer.current);
		draftTimer.current = setTimeout(() => {
			const bag = prefs.getPref(DRAFTS_PREF_KEY);
			const base = bag && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
			prefs.setPref(DRAFTS_PREF_KEY, { ...base, [draftKey]: next.slice(0, 20_000) });
		}, 600);
	}, [prefs, draftKey, onTextChange]);
	useEffect(() => () => { if (draftTimer.current) clearTimeout(draftTimer.current); }, []);

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
			return mode === 'read'
				? session.invoke<ReadQueryResult>(TOOL.readQuery, { cypher: send.cypher, params: {}, limit: send.limit }, { generation: ticket })
				// Counted in the call (the dev-tool controller counts it itself), so a write that lands after this console
				// closed still marks drawn graphs out of date.
				: env.countWrite(endpoint.key, () => session.invoke<ReadQueryResult>(TOOL.execute, { query: send.cypher, shape: 'graph' }, { generation: ticket }));
		},
		settle: (_run, result) => settleRun(mode, result),
		describeFailure: (message, error) => {
			const notice = mode === 'write' ? describeWriteFailure(message, error) : describeFailureOf(message, error, writable);
			failureNotes.current = notice;
			return notice as IFailureNotice & { verbatim: string };
		},
		formatPrior: (runs, index) => formatPriorStatements(runs, index, GRAPH_BATCH_WORDS),
		record: (run) => {
			// A write is counted where it is sent (countWrite); one the user stopped waiting for may still complete, so it
			// makes every graph drawn from this connection out of date now, in every document.
			if (isAbandonedWrite(mode, run.outcome)) env.markAbandonedWrite(endpoint.key);
			env.history.record(endpoint.key, toHistoryEntry(historySummaryOf(run, Date.now()), entryId()));
		},
		summarize: ({ shown, runs }) => {
			if (shown?.result) {
				const s = summarizeResult(shown.result);
				const said = `${shown.outcome === 'affected' ? `${num(shown.affected ?? 0)} affected. ` : ''}${resultAnnouncement(shown.result.rows.length, s.nodeCount, s.relationshipCount, truncationText(shown.result))}`;
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
	const [tab, setTab] = useState<ResultTab>('table');
	const resultKey = useRef(0);
	useEffect(() => {
		if (!summary) return;
		resultKey.current += 1;
		setTab(chooseTab(summary));
	}, [result, summary]);

	// The graph session lives as long as the connection: a new result replaces what it draws (load), but nothing that
	// merely re-probes the node, refreshes discovery or re-renders this component may rebuild it, because that would
	// silently drop the selection, the inspector, every expansion and the stale marks. What changes over time is read
	// through refs.
	const latest = useRef({ dialect, writable, session, announce, blocked });
	latest.current = { dialect, writable, session, announce, blocked };
	// `endpoint.key` is the whole dependency on purpose: one graph session per connection.
	const graphSession = useMemo<IGraphSession>(() => createGraphSession({
		engine: () => (latest.current.dialect ? { dialect: latest.current.dialect.dialect, version: latest.current.dialect.engineVersion } : null),
		invoke: (recipe) => {
			const current = latest.current.session;
			if (!current) throw new ExplorerToolError({ kind: 'unavailable', tool: TOOL.readQuery, message: 'This connection is not available.' });
			return current.invoke<ReadQueryResult>(TOOL.readQuery, { cypher: recipe.cypher, params: recipe.params, limit: recipe.limit }, { generation: recipeGeneration.current.next() });
		},
		describe: (error) => describeFailureOf(error instanceof Error ? error.message : String(error), error, latest.current.writable),
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
	const graphState = useSyncExternalStore(graphSession.subscribe, graphSession.getState, graphSession.getState);

	// ── Captions per connection (persisted, view state only) ─────────────────
	const [captions, setCaptions] = useState<ReadonlyMap<string, string>>(() => {
		const bag = prefs.getPref(CAPTIONS_PREF_KEY);
		const own = bag && typeof bag === 'object' ? (bag as Record<string, unknown>)[endpoint.key] : undefined;
		return new Map(own && typeof own === 'object' ? Object.entries(own as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string') : []);
	});
	const captionsRef = useRef(captions);
	captionsRef.current = captions;
	const setCaption = useCallback((label: string, choice: string) => {
		setCaptions((previous) => {
			const next = new Map(previous);
			if (choice === '') next.delete(label);
			else next.set(label, choice);
			const bag = prefs.getPref(CAPTIONS_PREF_KEY);
			const base = bag && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
			prefs.setPref(CAPTIONS_PREF_KEY, { ...base, [endpoint.key]: Object.fromEntries(next) });
			return next;
		});
	}, [prefs, endpoint.key]);

	// ── Running ──────────────────────────────────────────────────────────────
	const startRun = useCallback((targets: IRunTarget[], fromEditor: boolean) => {
		// A press while a batch runs (keyboard, History) or while the surface is paused is refused out loud, never dropped.
		const refusal = runRefusal({ running: runner.running, blocked });
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
	}, [mode, runner, announce, blocked]);

	// Run reads the buffer, the selection and the caret from the LIVE editor in one call. The `text` state is a copy that
	// lags a render behind fast typing; a caret taken from the editor against that copy points past its end and the run
	// would send a truncated statement.
	const run = useCallback((all: boolean) => {
		const handle = editor.current;
		const targets = handle ? targetsFromEditor(handle, all) : targetsFromEditor({ snapshot: () => ({ text: latestText.current, start: 0, end: 0, caret: latestText.current.length }) }, all);
		startRun(targets, true);
	}, [startRun]);

	// A request from the host: put text in the editor, and (for a click on a label) run it. The request is TAKEN from
	// the host's slot, so a surface that mounts again finds nothing to replay.
	useEffect(() => {
		const request = loadSlot.take();
		if (!request) return;
		editor.current?.setText(request.text);
		changeText(request.text);
		if (request.run) startRun([{ text: request.text }], false);
	}, [loadSlot, loadSeq]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Row inspector (Table) ────────────────────────────────────────────────
	const [openRow, setOpenRow] = useState<number | null>(null);
	useEffect(() => setOpenRow(null), [result]);
	const rowView = result && openRow !== null && result.rows[openRow] ? inspectorTextOfRow(result.columns, result.rows[openRow]) : null;

	// ── Meta line ────────────────────────────────────────────────────────────
	const metaText = result ? resultMeta(displayed, result) : '';
	const truncation = result ? truncationText(result) : null;
	const willRun = describeSnapshot(view ?? { text, start: 0, end: 0, caret: 0 });
	const strip = runner.runs.length > 1;

	const menu: ViewMenu = useMemo(() => ({
		entries: [
			{ id: 'graph', label: 'Graph', ...(summary && summary.drawable ? { count: summary.nodeCount } : {}) },
			{ id: 'table', label: 'Table', ...(result ? { count: result.rows.length } : {}) },
			{ id: 'raw', label: 'Raw' },
		],
	}), [summary, result]);

	return (
		<div style={styles.root}>
			{topSlot}
			<div style={styles.editorRegion}>
				<div style={styles.editorBox}>
					<QueryEditor ref={editor} value={text} onChange={changeText} onRun={() => run(false)} onRunAll={() => run(true)} onCursorChange={syncCursor} label={mode === 'read' ? 'Cypher query' : 'Cypher statements to execute'} />
				</div>
				<div style={styles.runBar}>
					<Button variant="primary" disabled={runner.running || blocked !== null} onClick={() => run(false)} title="Run the selection or the statement at the caret (Ctrl/Cmd+Enter)">
						{mode === 'read' ? 'Run' : 'Execute'}
					</Button>
					<Button variant="ghost" disabled={runner.running || blocked !== null} onClick={() => run(true)} title="Run every statement in order (Ctrl/Cmd+Shift+Enter)">
						{mode === 'read' ? 'Run all' : 'Execute all'}
					</Button>
					{mode === 'read' && (
						<ToggleGroup
							options={LIMIT_OPTIONS}
							value={limitId}
							onChange={(id) => setLimitId(id)}
							aria-label="Row limit"
						/>
					)}
					{runner.canStop && <Button variant="ghost" title={STOP_WAITING_NOTE} onClick={() => runner.stopWaiting()}>Stop waiting</Button>}
					{onOpenHistory && <Button variant="ghost" onClick={onOpenHistory}>History</Button>}
					{mode === 'read' && dialect && (() => {
						const chip = rowLimitChip(limitChoice, dialect);
						return <span title={chip.title ?? undefined}><StatusBadge variant="muted">{chip.text}</StatusBadge></span>;
					})()}
					<span style={styles.willRun}>{runner.running ? 'Running…' : willRun}</span>
				</div>
			</div>

			<div style={styles.notices}>
				{blocked && <Banner variant="warning">{blocked}</Banner>}
				{runner.refusal && <Banner variant="warning">{runner.refusal}</Banner>}
				{runner.failure && <FailureBanner failure={runner.failure} genericText="The node's message was not returned. The pipeline node's log has it." extra={runner.failure.notice.hint ? <div style={{ marginTop: 4 }}>{runner.failure.notice.hint}</div> : null} />}
				{runner.abandonNotice && <Banner variant="warning">{runner.abandonNotice}</Banner>}
				{strip && <StatementStrip runs={runner.runs} selected={runner.selectedRun} onSelect={(i) => runner.setSelectedRun(i)} labelOf={(r) => formatRunLabel(r)} ariaLabel="Statements in the last run" />}
				{strip && !runner.running && <div style={styles.willRun}>{formatBatchOutcome(runner.runs, GRAPH_BATCH_WORDS)}</div>}
			</div>

			<div style={styles.results}>
				<TabControl menu={menu} activeId={tab} onSelect={(id) => setTab(id as ResultTab)} />
				<div style={styles.body}>
					{!result ? (
						<EmptyState icon={<GraphIcon />} title={runner.running ? 'Waiting for the node' : runner.failure ? 'Statement failed' : 'No results yet'} description={runner.running ? 'The statement has been sent.' : runner.failure ? 'The error is above. Fix the statement and run it again.' : mode === 'read' ? 'Run a query. Results with nodes open as a graph; everything else opens as a table.' : 'Statements run here change data only after you confirm them.'} />
					) : tab === 'graph' ? (
						<GraphView session={graphSession} schemaLabels={schemaLabels} captions={captions} onCaption={setCaption} onInspect={(id) => graphSession.inspect({ kind: 'node', id })} seedKey={`${endpoint.key}:${resultKey.current}`} announce={announce} />
					) : tab === 'table' ? (
						<ResultTable result={result} tableKey={`${endpoint.key}-${resultKey.current}`} onRowOpen={setOpenRow} meta={<>{metaText}{truncation && <StatusBadge variant="warning">{truncation}</StatusBadge>}</>} />
					) : (
						<RawView result={result} announce={announce} />
					)}
				</div>
				{result && tab !== 'table' && <div style={{ ...styles.willRun, paddingTop: 4 }}>{metaText}{truncation ? ` · ${truncation}` : ''}</div>}
				{summary && summary.unsafeNumbers > 0 && <Banner variant="warning">{`${summary.unsafeNumbers} integer ${summary.unsafeNumbers === 1 ? 'value' : 'values'} beyond 2^53 arrived as plain JSON number${summary.unsafeNumbers === 1 ? '' : 's'} and may have been rounded before this app saw them. This node should send them as exact text; upgrade it.`}</Banner>}
				{summary && summary.malformed > 0 && <Banner variant="warning">{`${summary.malformed} value${summary.malformed === 1 ? ' looks' : 's look'} like graph values but are malformed, so ${summary.malformed === 1 ? 'it is' : 'they are'} shown as plain data.`}</Banner>}
				{summary && summary.danglingRelationships > 0 && <Banner variant="info">{`${summary.danglingRelationships} relationship${summary.danglingRelationships === 1 ? '' : 's'} in this result ${summary.danglingRelationships === 1 ? 'has' : 'have'} an end node that was not returned, so ${summary.danglingRelationships === 1 ? 'it is' : 'they are'} not drawn. Return the nodes too, or expand a node.`}</Banner>}
			</div>

			<InspectorPanel state={graphState} session={graphSession} captions={captions} announce={announce} />
			{rowView && <RowInspector open title={`Row ${(openRow ?? 0) + 1} of ${result?.rows.length ?? 0}`} subtitle={displayed ? `statement ${displayed.index + 1}${displayed.ms !== undefined ? ` · ${clock(Date.now() - displayed.ms)}` : ''}` : ''} fields={rowView.fields} json={rowView.json} note={rowView.note} nullText="null" announce={announce} onClose={() => setOpenRow(null)} />}

			{confirm && (
				<WriteConfirmDialog
					content={confirm.content}
					onConfirm={() => {
						const targets = confirm.targets;
						setConfirm(null);
						const refusal = runRefusal({ running: runner.running, blocked });
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
