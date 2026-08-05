// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * RunButton — Play/stop button that slides out from the left edge of source nodes.
 *
 * Four visual states:
 *   - **Run Pipeline** (idle): green filled play triangle; clicking saves + runs the pipeline.
 *   - **Stop** (running): red filled stop square; clicking aborts the pipeline.
 *   - **Stopping...** (stop pending): disabled spinning icon while pipeline is stopping.
 *   - **Pending** (run pending): spinning icon while waiting for state change.
 *
 * The glyphs are the shared BoxIcons (BxPlay / BxStop / BxRefresh), so the canvas
 * run control matches the Explorer sidebar's run/stop buttons exactly — filled
 * triangle in --rr-color-success, filled square in --rr-color-error (design-owner
 * decision 2026-07-08: canvas and sidebar run controls share one style).
 *
 * On hover the button slides further left and expands to reveal its label.
 * Includes debounce guards to prevent double-clicks.
 */

import React, { ReactElement, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { BxPlay, BxStop, BxRefresh } from '../../../../../../components/BoxIcon';
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
	const { nodes, edges } = useFlowGraph();

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
			if (isRunning || !onRunPipeline) return;

			const components = getProjectComponents(nodes as INode[], edges);
			const project: IProject = {
				...currentProject,
				components,
				version: PIPELINE_SCHEMA_VERSION,
			};

			onRunPipeline(nodeId, project);
		},
		[isRunning, onRunPipeline, nodeId, nodes, edges, currentProject, isSubscribed]
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
						<BxRefresh size={16} color="var(--rr-color-warning)" style={styles.icon} className="rotate" />
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
					<BxStop size={16} color="var(--rr-color-error)" style={styles.icon} />
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
					<BxPlay size={16} color="var(--rr-text-disabled)" style={styles.icon} />
					<span style={{ position: 'absolute' as const, top: -8, right: -8 }}>
						<PadlockIcon size={24} />
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
				<BxPlay size={16} color="var(--rr-color-success)" style={styles.icon} />
			</span>
		</div>
	);
}
