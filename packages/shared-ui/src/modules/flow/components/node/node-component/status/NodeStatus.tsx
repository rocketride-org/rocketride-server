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

import { ReactElement } from 'react';
import { Box, Typography, LinearProgress } from '@mui/material';
import { ITaskStatus, ITaskState } from '../../../../types';
import { PipelineActions } from '../../../../../../components/pipeline-actions';

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Component
// ============================================================================

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
			<Typography
				component="a"
				onClick={(e: React.MouseEvent) => {
					e.stopPropagation();
					onOpenStatus(componentProvider);
				}}
				sx={styles.statusLink}
			>
				Status ↗
			</Typography>
		) : null;

		const pipelineActions = <PipelineActions notes={taskStatus.notes} host={serverHost} onOpenLink={onOpenLink} displayName={displayName} />;

		// ── Starting / Initializing ──────────────────────────────────────
		if (isRunning && (taskStatus.state === ITaskState.STARTING || taskStatus.state === ITaskState.INITIALIZING)) {
			return (
				<Box sx={styles.footer}>
					<Box sx={styles.sourceFooterMain}>
						<Typography sx={{ ...styles.footerText, color: 'var(--rr-text-disabled)' }}>Initializing...</Typography>
						{statusLink}
					</Box>
					{taskStatus.status && (
						<Typography sx={styles.statusMessage} title={taskStatus.status}>
							{taskStatus.status}
						</Typography>
					)}
					{pipelineActions}
					<LinearProgress sx={styles.indeterminateBar} />
				</Box>
			);
		}

		// ── Running ──────────────────────────────────────────────────────
		if (isRunning) {
			return (
				<Box sx={styles.footer}>
					<Box sx={styles.sourceFooterMain}>
						<Typography sx={styles.footerText}>
							<Box component="span" sx={{ color: 'var(--rr-success, #4ec9b0)' }}>
								{completedCount} done
							</Box>
							{failedCount > 0 && (
								<>
									{' · '}
									<Box component="span" sx={{ color: 'var(--rr-error, #f14c4c)' }}>
										{failedCount} errors
									</Box>
								</>
							)}
							<Box component="span" sx={{ color: 'var(--rr-text-disabled)', ml: '2px' }}>
								{' '}
								· {formatElapsedTime(elapsed)}
							</Box>
						</Typography>
						{statusLink}
					</Box>
					{taskStatus.status && (
						<Typography sx={styles.statusMessage} title={taskStatus.status}>
							{taskStatus.status}
						</Typography>
					)}
					{pipelineActions}
				</Box>
			);
		}

		// ── Completed / Stopped ──────────────────────────────────────────
		if (isCompleted) {
			// Check for startup error: completed with errors but zero completions
			const isStartupError = completedCount === 0 && hasErrors;
			const firstError = taskStatus.errors?.[0];

			const elapsedFinal = taskStatus.endTime > 0 && taskStatus.startTime > 0 ? Math.max(0, taskStatus.endTime - taskStatus.startTime) : elapsed;

			if (isStartupError) {
				return (
					<Box sx={styles.footer}>
						<Box sx={styles.sourceFooterMain}>
							<Typography sx={styles.footerText}>
								<Box component="span" sx={{ color: 'var(--rr-error, #f14c4c)' }}>
									✕ Failed to start
								</Box>
							</Typography>
							{statusLink}
						</Box>
						{firstError && <Typography sx={styles.errorMessage}>{firstError}</Typography>}
						<Box sx={styles.accentBarError} />
					</Box>
				);
			}

			return (
				<Box sx={styles.footer}>
					<Box sx={styles.sourceFooterMain}>
						<Typography sx={styles.footerText}>
							{!hasErrors && (
								<Box component="span" sx={{ color: 'var(--rr-success, #4ec9b0)' }}>
									✓{' '}
								</Box>
							)}
							<Box component="span" sx={{ color: 'var(--rr-success, #4ec9b0)' }}>
								{completedCount} done
							</Box>
							{failedCount > 0 && (
								<>
									{' · '}
									<Box component="span" sx={{ color: 'var(--rr-error, #f14c4c)' }}>
										{failedCount} errors
									</Box>
								</>
							)}
							<Box component="span" sx={{ color: 'var(--rr-text-disabled)', ml: '2px' }}>
								{' '}
								· {formatElapsedTime(elapsedFinal)}
							</Box>
						</Typography>
						{statusLink}
					</Box>
					{pipelineActions}
				</Box>
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
		<Box sx={styles.footer}>
			<Box sx={styles.pipesFooter}>
				<Typography sx={styles.pipesLabel}>Pipes</Typography>
				<Box sx={styles.progressBarContainer}>
					<LinearProgress variant="determinate" value={progressPercentage} sx={styles.progressBarGreen} />
				</Box>
				<Typography sx={styles.pipesCount}>
					{pipesInComponent}/{totalPipes}
				</Typography>
			</Box>
		</Box>
	);
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
	footer: {
		borderTop: '1px solid',
		borderColor: 'var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface)',
		padding: '0.4rem 0.6rem 0.2rem',
		fontSize: 'var(--rr-font-size-xs)',
		borderRadius: 0,
	},
	sourceFooterMain: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '0.5rem',
	},
	footerText: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
		whiteSpace: 'nowrap',
	},
	statusLink: {
		fontSize: '9px',
		color: 'var(--rr-accent, #007acc)',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
		textDecoration: 'none',
		flexShrink: 0,
		'&:hover': { textDecoration: 'underline' },
	},
	statusMessage: {
		fontSize: '9px',
		color: 'var(--rr-text-disabled)',
		marginTop: '3px',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	errorMessage: {
		fontSize: '9px',
		color: 'var(--rr-error, #f14c4c)',
		marginTop: '3px',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		opacity: 0.85,
	},

	// Progress bars
	indeterminateBar: {
		height: '3px',
		borderRadius: '2px',
		marginTop: '5px',
		backgroundColor: 'action.hover',
		'& .MuiLinearProgress-bar': {
			backgroundColor: 'var(--rr-accent, #007acc)',
			borderRadius: '2px',
		},
	},
	progressBarGreen: {
		height: '3px',
		borderRadius: '2px',
		marginTop: '5px',
		backgroundColor: 'action.hover',
		'& .MuiLinearProgress-bar': {
			backgroundColor: 'var(--rr-success, #4ec9b0)',
			borderRadius: '2px',
			transition: 'transform 0.1s ease-in-out !important',
		},
	},
	progressBarOrange: {
		height: '3px',
		borderRadius: '2px',
		marginTop: '5px',
		backgroundColor: 'action.hover',
		'& .MuiLinearProgress-bar': {
			backgroundColor: 'var(--rr-warning, #cca700)',
			borderRadius: '2px',
			transition: 'transform 0.1s ease-in-out !important',
		},
	},

	// Accent bars (thin 2px bar at bottom of completed status)
	accentBarSuccess: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-success, #4ec9b0)',
	},
	accentBarWarning: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-warning, #cca700)',
	},
	accentBarError: {
		height: '2px',
		marginTop: '5px',
		borderRadius: '1px',
		backgroundColor: 'var(--rr-error, #f14c4c)',
	},

	// Non-source node pipes footer
	pipesFooter: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
		width: '100%',
	},
	pipesLabel: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		minWidth: 'fit-content',
	},
	progressBarContainer: {
		flex: 1,
		minWidth: '60px',
	},
	pipesCount: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
		minWidth: 'fit-content',
	},
};
