// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * SourcePanel — the source-major unit of the Development / Deploy pages.
 *
 * One self-contained, collapsible section per source ("like multiple status
 * cards today, extended"): a header (name, state, Run/Stop), its OWN pill
 * bar (Status / Tokens / Flow / Trace / Errors / Log / Analyze), the
 * selected pane, and its OWN PlayBar over this source's continuum. Sources
 * are fully independent — one can replay a past track while another streams
 * live; there is no shared cursor and no cross-source coupling.
 *
 * Each pane consumes its natural read from the useTaskEvents DVR:
 * - Snapshot panes (Tokens/Flow/Errors/header) take statusAt() — the last
 *   absolute status snapshot at the position (live mode prefers the host's
 *   status map, which also carries endpoint notes).
 * - Accumulating panes (Trace/Log/Analyze) take trackEvents() — the
 *   effective track from its begin to the position, so a finished run
 *   persists through the dead zone and resets only when the next run
 *   begins; a mid-track seek replays from the track's beginning.
 * - The chart takes chartSeries() — the ready 1-second grid merging tracks
 *   and dead zones (zeros) into one continuous timeline.
 * PLAY from a gap auto-skips to the next track (DVD semantics).
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { commonStyles } from 'shell';
import { ToggleGroup } from 'shell';
import { PlayBar } from '../../../components/play-bar/PlayBar';
import type { ITimeSelection } from '../../../components/play-bar/PlayBar';
import Utilization from '../../../components/utilization/Utilization';
import { StatusActions, StatusElapsed, StatusHeaderInfo } from '../../../components/status-header/StatusHeader';
import { Card } from 'shell';
import { SourceTokensContent } from '../../../components/tokens/Tokens';
import { SourceFlowContent } from '../../../components/flow/Flow';
import Trace from '../../../components/trace/Trace';
import { TraceDetail } from '../../../components/trace/TraceDetail';
import { DetailPanel } from 'shell';
import { Button } from 'shell';
import Errors from '../../../components/errors/Errors';
import { EmptyState } from 'shell';
import PipelineActions from '../../../components/pipeline-actions/PipelineActions';

import { useTaskEvents } from '../hooks/useTaskEvents';
import type { TaskEventMessage, TaskEventSession, TaskTimeline } from '../hooks/useTaskEvents';
import { useTraceState } from '../hooks/useTraceState';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { parseServerEvent } from '../utils';
import { LogPane } from './LogPane';
import { StatusPane } from './StatusPane';
import type { TaskStatus, TraceEvent } from '../types';

// =============================================================================
// TYPES
// =============================================================================

/** The per-source views selectable in the section's pill bar. */
export type SourcePill = 'status' | 'tokens' | 'flow' | 'trace' | 'errors' | 'log' | 'utilization';

/** Props for {@link SourcePanel}. */
export interface ISourcePanelProps {
	/** Source identity (component id + display name). */
	source: { id: string; name: string };
	/** Which continuum this section is bound to. */
	runKind: 'dev' | 'deploy';
	/** Pipeline project id (event filtering + stream addressing). */
	projectId: string;
	/** Raw stamped live events already filtered to THIS source by the parent. */
	liveEvents: TaskEventMessage[];
	/** Factory for this stream's DVR session (null disables replay). */
	openSession: (() => TaskEventSession) | null;
	/** Stream-bound chapters fetch (null disables the timeline). */
	fetchTimeline: (() => Promise<TaskTimeline>) | null;
	/** Host-fed live status for this source (live mode renders from it). */
	liveTaskStatus?: TaskStatus;
	/** Component id → display name for the trace viewer. */
	componentNames: Map<string, string>;
	/** Connection / gating flags, forwarded to the panes. */
	isConnected: boolean;
	isSubscribed?: boolean;
	isReadonly?: boolean;
	serverHost?: string;
	/** Run/stop for the dev continuum (hidden on deploy sections). */
	onPipelineAction?: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	onOpenLink?: (url: string, displayName?: string) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Pill bar entries, in order. */
const PILLS: Array<{ id: SourcePill; label: string }> = [
	{ id: 'status', label: 'Status' },
	{ id: 'tokens', label: 'Tokens' },
	{ id: 'flow', label: 'Flow' },
	{ id: 'trace', label: 'Trace' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'log', label: 'Log' },
	{ id: 'utilization', label: 'Utilization' },
];

/** Timeline refresh cadence (ms) — chapters are one small control-file read. */
const TIMELINE_REFRESH_MS = 30_000;

/**
 * Trace recency window (completed documents shown). Matches the session
 * contract: all in-flight traces plus the last 50 closed — older traces are
 * reached by scrubbing the DVR back into their lifetime, never by growing
 * the list.
 */
const TRACE_CLOSED_WINDOW = 50;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	// The Card owns the section chrome; this wrapper only spaces stacked
	// source sections apart.
	sectionSpacing: {
		marginBottom: 25,
	},
	// headerActions column: action buttons on top, elapsed line beneath —
	// the right-hand block of the Card header row.
	headerActionsColumn: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-end',
		gap: 4,
	},
	headerActionsRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	},
	// Replay: the live header (state, Run/Stop) is not what the cursor shows —
	// dim it and drop interactions so it visibly reads as "not live".
	headerDimmed: {
		opacity: 0.4,
		pointerEvents: 'none',
		userSelect: 'none',
	},
	// Replay identity line — sits in the header where "Started X ago" lives.
	replayContext: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	replayBadge: {
		...commonStyles.badge,
		backgroundColor: 'var(--rr-color-info)',
		color: 'var(--rr-fg-button)',
	},
	// Fixed-height pane body: every pill renders in the same 450px box (its
	// content scrolls), so switching pills or data arriving never resizes
	// the section or shoves the transport around.
	body: {
		height: 450,
		padding: '12px 14px 0',
		overflowY: 'auto',
		overflowX: 'hidden',
	},
	// Full-height pane frame for panes that scroll INTERNALLY (trace): the
	// pane fills the body exactly, so the body's own scrollbar never engages
	// and only the pane's inner scroll region scrolls.
	paneFill: {
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
	},
	// The scrolling child inside paneFill (takes whatever the toolbar left).
	paneScrollHost: {
		flex: 1,
		minHeight: 0,
	},
	// Trace recency-window honesty line above the trace list.
	traceWindowNote: {
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
		padding: '2px 2px 6px',
	},
	// Analyze-slice header: names the brushed range + the way back to track scope.
	sliceBar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 10,
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		padding: '6px 10px',
		marginBottom: 10,
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Format an epoch-seconds time for the replay/slice chrome (with seconds — slices can be 5 s wide). */
function formatTime(time: number | null | undefined): string {
	if (time == null) return '—';
	return new Date(time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The self-contained per-source monitoring + replay section.
 */
export const SourcePanel: React.FC<ISourcePanelProps> = ({ source, runKind, projectId, liveEvents, openSession, fetchTimeline, liveTaskStatus, componentNames, isConnected, isSubscribed, isReadonly, serverHost, onPipelineAction, onOpenLink }) => {
	// --- Section-local view state --------------------------------------------
	const [pill, setPill] = useState<SourcePill>('status');
	const [timeline, setTimeline] = useState<TaskTimeline | null>(null);

	// --- Timeline (chapters) fetch: mount + slow reconciliation --------------
	// Task begin/end announcements FIX UP the local timeline directly (see
	// the feed loop); this poll only reconciles with the authoritative
	// server list — merging keeps any locally synthesized chapter the
	// server's control file has not caught up to yet (begin-announcement
	// races the writer).
	const fetchTimelineRef = useRef(fetchTimeline);
	fetchTimelineRef.current = fetchTimeline;
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			if (!fetchTimelineRef.current) return;
			try {
				const next = await fetchTimelineRef.current();
				if (cancelled) return;
				setTimeline((prev) => {
					if (!prev) return next;
					// A locally synthesized chapter and the server's chapter for
					// the SAME run carry different begin seqs (task-begin event
					// vs run-begin marker) — treat a fetched chapter within 2s
					// of a local begin as the same run, or the bar draws two
					// overlapping blocks.
					const localNewer = prev.chapters.filter((c) => !next.chapters.some((f) => f.beginSeq === c.beginSeq || Math.abs(f.beginTime - c.beginTime) < 2));
					if (localNewer.length === 0) return next;
					return { ...next, completed: false, chapters: [...next.chapters, ...localNewer] };
				});
			} catch {
				// A never-logged stream (or transient error) keeps the last value.
			}
		};
		void refresh();
		const timer = setInterval(refresh, TIMELINE_REFRESH_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
		// projectId rides the deps like the DVR-session effect below: a
		// project switch must refresh chapters for the new stream identity.
	}, [source.id, runKind, projectId]);

	// --- The DVR session over this source's continuum ------------------------
	// One session per stream identity, host-created via the factory and
	// disposed on identity change/unmount. The factory identity churns with
	// host renders, so it rides a ref — only the stream identity re-creates.
	const openSessionRef = useRef(openSession);
	openSessionRef.current = openSession;
	const [session, setSession] = useState<TaskEventSession | null>(null);
	useEffect(() => {
		const next = openSessionRef.current ? openSessionRef.current() : null;
		setSession(next);
		return () => {
			next?.closeEventStream();
			setSession(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source.id, runKind, projectId, openSession === null]);

	const { statusAt, trackEvents, chartSeries, trackStats, ingestLive, player, controller } = useTaskEvents({
		session,
		timeline,
	});

	// Status slice (brushed on the PlayBar with Shift+drag). Completing a
	// brush also switches to the Status pill — selecting a slice IS asking
	// for its analysis (the slice scopes the event-folded pieces; the
	// server-computed analytics stay run-scoped as-of the needle).
	const [selection, setSelection] = useState<ITimeSelection | null>(null);
	const handleSelectionChange = useCallback((next: ITimeSelection | null) => {
		setSelection(next);
		if (next) setPill('status');
	}, []);

	// Task-active switch, flipped by the host's announcements: apaevt_task
	// 'begin' arrives -> a task is running (open run renders GREEN);
	// 'end' arrives -> terminated (renders blue). Null until either is
	// seen (page opened mid-run) — consumers fall back to the timeline.
	const [runActive, setRunActive] = useState<boolean | null>(null);

	// Feed NEW live events into the session (it dedupes on seq, so an
	// idempotent incremental feed over the growing host array is safe).
	const fedCountRef = useRef(0);
	useEffect(() => {
		// A shrunken array means the host cleared/pruned its feed (reconnect):
		// restart from the top — seq dedupe makes the re-feed a no-op for
		// anything the session already holds.
		if (liveEvents.length < fedCountRef.current) fedCountRef.current = 0;
		for (let i = fedCountRef.current; i < liveEvents.length; i++) {
			const message = liveEvents[i];
			if (message.event === 'apaevt_task') {
				const action = (message.body as Record<string, unknown> | undefined)?.action;
				if (action === 'begin') setRunActive(true);
				else if (action === 'end') setRunActive(false);
				// FIX UP the local timeline from the announcement itself —
				// the event carries the chapter identity (eventTime=begin,
				// seq=beginSeq), so no server round-trip, no race with the
				// writer, no thundering herd of chapter fetches. The slow
				// poll reconciles with authoritative data later.
				if (action === 'begin') {
					// The announcement carries the run-begin marker's seq — the
					// chapter's exact identity — so the local chapter joins the
					// server's list by equality (announcement seq is the
					// fallback for older servers).
					const announced = (message.body as Record<string, unknown> | undefined)?.beginSeq;
					const stampedTrace = (message.body as Record<string, unknown>).traceLevel;
					const begin = {
						beginTime: message.body.eventTime,
						beginSeq: typeof announced === 'number' ? announced : message.body.logSeq,
						endTime: null,
						outcome: null,
						// The run-begin marker carries its trace level. Spread it
						// conditionally: an ABSENT key means "no stamp" (older
						// server) and must stay absent — null claims tracing OFF.
						...(typeof stampedTrace === 'string' ? { traceLevel: stampedTrace } : {}),
					};
					setTimeline((prev) => {
						const base = prev ?? { chapters: [], segments: [], horizonSeq: 0, completed: false };
						if (base.chapters.some((c) => c.beginSeq === begin.beginSeq)) return prev;
						return { ...base, completed: false, chapters: [...base.chapters, begin] };
					});
				} else if (action === 'end') {
					const endTime = message.body.eventTime;
					setTimeline((prev) => {
						if (!prev) return prev;
						const chapters = prev.chapters.map((c, i) => (i === prev.chapters.length - 1 && c.endTime == null ? { ...c, endTime } : c));
						return { ...prev, completed: true, chapters };
					});
				}
			}
			ingestLive(message);
		}
		fedCountRef.current = liveEvents.length;
	}, [liveEvents, ingestLive]);

	// --- Position-shaped reads ------------------------------------------------
	const isReplay = player.mode === 'replay';

	// DEAD ZONE = CLEARED: pane data renders only when the position sits
	// INSIDE a running track (live: the task is active; replay: the cursor
	// is within a chapter). The header keeps the last status (name/state)
	// — only pane DATA clears.

	// Snapshot panes (tokens/flow/errors): the last status snapshot
	// at-or-before the position, from the STREAM in both modes — the fold's
	// last status event is the same wire event the host map holds, so the
	// panes have one source of truth. The HEADER (name/state/Run-Stop/
	// notes) deliberately stays on the host's live map: its controls act on
	// the live task, not the viewed position.
	const streamStatus = useMemo<TaskStatus | undefined>(() => (statusAt() ?? undefined) as TaskStatus | undefined, [statusAt]);
	const effectiveStatus = isReplay ? streamStatus : liveTaskStatus;
	const paneStatus = streamStatus;

	// Accumulating panes (trace/log/analyze): the EFFECTIVE track's events.
	// DEAD ZONE = CLEARED: outside a running track the window is empty (the
	// hook enforces it), and the snapshot panes gate on the same fact.
	const track = useMemo(() => trackEvents(), [trackEvents]);
	const cleared = !track.active;

	// Dead-zone jump (Status pane ghost card): land the needle on the latest
	// recorded run. An open chapter is the live run — go live; a sealed one
	// seeks just inside its end, where the report card holds the run's final
	// numbers. Undefined while the stream has no chapters (nothing to jump to).
	const jumpToLatestRun = useMemo(() => {
		const chapters = timeline?.chapters;
		if (!chapters || chapters.length === 0) return undefined;
		return () => {
			const latest = chapters[chapters.length - 1];
			if (latest.endTime == null) controller.goLive();
			else controller.seekToTime(latest.endTime - 0.001);
		};
	}, [timeline, controller]);

	/**
	 * Full-chapter reconstruction for the Download actions: a THROWAWAY
	 * session walks EVERY segment of the effective track through the SDK's
	 * reconstruction layer — the file is the complete run, independent of
	 * the display fold and its caps. Completion: a sealed chapter ends at
	 * the first event past its endTime; an open (live) chapter settles on
	 * delivery silence after the speed-0 drain.
	 */
	const fetchChapterEvents = useCallback(async (): Promise<TaskEventMessage[]> => {
		const factory = openSessionRef.current;
		const chapter = trackEvents().chapter;
		if (!factory || !chapter) return [];
		const walker = factory();
		try {
			const collected: TaskEventMessage[] = [];
			await walker.seek(chapter.beginTime - 0.001);
			const end = chapter.endTime ?? Number.POSITIVE_INFINITY;
			await new Promise<void>((resolve) => {
				let settle: ReturnType<typeof setTimeout> | null = null;
				const done = () => {
					if (settle) clearTimeout(settle);
					resolve();
				};
				const arm = () => {
					if (settle) clearTimeout(settle);
					settle = setTimeout(done, 700);
				};
				arm();
				void walker.play(undefined, 0, ({ event }) => {
					if (event.body.eventTime > end) {
						done();
						return;
					}
					collected.push(event);
					arm();
				});
			});
			return collected;
		} finally {
			walker.closeEventStream();
		}
	}, [trackEvents]);

	// Trace fold: same parse as live, over the track's flow events; the
	// track identity keys the fold so a track flip restarts it cleanly.
	// The parse is scoped to THIS section's continuum — a deploy section's
	// session delivers deploy-stamped events, which must fold here.
	const foldedTraceEvents = useMemo<TraceEvent[]>(() => {
		const folded: TraceEvent[] = [];
		for (const message of track.events) {
			if (message.event !== 'apaevt_flow') continue;
			const parsed = parseServerEvent(message, projectId, runKind);
			if (parsed.traceEvent && parsed.traceEvent.source === source.id) {
				folded.push(parsed.traceEvent);
			}
		}
		return folded;
	}, [track, projectId, source.id, runKind]);

	const { rows: traceRows } = useTraceState(foldedTraceEvents, track.chapter?.beginSeq ?? -1);

	// Trace display window (the recency contract): every IN-FLIGHT trace
	// plus the most recently completed TRACE_CLOSED_WINDOW documents — any
	// older trace stays reachable by scrubbing the DVR back into its
	// lifetime. Grouping is by document (a trace is that document's call
	// tree); hiding drops whole documents, never interior rows.
	const { rows: windowedTraceRows, hiddenTraces } = useMemo(() => {
		const byDoc = new Map<number, { open: boolean; end: number }>();
		for (const row of traceRows) {
			const group = byDoc.get(row.docId) ?? { open: false, end: 0 };
			if (!row.completed) group.open = true;
			group.end = Math.max(group.end, row.endTimestamp ?? row.timestamp);
			byDoc.set(row.docId, group);
		}
		if (byDoc.size <= TRACE_CLOSED_WINDOW) return { rows: traceRows, hiddenTraces: 0 };
		const closedEnds = [...byDoc.values()].filter((group) => !group.open).map((group) => group.end);
		closedEnds.sort((a, b) => b - a);
		const cutoff = closedEnds[TRACE_CLOSED_WINDOW - 1] ?? 0;
		const keep = new Set([...byDoc.entries()].filter(([, group]) => group.open || group.end >= cutoff).map(([docId]) => docId));
		if (keep.size === byDoc.size) return { rows: traceRows, hiddenTraces: 0 };
		return { rows: traceRows.filter((row) => keep.has(row.docId)), hiddenTraces: byDoc.size - keep.size };
	}, [traceRows]);

	// --- Trace DetailPanel (one request's call tree via session.getTrace) ----
	const [openTrace, setOpenTrace] = useState<{ traceId: number; name: string } | null>(null);

	// The list's request order — Prev/Next in the panel footer walks it.
	const traceDocOrder = useMemo(() => {
		const order: Array<{ traceId: number; name: string }> = [];
		const seen = new Set<number>();
		for (const row of windowedTraceRows) {
			if (!seen.has(row.docId) && row.beginSeq !== undefined) {
				seen.add(row.docId);
				order.push({ traceId: row.beginSeq, name: row.objectName });
			}
		}
		return order;
	}, [windowedTraceRows]);
	const openTraceIndex = openTrace ? traceDocOrder.findIndex((entry) => entry.traceId === openTrace.traceId) : -1;

	/** Fetch one trace's reconstructed events through the DVR session. */
	const fetchTrace = useCallback(
		async (traceId: number) => {
			if (!session) throw new Error('Trace detail requires a connected session');
			return session.getTrace(traceId);
		},
		[session]
	);

	// Flow pane: rebuild pipeflow.byPipe AT THE POSITION from the track's
	// flow events — every flow event carries the full post-op stack, and
	// 'end' retires its pipeline. Status snapshots cannot serve this: the
	// log samples them every ~5s and documents finish in under a second, so
	// sampled byPipe is almost always the empty idle instant.
	const flowStatus = useMemo<TaskStatus | null>(() => {
		const byPipe: Record<string, string[]> = {};
		for (const message of track.events) {
			if (message.event !== 'apaevt_flow') continue;
			const body = message.body as Record<string, any>;
			const id = String(body.id ?? 0);
			if (body.op === 'end') delete byPipe[id];
			else byPipe[id] = (body.pipes as string[]) ?? [];
		}
		const base = (cleared ? undefined : paneStatus) ?? null;
		if (!base) return null;
		return { ...base, pipeflow: { ...base.pipeflow, byPipe } } as TaskStatus;
	}, [track, paneStatus, cleared]);

	// --- Section chrome -------------------------------------------------------
	const currentElapsed = useElapsedTimer(effectiveStatus ?? null);

	/** Pill selection — plain toggle handler. */
	const handlePillChange = useCallback((id: string) => setPill(id as SourcePill), []);

	// --- Pane rendering -------------------------------------------------------
	const errorItems = cleared ? [] : (paneStatus?.errors ?? []);
	const warningItems = cleared ? [] : (paneStatus?.warnings ?? []);
	const [flowViewMode, setFlowViewMode] = useState<'pipeline' | 'component'>('pipeline');

	/** Render the pane for the active pill. */
	const renderPane = (): React.ReactNode => {
		// Idle gaps between tracks do NOT replace the panes: the folds render
		// the state as of the cursor, and the status chart's sliding window
		// legitimately shows zeros through dead space. The
		// activity bar is where gaps are visualized; PLAY from a gap still
		// auto-skips to the next track (DVD transport behavior in the hook).
		switch (pill) {
			case 'utilization':
				// The chart consumes the DVR's ready-made 1-second grid —
				// sliding while playing, frozen while paused, zeros through
				// dead space — and the footer its track-scoped stats.
				return <Utilization getSeries={chartSeries} getStats={trackStats} />;
			case 'tokens':
				return <SourceTokensContent tokens={cleared ? undefined : paneStatus?.tokens} />;
			case 'flow': {
				// Both views fold from byPipe — with nothing in flight the
				// toggle chooses between two empty states, so hide it (same
				// rule as Trace's Clear button).
				const hasFlowData = Object.keys(flowStatus?.pipeflow?.byPipe ?? {}).length > 0;
				return (
					<>
						{hasFlowData && (
							<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
								<ToggleGroup
									options={[
										{ id: 'pipeline', label: 'Pipeline View' },
										{ id: 'component', label: 'Component View' },
									]}
									value={flowViewMode}
									onChange={(id) => setFlowViewMode(id as 'pipeline' | 'component')}
								/>
							</div>
						)}
						<SourceFlowContent taskStatus={flowStatus} viewMode={flowViewMode} />
					</>
				);
			}
			case 'trace':
				return (
					<div style={styles.paneFill}>
						{hiddenTraces > 0 && (
							<div style={styles.traceWindowNote}>
								Showing in-flight traces and the last {TRACE_CLOSED_WINDOW} completed — {hiddenTraces} earlier {hiddenTraces === 1 ? 'trace is' : 'traces are'} reachable by scrubbing back.
							</div>
						)}
						<div style={styles.paneScrollHost}>
							<Trace rows={windowedTraceRows} componentNames={componentNames} onOpenTrace={(traceId, name) => setOpenTrace({ traceId, name })} />
						</div>
					</div>
				);
			case 'errors':
				return errorItems.length === 0 && warningItems.length === 0 ? (
					<EmptyState title="No errors or warnings" description="Problems raised by the pipeline appear here while it runs or when replaying a recorded run." />
				) : (
					<>
						{errorItems.length > 0 && <Errors title="Errors" items={errorItems} type="error" />}
						{warningItems.length > 0 && <Errors title="Warnings" items={warningItems} type="warning" />}
					</>
				);
			case 'log':
				return <LogPane events={track.events} downloadBase={`${source.id}.${runKind}`} {...(track.truncatedBefore !== undefined ? { truncatedBefore: track.truncatedBefore } : {})} fetchChapterEvents={fetchChapterEvents} />;
			case 'status':
				// The landing report card. The card's numbers are the
				// server-computed run analytics — ALWAYS run-scoped, never
				// sliced — so a brushed selection only gets an honest label
				// here (its real consumers are the chart/utilization views).
				return (
					<>
						{selection && (
							<div style={styles.sliceBar}>
								<span>
									Slice <b>{formatTime(selection.from)}</b> → <b>{formatTime(selection.to)}</b>
									{' · '}
									{Math.max(1, Math.round(selection.to - selection.from))} s{' — report card stays run-scoped'}
								</span>
								<Button variant="secondary" small onClick={() => setSelection(null)}>
									Clear — back to track
								</Button>
							</div>
						)}
						<StatusPane status={cleared ? null : (paneStatus ?? null)} chapters={timeline?.chapters} chapter={track.chapter} position={player.cursorTime ?? undefined} onOpenTrace={(traceId, name) => setOpenTrace({ traceId, name })} onJumpToRun={jumpToLatestRun} componentNames={componentNames} />
					</>
				);
			default:
				return null;
		}
	};

	// --- Render ---------------------------------------------------------------
	// Stock Card owns the section chrome: StatusHeaderInfo in the header slot,
	// the action cluster + elapsed in headerActions, the pill bar as the
	// toolbar, and the pane + transport as an edge-to-edge body.
	// Replay dims the header content — it is LIVE state, and its buttons act
	// on the live task, not the replayed moment.
	return (
		<div style={styles.sectionSpacing}>
			<Card
				header={
					<div style={isReplay ? styles.headerDimmed : undefined} aria-disabled={isReplay || undefined}>
						<StatusHeaderInfo name={source.name} taskStatus={(isReplay ? effectiveStatus : liveTaskStatus) ?? null} />
					</div>
				}
				headerActions={
					<div style={styles.headerActionsColumn}>
						<div style={{ ...styles.headerActionsRow, ...(isReplay ? styles.headerDimmed : undefined) }} aria-disabled={isReplay || undefined}>
							<PipelineActions notes={liveTaskStatus?.notes} host={serverHost} onOpenLink={onOpenLink} displayName={source.name} />
							{runKind === 'dev' && !isReadonly && !isReplay && onPipelineAction && <StatusActions taskStatus={liveTaskStatus ?? null} onPipelineAction={(action, src) => onPipelineAction(action, src ?? source.id)} isSubscribed={isSubscribed} />}
						</div>
						{isReplay ? (
							// The replayed track's identity replaces the live "Started
							// X ago" line — NOT dimmed: unlike the live-state controls
							// above it, this describes exactly what the panes show.
							<span style={styles.replayContext}>
								<span style={styles.replayBadge}>Replay</span>
								<span>of {formatTime(track.chapter?.beginTime ?? player.cursorTime)}</span>
							</span>
						) : (
							<StatusElapsed taskStatus={liveTaskStatus ?? null} currentElapsed={currentElapsed} />
						)}
					</div>
				}
				toolbar={<ToggleGroup options={PILLS} value={pill} onChange={handlePillChange} />}
				noBodyPadding
			>
				{/* The selected pane (or the idle-gap state). */}
				<div style={styles.body}>{renderPane()}</div>

				{/* This source's own transport + activity bar. */}
				<PlayBar timeline={timeline} player={player} controller={controller} runActive={runActive} selection={selection} onSelectionChange={handleSelectionChange} />
			</Card>

			{/* One request's full call tree — the stock right-side drawer, fed by
			    the log API's getTrace; Prev/Next walks the list without closing. */}
			{openTrace && (
				<DetailPanel
					open
					onClose={() => setOpenTrace(null)}
					title={openTrace.name}
					width={640}
					persistKey="panelTraceDetailWidth"
					subtitle={openTraceIndex >= 0 ? `Request ${openTraceIndex + 1} of ${traceDocOrder.length} — ${source.name}` : source.name}
					footer={
						<div style={{ display: 'flex', gap: 8 }}>
							<Button
								variant="secondary"
								small
								disabled={openTraceIndex <= 0}
								onClick={() => {
									const previous = traceDocOrder[openTraceIndex - 1];
									if (previous) setOpenTrace(previous);
								}}
							>
								Previous
							</Button>
							<Button
								variant="secondary"
								small
								disabled={openTraceIndex < 0 || openTraceIndex >= traceDocOrder.length - 1}
								onClick={() => {
									const next = traceDocOrder[openTraceIndex + 1];
									if (next) setOpenTrace(next);
								}}
							>
								Next
							</Button>
						</div>
					}
				>
					<TraceDetail traceId={openTrace.traceId} projectId={projectId} fetchTrace={fetchTrace} componentNames={componentNames} />
				</DetailPanel>
			)}
		</div>
	);
};
