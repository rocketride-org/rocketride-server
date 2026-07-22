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
import { commonStyles } from '../../../themes/styles';
import { EmptyState } from '../../../components/empty-state/EmptyState';
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
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Event types the text projection renders. */
const TEXT_EVENT_TYPES = new Set(['output', 'apaevt_log_lifecycle', 'apaevt_status_error', 'apaevt_status_warning']);

/** Auto-scroll re-pins when the user is within this many px of the bottom. */
const PIN_THRESHOLD_PX = 24;

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
		lineHeight: 1.55,
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
	const time = new Date(message.eventTime * 1000).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	// Engine/console output — stderr renders distinctly from stdout prints.
	if (message.event === 'output') {
		const text = String(body.output ?? '').replace(/\n$/, '');
		if (!text) return null;
		const style = body.category === 'stderr' ? styles.stderr : styles.line;
		return { key: message.seq, time, text, style };
	}

	// Errors / warnings from the engine protocol.
	if (message.event === 'apaevt_status_error') {
		return { key: message.seq, time, text: `ERROR: ${String(body.message ?? '')}`, style: styles.error };
	}
	if (message.event === 'apaevt_status_warning') {
		return { key: message.seq, time, text: `WARN: ${String(body.message ?? '')}`, style: styles.stderr };
	}

	// Lifecycle markers — run boundaries, restarts, clock anomalies.
	const action = String(body.action ?? '');
	const detail = body.outcome ? ` (${String(body.outcome)})` : body.detail ? ` — ${String(body.detail)}` : '';
	return { key: message.seq, time, text: `── ${action}${detail} ──`, style: styles.lifecycle };
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Text projection of the run log's output/stderr/lifecycle events.
 */
export const LogPane: React.FC<ILogPaneProps> = ({ events, downloadBase }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	// Project the visible window into text lines (memoized on the window).
	const lines = useMemo(() => {
		const projected: LogLine[] = [];
		for (const message of events) {
			const line = projectLine(message);
			if (line) projected.push(line);
		}
		return projected;
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
		anchor.click();
		URL.revokeObjectURL(url);
	}, []);

	/** Save the projected text lines as a plain-text log file. */
	const handleDownloadLog = useCallback(() => {
		const text = lines.map((line) => `${line.time} ${line.text}`).join('\n');
		saveAs(text, `${downloadBase ?? 'run-log'}.log.txt`);
	}, [lines, downloadBase, saveAs]);

	/** Save the run's raw stamped events as JSONL — the log file itself. */
	const handleDownloadEvents = useCallback(() => {
		const jsonl = events.map((message) => JSON.stringify(message)).join('\n');
		saveAs(jsonl, `${downloadBase ?? 'run-log'}.jsonl`);
	}, [events, downloadBase, saveAs]);

	// The stock placeholder replaces the terminal frame entirely while empty —
	// a dashed panel inside the log box would nest two frames.
	if (lines.length === 0) {
		return <EmptyState title="No log output" description="Run output appears here while the pipeline runs or when replaying a recorded run." />;
	}

	return (
		<div style={styles.pane}>
			<div style={styles.toolbar}>
				<button style={commonStyles.buttonSecondary} onClick={handleDownloadLog}>
					Download Log
				</button>
				<button style={commonStyles.buttonSecondary} onClick={handleDownloadEvents}>
					Download Events
				</button>
			</div>
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
