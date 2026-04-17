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

import { applyTheme } from '../../themes';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import { useTraceState } from './hooks/useTraceState';
import { useElapsedTimer } from './hooks/useElapsedTimer';
import Canvas from '../../components/canvas';
import Status from '../../components/status/Status';
import { StatusHeader } from '../../components/status/StatusHeader';
import { SourceTokensContent } from '../../components/tokens/Tokens';
import { SourceFlowContent } from '../../components/flow/Flow';
import Trace from '../../components/trace/Trace';
import Errors from '../../components/errors/Errors';
import { commonStyles } from '../../themes/styles';

import PipelineActions from '../../components/pipeline-actions/PipelineActions';
import type { IProjectViewProps, ProjectViewRef, ProjectViewMode, ViewState, ProjectViewIncoming, ProjectViewOutgoing, TaskStatus, TraceEvent, TraceRow } from './types';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
	disconnectOverlay: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.45)',
		backdropFilter: 'blur(8px)',
		WebkitBackdropFilter: 'blur(8px)',
		zIndex: 1000,
	} as CSSProperties,
	disconnectButton: {
		padding: '14px 40px',
		fontSize: 'var(--rr-font-size-h4)',
		fontWeight: 700,
		fontFamily: 'var(--rr-font-family)',
		color: '#ffffff',
		backgroundColor: 'transparent',
		border: '2px solid rgba(255, 255, 255, 0.7)',
		borderRadius: 6,
		cursor: 'default',
		letterSpacing: '0.05em',
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
		...commonStyles.card,
		borderRadius: 6,
		marginBottom: 25,
	} as CSSProperties,
	sourceName: {
		fontWeight: 600,
		fontSize: 'var(--rr-font-size-h5)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	sourceBody: commonStyles.cardBody,
	errorBadge: {
		fontSize: 11,
		fontWeight: 600,
		padding: '2px 8px',
		borderRadius: 10,
		backgroundColor: 'var(--rr-color-error)',
		color: '#fff',
	} as CSSProperties,
	warningBadge: {
		fontSize: 11,
		fontWeight: 600,
		padding: '2px 8px',
		borderRadius: 10,
		backgroundColor: 'var(--rr-color-warning)',
		color: '#fff',
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

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectView = forwardRef<ProjectViewRef, IProjectViewProps>(({ onMessage }, ref) => {
	// --- Internal state (all populated via handleMessage) ---------------------

	const [project, setProject] = useState<any>(null);
	const [projectId, setProjectId] = useState<string>('');
	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [isConnected, setIsConnected] = useState(false);
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
	const [viewState, setViewState] = useState<ViewState | null>(null);
	const [prefs, setPrefs] = useState<Record<string, unknown> | null>(null);
	const [serverHost, setServerHost] = useState<string>('');
	const [isDirty, setIsDirty] = useState(false);
	const [isNew, setIsNew] = useState(false);

	const projectIdRef = useRef(projectId);
	projectIdRef.current = projectId;

	// Pending validate requests
	const pendingValidates = useRef<Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>>(new Map());

	// --- Imperative message handler ------------------------------------------

	useImperativeHandle(ref, () => ({
		handleMessage(msg: ProjectViewIncoming) {
			switch (msg.type) {
				case 'project:load':
					// Atomic load — sets all state in one React batch
					setProject(msg.project);
					setProjectId(msg.project?.project_id ?? '');
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
					if (msg.serverHost) setServerHost(msg.serverHost);
					break;
				case 'shell:init':
					if (msg.theme) applyTheme(msg.theme as any);
					setIsConnected(msg.isConnected);
					send({ type: 'view:initialized' });
					break;
				case 'shell:themeChange':
					applyTheme(msg.tokens as any);
					break;
				case 'project:update':
					setProject(msg.project);
					break;
				case 'project:services':
					setServicesJson(msg.services);
					break;
				case 'project:validateResponse': {
					const pending = pendingValidates.current.get(msg.requestId);
					if (pending) {
						pendingValidates.current.delete(msg.requestId);
						if (msg.error) pending.reject(new Error(msg.error));
						else pending.resolve(msg.result);
					}
					break;
				}
				case 'server:event': {
					const event = msg.event as Record<string, any>;
					const pid = projectIdRef.current;
					if (event?.event === 'apaevt_status_update' && event?.body?.project_id === pid) {
						setStatusMap((prev) => ({ ...prev, [event.body.source]: event.body }));
					} else if (event?.event === 'apaevt_flow' && event?.body?.project_id === pid) {
						const body = event.body;
						const traceEvent: TraceEvent = {
							pipelineId: body.id ?? 0,
							op: body.op || 'enter',
							pipes: body.pipes || [],
							trace: body.op === 'end' ? {} : body.trace || {},
							source: body.source,
							...(body.op === 'end' && body.trace && Object.keys(body.trace).length > 0 ? { pipelineResult: body.trace } : {}),
						};
						setTraceEvents((prev) => [...prev, traceEvent]);
					}
					break;
				}
				case 'shell:connectionChange':
					// On reconnect, clear stale data so only fresh server
					// events repopulate the panels.
					if (msg.isConnected) {
						setStatusMap({});
						setTraceEvents([]);
					}
					setIsConnected(msg.isConnected);
					break;
				case 'shell:viewActivated':
					window.dispatchEvent(new CustomEvent('canvas:restoreViewport'));
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
				case 'project:dirtyState':
					setIsDirty(msg.isDirty);
					setIsNew(msg.isNew);
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

	const components = useMemo(() => {
		return (project?.components ?? []) as Array<{ provider: string; name?: string; id?: string; config?: Record<string, any> }>;
	}, [project]);

	const sources: SourceInfo[] = useMemo(() => {
		if (!components.length) return [];
		return components
			.filter((c) => c.config?.mode === 'Source')
			.map((c) => ({ id: c.id || c.name || c.provider, name: c.name || c.id || c.provider }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [components]);

	/** Map component id → display name for the trace viewer. */
	const componentNames: Map<string, string> = useMemo(() => {
		const map = new Map<string, string>();
		for (const c of components) {
			if (c.id && c.name) map.set(c.id, c.name);
		}
		return map;
	}, [components]);

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

	// --- Validate callback for Canvas ----------------------------------------

	const validateCounter = useRef(0);
	const handleValidate = useCallback(
		async (pipeline: any): Promise<any> => {
			return new Promise((resolve, reject) => {
				const requestId = ++validateCounter.current;
				pendingValidates.current.set(requestId, { resolve, reject });
				send({ type: 'project:validate', requestId, pipeline });
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
			send({ type: 'project:contentChanged', project: updatedProject });
		},
		[send]
	);

	const handleRunPipeline = useCallback(
		(source: string, _project: any) => {
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

	// --- Save ----------------------------------------------------------------

	const handleSave = useCallback(() => {
		send({ type: 'project:requestSave' });
	}, [send]);

	// --- Open link -----------------------------------------------------------

	const handleOpenLink = useCallback(
		(url: string, displayName?: string) => {
			send({ type: 'project:openLink', url, displayName });
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

	const handleViewportChange = (viewport: { x: number; y: number; zoom: number }) => {
		updateViewState({ viewport });
	};

	const panels = {
		design: {
			content: <div style={styles.canvasPadding}>{project && <Canvas oauth2RootUrl="" project={project} servicesJson={servicesJson} taskStatuses={statusMap} handleValidatePipeline={handleValidate} onContentChanged={handleContentChanged} onViewportChange={handleViewportChange} onRunPipeline={handleRunPipeline} onStopPipeline={handleStopPipeline} onOpenLink={handleOpenLink} serverHost={serverHost} isConnected={isConnected} getPreference={getPreference} setPreference={setPreference} initialViewport={viewState.viewport} isDirty={isDirty} isNew={isNew} onSave={handleSave} />}</div>,
		},
		status: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceStatusPane key={src.id} source={src} taskStatus={statusMap[src.id]} isConnected={isConnected} onPipelineAction={handlePipelineAction} onOpenLink={handleOpenLink} serverHost={serverHost} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		tokens: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceTokensPane key={src.id} source={src} taskStatus={statusMap[src.id]} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		flow: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceFlowPane key={src.id} source={src} taskStatus={statusMap[src.id]} viewMode={viewState.flowViewMode ?? 'pipeline'} onViewModeChange={(vm) => updateViewState({ flowViewMode: vm })} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		trace: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceTracePane key={src.id} source={src} rows={traceRows.filter((r) => r.source === src.id)} componentNames={componentNames} onClear={handleTraceClear} />) : <div style={styles.empty}>No source components found</div>}</div>,
		},
		errors: {
			content: (
				<div style={commonStyles.tabContent}>
					{Object.entries(statusMap).map(([source, ts]) => {
						const errs = ts.errors?.length ?? 0;
						const warns = ts.warnings?.length ?? 0;
						if (errs === 0 && warns === 0) return null;
						const displayName = sources.find((s) => s.id === source)?.name ?? source;
						return (
							<div key={source} style={{ ...commonStyles.card, borderRadius: 6, marginBottom: 25 }}>
								<div style={commonStyles.cardHeader}>
									<span style={styles.sourceName}>{displayName}</span>
									<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
										{errs > 0 && (
											<span style={styles.errorBadge}>
												{errs} {errs === 1 ? 'Error' : 'Errors'}
											</span>
										)}
										{warns > 0 && (
											<span style={styles.warningBadge}>
												{warns} {warns === 1 ? 'Warning' : 'Warnings'}
											</span>
										)}
									</div>
								</div>
								<div style={commonStyles.cardBody}>
									{errs > 0 && <Errors title="Errors" items={ts.errors} type="error" />}
									{warns > 0 && <Errors title="Warnings" items={ts.warnings} type="warning" />}
								</div>
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
			{!isConnected && (
				<div style={styles.disconnectOverlay}>
					<button type="button" style={styles.disconnectButton} disabled>
						[ Disconnected ]
					</button>
				</div>
			)}
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
	isConnected: boolean;
	onPipelineAction: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	onOpenLink?: (url: string, displayName?: string) => void;
	serverHost?: string;
}> = ({ source, taskStatus, isConnected, onPipelineAction, onOpenLink, serverHost }) => {
	const currentElapsed = useElapsedTimer(taskStatus ?? null);

	return (
		<div style={styles.sourcePane}>
			<StatusHeader name={source.name} taskStatus={taskStatus ?? null} currentElapsed={currentElapsed} onPipelineAction={(action, src) => onPipelineAction(action, src ?? source.id)} extraActions={<PipelineActions notes={taskStatus?.notes} host={serverHost} onOpenLink={onOpenLink} displayName={source.name} />} />
			<div style={styles.sourceBody}>
				<Status taskStatus={taskStatus ?? null} currentElapsed={currentElapsed} isConnected={isConnected} />
			</div>
		</div>
	);
};

// =============================================================================
// SOURCE TOKENS PANE
// =============================================================================

const SourceTokensPane: React.FC<{
	source: SourceInfo;
	taskStatus: TaskStatus | undefined;
}> = ({ source, taskStatus }) => {
	return (
		<div style={styles.sourcePane}>
			{/* Source name only when multiple sources exist */}
			<div style={commonStyles.cardHeader}>
				<span style={styles.sourceName}>{source.name}</span>
			</div>
			<div style={styles.sourceBody}>
				<SourceTokensContent tokens={taskStatus?.tokens} />
			</div>
		</div>
	);
};

// =============================================================================
// SOURCE FLOW PANE
// =============================================================================

const SourceFlowPane: React.FC<{
	source: SourceInfo;
	taskStatus: TaskStatus | undefined;
	viewMode: 'pipeline' | 'component';
	onViewModeChange: (mode: 'pipeline' | 'component') => void;
}> = ({ source, taskStatus, viewMode, onViewModeChange }) => {
	return (
		<div style={styles.sourcePane}>
			<div style={commonStyles.cardHeader}>
				<span style={styles.sourceName}>{source.name}</span>
				<div style={commonStyles.toggleGroup}>
					<button style={commonStyles.toggleButton(viewMode === 'pipeline')} onClick={() => onViewModeChange('pipeline')}>
						Pipeline View
					</button>
					<button style={commonStyles.toggleButton(viewMode === 'component')} onClick={() => onViewModeChange('component')}>
						Component View
					</button>
				</div>
			</div>
			<div style={styles.sourceBody}>
				<SourceFlowContent taskStatus={taskStatus ?? null} viewMode={viewMode} />
			</div>
		</div>
	);
};

// =============================================================================
// SOURCE TRACE PANE
// =============================================================================

const SourceTracePane: React.FC<{
	source: SourceInfo;
	rows: TraceRow[];
	componentNames: Map<string, string>;
	onClear: () => void;
}> = ({ source, rows, componentNames, onClear }) => {
	return (
		<div style={styles.sourcePane}>
			<div style={commonStyles.cardHeader}>
				<span style={styles.sourceName}>{source.name}</span>
				{rows.length > 0 && (
					<button style={commonStyles.buttonSecondary} onClick={onClear}>
						Clear
					</button>
				)}
			</div>
			<div style={styles.sourceBody}>
				<Trace rows={rows} componentNames={componentNames} />
			</div>
		</div>
	);
};

export default ProjectView;
