// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * LogPane — the human-readable text projection of a source's run log.
 *
 * The run log is JSONL events; this pane renders the output / stderr /
 * lifecycle subset as text, exactly like tailing a classic log file — the
 * "Log page is a projection, not a second file" decision. Live mode tails
 * the subscription; replay mode shows the visible window the useTaskEvents
 * buffer has dispatched up to the cursor. Auto-scrolls while pinned to the
 * tail; a manual scroll-up detaches until the user returns to the bottom.
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from 'shell';
import { Button } from 'shell';
import type { TaskEventMessage } from '../hooks/useTaskEvents';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link LogPane}. */
export interface ILogPaneProps {
	/** The visible event window (from useTaskEvents). */
	events: TaskEventMessage[];
	/** Base filename for the Download actions (defaults to run-log). */
	downloadBase?: string;
	/**
	 * Coverage honesty from the track window: events before this time exist
	 * but are not loaded (fold trim) — surfaced above the terminal.
	 */
	truncatedBefore?: number;
	/**
	 * Full-chapter reconstruction fetch for the Download actions: walks EVERY
	 * segment of the chapter through the DVR session, uncapped — the file is
	 * the complete run regardless of what the pane displays. Absent, the
	 * downloads fall back to the visible window.
	 */
	fetchChapterEvents?: () => Promise<TaskEventMessage[]>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Event types the text projection renders. */
const TEXT_EVENT_TYPES = new Set(['output', 'apaevt_log_lifecycle', 'apaevt_status_error', 'apaevt_status_warning']);

/** Auto-scroll re-pins when the user is within this many px of the bottom. */
const PIN_THRESHOLD_PX = 24;

/** Display cap (lines) — terminal semantics; downloads are never capped. */
const DISPLAY_LINE_CAP = 2_000;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	// Toolbar + terminal stack filling the pane body, with breathing room
	// beneath the box so it does not sit flush on the pane's bottom edge.
	pane: {
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		paddingBottom: 12,
		boxSizing: 'border-box',
	},
	toolbar: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 8,
		marginBottom: 8,
	},
	container: {
		flex: 1,
		minHeight: 160,
		overflow: 'auto',
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '8px 12px',
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 12,
		// Terminal-tight: log output (and the startup ASCII art) reads as a
		// console, not prose.
		lineHeight: 1.25,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	line: {
		color: 'var(--rr-text-primary)',
	},
	stderr: {
		color: 'var(--rr-color-warning)',
	},
	error: {
		color: 'var(--rr-color-error)',
	},
	lifecycle: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	},
	time: {
		color: 'var(--rr-text-disabled)',
		marginRight: 8,
	},
	// Coverage/cap honesty banner above the terminal box.
	notice: {
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
		padding: '4px 2px',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** One renderable log line derived from an event. */
interface LogLine {
	key: number;
	time: string;
	text: string;
	style: CSSProperties;
}

/**
 * Project one event message into a text line, or null when not text-worthy.
 *
 * @param message - A stamped event from the visible window.
 * @returns The renderable line, or null to skip.
 */
function projectLine(message: TaskEventMessage): LogLine | null {
	if (!TEXT_EVENT_TYPES.has(message.event)) return null;
	const body = (message.body ?? {}) as Record<string, unknown>;
	const time = new Date(message.body.eventTime * 1000).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	// Engine/console output — stderr renders distinctly from stdout prints.
	if (message.event === 'output') {
		const text = String(body.output ?? '').replace(/\n$/, '');
		if (!text) return null;
		const style = body.category === 'stderr' ? styles.stderr : styles.line;
		return { key: message.body.logSeq, time, text, style };
	}

	// Errors / warnings from the engine protocol.
	if (message.event === 'apaevt_status_error') {
		return { key: message.body.logSeq, time, text: `ERROR: ${String(body.message ?? '')}`, style: styles.error };
	}
	if (message.event === 'apaevt_status_warning') {
		return { key: message.body.logSeq, time, text: `WARN: ${String(body.message ?? '')}`, style: styles.stderr };
	}

	// Lifecycle markers — run boundaries, restarts, clock anomalies.
	const action = String(body.action ?? '');
	const detail = body.outcome ? ` (${String(body.outcome)})` : body.detail ? ` — ${String(body.detail)}` : '';
	return { key: message.body.logSeq, time, text: `── ${action}${detail} ──`, style: styles.lifecycle };
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Text projection of the run log's output/stderr/lifecycle events.
 */
export const LogPane: React.FC<ILogPaneProps> = ({ events, downloadBase, truncatedBefore, fetchChapterEvents }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);
	const [downloading, setDownloading] = useState(false);

	// Project the visible window into text lines (memoized on the window),
	// then apply the terminal display cap — the cap is display-only; the
	// Download actions reconstruct the complete run.
	const { lines, capped } = useMemo(() => {
		const projected: LogLine[] = [];
		for (const message of events) {
			const line = projectLine(message);
			if (line) projected.push(line);
		}
		if (projected.length > DISPLAY_LINE_CAP) {
			return { lines: projected.slice(-DISPLAY_LINE_CAP), capped: projected.length - DISPLAY_LINE_CAP };
		}
		return { lines: projected, capped: 0 };
	}, [events]);

	// Tail behavior: follow the bottom while pinned; a manual scroll-up
	// detaches, returning near the bottom re-pins.
	useEffect(() => {
		if (pinned && containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [lines, pinned]);

	/** Track whether the user is at (or near) the tail. */
	const handleScroll = () => {
		const el = containerRef.current;
		if (!el) return;
		setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX);
	};

	/** Trigger a browser download of the given content. */
	const saveAs = useCallback((content: string, filename: string) => {
		const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		// In-document click + deferred revoke: some browsers only reliably
		// start a download for an attached anchor, and revoking synchronously
		// can cancel a download that has not begun fetching the blob yet
		// (same pattern as the data-grid export helper).
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}, []);

	/**
	 * The download source: the FULL chapter reconstruction when the host
	 * provides it (every segment walked, uncapped), else the visible window.
	 */
	const collectEvents = useCallback(async (): Promise<TaskEventMessage[]> => {
		if (!fetchChapterEvents) return events;
		setDownloading(true);
		try {
			return await fetchChapterEvents();
		} catch {
			// Reconstruction failure falls back to what the pane holds.
			return events;
		} finally {
			setDownloading(false);
		}
	}, [fetchChapterEvents, events]);

	/** Save the run's COMPLETE console as a plain-text log file (uncapped). */
	const handleDownloadLog = useCallback(() => {
		void collectEvents().then((all) => {
			const text = all
				.map((message) => projectLine(message))
				.filter((line): line is LogLine => line !== null)
				.map((line) => `${line.time} ${line.text}`)
				.join('\n');
			saveAs(text, `${downloadBase ?? 'run-log'}.log.txt`);
		});
	}, [collectEvents, downloadBase, saveAs]);

	/** Save the run's raw stamped events as JSONL — the log file itself. */
	const handleDownloadEvents = useCallback(() => {
		void collectEvents().then((all) => {
			const jsonl = all.map((message) => JSON.stringify(message)).join('\n');
			saveAs(jsonl, `${downloadBase ?? 'run-log'}.jsonl`);
		});
	}, [collectEvents, downloadBase, saveAs]);

	// The stock placeholder replaces the terminal frame entirely while empty —
	// a dashed panel inside the log box would nest two frames.
	if (lines.length === 0) {
		return <EmptyState title="No log output" description="Run output appears here while the pipeline runs or when replaying a recorded run." />;
	}

	// Honesty notices: display cap and fold coverage — the pane never
	// silently truncates (downloads always reconstruct the complete run).
	const notices: string[] = [];
	if (truncatedBefore !== undefined) {
		const from = new Date(truncatedBefore * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		notices.push(`Showing events from ${from} — earlier output is not loaded. Download Log for the complete run.`);
	}
	if (capped > 0) {
		notices.push(`Showing the last ${DISPLAY_LINE_CAP.toLocaleString()} lines (${capped.toLocaleString()} earlier hidden). Download Log for the complete run.`);
	}

	return (
		<div style={styles.pane}>
			<div style={styles.toolbar}>
				<Button variant="secondary" small onClick={handleDownloadLog} disabled={downloading}>
					{downloading ? 'Preparing…' : 'Download Log'}
				</Button>
				<Button variant="secondary" small onClick={handleDownloadEvents} disabled={downloading}>
					{downloading ? 'Preparing…' : 'Download Events'}
				</Button>
			</div>
			{notices.map((notice) => (
				<div key={notice} style={styles.notice}>
					{notice}
				</div>
			))}
			<div ref={containerRef} style={styles.container} onScroll={handleScroll}>
				{lines.map((line) => (
					<div key={line.key} style={line.style}>
						<span style={styles.time}>{line.time}</span>
						{line.text}
					</div>
				))}
			</div>
		</div>
	);
};
