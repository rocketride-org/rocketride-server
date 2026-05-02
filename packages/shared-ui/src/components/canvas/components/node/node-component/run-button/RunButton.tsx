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
 *   - **Stopping...** (stop pending): disabled spinning icon while pipeline is stopping.
 *   - **Pending** (run pending): spinning icon while waiting for state change.
 *
 * On hover the button slides further left and expands to reveal its label.
 * Includes debounce guards to prevent double-clicks.
 */

import React, { ReactElement, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, RefreshCw } from 'lucide-react';
import PadlockIcon from '../../../../../../assets/icons/PadlockIcon';
import { useFlowProject } from '../../../../context/FlowProjectContext';
import { useFlowGraph } from '../../../../context/FlowGraphContext';
import { ITaskState, IProject, INode, PIPELINE_SCHEMA_VERSION } from '../../../../types';
import { getProjectComponents } from '../../../../util/graph';

// =============================================================================
// Types
// =============================================================================

interface IRunButtonProps {
	/** ID of the source node whose pipeline this button controls. */
	nodeId: string;
}

// =============================================================================
// Styles
// =============================================================================

const styles = {
	button: {
		padding: '0.13rem',
		pointerEvents: 'none' as const,
		display: 'inline-flex',
		alignItems: 'center' as const,
	},
	icon: {
		width: '1rem',
		height: '1rem',
	} as React.CSSProperties,
};

// =============================================================================
// Component
// =============================================================================

export default function RunButton({ nodeId }: IRunButtonProps): ReactElement {
	const [isStopping, setIsStopping] = useState(false);

	const { currentProject, taskStatuses, onRunPipeline, onStopPipeline, isConnected, isSubscribed } = useFlowProject();
	const { nodes } = useFlowGraph();

	// ── Running state ──────────────────────────────────────────────────────
	const isRunning = useMemo(() => {
		if (!currentProject?.project_id) return false;
		const taskStatus = taskStatuses?.[nodeId];
		if (!taskStatus) return false;
		const runningStates = [ITaskState.STARTING, ITaskState.INITIALIZING, ITaskState.RUNNING];
		return runningStates.includes(taskStatus.state) && !taskStatus.completed;
	}, [taskStatuses, currentProject, nodeId]);

	// ── Handlers ───────────────────────────────────────────────────────────
	const handleRun = useCallback(
		(e?: React.MouseEvent) => {
			e?.stopPropagation();
			console.log(`[RunButton] clicked nodeId=${nodeId} isRunning=${isRunning} isSubscribed=${isSubscribed} onRunPipeline=${!!onRunPipeline}`);
			if (isRunning || !onRunPipeline) return;

			const components = getProjectComponents(nodes as INode[]);
			const project: IProject = {
				...currentProject,
				components,
				version: PIPELINE_SCHEMA_VERSION,
			};

			console.log('[RunButton] calling onRunPipeline');
			onRunPipeline(nodeId, project);
		},
		[isRunning, onRunPipeline, nodeId, nodes, currentProject, isSubscribed]
	);

	const handleStop = useCallback(
		(e?: React.MouseEvent) => {
			e?.stopPropagation();
			if (isStopping || !onStopPipeline) return;

			setIsStopping(true);
			onStopPipeline(nodeId);
		},
		[isStopping, onStopPipeline, nodeId]
	);

	// ── Clear stopping on state transitions ────────────────────────────────
	const prevIsRunning = useRef(isRunning);
	useEffect(() => {
		if (prevIsRunning.current !== isRunning) {
			if (isStopping) {
				setIsStopping(false);
			}
		}
		prevIsRunning.current = isRunning;
	}, [isRunning, isStopping]);

	// ── Render ─────────────────────────────────────────────────────────────
	if (!isConnected) {
		return <></>;
	}

	if (isRunning) {
		if (isStopping) {
			return (
				<div
					className="rr-run-button-wrapper stopping-button"
					onDoubleClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
					}}
				>
					<span style={styles.button}>
						<RefreshCw size={16} style={{ ...styles.icon, color: 'var(--rr-color-warning)' }} className="rotate" />
					</span>
				</div>
			);
		}

		return (
			<div
				className="rr-run-button-wrapper stop-button"
				onClick={handleStop}
				onDoubleClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
				}}
			>
				<span style={styles.button}>
					<Square size={12} style={{ ...styles.icon, color: 'var(--rr-color-error)', strokeWidth: 2.5 }} />
				</span>
			</div>
		);
	}

	// Not subscribed — show locked play icon
	if (isSubscribed === false) {
		return (
			<div
				className="rr-run-button-wrapper"
				onClick={handleRun}
				onDoubleClick={(e) => {
					e.stopPropagation();
					e.preventDefault();
				}}
				title="Subscription required"
			>
				<span style={{ ...styles.button, position: 'relative' as const }}>
					<Play size={16} style={{ ...styles.icon, color: 'var(--rr-text-disabled)' }} />
					<span style={{ position: 'absolute' as const, top: -5, right: -5 }}>
						<PadlockIcon size={10} />
					</span>
				</span>
			</div>
		);
	}

	return (
		<div
			className="rr-run-button-wrapper"
			onClick={handleRun}
			onDoubleClick={(e) => {
				e.stopPropagation();
				e.preventDefault();
			}}
		>
			<span style={styles.button}>
				<Play size={16} style={{ ...styles.icon, color: 'var(--rr-accent)' }} />
			</span>
		</div>
	);
}
