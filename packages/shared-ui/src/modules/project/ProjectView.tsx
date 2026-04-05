// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * ProjectView — Unified project frame composing the canvas editor and all
 * runtime views (status, tokens, flow, trace, errors) behind a shared tab bar.
 *
 * Data in, callbacks out. The host pushes data as props and receives user
 * actions via callbacks. The message protocol types define the serialization
 * boundary between host and view.
 */

import React, { useState, useCallback, useRef, useEffect, lazy, Suspense, CSSProperties } from 'react';

// Theme CSS — defines --rr-* tokens in the iframe/webview context
import '../../themes/rocketride-default.css';
import '../../themes/rocketride-vscode.css';

import { TabPanel } from '../../components/tab-panel/TabPanel';
import { useTraceState } from './hooks/useTraceState';
import { useElapsedTimer } from './hooks/useElapsedTimer';

// Lazy-load all tab content so only the active tab's code is fetched
const Canvas = lazy(() => import('../../components/canvas'));
const Status = lazy(() => import('../../components/status/Status'));
const Tokens = lazy(() => import('../../components/tokens/Tokens'));
const Flow = lazy(() => import('../../components/flow/Flow'));
const Trace = lazy(() => import('../../components/trace/Trace'));
const Errors = lazy(() => import('../../components/errors/Errors'));
import type { IProjectViewProps, ProjectViewMode } from './types';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
	viewPadding: {
		padding: 16,
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
	} as CSSProperties,
	canvasWrapper: {
		flex: 1,
		minHeight: 0,
		width: '100%',
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
	} as CSSProperties,
	empty: {
		color: 'var(--rr-text-disabled)',
		textAlign: 'center',
		padding: 32,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

interface ProjectViewState {
	mode: ProjectViewMode;
	flowViewMode?: 'pipeline' | 'component';
}

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectView: React.FC<IProjectViewProps> = ({ project, servicesJson, isConnected, taskStatus, traceEvents, initialState, onContentChanged, onSave, onValidate, onStateChange, onPipelineAction, onTraceClear }) => {
	// --- State ----------------------------------------------------------------

	const initial = (initialState as ProjectViewState | undefined) ?? {};
	const [mode, setMode] = useState<ProjectViewMode>(initial.mode ?? 'design');
	const [flowViewMode, setFlowViewMode] = useState<'pipeline' | 'component'>(initial.flowViewMode ?? 'pipeline');

	const { rows: traceRows, clearTrace } = useTraceState(traceEvents ?? []);
	const currentElapsed = useElapsedTimer(taskStatus);

	// --- Persist view state --------------------------------------------------

	const onStateChangeRef = useRef(onStateChange);
	onStateChangeRef.current = onStateChange;

	useEffect(() => {
		onStateChangeRef.current?.({ mode, flowViewMode });
	}, [mode, flowViewMode]);

	// --- Validate callback for Canvas ----------------------------------------

	const handleValidate = useCallback(
		async (pipeline: any) => {
			if (!onValidate) return { errors: [], warnings: [] };
			try {
				return await onValidate(pipeline);
			} catch {
				return { errors: [], warnings: [] };
			}
		},
		[onValidate]
	);

	// --- Mode switch ---------------------------------------------------------

	const handleModeChange = useCallback((id: string) => {
		setMode(id as ProjectViewMode);
	}, []);

	// --- Trace clear ---------------------------------------------------------

	const handleTraceClear = useCallback(() => {
		clearTrace();
		onTraceClear?.();
	}, [clearTrace, onTraceClear]);

	// --- Tab definitions -----------------------------------------------------

	const errorCount = taskStatus?.errors?.length ?? 0;
	const warningCount = taskStatus?.warnings?.length ?? 0;

	const tabs = [
		{ id: 'design', label: 'Design' },
		{ id: 'status', label: 'Status' },
		{ id: 'tokens', label: 'Tokens' },
		{ id: 'flow', label: 'Flow' },
		{ id: 'trace', label: 'Trace' },
		{
			id: 'errors',
			label: 'Errors',
			badge: errorCount + warningCount > 0 ? String(errorCount + warningCount) : undefined,
		},
	];

	// --- Panels (all rendered, TabPanel controls visibility) -----------------

	const panels: Record<string, React.ReactNode> = {
		design: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.canvasWrapper}>
					<Canvas oauth2RootUrl="" project={project} servicesJson={servicesJson} handleValidatePipeline={handleValidate} onContentChanged={onContentChanged} isConnected={isConnected} />
				</div>
			</Suspense>
		),
		status: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.viewPadding}>
					<Status taskStatus={taskStatus} currentElapsed={currentElapsed} />
				</div>
			</Suspense>
		),
		tokens: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.viewPadding}>
					<Tokens taskStatus={taskStatus} />
				</div>
			</Suspense>
		),
		flow: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.viewPadding}>
					<Flow taskStatus={taskStatus} viewMode={flowViewMode} onViewModeChange={setFlowViewMode} />
				</div>
			</Suspense>
		),
		trace: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.viewPadding}>
					<Trace rows={traceRows} onClear={handleTraceClear} />
				</div>
			</Suspense>
		),
		errors: (
			<Suspense fallback={<div style={styles.empty}>Loading...</div>}>
				<div style={styles.viewPadding}>
					{errorCount > 0 && <Errors title="Errors" items={taskStatus!.errors} type="error" />}
					{warningCount > 0 && <Errors title="Warnings" items={taskStatus!.warnings} type="warning" />}
					{errorCount === 0 && warningCount === 0 && <div style={styles.empty}>No errors or warnings</div>}
				</div>
			</Suspense>
		),
	};

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.container}>
			<TabPanel tabs={tabs} activeTab={mode} onTabChange={handleModeChange} panels={panels} />
		</div>
	);
};

export default ProjectView;
