// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { ReactElement, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, IconButton, Typography } from '@mui/material';
import { PlayArrow, StopCircle, Autorenew } from '@mui/icons-material';

import { styles } from './index.style';
import { isInVSCode } from '../../../../utils/vscode';
import { useFlow } from '../../FlowContext';
import { TASK_STATE } from '../../types';
import usePrevious from '../../../../hooks/usePrevious';

/** Props for the RunButton component. */
interface IProps {
	/** ID of the source node whose pipeline this button controls. */
	nodeId: string;
}

/**
 * Renders a play/stop button attached to source nodes on the project canvas.
 * When idle, displays a play icon that saves the pipeline and starts execution.
 * When running, displays a stop icon that aborts the pipeline. The button
 * slides out from the left edge of the node on hover to reveal its label.
 * Includes debounce guards to prevent double-clicks from triggering
 * duplicate pipeline operations.
 *
 * @param nodeId - The ID of the source node this button controls.
 */
export default function RunButton({ nodeId }: IProps): ReactElement {
	const { t } = useTranslation();
	const [isPending, setIsPending] = useState(false);
	const { currentProject, runPipeline, abortPipeline, taskStatuses, saveChanges } = useFlow();

	/** Guard ref to prevent concurrent click handlers from firing. */
	const isProcessingClick = useRef(false);

	/**
	 * Determines whether the pipeline for this node is currently running
	 * by checking real-time task status events from the DAP.
	 */
	const isRunning = useMemo(() => {
		const projectId = currentProject?.project_id;
		// Cannot be running without an active project
		if (!projectId) return false;

		// Check real-time DAP task status events to determine running state
		if (taskStatuses) {
			const taskStatus = taskStatuses[nodeId];
			if (taskStatus) {
				// Consider the node running during the startup, initialization, and execution phases
				const runningStates = [
					TASK_STATE.STARTING,
					TASK_STATE.INITIALIZING,
					TASK_STATE.RUNNING,
				];
				// The `completed` flag is set when the task finishes, even if state hasn't reset yet
				const running = runningStates.includes(taskStatus.state) && !taskStatus.completed;
				return running;
			}
		}

		// FIXME: remove it
		return false;
	}, [taskStatuses, currentProject, nodeId]);

	/**
	 * Aborts the currently running pipeline for this node.
	 * Guarded by isPending and isProcessingClick to prevent duplicate calls.
	 */
	const handleAbortPipeline = useCallback(
		async (e?: React.MouseEvent) => {
			// Prevent the click from propagating to the node selection handler
			if (e) {
				e.stopPropagation();
			}

			// Guard against double-clicks or concurrent abort requests
			if (isPending || isProcessingClick.current) return;

			try {
				isProcessingClick.current = true;
				setIsPending(true);
				await abortPipeline(nodeId);
			} catch (error) {
				console.error('Error stopping pipeline:', error);
				// Reset guards on failure so the button becomes clickable again
				setIsPending(false);
				isProcessingClick.current = false;
			}
		},
		[isPending, abortPipeline, nodeId]
	);

	/**
	 * Saves the current pipeline state and then starts pipeline execution
	 * for this node. Guarded to prevent duplicate invocations.
	 */
	const handleRunPipeline = useCallback(
		async (e?: React.MouseEvent) => {
			// Prevent the click from propagating to the node selection handler
			if (e) {
				e.stopPropagation();
			}

			// Guard against double-clicks, concurrent runs, or clicking while already running
			if (isPending || isProcessingClick.current || isRunning) return;

			try {
				isProcessingClick.current = true;
				setIsPending(true);
				// Persist the latest pipeline state before starting execution
				await saveChanges();
				const resp = await runPipeline(nodeId);
				if (!resp) {
					throw new Error('Failed to run pipeline');
				}
			} catch (e) {
				console.error('Error running pipeline:', e);
				// Reset guards on failure so the button becomes clickable again
				setIsPending(false);
				isProcessingClick.current = false;
			}
		},

		[isPending, isRunning, runPipeline, nodeId, saveChanges]
	);

	const prevIsRunning = usePrevious(isRunning);

	// When the running state transitions (started or stopped) while we are pending,
	// clear the pending/processing guards so the button reflects the new state
	useEffect(() => {
		if (isPending && prevIsRunning !== isRunning) {
			setIsPending(false);
			isProcessingClick.current = false;
		}
	}, [prevIsRunning, isRunning, setIsPending, isPending]);

	// Ensure the processing click guard is always released when isPending clears
	useEffect(() => {
		if (!isPending) {
			isProcessingClick.current = false;
		}
	}, [isPending]);

	if (isRunning) {
		return (
			<Box
				sx={styles.buttonWrapper}
				className="stop-button"
				onClick={handleAbortPipeline}
				onDoubleClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
				}}
			>
				<IconButton sx={styles.button}>
					{isPending ? (
						<Autorenew color="warning" sx={styles.icon} className="rotate" />
					) : (
						<StopCircle color="error" sx={styles.icon} />
					)}
				</IconButton>
				<Typography sx={styles.label} className="run-btn-label">
					{t('projects.stopButton.label', 'Stop')}
				</Typography>
			</Box>
		);
	}

	return (
		<Box
			sx={styles.buttonWrapper}
			onClick={handleRunPipeline}
			onDoubleClick={(e) => {
				e.stopPropagation();
				e.preventDefault();
			}}
		>
			<IconButton sx={styles.button}>
				{isPending ? (
					<Autorenew color="warning" sx={styles.icon} className="rotate" />
				) : (
					<PlayArrow sx={{ ...styles.icon, color: isInVSCode() ? 'var(--vscode-button-background)' : 'primary.main' }} />
				)}
			</IconButton>
			<Typography sx={styles.label} className="run-btn-label">
				{t('projects.runButton.label', 'Play')}
			</Typography>
		</Box>
	);
}
