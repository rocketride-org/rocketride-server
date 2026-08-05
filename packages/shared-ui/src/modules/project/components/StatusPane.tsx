// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatusPane — the run's report card, and the section's landing pane.
 *
 * Everything renders as-of-needle from the reconstructed status at the
 * cursor: live it is the running run's meter, in replay the tiles climb as
 * the needle advances and settle into the final summary at track end.
 *
 * The marquee numbers (componentStats, slowestDocs, completionSeconds, and
 * the pipe-unused idle counters) are COMPUTED SERVER-SIDE by the supervisor
 * while it derives flow events — exact at any position, with no client
 * fold-window or recency caveats. They require tracing (pipelineTraceLevel),
 * same as the Trace pane; the plain counters (completions, sizes, tokens,
 * peaks) work regardless. The idle counters include the still-open quiet
 * stretch, folded in by the server at every status publish — this pane
 * renders every number verbatim.
 */

import React, { CSSProperties, useMemo } from 'react';
import { Button } from '../../../components/button/Button';
import { EmptyState } from '../../../components/empty-state/EmptyState';
import { MiniCard, MiniContainer } from '../../../components/mini-card/MiniCard';
import { commonStyles } from '../../../themes/styles';
import type { ITaskStatus } from '../../../types/project';
import type { TaskChapter } from '../hooks/useTaskEvents';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link StatusPane}. */
export interface IStatusPaneProps {
	/** Reconstructed status as of the cursor (null in the dead zone). */
	status: ITaskStatus | null;
	/** The stream's chapters — trailing-median context for deviation markers. */
	chapters?: TaskChapter[] | undefined;
	/** The chapter the cursor is inside (null in the dead zone). */
	chapter?: TaskChapter | null | undefined;
	/** The cursor position (epoch seconds) — the "as of" clock. */
	position?: number | undefined;
	/**
	 * Opens a completion's full call tree (the host's TraceDetail panel) by
	 * its begin-event continuum seq. Absent, slowest rows render inert.
	 */
	onOpenTrace?: ((traceBeginSeq: number, name: string) => void) | undefined;
	/**
	 * Seeks the section's player to the latest recorded run. Present only
	 * when the stream has chapters; drives the dead zone's jump action.
	 */
	onJumpToRun?: (() => void) | undefined;
	/**
	 * Component id → the user's display name for the node; component timing
	 * rows fall back to the raw id when a name is missing.
	 */
	componentNames?: Map<string, string> | undefined;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	// Composite MiniCard values: big number + a small inline qualifier
	// (unit, failed count, deviation marker) on a shared baseline.
	valueRow: {
		display: 'inline-flex',
		alignItems: 'baseline',
		gap: 5,
	},
	valueUnit: {
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
	},
	// Stacked MiniCard value: big number over a small context line
	// ("at 09:59 AM").
	valueColumn: {
		display: 'flex',
		flexDirection: 'column',
	},
	valueSub: {
		fontSize: 12,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
	},
	// Borderless section title: small uppercase label above each list.
	sectionTitle: {
		fontSize: 12,
		fontWeight: 700,
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
		marginBottom: 6,
	},
	// De-emphasized hint riding inside a section title.
	sectionHint: {
		fontWeight: 400,
		fontSize: 12,
		letterSpacing: 0,
		textTransform: 'none',
		color: 'var(--rr-text-disabled)',
	},
	// Two-up body: component timing on the left, slowest completions on the
	// right — equal halves beneath the tiles.
	columns: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 28,
		alignItems: 'start',
	},
	// Dead-zone ghost chrome: the pane's real shape, dimmed and inert.
	ghost: {
		opacity: 0.45,
		pointerEvents: 'none',
		userSelect: 'none',
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	// Traceless run: the trace-fed sections gray out and go inert — the
	// same dimming as the dead-zone ghost, signalling "disabled" at a glance.
	tracelessDim: {
		opacity: 0.45,
		pointerEvents: 'none',
		userSelect: 'none',
	},
	componentRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '1px 0',
		fontSize: 12.5,
	},
	componentName: {
		width: 140,
		flex: 'none',
		...commonStyles.textEllipsis,
	},
	componentTrack: {
		flex: 1,
		height: 10,
		display: 'flex',
		alignItems: 'center',
	},
	componentBar: {
		height: 10,
		borderRadius: '0 3px 3px 0',
		background: 'var(--rr-brand)',
		minWidth: 2,
	},
	// Time only — the row tooltip carries calls / avg / max.
	componentValue: {
		width: 62,
		flex: 'none',
		textAlign: 'right',
		...commonStyles.fontMono,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	},
	slowRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '1px 0',
		fontSize: 12.5,
	},
	slowRowClickable: {
		cursor: 'pointer',
	},
	slowDot: {
		width: 7,
		height: 7,
		borderRadius: '50%',
		background: 'var(--rr-brand)',
		flexShrink: 0,
	},
	slowTime: {
		...commonStyles.fontMono,
		fontSize: 11,
		fontWeight: 700,
	},
	slowName: {
		flex: 1,
		minWidth: 0,
		...commonStyles.textEllipsis,
	},
	slowElapsed: {
		...commonStyles.fontMono,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	},
	tileDeviation: {
		color: 'var(--rr-color-error)',
		fontSize: 11,
		fontWeight: 600,
	},
	emptyHint: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Deviation marker threshold: flag runs this much over the trailing median. */
const DEVIATION_RATIO = 1.5;

/** Format seconds compactly (ms under 1s, 1 decimal above). */
function formatSeconds(value: number): string {
	if (value < 1) return `${Math.round(value * 1000)} ms`;
	return `${value.toFixed(1)} s`;
}

/** Format a byte count with a binary-ish human unit. */
function formatBytes(bytes: number): { value: string; unit: string } {
	if (bytes >= 1024 ** 3) return { value: (bytes / 1024 ** 3).toFixed(1), unit: 'GB' };
	if (bytes >= 1024 ** 2) return { value: (bytes / 1024 ** 2).toFixed(1), unit: 'MB' };
	if (bytes >= 1024) return { value: (bytes / 1024).toFixed(1), unit: 'KB' };
	return { value: String(Math.round(bytes)), unit: 'B' };
}

/** Format an epoch-seconds stamp as a local clock time. */
function formatClock(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Format an epoch-seconds stamp as a short local clock time (hour + minute). */
function formatClockShort(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Coarse human duration for the unused-time readouts: exact seconds under
 * 10 s, 5-second steps to a minute, whole minutes to an hour, then hours +
 * minutes — idle time is a magnitude, not a stopwatch.
 */
function formatIdleDuration(seconds: number): string {
	if (seconds < 10) return `${Math.max(1, Math.round(seconds))} s`;
	if (seconds < 60) return `${Math.round(seconds / 5) * 5} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Tile captions, shared by the live report card and the dead-zone ghost. */
const TILE_LABELS = ['Completions', 'Data processed', 'Tokens charged', 'Peak GPU', 'Avg / completion', 'Longest idle'];

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The run's report card at the cursor: tiles, per-component time, slowest
 * completions, and idle gaps.
 */
export const StatusPane: React.FC<IStatusPaneProps> = ({ status, chapters, chapter, position, onOpenTrace, onJumpToRun, componentNames }) => {
	// Whether THIS run recorded traces: the chapter carries its trace level
	// (null/'none' = tracing was OFF; absent = pre-stamp legacy chapter, so
	// keep the generic wording rather than accusing the user).
	const traceOff = chapter != null && 'traceLevel' in chapter && (chapter.traceLevel == null || chapter.traceLevel === 'none');
	// --- Trailing-median deviation (run duration vs recent completed runs) ---
	const deviation = useMemo(() => {
		if (!chapter || !chapters) return null;
		const durations = chapters.filter((c) => c.endTime != null && c.beginSeq !== chapter.beginSeq).map((c) => (c.endTime as number) - c.beginTime);
		if (durations.length < 2) return null;
		durations.sort((a, b) => a - b);
		const median = durations[Math.floor(durations.length / 2)];
		if (median <= 0) return null;
		const runSeconds = (chapter.endTime ?? position ?? chapter.beginTime) - chapter.beginTime;
		const ratio = runSeconds / median;
		return ratio >= DEVIATION_RATIO ? ratio : null;
	}, [chapter, chapters, position]);

	// --- Server-computed analytics off the status snapshot -------------------
	const componentRows = useMemo(() => {
		const stats = status?.componentStats ?? {};
		return Object.entries(stats)
			.map(([component, stat]) => ({ component, ...stat }))
			.sort((a, b) => b.totalSeconds - a.totalSeconds);
	}, [status]);
	const maxComponentTotal = componentRows.length > 0 ? componentRows[0].totalSeconds : 0;

	if (!status) {
		// Dead zone: show the report card's real shape as a dimmed ghost so
		// the first look reads as a preview, not a void — with the compact
		// stock EmptyState (and a jump action when runs exist) in between.
		return (
			<div style={styles.container}>
				<div style={styles.ghost} aria-hidden="true">
					<MiniContainer>
						{TILE_LABELS.map((label) => (
							<MiniCard key={label} value={'—'} label={label} />
						))}
					</MiniContainer>
				</div>
				<EmptyState
					title="No run at this position"
					description={
						onJumpToRun
							? 'Land the needle inside a run — live or recorded — and its report card appears here.'
							: 'This source has not run yet — start a run and its report card appears here.'
					}
					action={
						onJumpToRun && (
							<Button small onClick={onJumpToRun}>
								Jump to latest run
							</Button>
						)
					}
				/>
				<div style={styles.ghost} aria-hidden="true">
					<div style={styles.columns}>
						<div>
							<div style={styles.sectionTitle}>
								Where the time went <span style={styles.sectionHint}>&mdash; this run</span>
							</div>
							<div style={styles.emptyHint}>Per-component timing lands here as the run executes.</div>
						</div>
						<div>
							<div style={styles.sectionTitle}>
								Slowest completions
							</div>
							<div style={styles.emptyHint}>The run&rsquo;s slowest completions land here, each opening its trace.</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	const completions = status.completedCount ?? 0;
	const failed = status.failedCount ?? 0;
	const data = formatBytes(status.completedSize ?? 0);
	const tokensTotal = status.tokens?.total ?? 0;
	const peakGpuMb = status.metrics?.peak_gpu_memory_mb ?? 0;
	const completionSeconds = status.completionSeconds ?? 0;
	const avgCompletion = completions > 0 && completionSeconds > 0 ? completionSeconds / completions : null;
	const slowest = status.slowestDocs ?? [];

	// Pipe-unused counters, rendered verbatim: the server folds the
	// still-open quiet stretch in at every status publish.
	const idleTotal = status.idleSeconds ?? 0;
	const idleLongest = status.idleLongestSeconds ?? 0;
	const idleLongestAt = status.idleLongestAt ?? 0;

	return (
		<div style={styles.container}>
			{/* Report-card tiles — plain status counters, tracing not required */}
			<MiniContainer>
				<MiniCard
					value={
						<span style={styles.valueRow}>
							{completions.toLocaleString()}
							{failed > 0 && <span style={styles.valueUnit}>{failed.toLocaleString()} failed</span>}
						</span>
					}
					label="Completions"
				/>
				<MiniCard
					value={
						<span style={styles.valueRow}>
							{data.value} <span style={styles.valueUnit}>{data.unit}</span>
						</span>
					}
					label="Data processed"
				/>
				<MiniCard value={Math.round(tokensTotal).toLocaleString()} label="Tokens charged" />
				<MiniCard
					value={
						<span style={styles.valueRow}>
							{peakGpuMb >= 1024 ? (peakGpuMb / 1024).toFixed(1) : Math.round(peakGpuMb)}{' '}
							<span style={styles.valueUnit}>{peakGpuMb >= 1024 ? 'GB' : 'MB'}</span>
						</span>
					}
					label="Peak GPU"
				/>
				<MiniCard
					value={
						<span style={styles.valueRow}>
							{avgCompletion !== null ? formatSeconds(avgCompletion) : '—'}
							{deviation !== null && (
								<span style={styles.tileDeviation}>
									{'▲'} {deviation.toFixed(1)}{'×'}
								</span>
							)}
						</span>
					}
					label="Avg / completion"
				/>
				<MiniCard
					value={
						idleLongest > 0 ? (
							<span style={styles.valueColumn} title={`Total idle this run: ${formatIdleDuration(idleTotal)}`}>
								{formatIdleDuration(idleLongest)}
								{idleLongestAt > 0 && <span style={styles.valueSub}>at {formatClockShort(idleLongestAt)}</span>}
							</span>
						) : (
							'—'
						)
					}
					label="Longest idle"
				/>
			</MiniContainer>

			{/* Two-up: component timing left, slowest completions right —
			    grayed/inert when this run recorded no traces. */}
			<div style={traceOff ? { ...styles.columns, ...styles.tracelessDim } : styles.columns}>
				<div>
					<div style={styles.sectionTitle}>
						Where the time went <span style={styles.sectionHint}>&mdash; this run</span>
					</div>
					{componentRows.length === 0 ? (
						<div style={styles.emptyHint}>{traceOff ? 'Pipeline tracing is not enabled for this run — set the Trace level to record component stats.' : 'No component timing recorded — component stats require pipeline tracing.'}</div>
					) : (
						componentRows.map((row) => (
							<div
								key={row.component}
								style={styles.componentRow}
								title={`${formatSeconds(row.totalSeconds)} · ${row.calls.toLocaleString()} calls · avg ${formatSeconds(row.calls > 0 ? row.totalSeconds / row.calls : 0)} · max ${formatSeconds(row.maxSeconds)}`}
							>
								<span style={styles.componentName}>{componentNames?.get(row.component) ?? row.component}</span>
								<span style={styles.componentTrack}>
									<span style={{ ...styles.componentBar, width: `${maxComponentTotal > 0 ? Math.max(1, (row.totalSeconds / maxComponentTotal) * 100) : 1}%` }} />
								</span>
								<span style={styles.componentValue}>{formatSeconds(row.totalSeconds)}</span>
							</div>
						))
					)}
				</div>
				<div>
					<div style={styles.sectionTitle}>
						Slowest completions
					</div>
					{slowest.length === 0 ? (
						<div style={styles.emptyHint}>{traceOff ? 'Pipeline tracing is not enabled for this run.' : `No completions recorded yet${componentRows.length === 0 ? ' — requires pipeline tracing' : ''}.`}</div>
					) : (
						slowest.map((doc) => {
							const clickable = onOpenTrace && doc.beginSeq != null;
							// One activation path for mouse AND keyboard.
							const open = clickable ? () => onOpenTrace(doc.beginSeq as number, doc.name || 'completion') : undefined;
							return (
								<div
									key={`${doc.beginSeq ?? doc.beginTime}`}
									style={clickable ? { ...styles.slowRow, ...styles.slowRowClickable } : styles.slowRow}
									title={clickable ? 'Open this completion’s trace' : undefined}
									role={clickable ? 'button' : undefined}
									tabIndex={clickable ? 0 : undefined}
									onClick={open}
									onKeyDown={
										open
											? (e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														open();
													}
												}
											: undefined
									}
								>
									<span style={styles.slowDot} />
									<span style={styles.slowTime}>{formatClock(doc.beginTime)}</span>
									<span style={styles.slowName}>{doc.name || 'completion'}</span>
									<span style={styles.slowElapsed}>{formatSeconds(doc.elapsed)}</span>
								</div>
							);
						})
					)}
				</div>
			</div>

		</div>
	);
};
