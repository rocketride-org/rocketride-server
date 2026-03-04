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

import { ReactElement, useState } from 'react';
import { Box, Typography, LinearProgress, Collapse, IconButton } from '@mui/material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { TaskStatus, TASK_STATE } from '../../types';
import { styles } from './index.style';

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
	// Truncate fractional seconds for a cleaner display
	const totalSeconds = Math.floor(seconds);
	// Short-circuit for sub-minute durations
	if (totalSeconds < 60) return `${totalSeconds}s`;
	// Minutes + seconds for durations under one hour
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}
	// Full hours + minutes + seconds for longer durations
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;
	return `${hours}h ${minutes}m ${remainingSeconds}s`;
};

/**
 * Props for the NodeFooter component.
 *
 * Provides all the runtime pipeline data needed to render either a source-node
 * completion summary or a non-source-node pipe progress bar at the bottom of
 * a canvas node.
 */
interface NodeFooterProps {
	/** Component provider name to match against pipeflow data. */
	componentProvider: string;

	/** Whether this is a source node (has Run button). */
	isSourceNode: boolean;

	/** Task status data from DAP events. */
	taskStatus: TaskStatus | undefined;

	/** Map of component provider to pipe count for progress tracking. */
	componentPipeCounts?: Record<string, number>;

	/** Total number of pipes in the pipeline (for progress calculation). */
	totalPipes?: number;
}

/**
 * NodeFooter Component
 *
 * Displays runtime status information at the bottom of canvas nodes:
 * - Source nodes: Shows "Completed X / Errors Y" with expandable details
 * - Other nodes: Shows "Pipes X/Y" progress bar indicating flow through component
 *
 * Only displays when pipeline is actively running.
 */
export default function NodeFooter({
	componentProvider,
	isSourceNode,
	taskStatus,
	componentPipeCounts,
	totalPipes,
}: NodeFooterProps): ReactElement | null {
	const [expanded, setExpanded] = useState(false);

	// ========================================================================
	// SOURCE NODE FOOTER (Completed/Errors)
	// ========================================================================

	if (isSourceNode && taskStatus) {
		// Only display the footer during active pipeline execution states
		const isRunning =
			[TASK_STATE.STARTING, TASK_STATE.INITIALIZING, TASK_STATE.RUNNING].includes(
				taskStatus.state
			) && !taskStatus.completed;

		// Hide the footer entirely when the pipeline is idle or completed
		if (!isRunning) {
			return null;
		}
		// Default counters to zero when the task has not yet reported counts
		const completedCount = taskStatus.completedCount || 0;
		const failedCount = taskStatus.failedCount || 0;

		// Derive wall-clock elapsed time from the task start timestamp (epoch seconds)
		const currentTimeSeconds = Math.floor(Date.now() / 1000);
		const elapsed =
			taskStatus.startTime > 0 ? Math.max(0, currentTimeSeconds - taskStatus.startTime) : 0;

		// Include failure count only when there are actual failures to avoid visual noise
		const statusText =
			failedCount > 0
				? `${completedCount} done / ${failedCount} failed`
				: `${completedCount} done`;

		return (
			<Box sx={styles.footer}>
				{/* Main Status Line */}
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

				{/* Expandable Details */}
				<Collapse in={expanded}>
					<Box sx={styles.expandedDetails}>
						<Box sx={styles.detailRow}>
							<Typography sx={styles.detailLabel}>Status:</Typography>
							<Typography sx={styles.detailValue}>{taskStatus.status}</Typography>
						</Box>
						<Box sx={styles.detailRow}>
							<Typography sx={styles.detailLabel}>Started</Typography>
							<Typography sx={styles.detailValue}>
								{formatElapsedTime(elapsed)} ago
							</Typography>
						</Box>
					</Box>
				</Collapse>
			</Box>
		);
	}

	// ========================================================================
	// NON-SOURCE NODE FOOTER (Pipes Progress)
	// ========================================================================

	// For non-source nodes, only show a progress footer if this component has reported pipe data
	if (!componentPipeCounts || !(componentProvider in componentPipeCounts)) {
		return null;
	}

	const pipesInComponent = componentPipeCounts[componentProvider];

	// Without a total pipe count, the progress bar cannot be rendered meaningfully
	if (!totalPipes || totalPipes === 0) {
		return null;
	}

	// Calculate percentage of total pipes that have reached this component
	const progressPercentage = totalPipes > 0 ? (pipesInComponent / totalPipes) * 100 : 0;

	return (
		<Box sx={styles.footer}>
			<Box sx={styles.pipesFooter}>
				{/* Pipes Label */}
				<Typography sx={styles.pipesLabel}>Pipes</Typography>

				{/* Progress Bar */}
				<Box sx={styles.progressBarContainer}>
					<LinearProgress
						variant="determinate"
						value={progressPercentage}
						sx={styles.progressBar}
					/>
				</Box>

				{/* Count Display */}
				<Typography sx={styles.pipesCount}>
					{pipesInComponent}/{totalPipes}
				</Typography>
			</Box>
		</Box>
	);
}
