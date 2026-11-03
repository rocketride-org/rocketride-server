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
 * - DEVELOPMENT: one self-contained {@link SourcePanel} per source over the
 *   dev run-log continuum — live monitoring, replay player, log, analysis.
 * - DEPLOY: the {@link DeployPanel} (version strip, where-live,
 *   history), composed here like the sibling pages — capability-fed from the
 *   host's `fetchDeployLifecycle`/publish/deploy closures; its presence
 *   enables the page.
 *
 * All data flows in via props; all user actions flow out via callbacks.
 * The host owns the connection: it accumulates raw stamped live events into
 * `liveLogEvents` and binds `openEventStream`/`fetchTimeline` to
 * `client.log`. Sections are independent — each carries its own pills,
 * player, and DVR session (sorted A→Z by source name).
 */

import React, { useState, useCallback, useRef, useMemo, useEffect, CSSProperties, ReactNode } from 'react';

import { TabPanel } from 'shell';
import { ContentHeader } from 'shell';
import { TabControl } from 'shell';
import type { ViewMenu } from 'shell';
import CanvasPanel from 'shared/tools/pipelines/panels/design/canvas';
import { PrefsProvider, type IPrefsApi } from 'shell';
import type { PrefsStore } from 'shell';
import { AppStateProvider, type IAppStateApi } from 'shell';
import { commonStyles } from 'shell';
import { OAUTH_ROOT_URL } from 'shell';

import { extractPipelineEnvVars } from 'shared/tools/pipelines/panels/design/canvas';
import { SourcePanel } from './panels/development/SourcePanel';
// Direct file imports (not the deploy-panel barrel): the barrel pulls
// DeploymentView, which imports SourcePanel back from this module — file
// paths keep the cross-module reference cycle-free.
import type { TaskEventMessage, TaskEventSession, TaskTimeline } from './panels/development/hooks/useTaskEvents';
import { createLiveEventStore, type LiveEventStore } from './panels/development/hooks/liveEventSession';
import type { ProjectViewMode, ViewState, TaskStatus } from './types';
import { DeployTab } from './panels/deploy';
import type { IPipelineDeploy } from './panels/deploy';
import { TASK_STATE } from './types';


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
	 * page header is a shell-only element and no header renders without it.
	 */
	documentTitle?: string;
	/** Available node service definitions (keyed by provider). */
	servicesJson: Record<string, any>;
	/** Whether the host is connected to the RocketRide server. */
	isConnected: boolean;
	/** Whether a connection is configured to use RocketRide Cloud. */
	cloudConnectionConfigured?: boolean;
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
	/** The editor's PREFERENCES — one value for the user, everywhere: drawer
	 *  widths and the Cloud-prompt dismissal. Per-document state does NOT
	 *  live here; it rides this view's own view state (see docViewState.tsx).
	 *  Absent = preferences do not persist in this host. */
	prefs?: PrefsStore;
	/** Called when the user edits the pipeline in the canvas. */
	onContentChanged?: (project: any) => void;
	/** Called to validate a pipeline. Host returns validation result as a Promise. */
	onValidate?: (pipeline: any) => Promise<any>;
	/**
	 * Fetches the FULL definition (config schema) for one service provider.
	 * The bulk `servicesJson` payload is summary-only, so the canvas requests
	 * definitions on demand through this and caches them. Reject on transient
	 * failure so the canvas can retry; resolve undefined for a genuine miss.
	 */
	getNodeSchema?: (provider: string) => Promise<Record<string, any> | undefined>;
	/** Called for pipeline run/stop/restart actions. Trace level and idle-timeout (TTL) are resolved host-side from the pipeline-builder settings. */
	onPipelineAction?: (action: 'run' | 'stop' | 'restart', source?: string) => void;
	/** Called when view state changes (mode, flowViewMode, viewport). */
	onViewStateChange?: (viewState: ViewState) => void;
	/** Called when the user clicks an external link in the canvas. */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Opens the host's RocketRide Cloud setup flow. */
	onOpenCloudSetup?: () => void;
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
	/** The host's DEPLOY capability — one object, not a dozen loose props
	 *  (appdev's IAppBuilderHost shape). Its PRESENCE enables the Deploy
	 *  tab; omitted, the tab renders the not-available state. */
	deploy?: IPipelineDeploy;
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
	canvasPadding: {
		padding: 2,
		minHeight: 0,
		width: '100%',
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
	} as CSSProperties,
	// Fills the space below the top TabControl strip; TabPanel's
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
	development: 'Development: live monitoring and replay of your dev runs.',
	deploy: 'Deploy: the deployed pipeline (scheduled runs, monitoring, and replay).',
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

/** The prefs key behind the Cloud prompt's "Don't show again". */
const CLOUD_CANVAS_PROMPT_DISMISSED_KEY = 'cloudCanvasPromptDismissed';

const ProjectView: React.FC<IProjectViewProps> = ({ project, documentTitle, servicesJson, isConnected, cloudConnectionConfigured, isSubscribed = true, statusMap, serverHost = '', isDirty = false, isNew = false, initialViewState, prefs, onContentChanged, onValidate, getNodeSchema, onPipelineAction, onViewStateChange, onOpenLink, onOpenCloudSetup, oauth2RootUrl = OAUTH_ROOT_URL, oauthReturnUrl, onOpenExternal, pendingOAuthTokens, clearPendingOAuthTokens, onSave, onExport, isReadonly = false, envKeys, onMissingEnvVars, liveLogEvents = [], openEventStream, fetchTimeline, deploy }) => {
	// --- Local view state (initialized from props, managed locally) -----------

	const [viewState, setViewState] = useState<ViewState>(() => ({
		// Persisted modes from before the environment-page restructure map
		// onto the new strip (old monitoring modes -> DEVELOPMENT).
		mode: migrateViewMode(initialViewState?.mode as string | undefined),
		flowViewMode: initialViewState?.flowViewMode ?? 'pipeline',
		viewport: initialViewState?.viewport,
	}));


	// --- Stable callback refs ------------------------------------------------

	const onViewStateChangeRef = useRef(onViewStateChange);
	onViewStateChangeRef.current = onViewStateChange;

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

	// --- Where-live rows for the DEPLOY page ---------------------------------
	// The host feeds raw deployment facts; THIS view resolves source names
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

	// The workspace's TWO accessors, both handed down as providers below (see
	// the shell's AppStateContext for why there are two).
	//
	// PREFERENCES — one value for the user, everywhere. Drawer widths (via
	// DetailPanel's persistKey) and the Cloud-prompt dismissal. Straight to
	// the host's prefs store: reads are synchronous off the realm's mirrored
	// copy, writes send ONE key to the workspace manager.
	const prefsApi = useMemo<IPrefsApi>(
		() => ({
			getPref: (key) => prefs?.get(key),
			setPref: (key, value) => prefs?.set(key, value),
		}),
		[prefs]
	);
	// Re-render when any realm changes a pref in this partition.
	const [, bumpPrefs] = useState(0);
	useEffect(() => prefs?.subscribe(() => bumpPrefs((n) => n + 1)), [prefs]);

	// APP STATE — the app's own state, scoped to THIS document. The slice is
	// the view state this component already owns and already reports upward;
	// the host persists it (Documents layers per-editor state on appState on
	// the web; the VS Code host writes the same blob keyed by document URI).
	//
	// Reads go through a ref so the accessor keeps a STABLE identity across
	// writes: memoizing on [viewState] would hand FlowPreferences a fresh
	// getter on every toolbar or layout write, re-running its read effect and
	// churning the canvas. The ref always holds the latest state, so
	// reactivity is preserved (viewState lives here and re-renders).
	const viewStateRef = useRef(viewState);
	viewStateRef.current = viewState;
	const appStateApi = useMemo<IAppStateApi>(
		() => ({
			getAppState: (key) => (viewStateRef.current as unknown as Record<string, unknown>)[key],
			setAppState: (key, value) => updateViewState({ [key]: value } as Partial<ViewState>),
		}),
		[updateViewState]
	);

	const [cloudPromptDismissedForActivation, setCloudPromptDismissedForActivation] = useState(false);

	const handleOpenCloudSetup = useCallback(() => {
		setCloudPromptDismissedForActivation(true);
		onOpenCloudSetup?.();
	}, [onOpenCloudSetup]);

	const handleDismissCloudPrompt = useCallback(() => {
		setCloudPromptDismissedForActivation(true);
	}, []);

	const handleDismissCloudPromptForever = useCallback(() => {
		prefsApi.setPref(CLOUD_CANVAS_PROMPT_DISMISSED_KEY, true);
		setCloudPromptDismissedForActivation(true);
	}, [prefsApi]);

	const cloudPromptDismissed = cloudPromptDismissedForActivation || prefsApi.getPref(CLOUD_CANVAS_PROMPT_DISMISSED_KEY) === true;

	// --- Validate callback for CanvasPanel -------------------------------------

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

	// --- Node schema fetch for CanvasPanel -------------------------------------

	const getNodeSchemaRef = useRef(getNodeSchema);
	getNodeSchemaRef.current = getNodeSchema;

	/** Identity-stable wrapper: fetches one provider's full service definition
	    from the host. Rejections propagate — the canvas treats them as retryable. */
	const handleGetNodeSchema = useCallback(async (provider: string): Promise<Record<string, any> | undefined> => {
		if (!getNodeSchemaRef.current) return undefined;
		return await getNodeSchemaRef.current(provider);
	}, []);

	// --- Mode switch ---------------------------------------------------------

	const handleModeChange = useCallback(
		(id: string) => {
			updateViewState({ mode: id as ProjectViewMode });
		},
		[updateViewState]
	);

	// --- CanvasPanel callbacks -------------------------------------------------

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
	// A source's errors/warnings are LIVE facts only while its run is in flight.
	// Once the run ends, each SourcePanel's Errors pane clears its items (the
	// deliberate "dead zone = cleared" rule), so the DEVELOPMENT badge must
	// clear in lockstep — a badge that outlives its pane advertises a problem
	// the user can open the page for but never see (statusMap retains the
	// finished run's final errors). Count issues only for sources whose task is
	// still in an active run state (STARTING..STOPPING); NONE/COMPLETED/CANCELLED
	// contribute nothing, matching what the panes show.
	const isLiveRun = (ts: TaskStatus): boolean => ts.state >= TASK_STATE.STARTING && ts.state <= TASK_STATE.STOPPING;
	const totalErrors = Object.values(statusMap).reduce((sum, ts) => sum + (isLiveRun(ts) ? (ts.errors?.length ?? 0) : 0), 0);
	const totalWarnings = Object.values(statusMap).reduce((sum, ts) => sum + (isLiveRun(ts) ? (ts.warnings?.length ?? 0) : 0), 0);

	// --- ViewMenu declaration (rendered by this view's own TabControl) ---
	// Strip = DESIGN | DEVELOPMENT | DEPLOY (UI direction v5). The Development
	// entry carries the live error-severity count so problems stay glanceable
	// from any page (the old Errors-entry convention, moved up a level).
	// READONLY hosts (the unknown-task status tabs) get NO Deploy page at
	// all: publishing snapshots a saved FILE, and a status tab has none — a
	// permanently-empty page earns no tab.
	const totalIssues = totalErrors + totalWarnings;
	const viewMenu = useMemo<ViewMenu>(
		() => ({
			entries: [{ id: 'design', label: isReadonly ? 'Design (Readonly)' : 'Design' }, { id: 'development', label: 'Development', ...(totalIssues > 0 ? { count: totalIssues, severity: 'error' as const } : {}) }, ...(isReadonly ? [] : [{ id: 'deploy', label: 'Deploy' }])],
		}),
		[isReadonly, totalIssues]
	);

	// A persisted mode of 'deploy' cannot land on a readonly tab (its page
	// does not exist there) — clamp to the Development page.
	const activeMode: ProjectViewMode = isReadonly && viewState.mode === 'deploy' ? 'development' : viewState.mode;

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
	const handleViewportChange = useCallback(
		(viewport: { x: number; y: number; zoom: number }) => {
			updateViewState({ viewport });
		},
		[updateViewState]
	);

	/**
	 * Wraps a non-canvas page's body in the standard page grammar: the
	 * 24px-gutter tab-content body. Save lives ONLY on the Design page
	 * (inside the canvas) — the monitoring pages carry no document actions.
	 *
	 * @param inner - The page's body content.
	 * @returns The composed panel node.
	 */
	const renderDocPanel = (inner: ReactNode): ReactNode => (
		// The page title is PINNED above the scroll region (rendered once at
		// the view level, not here) — panels carry only their scrolling body.
		<div style={commonStyles.tabContent}>{inner}</div>
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

	// Live-edge fallback: hosts that have not bridged `openEventStream` across
	// their transport (the VS Code webview is one) would otherwise pass a null
	// session, and `useTaskEvents.ingestLive` drops every event — Trace, Errors,
	// Status, Tokens, Flow and Log all render their empty states mid-run with no
	// error anywhere. An in-memory store over the live events the host already
	// delivers keeps those panes working at the live edge. Replay of recorded
	// runs still needs the real stream.
	//
	// One store per stream identity, kept across renders: `SourcePanel` opens
	// the factory more than once (the export walker takes its own view), and all
	// of them must see the same buffer.
	const liveStoresRef = useRef(new Map<string, LiveEventStore>());
	const liveStore = useCallback((key: string): LiveEventStore => {
		const stores = liveStoresRef.current;
		let store = stores.get(key);
		if (!store) {
			store = createLiveEventStore();
			stores.set(key, store);
		}
		return store;
	}, []);

	/** Render the stacked SourcePanels for one continuum. */
	const renderSections = (runKind: 'dev' | 'deploy'): ReactNode => (sources.length > 0 ? sources.map((src) => <SourcePanel key={`${projectId}.${src.id}.${runKind}`} source={src} runKind={runKind} projectId={projectId} liveEvents={runKind === 'dev' ? (liveBySource.get(src.id) ?? []) : []} openSession={openEventStream ? () => openEventStream({ source: src.id, runKind }) : () => liveStore(`${src.id}.${runKind}.${projectId}`).open()} fetchTimeline={fetchTimeline ? () => fetchTimeline({ source: src.id, runKind }) : null} liveTaskStatus={runKind === 'dev' ? statusMap[src.id] : undefined} componentNames={componentNames} isSubscribed={isSubscribed} isReadonly={isReadonly} serverHost={serverHost} onPipelineAction={isReadonly ? undefined : handlePipelineAction} onOpenLink={handleOpenLink} />) : <div style={commonStyles.empty}>No source components found</div>);

	const panels = {
		design: {
			content: (
				<div style={styles.canvasPadding}>
					<PrefsProvider value={prefsApi}>
						<AppStateProvider value={appStateApi}>
						{project && (
							<CanvasPanel
								oauth2RootUrl={oauth2RootUrl}
								oauthReturnUrl={oauthReturnUrl}
								onOpenExternal={onOpenExternal}
								pendingOAuthTokens={pendingOAuthTokens}
								clearPendingOAuthTokens={clearPendingOAuthTokens}
								project={project}
								servicesJson={servicesJson}
								getNodeSchema={getNodeSchema ? handleGetNodeSchema : undefined}
								taskStatuses={statusMap}
								handleValidatePipeline={handleValidate}
								onContentChanged={isReadonly ? undefined : handleContentChanged}
								onViewportChange={handleViewportChange}
								onRunPipeline={isReadonly ? undefined : handleRunPipeline}
								onStopPipeline={isReadonly ? undefined : handleStopPipeline}
								onOpenLink={handleOpenLink}
								onOpenCloudSetup={onOpenCloudSetup ? handleOpenCloudSetup : undefined}
								cloudPromptDismissed={cloudPromptDismissed}
								onDismissCloudPrompt={handleDismissCloudPrompt}
								onDismissCloudPromptForever={handleDismissCloudPromptForever}
								serverHost={serverHost}
								isConnected={isConnected}
								cloudConnectionConfigured={cloudConnectionConfigured}
								isSubscribed={isSubscribed}
								initialViewport={viewState.viewport}
								isDirty={isReadonly ? false : isDirty}
								isNew={isReadonly ? false : isNew}
								onSave={isReadonly ? undefined : handleSave}
								onExport={isReadonly ? undefined : onExport}
								isReadonly={isReadonly}
								envKeys={envKeys}
							/>
						)}
						</AppStateProvider>
					</PrefsProvider>
				</div>
			),
		},
		development: {
			// The dev environment: one self-contained section per source (its
			// own pills, panes, and player over the dev continuum).
			content: renderDocPanel(renderSections('dev')),
		},
		deploy: {
			// The deploy LIFECYCLE surface: version strip, where-live, merged
			// history. Its pipeline-specific adaptation (the readonly guard,
			// the team-deployment row mapping, publish gating from document
			// state) lives in the panel — see panels/deploy.
			content: renderDocPanel(
				<DeployTab
					{...(deploy ? { deploy } : {})}
					sources={sources}
					pipelineName={project?.name ?? ''}
					isReadonly={isReadonly}
					isDirty={isDirty}
					isNew={isNew}
					artifactContext={{ servicesJson, handleValidatePipeline: handleValidate, isConnected, isSubscribed, serverHost, ...(onOpenLink ? { onOpenLink } : {}) }}
				/>
			),
		},
	};

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.container}>
			{/* Page strip — the view renders its own tabs at the very top, above
			    any ContentHeader (the title lives inside each page, below it). */}
			<TabControl menu={viewMenu} activeId={activeMode} onSelect={handleModeChange} />
			{/* Page title, PINNED with the strip — canvas (Design) has none;
			    only the panel bodies below scroll. */}
			{documentTitle && activeMode !== 'design' && <ContentHeader title={documentTitle} subtitle={DOC_SUBVIEW_SUBTITLES[activeMode as DocSubView]} />}
			{/* Page bodies fill the space below the strip. */}
			<div style={styles.pageBody}>
				<TabPanel panels={panels} activeId={activeMode} />
			</div>
		</div>
	);
};

ProjectView.displayName = 'ProjectView';

export default ProjectView;
