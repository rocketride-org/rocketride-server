// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * ProjectView — Unified project frame composing the canvas editor and all
 * runtime views (status, tokens, flow, trace, errors) behind a shared tab bar.
 *
 * All incoming data flows via ref.handleMessage(). Outgoing messages flow
 * via the onMessage callback prop. The host bridge is stateless.
 *
 * Supports multiple source nodes — the Status tab renders a self-contained
 * pane per source (sorted A→Z by name).
 */

import React, { useState, useCallback, useRef, useEffect, useMemo, useImperativeHandle, forwardRef, CSSProperties } from 'react';

// Theme CSS — defines --rr-* tokens in the iframe/webview context
import '../../themes/rocketride-default.css';

import { TabPanel } from '../../components/tab-panel/TabPanel';
import { useTraceState } from './hooks/useTraceState';
import { useElapsedTimer } from './hooks/useElapsedTimer';
import Canvas, { CanvasToolbarProvider, useCanvasToolbar } from '../../components/canvas';
import Status from '../../components/status/Status';
import { StatusHeader } from '../../components/status/StatusHeader';
import Tokens from '../../components/tokens/Tokens';
import Flow from '../../components/flow/Flow';
import Trace from '../../components/trace/Trace';
import Errors from '../../components/errors/Errors';
import { commonStyles } from '../../themes/styles';
import { ITaskState } from '../../types/project';
import type { IProjectViewProps, ProjectViewRef, ProjectViewMode, ProjectViewIncoming, ProjectViewOutgoing, TaskStatus, TraceEvent } from './types';

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
	canvasPadding: {
		padding: 2,
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
	sourcePane: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		overflow: 'hidden',
		marginBottom: 25,
	} as CSSProperties,
	sourceName: {
		fontWeight: 600,
		fontSize: 'var(--rr-font-size-h5)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	sourceBody: {
		padding: '8px 12px',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

interface ProjectViewState {
	mode: ProjectViewMode;
	flowViewMode?: 'pipeline' | 'component';
}

interface SourceInfo {
	id: string;
	name: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function pickActiveStatus(statusMap: Record<string, TaskStatus>): TaskStatus | null {
	const entries = Object.values(statusMap);
	if (entries.length === 0) return null;
	return entries.find((ts) => ts.state === ITaskState.RUNNING || ts.state === ITaskState.INITIALIZING) ?? entries[0];
}

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectView = forwardRef<ProjectViewRef, IProjectViewProps>(({ onMessage }, ref) => {
	// --- Internal state (all populated via handleMessage) ---------------------

	const [project, setProject] = useState<any>(null);
	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [isConnected, setIsConnected] = useState(false);
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
	const [initialState, setInitialState] = useState<Record<string, unknown> | undefined>(undefined);

	// Pending validate requests
	const pendingValidates = useRef<Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>>(new Map());

	// --- Imperative message handler ------------------------------------------

	useImperativeHandle(ref, () => ({
		handleMessage(msg: ProjectViewIncoming) {
			switch (msg.type) {
				case 'canvas:update':
					setProject(msg.project);
					break;
				case 'canvas:services':
					setServicesJson(msg.services);
					break;
				case 'canvas:validateResponse': {
					const pending = pendingValidates.current.get(msg.requestId);
					if (pending) {
						pendingValidates.current.delete(msg.requestId);
						if (msg.error) pending.reject(new Error(msg.error));
						else pending.resolve(msg.result);
					}
					break;
				}
				case 'status:update':
					setStatusMap((prev) => ({ ...prev, [msg.taskStatus.source]: msg.taskStatus }));
					break;
				case 'trace:event':
					setTraceEvents((prev) => [...prev, msg.event]);
					break;
				case 'project:connectionState':
					setIsConnected(msg.isConnected);
					break;
				case 'project:initialState':
					setInitialState(msg.state);
					break;
				case 'project:themeChange':
					// Handled by CSS in VSCode; rocket-ui applies via applyTheme before rendering
					break;
			}
		},
	}));

	// --- Outgoing message helper ---------------------------------------------

	const send = useCallback(
		(msg: ProjectViewOutgoing) => {
			onMessage?.(msg);
		},
		[onMessage]
	);

	// --- Extract source components from project ------------------------------

	const sources: SourceInfo[] = useMemo(() => {
		const components = project?.components as Array<{ provider: string; name?: string; id?: string; config?: Record<string, any> }> | undefined;
		if (!components) return [];
		console.log(
			'[ProjectView] components:',
			components.map((c) => ({ id: c.id, provider: c.provider, mode: c.config?.mode, configKeys: c.config ? Object.keys(c.config) : [] }))
		);
		return components
			.filter((c) => c.config?.mode === 'Source')
			.map((c) => ({ id: c.id || c.name || c.provider, name: c.name || c.id || c.provider }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [project]);

	// --- View state -----------------------------------------------------------

	const initial = (initialState as ProjectViewState | undefined) ?? {};
	const [mode, setMode] = useState<ProjectViewMode>(initial.mode ?? 'design');
	const [flowViewMode, setFlowViewMode] = useState<'pipeline' | 'component'>(initial.flowViewMode ?? 'pipeline');

	const { rows: traceRows, clearTrace } = useTraceState(traceEvents);
	const activeStatus = useMemo(() => pickActiveStatus(statusMap), [statusMap]);

	// --- Persist view state --------------------------------------------------

	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;

	useEffect(() => {
		onMessageRef.current?.({ type: 'project:stateChange', state: { mode, flowViewMode } });
	}, [mode, flowViewMode]);

	// --- Validate callback for Canvas ----------------------------------------

	const validateCounter = useRef(0);
	const handleValidate = useCallback(
		async (pipeline: any): Promise<any> => {
			return new Promise((resolve, reject) => {
				const requestId = ++validateCounter.current;
				pendingValidates.current.set(requestId, { resolve, reject });
				send({ type: 'canvas:validate', requestId, pipeline });
				setTimeout(() => {
					if (pendingValidates.current.has(requestId)) {
						pendingValidates.current.get(requestId)!.resolve({ errors: [], warnings: [] });
						pendingValidates.current.delete(requestId);
					}
				}, 15000);
			});
		},
		[send]
	);

	// --- Mode switch ---------------------------------------------------------

	const handleModeChange = useCallback((id: string) => {
		setMode(id as ProjectViewMode);
	}, []);

	// --- Canvas callbacks ----------------------------------------------------

	const handleContentChanged = useCallback(
		(updatedProject: any) => {
			setProject(updatedProject);
			send({ type: 'canvas:contentChanged', project: updatedProject });
		},
		[send]
	);

	const handleRunPipeline = useCallback(
		(source: string, updatedProject: any) => {
			send({ type: 'canvas:contentChanged', project: updatedProject });
			send({ type: 'status:pipelineAction', action: 'run', source });
		},
		[send]
	);

	const handleStopPipeline = useCallback(
		(source: string) => {
			send({ type: 'status:pipelineAction', action: 'stop', source });
		},
		[send]
	);

	// --- Trace clear ---------------------------------------------------------

	const handleTraceClear = useCallback(() => {
		clearTrace();
		send({ type: 'trace:clear' });
	}, [clearTrace, send]);

	// --- Aggregated error/warning counts -------------------------------------

	const totalErrors = Object.values(statusMap).reduce((sum, ts) => sum + (ts.errors?.length ?? 0), 0);
	const totalWarnings = Object.values(statusMap).reduce((sum, ts) => sum + (ts.warnings?.length ?? 0), 0);

	// --- Tab definitions -----------------------------------------------------

	const tabs = [
		{ id: 'design', label: 'Design' },
		{ id: 'status', label: 'Status' },
		{ id: 'tokens', label: 'Tokens' },
		{ id: 'flow', label: 'Flow' },
		{ id: 'trace', label: 'Trace' },
		{
			id: 'errors',
			label: 'Errors',
			badge: totalErrors + totalWarnings > 0 ? String(totalErrors + totalWarnings) : undefined,
		},
	];

	// --- Panels (only the active panel is mounted) ----------------------------

	const handlePipelineAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			send({ type: 'status:pipelineAction', action, source });
		},
		[send]
	);

	const panels = {
		design: {
			content: <div style={styles.canvasPadding}>{project && <Canvas oauth2RootUrl="" project={project} servicesJson={servicesJson} handleValidatePipeline={handleValidate} onContentChanged={handleContentChanged} onRunPipeline={handleRunPipeline} onStopPipeline={handleStopPipeline} isConnected={isConnected} />}</div>,
			actions: <CanvasToolbarSlot />,
		},
		status: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceStatusPane key={src.id} source={src} taskStatus={statusMap[src.id]} onPipelineAction={handlePipelineAction} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		tokens: {
			content: <div style={commonStyles.tabContent}>{activeStatus?.tokens ? <Tokens taskStatus={activeStatus} /> : <div style={styles.empty}>No token data available</div>}</div>,
		},
		flow: {
			content: (
				<div style={commonStyles.tabContent}>
					<Flow taskStatus={activeStatus} viewMode={flowViewMode} onViewModeChange={setFlowViewMode} />
				</div>
			),
		},
		trace: {
			content: (
				<div style={commonStyles.tabContent}>
					<Trace rows={traceRows} onClear={handleTraceClear} />
				</div>
			),
		},
		errors: {
			content: (
				<div style={commonStyles.tabContent}>
					{Object.entries(statusMap).map(([source, ts]) => {
						const errs = ts.errors?.length ?? 0;
						const warns = ts.warnings?.length ?? 0;
						if (errs === 0 && warns === 0) return null;
						return (
							<div key={source} style={{ marginBottom: 12 }}>
								{sources.length > 1 && <div style={styles.sourceName}>{source}</div>}
								{errs > 0 && <Errors title="Errors" items={ts.errors} type="error" />}
								{warns > 0 && <Errors title="Warnings" items={ts.warnings} type="warning" />}
							</div>
						);
					})}
					{totalErrors === 0 && totalWarnings === 0 && <div style={styles.empty}>No errors or warnings</div>}
				</div>
			),
		},
	};

	// --- Render --------------------------------------------------------------

	return (
		<CanvasToolbarProvider>
			<div style={styles.container}>
				<TabPanel tabs={tabs} activeTab={mode} onTabChange={handleModeChange} panels={panels} />
			</div>
		</CanvasToolbarProvider>
	);
});

ProjectView.displayName = 'ProjectView';

// =============================================================================
// SOURCE STATUS PANE
// =============================================================================

const SourceStatusPane: React.FC<{
	source: SourceInfo;
	taskStatus: TaskStatus | undefined;
	onPipelineAction: (action: 'run' | 'stop' | 'restart', source?: string) => void;
}> = ({ source, taskStatus, onPipelineAction }) => {
	const currentElapsed = useElapsedTimer(taskStatus ?? null);

	return (
		<div style={styles.sourcePane}>
			<StatusHeader name={source.name} taskStatus={taskStatus ?? null} currentElapsed={currentElapsed} onPipelineAction={(action, src) => onPipelineAction(action, src ?? source.id)} />
			<div style={styles.sourceBody}>
				<Status taskStatus={taskStatus ?? null} currentElapsed={currentElapsed} />
			</div>
		</div>
	);
};

// =============================================================================
// CANVAS TOOLBAR SLOT
// =============================================================================

const CanvasToolbarSlot: React.FC = () => {
	const { toolbar } = useCanvasToolbar();
	if (!toolbar) return null;
	return <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 6px', borderRadius: 6, border: '1px solid var(--rr-border)', height: 34 }}>{toolbar}</div>;
};

export default ProjectView;
