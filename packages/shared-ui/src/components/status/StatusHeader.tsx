// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * StatusHeader — Full status header bar with state badge, Run/Stop button,
 * and elapsed-time display.
 *
 * Layout:
 *   Left:  state indicator dot + "Running"/"Offline" + status subtitle
 *   Right: Run/Stop button + "Started Xs ago"
 */

import React from 'react';
import type { CSSProperties } from 'react';
import type { ITaskStatus } from '../../types/project';
import { ITaskState } from '../../types/project';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: 16,
		marginBottom: 16,
	} as CSSProperties,
	left: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	right: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-end',
		gap: 6,
		flexShrink: 0,
	} as CSSProperties,

	// State badge
	stack: {
		display: 'flex',
		flexDirection: 'column',
		gap: 2,
	} as CSSProperties,
	badge: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	} as CSSProperties,
	indicatorBox: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 16,
		height: 16,
		flexShrink: 0,
	} as CSSProperties,
	stateLabel: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	subtitle: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		fontSize: 12,
		color: 'var(--rr-brand)',
	} as CSSProperties,

	// Elapsed
	elapsed: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	elapsedValue: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Action button
	actionRow: {
		display: 'flex',
		gap: 6,
	} as CSSProperties,
};

// Indicator dot styles by state
const indicatorBase: CSSProperties = { width: 8, height: 8, borderRadius: '50%' };

const indicators: Record<string, CSSProperties> = {
	running: { ...indicatorBase, backgroundColor: 'var(--rr-color-success)', boxShadow: '0 0 4px var(--rr-color-success)' },
	initializing: { ...indicatorBase, backgroundColor: 'var(--rr-color-info)' },
	stopping: { ...indicatorBase, backgroundColor: 'var(--rr-color-warning)' },
	completed: { ...indicatorBase, backgroundColor: 'var(--rr-text-secondary)' },
	offline: { ...indicatorBase, backgroundColor: 'var(--rr-text-secondary)', opacity: 0.5 },
};

const actionBtnStyle = (variant: 'run' | 'stop' | 'disabled'): CSSProperties => ({
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: 'none',
	cursor: variant === 'disabled' ? 'default' : 'pointer',
	opacity: variant === 'disabled' ? 0.5 : 1,
	backgroundColor: variant === 'stop' ? 'var(--rr-color-error)' : 'var(--rr-brand)',
	color: 'var(--rr-fg-button)',
	transition: 'opacity 0.15s',
});

// =============================================================================
// TYPES
// =============================================================================

export interface StatusHeaderProps {
	taskStatus: ITaskStatus | null | undefined;
	currentElapsed: number;
	onPipelineAction?: (action: 'run' | 'stop' | 'restart') => void;
}

// =============================================================================
// HELPERS
// =============================================================================

const formatElapsedTime = (seconds: number): string => {
	const totalSeconds = Math.floor(seconds);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;
	return `${hours}h ${minutes}m ${remainingSeconds}s`;
};

const getTaskStateDisplay = (state: number): string => {
	switch (state) {
		case ITaskState.RUNNING:
			return 'Running';
		case ITaskState.INITIALIZING:
			return 'Initializing';
		case ITaskState.STOPPING:
			return 'Stopping';
		case ITaskState.COMPLETED:
			return 'Completed';
		case ITaskState.CANCELLED:
			return 'Offline';
		case ITaskState.NONE:
			return 'Offline';
		default:
			return 'Offline';
	}
};

const getIndicator = (state: number): CSSProperties => {
	switch (state) {
		case ITaskState.RUNNING:
			return indicators.running;
		case ITaskState.INITIALIZING:
			return indicators.initializing;
		case ITaskState.STOPPING:
			return indicators.stopping;
		case ITaskState.COMPLETED:
			return indicators.completed;
		default:
			return indicators.offline;
	}
};

const getControlButton = (state: number) => {
	if (state === ITaskState.STOPPING) {
		return { label: 'Stopping...', action: 'stop' as const, disabled: true, variant: 'disabled' as const };
	}
	if (state === ITaskState.RUNNING || state === ITaskState.INITIALIZING) {
		return { label: 'Stop', action: 'stop' as const, disabled: false, variant: 'stop' as const };
	}
	return { label: 'Run', action: 'run' as const, disabled: false, variant: 'run' as const };
};

// =============================================================================
// COMPONENT
// =============================================================================

export const StatusHeader: React.FC<StatusHeaderProps> = ({ taskStatus, currentElapsed, onPipelineAction }) => {
	const hasSubtitle = !!taskStatus?.status;
	const state = taskStatus?.state ?? ITaskState.NONE;
	const controlButton = getControlButton(state);
	const showElapsed = !!taskStatus && taskStatus.startTime > 0 && !taskStatus.completed;

	return (
		<div style={styles.header}>
			{/* Left: state badge */}
			<div style={styles.left}>
				<div style={styles.stack}>
					<div style={styles.badge}>
						<div style={styles.indicatorBox}>
							<div style={getIndicator(state)} />
						</div>
						<span style={styles.stateLabel}>{getTaskStateDisplay(state)}</span>
					</div>
					<div style={{ ...styles.subtitle, visibility: hasSubtitle ? 'visible' : 'hidden' }}>
						<div style={styles.indicatorBox} />
						<span>{taskStatus?.status || '\u00A0'}</span>
					</div>
				</div>
			</div>

			{/* Right: action button + elapsed */}
			<div style={styles.right}>
				{onPipelineAction && (
					<div style={styles.actionRow}>
						<button
							style={actionBtnStyle(controlButton.variant)}
							disabled={controlButton.disabled}
							onClick={() => {
								if (!controlButton.disabled) onPipelineAction(controlButton.action);
							}}
						>
							{controlButton.label}
						</button>
					</div>
				)}
				<div style={{ ...styles.elapsed, visibility: showElapsed ? 'visible' : 'hidden' }}>
					Started <span style={styles.elapsedValue}>{formatElapsedTime(currentElapsed)}</span> ago
				</div>
			</div>
		</div>
	);
};

export default StatusHeader;
