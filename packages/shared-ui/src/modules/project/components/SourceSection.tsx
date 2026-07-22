// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * SourceSection — the source-major unit of the Development / Deploy pages.
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

import { commonStyles } from '../../../themes/styles';
import { ToggleGroup } from '../../../components/toggle-group/ToggleGroup';
import { PlayBar } from '../../../components/play-bar/PlayBar';
import type { ITimeSelection } from '../../../components/play-bar/PlayBar';
import Status from '../../../components/status/Status';
import { StatusHeader } from '../../../components/status/StatusHeader';
import { SourceTokensContent } from '../../../components/tokens/Tokens';
import { SourceFlowContent } from '../../../components/flow/Flow';
import Trace from '../../../components/trace/Trace';
import Errors from '../../../components/errors/Errors';
import { EmptyState } from '../../../components/empty-state/EmptyState';
import PipelineActions from '../../../components/pipeline-actions/PipelineActions';

import { useTaskEvents } from '../hooks/useTaskEvents';
import type { LogReadFetcher, TaskEventMessage, TaskTimeline } from '../hooks/useTaskEvents';
import { useTraceState } from '../hooks/useTraceState';
import { useElapsedTimer } from '../hooks/useElapsedTimer';
import { parseServerEvent } from '../utils';
import { LogPane } from './LogPane';
import { AnalyzePane } from './AnalyzePane';
import type { TaskStatus, TraceEvent } from '../types';

// =============================================================================
// TYPES
// =============================================================================

/** The per-source views selectable in the section's pill bar. */
export type SourcePill = 'status' | 'tokens' | 'flow' | 'trace' | 'errors' | 'log' | 'analyze';

/** Props for {@link SourceSection}. */
export interface ISourceSectionProps {
	/** Source identity (component id + display name). */
	source: { id: string; name: string };
	/** Which continuum this section is bound to. */
	runKind: 'dev' | 'deploy';
	/** Pipeline project id (event filtering + stream addressing). */
	projectId: string;
	/** Raw stamped live events already filtered to THIS source by the parent. */
	liveEvents: TaskEventMessage[];
	/** Stream-bound log pager (null disables replay — live-only host). */
	readLog: LogReadFetcher | null;
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
	{ id: 'analyze', label: 'Analyze' },
];

/** Timeline refresh cadence (ms) — chapters are one small control-file read. */
const TIMELINE_REFRESH_MS = 30_000;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	section: {
		...commonStyles.card,
		borderRadius: 6,
		marginBottom: 25,
		overflow: 'hidden',
	},
	pillRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '10px 14px 0',
		flexWrap: 'wrap',
	},
	// Replay: the live header (state, Run/Stop) is not what the cursor shows —
	// dim it and drop interactions so it visibly reads as "not live".
	headerDimmed: {
		opacity: 0.4,
		pointerEvents: 'none',
		userSelect: 'none',
	},
	replayContext: {
		marginLeft: 'auto',
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
export const SourceSection: React.FC<ISourceSectionProps> = ({
	source,
	runKind,
	projectId,
	liveEvents,
	readLog,
	fetchTimeline,
	liveTaskStatus,
	componentNames,
	isConnected,
	isSubscribed,
	isReadonly,
	serverHost,
	onPipelineAction,
	onOpenLink,
}) => {
	// --- Section-local view state --------------------------------------------
	const [pill, setPill] = useState<SourcePill>('status');
	const [timeline, setTimeline] = useState<TaskTimeline | null>(null);

	// --- Timeline (chapters) fetch: mount + slow refresh ---------------------
	const fetchTimelineRef = useRef(fetchTimeline);
	fetchTimelineRef.current = fetchTimeline;
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			if (!fetchTimelineRef.current) return;
			try {
				const next = await fetchTimelineRef.current();
				if (!cancelled) setTimeline(next);
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
	}, [source.id, runKind]);

	// --- The DVR over this source's continuum --------------------------------
	const { statusAt, trackEvents, rangeEvents, chartSeries, trackStats, ingestLive, player, controller } = useTaskEvents({
		readLog,
		timeline,
	});

	// Analyze slice (brushed on the PlayBar with Shift+drag). Completing a
	// brush also switches to the Analyze pill — selecting a slice IS asking
	// for its analysis.
	const [selection, setSelection] = useState<ITimeSelection | null>(null);
	const handleSelectionChange = useCallback((next: ITimeSelection | null) => {
		setSelection(next);
		if (next) setPill('analyze');
	}, []);

	// Feed NEW live events into the buffer (absorb dedupes on seq, so an
	// idempotent incremental feed over the growing host array is safe).
	const fedCountRef = useRef(0);
	useEffect(() => {
		// A shrunken array means the host cleared/pruned its feed (reconnect):
		// restart from the top — seq dedupe makes the re-feed a no-op for
		// anything the buffer already holds.
		if (liveEvents.length < fedCountRef.current) fedCountRef.current = 0;
		for (let i = fedCountRef.current; i < liveEvents.length; i++) {
			ingestLive(liveEvents[i]);
		}
		fedCountRef.current = liveEvents.length;
	}, [liveEvents, ingestLive]);

	// --- Position-shaped reads ------------------------------------------------
	const isReplay = player.mode === 'replay';

	// Snapshot panes (tokens/flow/errors/header): the last status snapshot
	// at-or-before the position — absolute, so it fully reconstructs their
	// state; in a dead zone it is naturally the previous run's final state.
	// Live mode prefers the host's map (it also carries endpoint notes).
	const replayStatus = useMemo<TaskStatus | undefined>(
		() => (isReplay ? ((statusAt() ?? undefined) as TaskStatus | undefined) : undefined),
		[isReplay, statusAt],
	);
	const effectiveStatus = isReplay ? replayStatus : liveTaskStatus;

	// Accumulating panes (trace/log/analyze): the EFFECTIVE track's events —
	// a finished run persists through the dead zone and resets only when the
	// next run begins; a mid-track seek replays from the track's beginning.
	const track = useMemo(() => trackEvents(), [trackEvents]);

	// Trace fold: same parse as live, over the track's flow events; the
	// track identity keys the fold so a track flip restarts it cleanly.
	const foldedTraceEvents = useMemo<TraceEvent[]>(() => {
		const folded: TraceEvent[] = [];
		for (const message of track.events) {
			if (message.event !== 'apaevt_flow') continue;
			const parsed = parseServerEvent(message, projectId);
			if (parsed.traceEvent && parsed.traceEvent.source === source.id) {
				folded.push(parsed.traceEvent);
			}
		}
		return folded;
	}, [track, projectId, source.id]);

	const { rows: traceRows, clearTrace } = useTraceState(foldedTraceEvents, track.chapter?.beginSeq ?? -1);

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
		const base = effectiveStatus ?? null;
		if (!base) return null;
		return { ...base, pipeflow: { ...base.pipeflow, byPipe } } as TaskStatus;
	}, [track, effectiveStatus]);

	// --- Section chrome -------------------------------------------------------
	const currentElapsed = useElapsedTimer(effectiveStatus ?? null);

	// Track number of the cursor's chapter (1-based), for the replay chrome.
	const trackNumber = useMemo(() => {
		if (!isReplay || player.cursorTime === null || !timeline?.chapters) return null;
		for (let i = timeline.chapters.length - 1; i >= 0; i--) {
			const chapter = timeline.chapters[i];
			if (chapter.beginTime <= player.cursorTime) return i + 1;
		}
		return null;
	}, [isReplay, player.cursorTime, timeline]);

	/** Pill selection — plain toggle handler. */
	const handlePillChange = useCallback((id: string) => setPill(id as SourcePill), []);

	// --- Pane rendering -------------------------------------------------------
	const errorItems = effectiveStatus?.errors ?? [];
	const warningItems = effectiveStatus?.warnings ?? [];
	const [flowViewMode, setFlowViewMode] = useState<'pipeline' | 'component'>('pipeline');

	/** Render the pane for the active pill. */
	const renderPane = (): React.ReactNode => {
		// Idle gaps between tracks do NOT replace the panes: the folds render
		// the state as of the cursor, and the status chart's sliding window
		// legitimately shows zeros through dead space. The
		// activity bar is where gaps are visualized; PLAY from a gap still
		// auto-skips to the next track (DVD transport behavior in the hook).
		switch (pill) {
			case 'status':
				// The chart consumes the DVR's ready-made 1-second grid —
				// sliding while playing, frozen while paused, zeros through
				// dead space — and the footer its track-scoped stats.
				return <Status getSeries={chartSeries} getStats={trackStats} />;
			case 'tokens':
				return <SourceTokensContent tokens={effectiveStatus?.tokens} />;
			case 'flow': {
				// Both views fold from byPipe — with nothing in flight the
				// toggle chooses between two empty states, so hide it (same
				// rule as Trace's Clear button).
				const hasFlowData = Object.keys(flowStatus?.pipeflow?.byPipe ?? {}).length > 0;
				return (
					<>
						{hasFlowData && (
							<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
								<div style={commonStyles.toggleGroup}>
									<button style={commonStyles.toggleButton(flowViewMode === 'pipeline')} onClick={() => setFlowViewMode('pipeline')}>
										Pipeline View
									</button>
									<button style={commonStyles.toggleButton(flowViewMode === 'component')} onClick={() => setFlowViewMode('component')}>
										Component View
									</button>
								</div>
							</div>
						)}
						<SourceFlowContent taskStatus={flowStatus} viewMode={flowViewMode} />
					</>
				);
			}
			case 'trace':
				return (
					<div style={styles.paneFill}>
						{traceRows.length > 0 && (
							<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
								<button style={commonStyles.buttonSecondary} onClick={clearTrace}>
									Clear
								</button>
							</div>
						)}
						<div style={styles.paneScrollHost}>
							<Trace rows={traceRows} componentNames={componentNames} />
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
				return <LogPane events={track.events} downloadBase={`${source.id}.${runKind}`} />;
			case 'analyze':
				// A brushed slice overrides the track scope; the header row
				// names the slice and offers the way back.
				return (
					<>
						{selection && (
							<div style={styles.sliceBar}>
								<span>
									Analyzing slice <b>{formatTime(selection.from)}</b> → <b>{formatTime(selection.to)}</b>
									{' · '}
									{Math.max(1, Math.round(selection.to - selection.from))} s
								</span>
								<button style={commonStyles.buttonSecondary} onClick={() => setSelection(null)}>
									Clear — back to track
								</button>
							</div>
						)}
						<AnalyzePane events={selection ? rangeEvents(selection.from, selection.to) : track.events} />
					</>
				);
			default:
				return null;
		}
	};

	// --- Render ---------------------------------------------------------------
	return (
		<div style={styles.section}>
			{/* Header: name + live state + run/stop (dev continuum only).
			    Replay dims and disables it — the header is LIVE state, and its
			    buttons act on the live task, not the replayed moment. */}
			<div style={isReplay ? styles.headerDimmed : undefined} aria-disabled={isReplay || undefined}>
				<StatusHeader
					name={source.name}
					taskStatus={(isReplay ? effectiveStatus : liveTaskStatus) ?? null}
					currentElapsed={currentElapsed}
					onPipelineAction={
						runKind === 'dev' && !isReadonly && !isReplay && onPipelineAction
							? (action, src) => onPipelineAction(action, src ?? source.id)
							: undefined
					}
					extraActions={
						<PipelineActions notes={liveTaskStatus?.notes} host={serverHost} onOpenLink={onOpenLink} displayName={source.name} />
					}
					isSubscribed={isSubscribed}
				/>
			</div>

			{/* Per-source pill bar + replay context. */}
			<div style={styles.pillRow}>
				<ToggleGroup options={PILLS} value={pill} onChange={handlePillChange} />
				{isReplay && (
					<span style={styles.replayContext}>
						<span style={styles.replayBadge}>Replay</span>
						<span>
							{formatTime(player.cursorTime)}
							{trackNumber !== null ? ` · track ${trackNumber}` : ''} · {player.speed}X
						</span>
					</span>
				)}
			</div>

			{/* The selected pane (or the idle-gap state). */}
			<div style={styles.body}>{renderPane()}</div>

			{/* This source's own transport + activity bar. */}
			<PlayBar
				timeline={timeline}
				player={player}
				controller={controller}
				selection={selection}
				onSelectionChange={handleSelectionChange}
			/>
		</div>
	);
};
