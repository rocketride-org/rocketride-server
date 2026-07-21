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
 * Live mode renders from the host-fed live state (statusMap + raw events),
 * exactly like today's pages. Replay mode derives everything from the
 * useTaskEvents visible window: status is the LAST status snapshot at the
 * cursor (snapshots are absolute, verified), trace/flow fold from the
 * replayed flow events, and the Log/Analyze projections read the window
 * directly. Seeking into an idle gap shows an explicit gap state whose PLAY
 * auto-skips to the next track (DVD semantics).
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { commonStyles } from '../../../themes/styles';
import { Button } from '../../../components/button/Button';
import { ToggleGroup } from '../../../components/toggle-group/ToggleGroup';
import { PlayBar } from '../../../components/play-bar/PlayBar';
import Status from '../../../components/status/Status';
import { StatusHeader } from '../../../components/status/StatusHeader';
import { SourceTokensContent } from '../../../components/tokens/Tokens';
import { SourceFlowContent } from '../../../components/flow/Flow';
import Trace from '../../../components/trace/Trace';
import Errors from '../../../components/errors/Errors';
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
	body: {
		padding: '12px 14px 0',
	},
	gapState: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		padding: '40px 24px',
		border: '1px dashed var(--rr-border-hover)',
		borderRadius: 10,
		background: 'var(--rr-bg-surface-alt)',
		gap: 6,
	},
	gapTitle: {
		fontSize: 15,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	},
	gapDetail: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		maxWidth: 460,
	},
	gapActions: {
		display: 'flex',
		gap: 10,
		marginTop: 10,
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Format an epoch-seconds time for the gap/replay chrome. */
function formatTime(time: number | null | undefined): string {
	if (time == null) return '—';
	return new Date(time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

	// --- The smart buffer over this source's continuum -----------------------
	const { visibleEvents, ingestLive, player, controller, inGap, gapNeighbors } = useTaskEvents({
		readLog,
		timeline,
	});

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

	// --- Replay derivations ---------------------------------------------------
	const isReplay = player.mode === 'replay';

	// Status at the cursor: snapshots are ABSOLUTE (verified), so the last
	// visible one IS the state at the cursor. Live mode uses the host's map.
	const replayStatus = useMemo<TaskStatus | undefined>(() => {
		if (!isReplay) return undefined;
		for (let i = visibleEvents.length - 1; i >= 0; i--) {
			const message = visibleEvents[i];
			if (message.event === 'apaevt_status_update') {
				return message.body as unknown as TaskStatus;
			}
		}
		return undefined;
	}, [isReplay, visibleEvents]);

	const effectiveStatus = isReplay ? replayStatus : liveTaskStatus;

	// Trace/flow events fold from the SAME parse used live, so replay rows
	// are identical to what the live view produced (the whole point of the
	// stamped continuum).
	const foldedTraceEvents = useMemo<TraceEvent[]>(() => {
		const folded: TraceEvent[] = [];
		for (const message of visibleEvents) {
			const parsed = parseServerEvent(message, projectId);
			if (parsed.traceEvent && parsed.traceEvent.source === source.id) {
				folded.push(parsed.traceEvent);
			}
		}
		return folded;
	}, [visibleEvents, projectId, source.id]);

	const { rows: traceRows, clearTrace } = useTraceState(foldedTraceEvents);

	// --- Section chrome -------------------------------------------------------
	const currentElapsed = useElapsedTimer(effectiveStatus ?? null);
	const hasLiveRun = Boolean(liveTaskStatus?.serviceUp) || liveTaskStatus?.state === 3;

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
		// The idle-gap state replaces every pane while the cursor sits
		// between tracks — explicit, never a silently blank panel.
		if (isReplay && inGap) {
			return (
				<div style={styles.gapState}>
					<div style={styles.gapTitle}>No run was active at this time</div>
					<div style={styles.gapDetail}>
						{formatTime(player.cursorTime)} sits between
						{gapNeighbors.previous
							? ` the run that ended ${formatTime(gapNeighbors.previous.endTime)}`
							: ' the start of history'}
						{gapNeighbors.next ? ` and the run starting ${formatTime(gapNeighbors.next.beginTime)}.` : '.'}
					</div>
					<div style={styles.gapActions}>
						{gapNeighbors.previous && (
							<Button variant="ghost" small onClick={controller.previousTrack}>
								{'|◀'} Back to previous run
							</Button>
						)}
						{gapNeighbors.next && (
							<Button variant="secondary" small onClick={controller.nextTrack}>
								Skip to next run {'▶|'}
							</Button>
						)}
					</div>
				</div>
			);
		}

		switch (pill) {
			case 'status':
				return <Status taskStatus={effectiveStatus ?? null} currentElapsed={currentElapsed} isConnected={isConnected} />;
			case 'tokens':
				return <SourceTokensContent tokens={effectiveStatus?.tokens} />;
			case 'flow':
				return (
					<>
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
						<SourceFlowContent taskStatus={effectiveStatus ?? null} viewMode={flowViewMode} />
					</>
				);
			case 'trace':
				return (
					<>
						{traceRows.length > 0 && (
							<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
								<button style={commonStyles.buttonSecondary} onClick={clearTrace}>
									Clear
								</button>
							</div>
						)}
						<Trace rows={traceRows} componentNames={componentNames} />
					</>
				);
			case 'errors':
				return errorItems.length === 0 && warningItems.length === 0 ? (
					<div style={commonStyles.empty}>No errors or warnings</div>
				) : (
					<>
						{errorItems.length > 0 && <Errors title="Errors" items={errorItems} type="error" />}
						{warningItems.length > 0 && <Errors title="Warnings" items={warningItems} type="warning" />}
					</>
				);
			case 'log':
				return <LogPane events={visibleEvents} />;
			case 'analyze':
				return <AnalyzePane events={visibleEvents} />;
			default:
				return null;
		}
	};

	// --- Render ---------------------------------------------------------------
	return (
		<div style={styles.section}>
			{/* Header: name + live state + run/stop (dev continuum only). */}
			<StatusHeader
				name={source.name}
				taskStatus={(isReplay ? effectiveStatus : liveTaskStatus) ?? null}
				currentElapsed={currentElapsed}
				onPipelineAction={
					runKind === 'dev' && !isReadonly && onPipelineAction
						? (action, src) => onPipelineAction(action, src ?? source.id)
						: undefined
				}
				extraActions={
					<PipelineActions notes={liveTaskStatus?.notes} host={serverHost} onOpenLink={onOpenLink} displayName={source.name} />
				}
				isSubscribed={isSubscribed}
			/>

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
			<PlayBar timeline={timeline} player={player} controller={controller} hasLiveRun={hasLiveRun} />
		</div>
	);
};
