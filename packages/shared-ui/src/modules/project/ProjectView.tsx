// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * ProjectView — Unified project frame composing the canvas editor and all
 * runtime views (status, tokens, flow, trace, errors) behind a shared tab bar.
 *
 * All data flows in via props; all user actions flow out via callbacks.
 * The host is responsible for managing state, fetching data, and parsing
 * server events (use `parseServerEvent` utility).
 *
 * Supports multiple source nodes — the Status tab renders a self-contained
 * pane per source (sorted A→Z by name).
 */

import React, { useState, useCallback, useRef, useMemo, CSSProperties } from 'react';

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
import type { ProjectViewMode, ViewState, TaskStatus, TraceEvent, TraceRow } from './types';

// =============================================================================
// PROPS
// =============================================================================

/**
 * ProjectView props — pure props-based API for direct mounting.
 *
 * All data flows in as props; all user actions flow out as callbacks.
 * The host is responsible for managing state, fetching data, and
 * parsing server events (use `parseServerEvent` utility).
 */
export interface IProjectViewProps {
	/** The pipeline project object. */
	project: any | null;
	/** Available node service definitions (keyed by provider). */
	servicesJson: Record<string, any>;
	/** Whether the host is connected to the RocketRide server. */
	isConnected: boolean;
	/** Per-source task status map (source ID → status). */
	statusMap: Record<string, TaskStatus>;
	/** Server host URL for {host} placeholder replacement in endpoint URLs. */
	serverHost?: string;
	/** Whether the document has unsaved changes. */
	isDirty?: boolean;
	/** Whether the document is a new (never-saved) file. */
	isNew?: boolean;
	/** Initial view state (mode, flowViewMode, viewport). Used as starting values; ProjectView manages its own local view state after mount. */
	initialViewState?: ViewState;
	/** Initial user preferences. Used as starting values; ProjectView manages its own local prefs after mount. */
	initialPrefs?: Record<string, unknown>;
	/** Accumulated trace events — host appends new events, ProjectView renders them. */
	traceEvents?: TraceEvent[];
	/** Called when the user edits the pipeline in the canvas. */
	onContentChanged?: (project: any) => void;
	/** Called to validate a pipeline. Host returns validation result as a Promise. */
	onValidate?: (pipeline: any) => Promise<any>;
	/** Called for pipeline run/stop/restart actions. */
	onPipelineAction?: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	/** Called when view state changes (mode, flowViewMode, viewport). */
	onViewStateChange?: (viewState: ViewState) => void;
	/** Called when user preferences change (e.g. panel widths, toggles). */
	onPrefsChange?: (prefs: Record<string, unknown>) => void;
	/** Called when the user clicks an external link in the canvas. */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Called when the user requests a save (Ctrl+S or menu). */
	onSave?: () => void;
	/** Called when the user clears the trace log. */
	onTraceClear?: () => void;
}

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
		...commonStyles.badge,
		backgroundColor: 'var(--rr-color-error)',
		color: 'var(--rr-fg-button)',
	} as CSSProperties,
	warningBadge: {
		...commonStyles.badge,
		backgroundColor: 'var(--rr-color-warning)',
		color: 'var(--rr-fg-button)',
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
// COMPONENT
// =============================================================================

const ProjectView: React.FC<IProjectViewProps> = ({ project, servicesJson, isConnected, statusMap, serverHost = '', isDirty = false, isNew = false, initialViewState, initialPrefs, traceEvents = [], onContentChanged, onValidate, onPipelineAction, onViewStateChange, onPrefsChange, onOpenLink, onSave, onTraceClear }) => {
	// --- Local view state (initialized from props, managed locally) -----------

	const [viewState, setViewState] = useState<ViewState>(() => ({
		mode: initialViewState?.mode ?? 'design',
		flowViewMode: initialViewState?.flowViewMode ?? 'pipeline',
		viewport: initialViewState?.viewport,
	}));

	const [prefs, setPrefs] = useState<Record<string, unknown>>(() => initialPrefs ?? {});

	// --- Stable callback refs ------------------------------------------------

	const onViewStateChangeRef = useRef(onViewStateChange);
	onViewStateChangeRef.current = onViewStateChange;
	const onPrefsChangeRef = useRef(onPrefsChange);
	onPrefsChangeRef.current = onPrefsChange;

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

	const updateViewState = useCallback((patch: Partial<ViewState>) => {
		setViewState((prev) => {
			const next = { ...prev, ...patch };
			onViewStateChangeRef.current?.(next);
			return next;
		});
	}, []);

	const getPreference = useCallback((key: string) => prefs?.[key], [prefs]);
	const setPreference = useCallback((key: string, value: unknown) => {
		setPrefs((prev) => {
			const next = { ...prev, [key]: value };
			onPrefsChangeRef.current?.(next);
			return next;
		});
	}, []);

	const { rows: traceRows, clearTrace } = useTraceState(traceEvents);

	// --- Validate callback for Canvas ----------------------------------------

	const onValidateRef = useRef(onValidate);
	onValidateRef.current = onValidate;

	const handleValidate = useCallback(async (pipeline: any): Promise<any> => {
		if (!onValidateRef.current) return { errors: [], warnings: [] };
		try {
			return await onValidateRef.current(pipeline);
		} catch {
			return { errors: [], warnings: [] };
		}
	}, []);

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
			onContentChanged?.(updatedProject);
		},
		[onContentChanged]
	);

	const handleRunPipeline = useCallback(
		(source: string, _project: any) => {
			onPipelineAction?.('run', source);
		},
		[onPipelineAction]
	);

	const handleStopPipeline = useCallback(
		(source: string) => {
			onPipelineAction?.('stop', source);
		},
		[onPipelineAction]
	);

	// --- Save ----------------------------------------------------------------

	const handleSave = useCallback(() => {
		onSave?.();
	}, [onSave]);

	// --- Open link -----------------------------------------------------------

	const handleOpenLink = useCallback(
		(url: string, displayName?: string) => {
			onOpenLink?.(url, displayName);
		},
		[onOpenLink]
	);

	// --- Trace clear ---------------------------------------------------------

	const handleTraceClear = useCallback(() => {
		clearTrace();
		onTraceClear?.();
	}, [clearTrace, onTraceClear]);

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
			onPipelineAction?.(action, source);
		},
		[onPipelineAction]
	);

	// --- Viewport change -----------------------------------------------------

	const handleViewportChange = (viewport: { x: number; y: number; zoom: number }) => {
		updateViewState({ viewport });
	};

	const panels = {
		design: {
			content: <div style={styles.canvasPadding}>{project && <Canvas oauth2RootUrl="" project={project} servicesJson={servicesJson} taskStatuses={statusMap} handleValidatePipeline={handleValidate} onContentChanged={handleContentChanged} onViewportChange={handleViewportChange} onRunPipeline={handleRunPipeline} onStopPipeline={handleStopPipeline} onOpenLink={handleOpenLink} serverHost={serverHost} isConnected={isConnected} getPreference={getPreference} setPreference={setPreference} initialViewport={viewState.viewport} isDirty={isDirty} isNew={isNew} onSave={handleSave} />}</div>,
		},
		status: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceStatusPane key={src.id} source={src} taskStatus={statusMap[src.id]} isConnected={isConnected} onPipelineAction={handlePipelineAction} onOpenLink={handleOpenLink} serverHost={serverHost} />) : <div style={commonStyles.empty}>No source components found</div>}</div>,
		},
		tokens: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceTokensPane key={src.id} source={src} taskStatus={statusMap[src.id]} />) : <div style={commonStyles.empty}>No source components found</div>}</div>,
		},
		flow: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceFlowPane key={src.id} source={src} taskStatus={statusMap[src.id]} viewMode={viewState.flowViewMode ?? 'pipeline'} onViewModeChange={(vm) => updateViewState({ flowViewMode: vm })} />) : <div style={commonStyles.empty}>No source components found</div>}</div>,
		},
		trace: {
			content: <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src) => <SourceTracePane key={src.id} source={src} rows={traceRows.filter((r) => r.source === src.id)} componentNames={componentNames} onClear={handleTraceClear} />) : <div style={commonStyles.empty}>No source components found</div>}</div>,
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
					{totalErrors === 0 && totalWarnings === 0 && <div style={commonStyles.empty}>No errors or warnings</div>}
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
};

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
