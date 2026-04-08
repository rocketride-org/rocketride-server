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

import React, { useState, useCallback, useRef, useMemo, useImperativeHandle, forwardRef, CSSProperties } from 'react';

// Theme CSS — defines --rr-* tokens in the iframe/webview context
import '../../themes/rocketride-default.css';

import { TabPanel } from '../../components/tab-panel/TabPanel';
import { useTraceState } from './hooks/useTraceState';
import { useElapsedTimer } from './hooks/useElapsedTimer';
import Canvas from '../../components/canvas';
import Status from '../../components/status/Status';
import { StatusHeader } from '../../components/status/StatusHeader';
import Tokens from '../../components/tokens/Tokens';
import Flow from '../../components/flow/Flow';
import Trace from '../../components/trace/Trace';
import Errors from '../../components/errors/Errors';
import { commonStyles } from '../../themes/styles';
import { ITaskState } from '../../types/project';
import type { IProjectViewProps, ProjectViewRef, ProjectViewMode, ViewState, ProjectViewIncoming, ProjectViewOutgoing, TaskStatus, TraceEvent } from './types';

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
	const [viewState, setViewState] = useState<ViewState | null>(null);
	const [prefs, setPrefs] = useState<Record<string, unknown> | null>(null);

	// Pending validate requests
	const pendingValidates = useRef<Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>>(new Map());

	// --- Imperative message handler ------------------------------------------

	useImperativeHandle(ref, () => ({
		handleMessage(msg: ProjectViewIncoming) {
			switch (msg.type) {
				case 'project:load':
					// Atomic load — sets all state in one React batch
					setProject(msg.project);
					setServicesJson(msg.services);
					setIsConnected(msg.isConnected);
					setStatusMap(msg.statuses ?? {});
					setViewState({
						mode: msg.viewState?.mode ?? 'design',
						flowViewMode: msg.viewState?.flowViewMode ?? 'pipeline',
						viewport: msg.viewState?.viewport,
					});
					setPrefs(msg.prefs ?? {});
					setTraceEvents([]);
					break;
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
					setViewState({
						mode: msg.state?.mode ?? 'design',
						flowViewMode: msg.state?.flowViewMode ?? 'pipeline',
						viewport: msg.state?.viewport,
					});
					break;
				case 'project:initialPrefs':
					setPrefs(msg.prefs ?? {});
					break;
				case 'project:themeChange':
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

		return components
			.filter((c) => c.config?.mode === 'Source')
			.map((c) => ({ id: c.id || c.name || c.provider, name: c.name || c.id || c.provider }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [project]);

	// --- View state + preferences (separate concerns) -----------------------

	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;

	const updateViewState = useCallback((patch: Partial<ViewState>) => {
		setViewState((prev) => {
			if (!prev) return prev;
			const next = { ...prev, ...patch };
			onMessageRef.current?.({ type: 'project:viewStateChange', viewState: next });
			return next;
		});
	}, []);

	const getPreference = useCallback((key: string) => prefs?.[key], [prefs]);
	const setPreference = useCallback((key: string, value: unknown) => {
		setPrefs((prev) => {
			const next = { ...prev, [key]: value };
			onMessageRef.current?.({ type: 'project:prefsChange', prefs: next });
			return next;
		});
	}, []);

	const { rows: traceRows, clearTrace } = useTraceState(traceEvents);
	const activeStatus = useMemo(() => pickActiveStatus(statusMap), [statusMap]);

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

	const handleModeChange = useCallback(
		(id: string) => {
			updateViewState({ mode: id as ProjectViewMode });
		},
		[updateViewState]
	);

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

	// --- Wait for viewState before building any UI --------------------------

	if (!viewState || !prefs) return null;

	// Inject saved viewport from viewState into the project for Canvas to restore
	const projectForCanvas = project && viewState.viewport ? { ...project, viewport: viewState.viewport } : project;

	const handleViewportChange = (viewport: { x: number; y: number; zoom: number }) => {
		updateViewState({ viewport });
	};

	const panels = {
		design: {
			content: <div style={styles.canvasPadding}>{projectForCanvas && <Canvas oauth2RootUrl="" project={projectForCanvas} servicesJson={servicesJson} handleValidatePipeline={handleValidate} onContentChanged={handleContentChanged} onViewportChange={handleViewportChange} onRunPipeline={handleRunPipeline} onStopPipeline={handleStopPipeline} isConnected={isConnected} getPreference={getPreference} setPreference={setPreference} />}</div>,
		},
		status: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceStatusPane key={src.id} source={src} taskStatus={statusMap[src.id]} onPipelineAction={handlePipelineAction} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		tokens: {
			content: (
				<div style={commonStyles.tabContent}>
					<Tokens statusMap={statusMap} sources={sources} />
				</div>
			),
		},
		flow: {
			content: (
				<div style={commonStyles.tabContent}>
					<Flow taskStatus={activeStatus} viewMode={viewState.flowViewMode ?? 'pipeline'} onViewModeChange={(vm) => updateViewState({ flowViewMode: vm })} />
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
		<div style={styles.container}>
			<TabPanel tabs={tabs} activeTab={viewState.mode} onTabChange={handleModeChange} panels={panels} />
		</div>
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

export default ProjectView;
