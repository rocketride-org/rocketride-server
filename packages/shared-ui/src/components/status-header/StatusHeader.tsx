// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * StatusHeader — State badge and elapsed-time display for a pipeline.
 * StatusHeaderInfo / StatusElapsed — the header's composable pieces, exported
 * so hosts that render inside a stock Card's header/headerActions slots reuse
 * the SAME markup instead of nesting a second header row.
 * StatusActions — Run/Stop button (stock Button, per the Card-header rule
 * that header buttons are plain `<Button small>`).
 */

import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import PadlockIcon from '../../assets/icons/PadlockIcon';
import type { ITaskStatus } from '../../types/project';
import { ITaskState } from '../../types/project';
import { commonStyles } from '../../themes/styles';
import { Button } from '../button/Button';

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
	/** Extra content rendered to the left of the Run/Stop button. */
	extraActions?: ReactNode;
	/** When false, the Run button shows "Subscribe" instead of "Run". */
	isSubscribed?: boolean;
}

export interface StatusActionsProps {
	taskStatus: ITaskStatus | null | undefined;
	onPipelineAction: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	/** When false, the Run button shows "Subscribe" instead of "Run". */
	isSubscribed?: boolean;
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
 * StatusHeaderInfo — the header's LEFT block: state dot, name, state label,
 * and the status-message subtitle. Rendered standalone inside a stock Card's
 * `header` slot (the Card owns the row chrome), or composed by StatusHeader.
 */
export const StatusHeaderInfo: React.FC<Pick<StatusHeaderProps, 'name' | 'taskStatus'>> = ({ name, taskStatus }) => {
	const state = taskStatus?.state ?? ITaskState.NONE;
	const hasStatus = !!taskStatus?.status;

	return (
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
	);
};

/**
 * StatusElapsed \u2014 the "Started Xs ago" line (hidden while not running).
 * Rendered under the action buttons in a Card's `headerActions` column.
 */
export const StatusElapsed: React.FC<Pick<StatusHeaderProps, 'taskStatus' | 'currentElapsed'>> = ({ taskStatus, currentElapsed }) => {
	const showElapsed = !!taskStatus && taskStatus.startTime > 0 && !taskStatus.completed;

	return (
		<div style={{ ...commonStyles.textMuted, fontSize: 'var(--rr-font-size-caption)', visibility: showElapsed ? 'visible' : 'hidden' }}>
			Started <span style={styles.elapsedValue}>{formatElapsedTime(currentElapsed)}</span> ago
		</div>
	);
};

/**
 * StatusHeader \u2014 source name, state, status, elapsed time, and action buttons
 * as one self-contained header row, for hosts NOT composing a stock Card
 * (Card-based hosts put StatusHeaderInfo / StatusElapsed in the Card's slots
 * instead, so the Card owns the single header row).
 *
 * Layout:
 *   Row 1: \u25CF Name  StateLabel                          [Run/Stop]
 *   Row 2:   Status message
 *   Row 3:   Started Xs ago (when running)
 */
export const StatusHeader: React.FC<StatusHeaderProps> = ({ name, taskStatus, currentElapsed, onPipelineAction, extraActions, isSubscribed }) => {
	return (
		<div style={commonStyles.cardHeader}>
			{/* Left column: name, state, status */}
			<StatusHeaderInfo name={name} taskStatus={taskStatus} />
			{/* Right column: buttons on top, elapsed below */}
			<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{extraActions}
					{onPipelineAction && <StatusActions taskStatus={taskStatus} onPipelineAction={onPipelineAction} isSubscribed={isSubscribed} />}
				</div>
				<StatusElapsed taskStatus={taskStatus} currentElapsed={currentElapsed} />
			</div>
		</div>
	);
};

/**
 * StatusActions — Run/Stop button for the tab bar actions slot.
 * Renders in the host's tab-bar actions area, not inside the panel content.
 */
export const StatusActions: React.FC<StatusActionsProps> = ({ taskStatus, onPipelineAction, isSubscribed }) => {
	const state = taskStatus?.state ?? ITaskState.NONE;
	let btn = getControlButton(state);
	// Not subscribed — show "Subscribe" instead of "Run"
	if (isSubscribed === false && btn.action === 'run') {
		btn = { ...btn, label: 'Subscribe' };
	}

	// Stock Button, per the Card-header rule: header buttons are plain
	// <Button small> — danger for Stop, primary for Run/Subscribe.
	return (
		<Button small variant={btn.variant === 'stop' ? 'danger' : 'primary'} disabled={btn.disabled} onClick={() => onPipelineAction(btn.action, taskStatus?.source)}>
			{btn.label}
			{isSubscribed === false && btn.action === 'run' && (
				<span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
					<PadlockIcon size={18} />
				</span>
			)}
		</Button>
	);
};

export default StatusHeader;
