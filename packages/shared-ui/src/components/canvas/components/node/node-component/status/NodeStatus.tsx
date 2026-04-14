// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * NodeStatus — Real-time pipeline execution status displayed on canvas nodes.
 *
 * For **source nodes**, shows a persistent mini dashboard:
 *   - Starting: "Initializing..." + status message + indeterminate progress bar
 *   - Running: "X done · Ys" + progress bar + "Status ↗" link
 *   - Running with errors: adds error count, orange progress bar
 *   - Completed (success): "✓ X done · Ys" + green accent bar — persists
 *   - Completed (errors): counts + orange accent bar + persists
 *   - Startup error: "✕ Failed to start" + error message inline + red accent bar
 *
 * For **non-source nodes**, shows a "Pipes X/Y" progress bar during execution.
 */

import React, { ReactElement } from 'react';

import { ITaskStatus, ITaskState } from '../../../../types';
import { PipelineActions } from '../../../../../../components/pipeline-actions';
import { commonStyles } from '../../../../../../themes/styles';

// =============================================================================
// Helpers
// =============================================================================

/** Parse structured error "ErrorType*`message`*filepath:line" into display parts. */
const parseError = (raw: string): { type: string; message: string } => {
	const parts = raw.split('*');
	if (parts.length >= 2) {
		return { type: parts[0].trim(), message: parts[1].replace(/^`|`$/g, '').trim() };
	}
	return { type: '', message: raw };
};

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

// =============================================================================
// Component
// =============================================================================

interface INodeStatusProps {
	/** Node ID used to look up this component's pipe count in the flow data. */
	componentProvider: string;
	/** Whether this node is a source (pipeline entry point) node. */
	isSourceNode: boolean;
	/** Task status data received via DAP events; undefined when no task is running. */
	taskStatus: ITaskStatus | undefined;
	/** Map of component ID → number of pipes that have reached it. */
	componentPipeCounts?: Record<string, number>;
	/** Total number of pipes in the running pipeline (denominator for progress). */
	totalPipes?: number;
	/** Callback to open the status page for this source node. */
	onOpenStatus?: (nodeId: string) => void;
	/** Callback to open a URL externally (for pipeline action buttons). */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Server host URL for replacing {host} placeholders in endpoint URLs. */
	serverHost?: string;
	/** Display name for the source node (used as the tab title when opening links). */
	displayName?: string;
}

export default function NodeStatus({ componentProvider, isSourceNode, taskStatus, componentPipeCounts, totalPipes, onOpenStatus, onOpenLink, serverHost, displayName }: INodeStatusProps): ReactElement | null {
	// ========================================================================
	// Source node: persistent mini dashboard
	// ========================================================================
	if (isSourceNode && taskStatus) {
		const runningStates = [ITaskState.STARTING, ITaskState.INITIALIZING, ITaskState.RUNNING];
		const isRunning = runningStates.includes(taskStatus.state) && !taskStatus.completed;
		const isCompleted = taskStatus.completed || taskStatus.state === ITaskState.COMPLETED || taskStatus.state === ITaskState.CANCELLED;

		const completedCount = taskStatus.completedCount || 0;
		const failedCount = taskStatus.failedCount || 0;
		const hasErrors = failedCount > 0 || (taskStatus.errors && taskStatus.errors.length > 0);

		const currentTimeSeconds = Math.floor(Date.now() / 1000);
		const elapsed = taskStatus.startTime > 0 ? Math.max(0, currentTimeSeconds - taskStatus.startTime) : 0;

		const statusLink = onOpenStatus ? (
			<a
				onClick={(e: React.MouseEvent) => {
					e.stopPropagation();
					onOpenStatus(componentProvider);
				}}
				style={styles.statusLink}
			>
				Status ↗
			</a>
		) : null;

		const pipelineActions = <PipelineActions notes={taskStatus.notes} host={serverHost} onOpenLink={onOpenLink} displayName={displayName} />;

		// ── Starting / Initializing ──────────────────────────────────────
		if (isRunning && (taskStatus.state === ITaskState.STARTING || taskStatus.state === ITaskState.INITIALIZING)) {
			return (
				<div style={styles.footer}>
					<div style={styles.sourceFooterMain}>
						<span style={{ ...styles.footerText, color: 'var(--rr-text-disabled)' }}>Initializing...</span>
						{statusLink}
					</div>
					{taskStatus.status && (
						<span style={styles.statusMessage} title={taskStatus.status}>
							{taskStatus.status}
						</span>
					)}
					{pipelineActions}
					<div style={{ height: 3, borderRadius: 2, marginTop: 5, backgroundColor: 'var(--rr-border)', overflow: 'hidden' }}>
						<div style={{ width: '30%', height: '100%', backgroundColor: 'var(--rr-accent)', borderRadius: 2, animation: 'rr-indeterminate 1.5s ease-in-out infinite', transformOrigin: '0% 50%' }} />
					</div>
				</div>
			);
		}

		// ── Running ──────────────────────────────────────────────────────
		if (isRunning) {
			return (
				<div style={styles.footer}>
					<div style={styles.sourceFooterMain}>
						<span style={styles.footerText}>
							<span style={{ color: 'var(--rr-success)' }}>{completedCount} done</span>
							{failedCount > 0 && (
								<>
									{' · '}
									<span style={{ color: 'var(--rr-error)' }}>{failedCount} errors</span>
								</>
							)}
							<span style={{ color: 'var(--rr-text-disabled)', marginLeft: '2px' }}> · {formatElapsedTime(elapsed)}</span>
						</span>
						{statusLink}
					</div>
					{taskStatus.status && (
						<span style={styles.statusMessage} title={taskStatus.status}>
							{taskStatus.status}
						</span>
					)}
					{pipelineActions}
				</div>
			);
		}

		// ── Completed / Stopped ──────────────────────────────────────────
		if (isCompleted) {
			// Check for startup error: completed with errors but zero completions
			const isStartupError = completedCount === 0 && hasErrors;
			const firstError = taskStatus.errors?.[0];

			const elapsedFinal = taskStatus.endTime > 0 && taskStatus.startTime > 0 ? Math.max(0, taskStatus.endTime - taskStatus.startTime) : elapsed;

			if (isStartupError) {
				const parsed = firstError ? parseError(firstError) : null;
				return (
					<div style={styles.footer}>
						<div style={styles.sourceFooterMain}>
							<span style={styles.footerText}>
								<span style={{ color: 'var(--rr-error)' }}>✕ Failed to start</span>
							</span>
							{statusLink}
						</div>
						{parsed && (
							<span style={styles.errorMessage}>
								{parsed.type && <span style={{ fontWeight: 600 }}>{parsed.type}: </span>}
								{parsed.message}
							</span>
						)}
						<div style={styles.accentBarError} />
					</div>
				);
			}

			return (
				<div style={styles.footer}>
					<div style={styles.sourceFooterMain}>
						<span style={styles.footerText}>
							{!hasErrors && <span style={{ color: 'var(--rr-success)' }}>✓ </span>}
							<span style={{ color: 'var(--rr-success)' }}>{completedCount} done</span>
							{failedCount > 0 && (
								<>
									{' · '}
									<span style={{ color: 'var(--rr-error)' }}>{failedCount} errors</span>
								</>
							)}
							<span style={{ color: 'var(--rr-text-disabled)', marginLeft: '2px' }}> · {formatElapsedTime(elapsedFinal)}</span>
						</span>
						{statusLink}
					</div>
					{pipelineActions}
				</div>
			);
		}

		// No status to show (NONE state, no data yet)
		return null;
	}

	// ========================================================================
	// Non-source node: Pipes progress bar
	// ========================================================================
	if (!componentPipeCounts || !(componentProvider in componentPipeCounts)) return null;
	const pipesInComponent = componentPipeCounts[componentProvider];
	if (!totalPipes || totalPipes === 0) return null;

	const progressPercentage = totalPipes > 0 ? (pipesInComponent / totalPipes) * 100 : 0;

	return (
		<div style={styles.footer}>
			<div style={styles.pipesFooter}>
				<span style={styles.pipesLabel}>Pipes</span>
				<div style={styles.progressBarContainer}>
					<div style={{ height: 3, borderRadius: 2, marginTop: 5, backgroundColor: 'var(--rr-border)', overflow: 'hidden' }}>
						<div style={{ width: `${progressPercentage}%`, height: '100%', backgroundColor: 'var(--rr-success)', borderRadius: 2, transition: 'width 0.1s ease-in-out' }} />
					</div>
				</div>
				<span style={styles.pipesCount}>
					{pipesInComponent}/{totalPipes}
				</span>
			</div>
		</div>
	);
}

// =============================================================================
// Styles
// =============================================================================

const styles = {
	footer: {
		borderTop: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface)',
		padding: '0.4rem 0.6rem 0.2rem',
		fontSize: 'var(--rr-font-size-xs)',
		borderRadius: 0,
	} as React.CSSProperties,
	sourceFooterMain: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '0.5rem',
	} as React.CSSProperties,
	footerText: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
		whiteSpace: 'nowrap' as const,
	} as React.CSSProperties,
	statusLink: {
		fontSize: '9px',
		color: 'var(--rr-accent)',
		cursor: 'pointer',
		whiteSpace: 'nowrap' as const,
		textDecoration: 'none',
		flexShrink: 0,
	} as React.CSSProperties,
	statusMessage: {
		fontSize: '9px',
		color: 'var(--rr-text-disabled)',
		marginTop: '3px',
		...commonStyles.textEllipsis,
		display: 'block',
	} as React.CSSProperties,
	errorMessage: {
		fontSize: '9px',
		color: 'var(--rr-error)',
		marginTop: '3px',
		opacity: 0.85,
		display: 'block',
		wordBreak: 'break-word',
		lineHeight: 1.4,
	} as React.CSSProperties,

	// Accent bars (thin 2px bar at bottom of completed status)
	accentBarSuccess: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-success)',
	} as React.CSSProperties,
	accentBarWarning: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-warning)',
	} as React.CSSProperties,
	accentBarError: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-error)',
	} as React.CSSProperties,

	// Non-source node pipes footer
	pipesFooter: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
		width: '100%',
	} as React.CSSProperties,
	pipesLabel: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		minWidth: 'fit-content',
	} as React.CSSProperties,
	progressBarContainer: {
		flex: 1,
		minWidth: '60px',
	} as React.CSSProperties,
	pipesCount: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
		minWidth: 'fit-content',
	} as React.CSSProperties,
};
