// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * StatusHeader — State badge and elapsed-time display for a running pipeline.
 *
 * Ported from vscode StatusSection/StatusHeader.tsx.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import type { ITaskStatus } from '../../types/project';
import { ITaskState } from '../../types/project';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	stack: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
	},
	badge: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
	},
	indicatorBox: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 16,
		height: 16,
		flexShrink: 0,
	},
	indicator: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-text-secondary, #888)',
	},
	indicatorRunning: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-chart-green, #2e7d32)',
		boxShadow: '0 0 4px var(--rr-chart-green, #2e7d32)',
	},
	indicatorInitializing: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-chart-blue, #1976d2)',
	},
	indicatorStopping: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-chart-purple, #9c27b0)',
	},
	indicatorCompleted: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-text-secondary, #888)',
	},
	indicatorOffline: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-text-secondary, #888)',
		opacity: 0.5,
	},
	stateLabel: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary, #e0e0e0)',
	},
	subtitle: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		fontSize: 12,
		color: 'var(--rr-brand, #1976d2)',
	},
	elapsed: {
		fontSize: 12,
		color: 'var(--rr-text-secondary, rgba(204,204,204,0.6))',
	},
	elapsedValue: {
		fontWeight: 600,
		color: 'var(--rr-text-primary, #e0e0e0)',
	},
};

// =============================================================================
// TYPES
// =============================================================================

interface StatusHeaderProps {
	taskStatus: ITaskStatus | null | undefined;
	currentElapsed: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Format elapsed time for compact display.
 */
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

/**
 * Get task state display label.
 */
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

/**
 * Get the inline style for the status indicator dot based on state.
 */
const getIndicatorStyle = (state: number): CSSProperties => {
	switch (state) {
		case ITaskState.RUNNING:
			return styles.indicatorRunning;
		case ITaskState.INITIALIZING:
			return styles.indicatorInitializing;
		case ITaskState.STOPPING:
			return styles.indicatorStopping;
		case ITaskState.COMPLETED:
			return styles.indicatorCompleted;
		case ITaskState.CANCELLED:
			return styles.indicatorOffline;
		case ITaskState.NONE:
			return styles.indicatorOffline;
		default:
			return styles.indicatorOffline;
	}
};

/**
 * StatusHeader Component
 *
 * Two-line stacked layout:
 * - Line 1: State badge (dot + Running / Initializing / etc.)
 * - Line 2: Job status message in accent color
 */
export const StatusHeader: React.FC<StatusHeaderProps> = ({ taskStatus }) => {
	const hasSubtitle = !!taskStatus?.status;

	return (
		<div style={styles.stack}>
			<div style={styles.badge}>
				<div style={styles.indicatorBox}>
					<div style={taskStatus ? getIndicatorStyle(taskStatus.state) : styles.indicatorOffline} />
				</div>
				<span style={styles.stateLabel}>{taskStatus ? getTaskStateDisplay(taskStatus.state) : 'Offline'}</span>
			</div>
			<div
				style={{
					...styles.subtitle,
					visibility: hasSubtitle ? 'visible' : 'hidden',
				}}
			>
				<div style={styles.indicatorBox} />
				<span>{taskStatus?.status || '\u00A0'}</span>
			</div>
		</div>
	);
};

/**
 * StatusElapsed Component
 *
 * Renders "Started Xs ago" — placed in the right column by the parent layout.
 */
export const StatusElapsed: React.FC<StatusHeaderProps> = ({ taskStatus, currentElapsed }) => {
	const isVisible = !!taskStatus && taskStatus.startTime > 0 && !taskStatus.completed;

	return (
		<div
			style={{
				...styles.elapsed,
				visibility: isVisible ? 'visible' : 'hidden',
			}}
		>
			Started <span style={styles.elapsedValue}>{formatElapsedTime(currentElapsed)}</span> ago
		</div>
	);
};

export default StatusHeader;
