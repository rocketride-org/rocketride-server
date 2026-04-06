// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * StatusHeader — State badge and elapsed-time display for a pipeline.
 * StatusActions — Run/Stop button for the tab bar actions slot.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import type { ITaskStatus } from '../../types/project';
import { ITaskState } from '../../types/project';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// STYLES (component-specific only)
// =============================================================================

const styles = {
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
	elapsedValue: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

export interface StatusHeaderProps {
	/** Source display name (shown as title when provided). */
	name?: string;
	taskStatus: ITaskStatus | null | undefined;
	currentElapsed: number;
	/** Pipeline action callback. When provided, Run/Stop buttons are rendered. */
	onPipelineAction?: (action: 'run' | 'stop' | 'restart', source?: string) => void;
}

export interface StatusActionsProps {
	taskStatus: ITaskStatus | null | undefined;
	onPipelineAction: (action: 'run' | 'stop' | 'restart', source?: string) => void;
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
			return commonStyles.indicatorSuccess;
		case ITaskState.INITIALIZING:
			return commonStyles.indicatorInfo;
		case ITaskState.STOPPING:
			return commonStyles.indicatorWarning;
		case ITaskState.COMPLETED:
			return { ...commonStyles.indicatorBase, backgroundColor: 'var(--rr-text-secondary)' };
		default:
			return commonStyles.indicatorMuted;
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
// COMPONENTS
// =============================================================================

/**
 * StatusHeader — source name, state, status, elapsed time, and action buttons.
 *
 * Layout:
 *   Row 1: ● Name  StateLabel                          [Run/Stop]
 *   Row 2:   Status message
 *   Row 3:   Started Xs ago (when running)
 */
export const StatusHeader: React.FC<StatusHeaderProps> = ({ name, taskStatus, currentElapsed, onPipelineAction }) => {
	const state = taskStatus?.state ?? ITaskState.NONE;
	const hasStatus = !!taskStatus?.status;
	const showElapsed = !!taskStatus && taskStatus.startTime > 0 && !taskStatus.completed;

	return (
		<div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--rr-border)' }}>
			{/* Left column: name, state, status */}
			<div style={styles.stack}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<div style={styles.indicatorBox}>
						<div style={getIndicator(state)} />
					</div>
					{name && <span style={styles.stateLabel}>{name}</span>}
					<span style={{ fontSize: 'var(--rr-font-size-caption)', color: 'var(--rr-text-secondary)' }}>{getTaskStateDisplay(state)}</span>
				</div>
				<div style={{ ...styles.subtitle, visibility: hasStatus ? 'visible' : 'hidden' }}>
					<div style={styles.indicatorBox} />
					<span>{taskStatus?.status || '\u00A0'}</span>
				</div>
			</div>
			{/* Right column: buttons on top, elapsed below */}
			<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
				{onPipelineAction && <StatusActions taskStatus={taskStatus} onPipelineAction={onPipelineAction} />}
				<div style={{ ...commonStyles.textMuted, fontSize: 'var(--rr-font-size-caption)', visibility: showElapsed ? 'visible' : 'hidden' }}>
					Started <span style={styles.elapsedValue}>{formatElapsedTime(currentElapsed)}</span> ago
				</div>
			</div>
		</div>
	);
};

/**
 * StatusActions — Run/Stop button for the tab bar actions slot.
 * Renders in the TabPanel bar, not inside the panel content.
 */
export const StatusActions: React.FC<StatusActionsProps> = ({ taskStatus, onPipelineAction }) => {
	const state = taskStatus?.state ?? ITaskState.NONE;
	const btn = getControlButton(state);

	return (
		<button
			style={{
				...(btn.variant === 'stop' ? commonStyles.buttonDanger : commonStyles.buttonPrimary),
				...(btn.disabled ? commonStyles.buttonDisabled : {}),
			}}
			disabled={btn.disabled}
			onClick={() => {
				if (!btn.disabled) onPipelineAction(btn.action, taskStatus?.source);
			}}
		>
			{btn.label}
		</button>
	);
};

export default StatusHeader;
