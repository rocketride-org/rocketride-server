// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * ProjectView — Unified project frame composing the canvas editor and the two
 * environment pages behind a shared page strip (DESIGN | DEVELOPMENT | DEPLOY,
 * UI direction v5):
 *
 * - DESIGN: the pipeline canvas (the only page with Save).
 * - DEVELOPMENT: one self-contained {@link SourceSection} per source over the
 *   dev run-log continuum — live monitoring, replay player, log, analysis.
 * - DEPLOY: the deploy-continuum sections, with an optional pipeline-level
 *   deployment lifecycle card slotted above them (owned by the deploy feature).
 *
 * All data flows in via props; all user actions flow out via callbacks.
 * The host owns the connection: it accumulates raw stamped live events into
 * `liveLogEvents` and binds `openEventStream`/`fetchTimeline` to
 * `client.log`. Sections are independent — each carries its own pills,
 * player, and DVR session (sorted A→Z by source name).
 */

import React, { useState, useCallback, useRef, useMemo, CSSProperties, ReactNode } from 'react';

import { TabPanelContent } from '../../components/tab-panel/TabPanelContent';
import { ContentHeader } from '../../components/content-header/ContentHeader';
import { PageViewControl } from '../../components/page-view-control/PageViewControl';
import type { ViewMenu } from '../../types/viewMenu';
import Canvas from '../../components/canvas';
import { PrefsProvider, type IPrefsApi } from '../../contexts/PrefsContext';
import { commonStyles } from '../../themes/styles';
import { OAUTH_ROOT_URL } from '../../config/oauth';

import { extractPipelineEnvVars } from '../../components/canvas/util/extractEnvVars';
import { SourceSection } from './components/SourceSection';
import type { TaskEventMessage, TaskEventSession, TaskTimeline } from './hooks/useTaskEvents';
import type { ProjectViewMode, ViewState, TaskStatus, TraceEvent } from './types';

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
	/**
	 * Document display name for the page header (shell hosts only). When
	 * provided, the non-canvas sub-views render a stock {@link ContentHeader}
	 * titled with this name (matching the document's DocTab). VS Code omits it:
	 * its editor tab + breadcrumb already name the document, so the Archetype B
	 * page header is a shell-ui-only element and no header renders without it.
	 */
	documentTitle?: string;
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
	/**
	 * @deprecated Unused since the environment-page restructure — sections fold
	 * trace state from `liveLogEvents` themselves. Kept so existing hosts
	 * compile; remove once both hosts have migrated.
	 */
	traceEvents?: TraceEvent[];
	/** Called when the user edits the pipeline in the canvas. */
	onContentChanged?: (project: any) => void;
	/** Called to validate a pipeline. Host returns validation result as a Promise. */
	onValidate?: (pipeline: any) => Promise<any>;
	/** Called for pipeline run/stop/restart actions. Trace level and idle-timeout (TTL) are resolved host-side from the pipeline-builder settings. */
	onPipelineAction?: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	/** Called when view state changes (mode, flowViewMode, viewport). */
	onViewStateChange?: (viewState: ViewState) => void;
	/** Called when user preferences change (e.g. panel widths, toggles). */
	onPrefsChange?: (prefs: Record<string, unknown>) => void;
	/** Called when the user clicks an external link in the canvas. */
	onOpenLink?: (url: string, displayName?: string) => void;
	/**
	 * OAuth broker base URL for the social-login buttons. Defaults to the
	 * built-in {@link OAUTH_ROOT_URL}; hosts may override (e.g. for staging).
	 */
	oauth2RootUrl?: string;
	/**
	 * Where the OAuth broker should redirect after authentication. Hosts that
	 * cannot receive a web redirect (VS Code) set a deep link they intercept.
	 */
	oauthReturnUrl?: string;
	/** Opens an external URL in the host's system browser to start an OAuth login. */
	onOpenExternal?: (url: string) => void;
	/** OAuth tokens delivered out-of-band by the host (e.g. VS Code deep-link callback). */
	pendingOAuthTokens?: { tokens: string; state: string };
	/** Clears `pendingOAuthTokens` once a config panel has consumed them. */
	clearPendingOAuthTokens?: () => void;
	/** Called when the user requests a save (Ctrl+S or menu). */
	onSave?: () => void;
	/** SaaS-only: export/download the current pipeline. Forwarded to the canvas. */
	onExport?: () => void;
	/**
	 * @deprecated Unused since the environment-page restructure — each section
	 * owns its replay window; there is no shared trace accumulator to clear.
	 */
	onTraceClear?: () => void;
	/** When true, the canvas is fully read-only: editing, saving, and run/stop are disabled. */
	isReadonly?: boolean;
	/**
	 * Whether the user has an active subscription for pipeline execution.
	 * When false, play buttons show a lock overlay and the run button shows "Subscribe".
	 * Defaults to true (ungated) when not provided.
	 */
	isSubscribed?: boolean;
	/** Available ROCKETRIDE_* environment variable key names for autocomplete in config fields. */
	envKeys?: string[];
	/** Called when the pipeline references ROCKETRIDE_* vars not present in envKeys. */
	onMissingEnvVars?: (missingKeys: string[]) => void;
	/**
	 * Raw STAMPED live events (header eventTime + seq) as received from the
	 * server subscription — the host appends, sections absorb increments
	 * (deduped on seq). Feeds live Trace/Flow/Log/Analyze and the DVR buffer.
	 */
	liveLogEvents?: TaskEventMessage[];
	/**
	 * Stream-bound DVR session factory (wraps `client.log.openEventStream`
	 * for this project). Null/omitted disables replay (live-only host).
	 */
	openEventStream?: (stream: { source: string; runKind: 'dev' | 'deploy' }) => TaskEventSession;
	/**
	 * Stream-bound chapters fetch (wraps `client.log.chapters`). Null/omitted
	 * disables the activity timeline.
	 */
	fetchTimeline?: (stream: { source: string; runKind: 'dev' | 'deploy' }) => Promise<TaskTimeline>;
	/**
	 * Optional pipeline-level deployment lifecycle card rendered at the top
	 * of the DEPLOY page (owned by the deploy feature; this view only hosts
	 * the slot).
	 */
	deployLifecycle?: ReactNode;
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
		...commonStyles.modalOverlay,
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
	// Fills the space below the top PageViewControl strip; TabPanelContent's
	// 100%-height wrapper resolves against this definite flex box.
	pageBody: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
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
// DOCUMENT HEADER
// =============================================================================

/** Non-canvas pages that render the document {@link ContentHeader}. */
type DocSubView = 'development' | 'deploy';

/**
 * Per-page header subtitles — "{Page} — {short descriptor}".
 */
const DOC_SUBVIEW_SUBTITLES: Record<DocSubView, string> = {
	development: 'Development — live monitoring and replay of your dev runs.',
	deploy: 'Deploy — the deployed pipeline: scheduled runs, monitoring, and replay.',
};

/**
 * Map a persisted view mode from BEFORE the environment-page restructure
 * onto the new strip: the old monitoring modes all lived where the
 * DEVELOPMENT page now is.
 */
function migrateViewMode(mode: string | undefined): ProjectViewMode {
	if (mode === 'design' || mode === 'development' || mode === 'deploy') return mode;
	if (mode === 'status' || mode === 'tokens' || mode === 'flow' || mode === 'trace' || mode === 'errors') {
		return 'development';
	}
	return 'design';
}

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectView: React.FC<IProjectViewProps> = ({ project, documentTitle, servicesJson, isConnected, isSubscribed = true, statusMap, serverHost = '', isDirty = false, isNew = false, initialViewState, initialPrefs, onContentChanged, onValidate, onPipelineAction, onViewStateChange, onPrefsChange, onOpenLink, oauth2RootUrl = OAUTH_ROOT_URL, oauthReturnUrl, onOpenExternal, pendingOAuthTokens, clearPendingOAuthTokens, onSave, onExport, isReadonly = false, envKeys, onMissingEnvVars, liveLogEvents = [], openEventStream, fetchTimeline, deployLifecycle }) => {
	// --- Local view state (initialized from props, managed locally) -----------

	const [viewState, setViewState] = useState<ViewState>(() => ({
		// Persisted modes from before the environment-page restructure map
		// onto the new strip (old monitoring modes -> DEVELOPMENT).
		mode: migrateViewMode(initialViewState?.mode as string | undefined),
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

	// The ONE prefs accessor the canvas — and every DetailPanel inside it — reads
	// and writes through, handed down via <PrefsProvider> below. getPref reads the
	// local prefs bag; setPref merges a key and threads the whole bag to the host
	// (onPrefsChange → useWorkspace on web / the extension host in VS Code).
	//
	// getPref reads through a ref so prefsApi keeps a STABLE identity across pref
	// writes: memoizing on [prefs] would hand FlowPreferences a fresh getPref on
	// every toolbar/view/width write, re-running its layout-read effect and
	// churning the canvas. The ref always holds the latest prefs, so reactivity is
	// preserved (prefs state lives here and re-renders the subtree).
	const prefsRef = useRef(prefs);
	prefsRef.current = prefs;
	const prefsApi = useMemo<IPrefsApi>(
		() => ({
			getPref: (key) => prefsRef.current?.[key],
			setPref: (key, value) =>
				setPrefs((prev) => {
					const next = { ...prev, [key]: value };
					onPrefsChangeRef.current?.(next);
					return next;
				}),
		}),
		[],
	);

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
		(source: string, pipelineProject: any) => {
			// Check for missing ROCKETRIDE_* env vars before running
			if (onMissingEnvVars && envKeys) {
				const referenced = extractPipelineEnvVars(pipelineProject);
				const missing = referenced.filter((v) => !envKeys.includes(v));
				if (missing.length > 0) {
					onMissingEnvVars(missing);
					return;
				}
			}
			onPipelineAction?.('run', source);
		},
		[onPipelineAction, onMissingEnvVars, envKeys]
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

	// --- Aggregated error/warning counts -------------------------------------

	const totalErrors = Object.values(statusMap).reduce((sum, ts) => sum + (ts.errors?.length ?? 0), 0);
	const totalWarnings = Object.values(statusMap).reduce((sum, ts) => sum + (ts.warnings?.length ?? 0), 0);

	// --- ViewMenu declaration (rendered by this view's own PageViewControl) ---
	// Strip = DESIGN | DEVELOPMENT | DEPLOY (UI direction v5). The Development
	// entry carries the live error-severity count so problems stay glanceable
	// from any page (the old Errors-entry convention, moved up a level).
	const totalIssues = totalErrors + totalWarnings;
	const viewMenu = useMemo<ViewMenu>(
		() => ({
			entries: [
				{ id: 'design', label: isReadonly ? 'Design (Readonly)' : 'Design' },
				{ id: 'development', label: 'Development', ...(totalIssues > 0 ? { count: totalIssues, severity: 'error' as const } : {}) },
				{ id: 'deploy', label: 'Deploy' },
			],
		}),
		[isReadonly, totalIssues]
	);

	// --- Panels (all mounted; inactive panels hidden) --------------------------

	const handlePipelineAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			onPipelineAction?.(action, source);
		},
		[onPipelineAction]
	);

	// --- Viewport change -----------------------------------------------------

	// Memoized so ReactFlow's onMoveEnd handler keeps a stable identity — an
	// inline function here gives <ReactFlow> a new onMoveEnd every render, which
	// makes its StoreUpdater re-sync endlessly ("Maximum update depth exceeded").
	const handleViewportChange = useCallback((viewport: { x: number; y: number; zoom: number }) => {
		updateViewState({ viewport });
	}, [updateViewState]);

	/**
	 * Wraps a non-canvas page's body in the standard page grammar: an
	 * optional {@link ContentHeader} (rendered only when the host supplies a
	 * `documentTitle`; VS Code omits it) above the 24px-gutter tab-content
	 * body. Save lives ONLY on the Design page (inside the canvas) — the
	 * monitoring pages carry no document actions.
	 *
	 * @param subView - The page whose header subtitle to show.
	 * @param inner   - The page's body content.
	 * @returns The composed panel node.
	 */
	const renderDocPanel = (subView: DocSubView, inner: ReactNode): ReactNode => (
		<>
			{/* Page header repeats the document name; canvas (Design) has none. */}
			{documentTitle && <ContentHeader title={documentTitle} subtitle={DOC_SUBVIEW_SUBTITLES[subView]} />}
			<div style={commonStyles.tabContent}>{inner}</div>
		</>
	);

	// --- Per-source live event routing + stream bindings ----------------------
	// Split the host's raw stamped feed by source once per update: flow/status
	// events carry body.source; task-scoped events (output, lifecycle, exit)
	// carry the task display id '<tokenhash8>.<source>' in the envelope's
	// top-level `id` (set by the server's monitor forward).
	const projectId: string = project?.project_id ?? '';
	const liveBySource = useMemo(() => {
		const bySource = new Map<string, TaskEventMessage[]>();
		for (const src of sources) bySource.set(src.id, []);
		for (const message of liveLogEvents) {
			// Pure body routing: every task-scoped event carries source
			// (stamped server-side at the forward point).
			const body = (message.body ?? {}) as Record<string, unknown>;
			if (typeof body.source === 'string') bySource.get(body.source)?.push(message);
		}
		return bySource;
	}, [liveLogEvents, sources]);

	/** Render the stacked SourceSections for one continuum. */
	const renderSections = (runKind: 'dev' | 'deploy'): ReactNode =>
		sources.length > 0 ? (
			sources.map((src) => (
				<SourceSection
					key={`${src.id}.${runKind}`}
					source={src}
					runKind={runKind}
					projectId={projectId}
					liveEvents={runKind === 'dev' ? (liveBySource.get(src.id) ?? []) : []}
					openSession={openEventStream ? () => openEventStream({ source: src.id, runKind }) : null}
					fetchTimeline={fetchTimeline ? () => fetchTimeline({ source: src.id, runKind }) : null}
					liveTaskStatus={runKind === 'dev' ? statusMap[src.id] : undefined}
					componentNames={componentNames}
					isConnected={isConnected}
					isSubscribed={isSubscribed}
					isReadonly={isReadonly}
					serverHost={serverHost}
					onPipelineAction={isReadonly ? undefined : handlePipelineAction}
					onOpenLink={handleOpenLink}
				/>
			))
		) : (
			<div style={commonStyles.empty}>No source components found</div>
		);

	const panels = {
		design: {
			content: <div style={styles.canvasPadding}><PrefsProvider value={prefsApi}>{project && <Canvas oauth2RootUrl={oauth2RootUrl} oauthReturnUrl={oauthReturnUrl} onOpenExternal={onOpenExternal} pendingOAuthTokens={pendingOAuthTokens} clearPendingOAuthTokens={clearPendingOAuthTokens} project={project} servicesJson={servicesJson} taskStatuses={statusMap} handleValidatePipeline={handleValidate} onContentChanged={isReadonly ? undefined : handleContentChanged} onViewportChange={handleViewportChange} onRunPipeline={isReadonly ? undefined : handleRunPipeline} onStopPipeline={isReadonly ? undefined : handleStopPipeline} onOpenLink={handleOpenLink} serverHost={serverHost} isConnected={isConnected} isSubscribed={isSubscribed} initialViewport={viewState.viewport} isDirty={isReadonly ? false : isDirty} isNew={isReadonly ? false : isNew} onSave={isReadonly ? undefined : handleSave} onExport={isReadonly ? undefined : onExport} isReadonly={isReadonly} envKeys={envKeys} />}</PrefsProvider></div>,
		},
		development: {
			// The dev environment: one self-contained section per source (its
			// own pills, panes, and player over the dev continuum).
			content: renderDocPanel('development', renderSections('dev')),
		},
		deploy: {
			// The deploy environment: the (optional) pipeline-level lifecycle
			// card on top, then the same per-source sections bound to the
			// deploy continuum — scheduled runs' history, monitoring, replay.
			content: renderDocPanel(
				'deploy',
				<>
					{deployLifecycle}
					{renderSections('deploy')}
				</>
			),
		},
	};

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.container}>
			{/* Page strip — the view renders its own tabs at the very top, above
			    any ContentHeader (the title lives inside each page, below it). */}
			<PageViewControl menu={viewMenu} activeId={viewState.mode} onSelect={handleModeChange} />
			{/* Page bodies fill the space below the strip. */}
			<div style={styles.pageBody}>
				<TabPanelContent panels={panels} activeId={viewState.mode} />
			</div>
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

export default ProjectView;
