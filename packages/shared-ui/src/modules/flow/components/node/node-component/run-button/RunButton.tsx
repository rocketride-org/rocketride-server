// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * RunButton — Play/stop button that slides out from the left edge of source nodes.
 *
 * Four visual states:
 *   - **Run Pipeline** (idle): accent-colored play icon; clicking saves + runs the pipeline.
 *   - **Stop** (running): red stop icon; clicking aborts the pipeline.
 *   - **Stopping...** (stopping): disabled spinner; pipeline is shutting down.
 *   - **Pending** (transitioning): spinning icon while waiting for state change.
 *
 * Button text always indicates the action that will be performed on click,
 * never the current state. Smooth CSS transitions between all states.
 * Includes debounce guards to prevent double-clicks.
 */

import { ReactElement, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import { PlayArrow, StopCircle, Autorenew } from '@mui/icons-material';
import { useFlowProject } from '../../../../context/FlowProjectContext';
import { useFlowGraph } from '../../../../context/FlowGraphContext';
import { ITaskState, IProject, INode, PIPELINE_SCHEMA_VERSION } from '../../../../types';
import { getProjectComponents } from '../../../../util/graph';

// ============================================================================
// Types
// ============================================================================

interface IRunButtonProps {
	/** ID of the source node whose pipeline this button controls. */
	nodeId: string;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
	buttonWrapper: {
		zIndex: -1,
		position: 'absolute',
		backgroundColor: 'var(--rr-bg-paper)',
		left: 'calc(-2rem - 1px)',
		top: '0.75rem',
		margin: 'auto',
		width: '2rem',
		height: '1.75rem',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		cursor: 'pointer',
		borderRadius: '1rem 0 0 1rem',
		boxShadow: '0px 2px 1px -1px rgba(0, 0, 0, 0.15), 0px 1px 1px 0px rgba(0, 0, 0, 0.1), 0px 1px 3px 0px rgba(0, 0, 0, 0.08)',
		border: 'none',
		outline: '1px solid var(--rr-border)',
		transition: 'left 0.2s ease, width 0.2s ease, background-color 0.2s ease, opacity 0.2s ease',
		'&:hover': {
			left: 'calc(-5rem - 1px)',
			width: '5rem',
			backgroundColor: 'var(--rr-accent, #007acc)',
			'& .run-btn-label': {
				opacity: 1,
				color: '#fff',
				width: 'auto',
			},
			'& svg': {
				fill: '#fff',
			},
		},
		'&.stop-button:hover': {
			backgroundColor: 'error.main',
			left: 'calc(-3.5rem - 1px)',
			width: '3.5rem',
		},
		'&.stopping-button': {
			cursor: 'default',
			pointerEvents: 'none',
			opacity: 0.6,
			left: 'calc(-5.5rem - 1px)',
			width: '5.5rem',
			'& .run-btn-label': {
				opacity: 1,
				width: 'auto',
			},
		},
	},
	button: {
		padding: '0.13rem',
		pointerEvents: 'none',
	},
	icon: {
		width: '1rem',
		height: '1rem',
		transition: 'color 0.2s ease, fill 0.2s ease',
	},
	label: {
		opacity: 0,
		transition: 'opacity 0.2s ease, width 0.2s ease',
		pointerEvents: 'none',
		whiteSpace: 'nowrap',
		fontSize: '0.65rem',
		width: '0',
	},
};

// ============================================================================
// Component
// ============================================================================

export default function RunButton({ nodeId }: IRunButtonProps): ReactElement {
	const [isPending, setIsPending] = useState(false);
	const isProcessingClick = useRef(false);

	const { currentProject, taskStatuses, onRunPipeline, onStopPipeline, isConnected } = useFlowProject();
	const { nodes } = useFlowGraph();

	// ── Running / stopping state ───────────────────────────────────────────
	const isRunning = useMemo(() => {
		if (!currentProject?.project_id) return false;
		const taskStatus = taskStatuses?.[nodeId];
		if (!taskStatus) return false;
		const runningStates = [ITaskState.STARTING, ITaskState.INITIALIZING, ITaskState.RUNNING];
		return runningStates.includes(taskStatus.state) && !taskStatus.completed;
	}, [taskStatuses, currentProject, nodeId]);

	const isStopping = useMemo(() => {
		if (!currentProject?.project_id) return false;
		const taskStatus = taskStatuses?.[nodeId];
		if (!taskStatus) return false;
		return taskStatus.state === ITaskState.STOPPING && !taskStatus.completed;
	}, [taskStatuses, currentProject, nodeId]);

	// ── Handlers ───────────────────────────────────────────────────────────
	const handleRun = useCallback(
		(e?: React.MouseEvent) => {
			e?.stopPropagation();
			if (isPending || isProcessingClick.current || isRunning || !onRunPipeline) return;

			isProcessingClick.current = true;
			setIsPending(true);

			// Serialize the current graph into an IProject for the host
			const components = getProjectComponents(nodes as INode[]);
			const project: IProject = {
				...currentProject,
				components,
				version: PIPELINE_SCHEMA_VERSION,
				source: nodeId,
			};

			onRunPipeline(nodeId, project);
		},
		[isPending, isRunning, onRunPipeline, nodeId, nodes, currentProject]
	);

	const handleStop = useCallback(
		(e?: React.MouseEvent) => {
			e?.stopPropagation();
			if (isPending || isProcessingClick.current || !onStopPipeline) return;

			isProcessingClick.current = true;
			setIsPending(true);
			onStopPipeline(nodeId);
		},
		[isPending, onStopPipeline, nodeId]
	);

	// ── Clear pending on state transitions ─────────────────────────────────
	const prevIsRunning = useRef(isRunning);
	const prevIsStopping = useRef(isStopping);
	useEffect(() => {
		if (isPending && (prevIsRunning.current !== isRunning || prevIsStopping.current !== isStopping)) {
			setIsPending(false);
			isProcessingClick.current = false;
		}
		prevIsRunning.current = isRunning;
		prevIsStopping.current = isStopping;
	}, [isRunning, isStopping, isPending]);

	useEffect(() => {
		if (!isPending) {
			isProcessingClick.current = false;
		}
	}, [isPending]);

	// ── Render ─────────────────────────────────────────────────────────────
	// Hide the button entirely when not connected — can't run or stop without a server
	if (!isConnected) {
		return <></>;
	}

	// Stopping state — disabled button with spinner and "Stopping..." label
	if (isStopping) {
		return (
			<Box
				sx={styles.buttonWrapper}
				className="stopping-button"
				onDoubleClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
				}}
			>
				<IconButton sx={styles.button} disabled>
					<Autorenew color="warning" sx={styles.icon} className="rotate" />
				</IconButton>
				<Typography sx={styles.label} className="run-btn-label">
					Stopping...
				</Typography>
			</Box>
		);
	}

	if (isRunning) {
		return (
			<Box
				sx={styles.buttonWrapper}
				className="stop-button"
				onClick={handleStop}
				onDoubleClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
				}}
			>
				<IconButton sx={styles.button}>{isPending ? <Autorenew color="warning" sx={styles.icon} className="rotate" /> : <StopCircle color="error" sx={styles.icon} />}</IconButton>
				<Typography sx={styles.label} className="run-btn-label">
					Stop
				</Typography>
			</Box>
		);
	}

	return (
		<Box
			sx={styles.buttonWrapper}
			onClick={handleRun}
			onDoubleClick={(e) => {
				e.stopPropagation();
				e.preventDefault();
			}}
		>
			<IconButton sx={styles.button}>{isPending ? <Autorenew color="warning" sx={styles.icon} className="rotate" /> : <PlayArrow sx={{ ...styles.icon, color: 'var(--rr-accent, #007acc)' }} />}</IconButton>
			<Typography sx={styles.label} className="run-btn-label">
				Run Pipeline
			</Typography>
		</Box>
	);
}
