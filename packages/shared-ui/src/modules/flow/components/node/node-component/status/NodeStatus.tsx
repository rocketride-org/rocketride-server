// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * NodeStatus — Real-time pipeline execution status displayed on canvas nodes.
 *
 * Renders runtime status information at the bottom of a canvas node:
 *
 *   - **Source nodes**: Shows "X done / Y failed" with an expandable detail
 *     panel containing the current status string and elapsed time since start.
 *     Only visible while the pipeline is actively running (STARTING, INITIALIZING,
 *     or RUNNING states). Hidden when idle or completed.
 *
 *   - **Non-source nodes**: Shows a "Pipes X/Y" progress bar indicating how
 *     many data pipes have reached this component out of the pipeline total.
 *     Only visible when pipe count data is available.
 *
 * Returns null when the pipeline is idle — the node shows no status chrome.
 */

import { ReactElement, useState } from 'react';
import { Box, Typography, LinearProgress, Collapse, IconButton } from '@mui/material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { ITaskStatus, ITaskState } from '../../../../types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a duration in seconds into a compact, human-readable string.
 *
 * Produces the same format used on the pipeline status page so that elapsed
 * times are displayed consistently across the application.
 *
 * @param seconds - The elapsed time in seconds to format.
 * @returns A formatted string such as "45s", "3m 12s", or "1h 5m 30s".
 */
const formatElapsedTime = (seconds: number): string => {
	const totalSeconds = Math.floor(seconds);

	// Sub-minute: just seconds
	if (totalSeconds < 60) return `${totalSeconds}s`;

	// Sub-hour: minutes and seconds
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}

	// Hours, minutes, and seconds
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;
	return `${hours}h ${minutes}m ${remainingSeconds}s`;
};

// ============================================================================
// Component
// ============================================================================

/**
 * Props for the NodeStatus component.
 */
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
}

/**
 * Renders pipeline execution status inside a canvas node.
 *
 * @param props - Pipeline status data and node identity.
 * @returns Status UI for the active pipeline, or null when idle.
 */
export default function NodeStatus({ componentProvider, isSourceNode, taskStatus, componentPipeCounts, totalPipes }: INodeStatusProps): ReactElement | null {
	/** Whether the expandable details section is open (source nodes only). */
	const [expanded, setExpanded] = useState(false);

	// ========================================================================
	// Source node: Completed/Errors summary with expandable details
	// ========================================================================
	if (isSourceNode && taskStatus) {
		// Only show status during active execution states
		const isRunning = [ITaskState.STARTING, ITaskState.INITIALIZING, ITaskState.RUNNING].includes(taskStatus.state) && !taskStatus.completed;

		// Hide entirely when the pipeline is idle or has completed
		if (!isRunning) return null;

		// Default counters to zero when the task hasn't reported counts yet
		const completedCount = taskStatus.completedCount || 0;
		const failedCount = taskStatus.failedCount || 0;

		// Compute wall-clock elapsed time from the task's start timestamp
		const currentTimeSeconds = Math.floor(Date.now() / 1000);
		const elapsed = taskStatus.startTime > 0 ? Math.max(0, currentTimeSeconds - taskStatus.startTime) : 0;

		// Include failure count only when there are actual failures
		const statusText = failedCount > 0 ? `${completedCount} done / ${failedCount} failed` : `${completedCount} done`;

		return (
			<Box sx={styles.footer}>
				{/* Main status line with expand toggle */}
				<Box sx={styles.sourceFooterMain}>
					<Typography sx={styles.footerText}>{statusText}</Typography>
					<IconButton
						size="small"
						onClick={() => setExpanded(!expanded)}
						sx={{
							...styles.expandButton,
							transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
						}}
					>
						<ExpandMoreIcon fontSize="small" />
					</IconButton>
				</Box>

				{/* Expandable details panel */}
				<Collapse in={expanded}>
					<Box sx={styles.expandedDetails}>
						<Box sx={styles.detailRow}>
							<Typography sx={styles.detailLabel}>Status:</Typography>
							<Typography sx={styles.detailValue}>{taskStatus.status}</Typography>
						</Box>
						<Box sx={styles.detailRow}>
							<Typography sx={styles.detailLabel}>Started</Typography>
							<Typography sx={styles.detailValue}>{formatElapsedTime(elapsed)} ago</Typography>
						</Box>
					</Box>
				</Collapse>
			</Box>
		);
	}

	// ========================================================================
	// Non-source node: Pipes progress bar
	// ========================================================================

	// Only render when this component has reported pipe flow data
	if (!componentPipeCounts || !(componentProvider in componentPipeCounts)) return null;
	const pipesInComponent = componentPipeCounts[componentProvider];

	// Cannot render a meaningful progress bar without a total
	if (!totalPipes || totalPipes === 0) return null;

	// Calculate what percentage of total pipes have reached this component
	const progressPercentage = totalPipes > 0 ? (pipesInComponent / totalPipes) * 100 : 0;

	return (
		<Box sx={styles.footer}>
			<Box sx={styles.pipesFooter}>
				<Typography sx={styles.pipesLabel}>Pipes</Typography>
				<Box sx={styles.progressBarContainer}>
					<LinearProgress variant="determinate" value={progressPercentage} sx={styles.progressBar} />
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

/**
 * MUI sx-compatible style definitions for the NodeStatus component.
 *
 * Covers both the source-node footer (completion summary with expandable
 * details) and the non-source-node footer (pipe progress bar).
 */
const styles = {
	/** Shared footer container — sits below the lanes with a top border. */
	footer: {
		borderTop: '1px solid',
		borderColor: 'var(--rr-border)',
		backgroundColor: 'var(--rr-bg-surface)',
		padding: '0.4rem 0.6rem 0.2rem',
		fontSize: 'var(--rr-font-size-xs)',
		borderRadius: 0,
	},

	/** Source node: horizontal layout for status text and expand button. */
	sourceFooterMain: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '0.5rem',
	},

	/** Status text (e.g. "3 done / 1 failed"). */
	footerText: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
	},

	/** Expand/collapse chevron button. */
	expandButton: {
		padding: '0.2rem',
		transition: 'transform 0.2s',
		color: 'var(--rr-text-secondary)',
	},

	/** Container for the expanded detail rows. */
	expandedDetails: {
		paddingTop: '0.5rem',
		paddingLeft: '0.2rem',
		display: 'flex',
		flexDirection: 'column',
		gap: '0.3rem',
		borderTop: '1px solid',
		borderColor: 'var(--rr-border)',
		marginTop: '0.5rem',
	},

	/** Single detail row (label + value side by side). */
	detailRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.3rem',
		lineHeight: 1.4,
	},

	/** Detail label text (e.g. "Status:"). */
	detailLabel: {
		fontSize: '0.45rem',
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		textAlign: 'left',
	},

	/** Detail value text (e.g. "Processing file 3 of 10"). */
	detailValue: {
		fontSize: '0.45rem',
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
		textAlign: 'left',
	},

	/** Non-source node: horizontal layout for label, bar, and count. */
	pipesFooter: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
		width: '100%',
	},

	/** "Pipes" label to the left of the progress bar. */
	pipesLabel: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		minWidth: 'fit-content',
	},

	/** Flex container for the progress bar. */
	progressBarContainer: {
		flex: 1,
		minWidth: '60px',
	},

	/** MUI LinearProgress overrides for the green progress bar. */
	progressBar: {
		height: '6px',
		borderRadius: '3px',
		backgroundColor: 'action.hover',
		'& .MuiLinearProgress-bar': {
			backgroundColor: 'success.main',
			borderRadius: '3px',
			transition: 'transform 0.1s ease-in-out !important',
		},
	},

	/** Pipe count text to the right of the progress bar (e.g. "3/10"). */
	pipesCount: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
		minWidth: 'fit-content',
	},
};
