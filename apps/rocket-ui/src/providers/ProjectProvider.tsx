// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PROJECT PAGE — pipeline editor view
// =============================================================================
//
// Owns the full lifecycle for a project document view:
//   - Documents library integration (useDocuments for save/dirty)
//   - Save logic (dirty state, SaveDialog, Ctrl+S via tab:save event)
//   - Pipeline run/stop/restart (via RocketRide client)
//   - Server event handling: status updates for the canvas, plus the raw
//     stamped live-event feed + run-log bindings (client.log) that power the
//     Development/Deploy section players
//
// Directly mounts <ProjectView> as a React child — no iframe, no postMessage.
// =============================================================================

import React, { useEffect, useCallback, useMemo, useRef, useState, CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { getClient, useShellConnection, useWorkspace, useSubscriptions, ConnectionManager, ConfirmDialog } from 'shell';
import { getDocs } from '../docs';
import type { PipelineConfig } from 'shell';
// Project module is imported via subpath (not the 'shared' barrel) so the
// canvas bundles into THIS app, not the shell's eager shared chunk.
import { ProjectView, parseServerEvent, isDevLiveEvent } from 'shared/modules/project';
import { registerServiceIcons } from 'shared/components/canvas/util/Icon';
import { foldProjectDeployRuns } from 'shared/modules/sidebar/taskFold';
import type { DeploySnapshot, TeamDeployment } from 'shared/components/deploy-panel';
import type { DeployArtifact } from 'shell';
import { useDeployments } from '../hooks/useDeployments';
import { usePipelineTree } from '../hooks/usePipelineTree';
import { PrefsProvider } from 'shell';
import type { TaskEventMessage, TaskEventSession, TaskStatus, TaskTimeline, TraceLevel, ViewState } from 'shared/modules/project';
import { saveProject, deleteProject, displayName as projectDisplayName } from '../utils/projectStore';
import { downloadJson } from '../utils/downloadFile';
import SaveDialog from '../components/layout/SaveDialog';
import DeploymentProvider from './DeploymentProvider';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Host-side live-event feed cap. The feed only ever grows within a session;
 * past this length it is trimmed to the newest LIVE_EVENTS_KEEP in one cut
 * (a rare, chunky trim — the sections detect the shrink and re-feed their
 * buffers, deduped on seq, so nothing inside their own DVR caps is lost).
 */
const LIVE_EVENTS_MAX = 20000;

/** Post-trim feed length (see {@link LIVE_EVENTS_MAX}). */
const LIVE_EVENTS_KEEP = 10000;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives an HTTP URL from the WebSocket connection URI.
 *
 * @returns The HTTP base URL for the RocketRide server.
 */
function getHttpUrl(): string {
	const wsUri = getClient()?.getConnectionInfo().uri;
	if (!wsUri) return '';
	try {
		const url = new URL(wsUri);
		const proto = url.protocol === 'wss:' ? 'https:' : 'http:';
		const port = url.port || (url.protocol === 'wss:' ? '443' : '80');
		return `${proto}//${url.hostname}:${port}`;
	} catch {
		return '';
	}
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
		flex: 1,
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for ProjectProvider — received from RocketApp's editor content router.
 */
interface ProjectPageProps {
	/** Document URI / file path. */
	uri: string;
	/** Parsed PipelineConfig object. */
	pipeline: PipelineConfig;
	/** Whether the document has unsaved changes. */
	isDirty: boolean;
	/** Whether the document has never been saved to disk. */
	isNew: boolean;
	/** Whether the pipeline should be displayed in read-only mode (e.g. status views for unknown tasks). */
	isReadonly?: boolean;
	/**
	 * Per-editor saved view state (active tab, viewport, flow mode). Typed
	 * `unknown` because it is an untyped persisted blob from the Documents
	 * store; it was originally written from a ProjectView `ViewState`, so it
	 * is narrowed back to that shape where it is handed to ProjectView.
	 */
	initialViewState?: unknown;
	/** Called when the pipeline editor modifies the content. */
	onContentChanged: (updatedPipeline: any) => void;
	/** Called when view state changes (tab switch, viewport pan/zoom). */
	onViewStateChange?: (viewState: Record<string, unknown>) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Pipeline editor view.
 *
 * Receives parsed pipeline data from RocketApp and delegates rendering to
 * the shared ProjectView component.  Handles save logic, pipeline actions
 * (run/stop/restart), and server event parsing.
 *
 * @param props - Project page configuration.
 */
const ProjectProvider: React.FC<ProjectPageProps> = ({ uri, pipeline, isDirty, isNew, isReadonly = false, initialViewState, onContentChanged, onViewStateChange: onViewStateChangeProp }) => {
	const { client, isConnected } = useShellConnection();
	const { prefs, updatePrefs, settings } = useWorkspace();

	// --- Unified settings (effective values incl. manifest defaults) ----------

	// Default trace level for pipelines with no per-editor override
	const settingTraceLevel = (String(settings['rocketride.pipeBuilder.pipelineTraceLevel'] ?? '') || 'full') as TraceLevel;
	// Default idle-timeout in seconds; NaN when unset (then the engine default applies)
	const settingTtl = Number(settings['rocketride.pipeBuilder.pipelineTTL'] ?? NaN);
	// Extra command-line arguments for each task, kept as one raw string — the
	// engine splits it with shell parsing rules so quoted paths survive
	const settingTaskArguments = String(settings['rocketride.pipeBuilder.taskArguments'] ?? '').trim();
	// Full task debug output; adds --trace=debugOut to the task args when enabled
	const settingDebugOutput = settings['rocketride.pipeBuilder.pipelineDebugOutput'] === true;

	// Pipeline Builder is a paywalled app. Running requires an active sub —
	// gate the run controls (lock icon) and the run action on this. Reactive:
	// updates live when the subscription status changes.
	const { getStatus } = useSubscriptions();
	// Memoized so its reference is stable across renders (getStatus only changes
	// when identity.apps changes) — keeps it from ever contributing render churn
	// to the canvas/context subtree.
	const isSubscribed = useMemo(() => {
		const s = getStatus('rocketride.pipeBuilder');
		return s === 'subscribed' || s === 'trialing';
	}, [getStatus]);
	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [envKeys, setEnvKeys] = useState<string[]>([]);
	const [saveDialogOpen, setSaveDialogOpen] = useState(false);
	const [pendingRun, setPendingRun] = useState<{ action: string; source?: string } | null>(null);
	// Ref preserves the run intent across save-as for new files (state is
	// cleared to dismiss the ConfirmDialog, but the ref survives)
	const deferredRunRef = useRef<{ action: string; source?: string } | null>(null);
	const [pipelineError, setPipelineError] = useState<string | null>(null);

	// --- Server event state ---------------------------------------------------
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	// Raw stamped live events (header eventTime + seq) for this project — the
	// sections' DVR buffers and folds feed from this append-only array.
	const [liveLogEvents, setLiveLogEvents] = useState<TaskEventMessage[]>([]);

	// Derived values
	const projectId = pipeline?.project_id ?? '';
	const filename = uri;

	// Existing pipeline paths (with extension) for the SaveDialog's overwrite
	// guard — the hook refreshes itself on connect and on project:saved.
	const { flat: pipelineFlat } = usePipelineTree(client, isConnected);
	const existingPaths = useMemo(() => pipelineFlat.map((entry) => entry.path), [pipelineFlat]);

	// --- Services from the shell's cached catalog -----------------------------

	useEffect(() => {
		if (!isConnected) return;
		// Seed from the shell's summary cache (first access triggers its lazy
		// fetch) and follow refreshes — the shell fetches the catalog once per
		// connection, so opening more canvases issues no services traffic.
		const manager = ConnectionManager.getInstance();
		const cached = manager.getCachedServices();
		if (!cached.servicesError && Object.keys(cached.services).length > 0) {
			// The summary carries the deduplicated icon table — (re)build the
			// icon registry with the same lifecycle as the services list itself.
			registerServiceIcons({ services: cached.services, icons: cached.icons ?? {} });
			setServicesJson(cached.services);
		}
		return manager.on('shell:servicesUpdated', ({ services, icons, servicesError }) => {
			// A failed refresh keeps the last good catalog on the canvas.
			if (servicesError) return;
			registerServiceIcons({ services, icons: icons ?? {} });
			setServicesJson(services);
		});
	}, [isConnected]);

	// --- Environment variable keys (for ${...} autocomplete in config fields) -
	// Mirrors the VS Code host: fetch the saved variable names and feed them to
	// ProjectView, which drives the env-var suggestions in the config widgets.
	// Without this, the web autocomplete list is always empty.

	useEffect(() => {
		if (!client || !isConnected) {
			setEnvKeys([]);
			return;
		}
		const load = () => {
			(client as any).account
				?.getEnvironmentKeys?.()
				.then((keys: string[]) => setEnvKeys(keys ?? []))
				.catch(() => setEnvKeys([]));
		};
		load();
		// Let other views (e.g. the Variables panel) trigger a refresh after the
		// user adds or removes a variable, without reconnecting.
		window.addEventListener('rocketride:envKeysChanged', load);
		return () => window.removeEventListener('rocketride:envKeysChanged', load);
	}, [client, isConnected]);

	// --- Server event subscription --------------------------------------------

	useEffect(() => {
		const pid = pipeline?.project_id;
		if (!pid) return;

		// Subscribe to raw server events: statusMap keeps feeding the canvas
		// (per-node badges + page error counts); the raw stamped envelope is
		// accumulated into liveLogEvents for the ProjectView sections.
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }) => {
			// Host firehose parse is DEV-scoped: deploy events ride this
			// connection whenever a team-scoped subscription is open and must
			// not paint the dev canvas.
			const parsed = parseServerEvent(event, pid, 'dev');
			if (parsed.statusUpdate) {
				setStatusMap((prev) => ({ ...prev, [parsed.statusUpdate!.source]: parsed.statusUpdate!.status }));
			}

			// Accumulate this project's STAMPED task events for the DEV
			// sections. Membership (stamps present + project match + not a
			// deploy run) is the shared classification — deploy events ride
			// this connection whenever a team-scoped subscription is open and
			// must never enter the dev feed.
			const msg = event as TaskEventMessage;
			if (!isDevLiveEvent(msg, pid)) return;
			setLiveLogEvents((prev) => {
				const next = [...prev, msg];
				// Rare chunky trim; sections re-feed (seq-deduped) on shrink.
				return next.length > LIVE_EVENTS_MAX ? next.slice(next.length - LIVE_EVENTS_KEEP) : next;
			});
		});
		return unsub;
	}, [pipeline?.project_id]);

	// --- Clear stale data on reconnect ----------------------------------------

	useEffect(() => {
		if (isConnected) {
			setStatusMap({});
			setLiveLogEvents([]);
		}
	}, [isConnected]);

	// --- Viewport restore on view activation ----------------------------------

	useEffect(() => {
		const unsub = ConnectionManager.getInstance().on('shell:viewActivated', () => {
			window.dispatchEvent(new CustomEvent('canvas:restoreViewport'));
		});
		return unsub;
	}, []);

	// --- Save logic -----------------------------------------------------------

	/**
	 * Saves the pipeline to disk and marks the document clean.
	 *
	 * @param saveFilename - The file path to save to.
	 * @param project      - The pipeline configuration to save.
	 */
	const performSave = useCallback(
		async (saveFilename: string, project: PipelineConfig) => {
			if (!client || !isConnected) return;
			try {
				await saveProject(client, saveFilename, project);
				// Mark clean in Documents model
				await getDocs()?.saveDocument(uri);
				window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId } }));
			} catch (err) {
				console.error('[ProjectProvider] Save failed:', err);
				// Surface the failure — a silent catch leaves the user believing
				// the document was saved.
				setPipelineError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		[client, isConnected, projectId, uri]
	);

	// --- Pipeline run/stop/restart -------------------------------------------

	/**
	 * Opens the subscription checkout (plan picker) for Pipeline Builder.
	 * Uses the app entry from account info when present, else a minimal entry —
	 * the checkout only needs the app id (to fetch prices) plus name/description.
	 */
	const promptSubscribe = useCallback(() => {
		const info: any = getClient()?.getAccountInfo();
		const app = info?.apps?.find((a: any) => a.id === 'rocketride.pipeBuilder') ?? { id: 'rocketride.pipeBuilder', name: 'Pipeline Builder', description: '' };
		ConnectionManager.getInstance().emit('shell:subscribe', { app });
	}, []);

	/**
	 * Executes a pipeline action (run, stop, restart) via the RocketRide client.
	 *
	 * @param action  - The action to perform ('run', 'stop', 'restart').
	 * @param source  - The source component ID to act on.
	 */
	const executePipelineAction = useCallback(
		(action: string, source?: string) => {
			if (!client || !isConnected || !pipeline) return;
			const pid = pipeline.project_id;
			if (!source || !pid) return;

			// Subscription gate (defense-in-depth; the primary gate is in
			// handlePipelineAction). Running/restarting a paywalled pipeline requires
			// an active subscription — prompt checkout instead of executing.
			if ((action === 'run' || action === 'restart') && !isSubscribed) {
				promptSubscribe();
				return;
			}

			if (action === 'run') {
				// Trace level, TTL, task arguments, and debug output all come from the
				// effective pipeline-builder settings (each already carries its manifest
				// default). ttl:0 = no timeout; omitting ttl lets the engine apply its
				// own default.
				const traceLevel = settingTraceLevel;
				const ttl = Number.isFinite(settingTtl) ? settingTtl : undefined;
				// Task args mirror the VSCode host: the raw string is passed as a single
				// entry (the engine shell-splits it), with --trace=debugOut appended when
				// debug output is on and the user hasn't set an explicit --trace.
				const taskArgs: string[] = [];
				if (settingTaskArguments) taskArgs.push(settingTaskArguments);
				if (settingDebugOutput && !settingTaskArguments.includes('--trace=')) taskArgs.push('--trace=debugOut');
				client
					.use({
						pipeline,
						source,
						name: projectDisplayName(filename),
						pipelineTraceLevel: traceLevel,
						...(taskArgs.length > 0 ? { args: taskArgs } : {}),
						...(ttl !== undefined ? { ttl } : {}),
					})
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			} else if (action === 'stop') {
				client
					.getTaskToken({ projectId: pid, source })
					.then((token: string | undefined) => {
						if (token) return client.terminate(token);
					})
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			} else if (action === 'restart') {
				client
					.getTaskToken({ projectId: pid, source })
					.then((token: string | undefined) => client.restart({ token, projectId: pid, source, pipeline }))
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			}
		},
		[client, isConnected, pipeline, filename, isSubscribed, promptSubscribe, settingTraceLevel, settingTtl, settingTaskArguments, settingDebugOutput]
	);

	/**
	 * Initiates save — opens SaveDialog for new documents, or saves directly.
	 */
	const handleSave = useCallback(() => {
		if (!pipeline) return;
		if (isNew) {
			setSaveDialogOpen(true);
			return;
		}
		performSave(filename, pipeline);
	}, [isNew, filename, pipeline, performSave]);

	/**
	 * Exports the current pipeline as a downloaded .pipe file (SaaS-only).
	 */
	const handleExport = useCallback(() => {
		if (!pipeline) return;
		const name = filename.split('/').pop() ?? 'pipeline.pipe';
		downloadJson(name, pipeline);
	}, [filename, pipeline]);

	/**
	 * Handles SaveDialog confirmation with a new file path.
	 *
	 * @param fileRelPath - The chosen file path from the dialog.
	 */
	const handleSaveDialogConfirm = useCallback(
		async (fileRelPath: string) => {
			if (!pipeline || !client || !isConnected) return;
			setSaveDialogOpen(false);

			// Save to the new path
			try {
				await saveProject(client, fileRelPath, pipeline);
			} catch (err) {
				console.error('[ProjectProvider] Save-as failed:', err);
				// Surface the failure — a silent catch leaves the user believing
				// the document was saved.
				setPipelineError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}

			// Close old tab and open the new file so the tab name updates
			const docs = getDocs();
			if (docs) {
				const st = docs.getState();
				const editorIds = Object.entries(st.editors)
					.filter(([, ed]) => ed.documentUri === uri)
					.map(([id]) => id);
				for (const eid of editorIds) docs.closeEditor(eid);
				await docs.openDocument(fileRelPath);
			}

			window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId } }));

			// If there was a deferred run (save-and-run flow), execute it now
			const deferredRun = deferredRunRef.current;
			deferredRunRef.current = null;
			if (deferredRun) {
				executePipelineAction(deferredRun.action, deferredRun.source);
			}
		},
		[pipeline, client, isConnected, uri, projectId, executePipelineAction]
	);

	/**
	 * Handles pipeline action with dirty-save prompt if needed.
	 *
	 * @param action  - The action to perform.
	 * @param source  - The source component ID.
	 */
	const handlePipelineAction = useCallback(
		(action: string, source?: string) => {
			// Not subscribed → prompt checkout (plan picker) instead of running. Gate
			// here, before the dirty-save detour, so the lock always prompts checkout.
			if ((action === 'run' || action === 'restart') && !isSubscribed) {
				promptSubscribe();
				return;
			}
			if (action !== 'run') {
				executePipelineAction(action, source);
				return;
			}
			if (isDirty) {
				setPendingRun({ action, source });
				return;
			}
			executePipelineAction(action, source);
		},
		[isDirty, executePipelineAction, isSubscribed, promptSubscribe]
	);

	/**
	 * Saves the pipeline then runs the pending action.
	 */
	const handleSaveAndRun = useCallback(() => {
		if (!pendingRun || !pipeline) {
			setPendingRun(null);
			return;
		}
		if (isNew) {
			// Stash the run intent in a ref so handleSaveDialogConfirm can
			// trigger it after save-as. Clear state to dismiss the ConfirmDialog.
			deferredRunRef.current = pendingRun;
			setPendingRun(null);
			setSaveDialogOpen(true);
			return;
		}
		const run = pendingRun;
		setPendingRun(null);
		if (!client || !isConnected) return;
		saveProject(client, filename, pipeline)
			.then(() => {
				getDocs()?.saveDocument(uri);
				executePipelineAction(run.action, run.source);
			})
			.catch((err) => setPipelineError(err instanceof Error ? err.message : String(err)));
	}, [pendingRun, isNew, filename, pipeline, client, isConnected, uri, executePipelineAction]);

	// --- ProjectView callbacks ------------------------------------------------

	/**
	 * Called when the ProjectView editor modifies the pipeline content.
	 *
	 * @param updatedProject - The modified PipelineConfig.
	 */
	const handleContentChanged = useCallback(
		(updatedProject: any) => {
			onContentChanged(updatedProject);
		},
		[onContentChanged]
	);

	/**
	 * Validates a pipeline via the RocketRide client.
	 *
	 * @param pipelineToValidate - The pipeline to validate.
	 * @returns Validation result with errors and warnings.
	 */
	const handleValidate = useCallback(async (pipelineToValidate: any): Promise<any> => {
		const c = getClient();
		if (!c) return { errors: [], warnings: [] };
		try {
			return await c.validate({ pipeline: pipelineToValidate });
		} catch {
			return { errors: [], warnings: [] };
		}
	}, []);

	/**
	 * Fetches the FULL definition (config schema) for one service provider.
	 * The bulk services payload is summary-only, so the canvas requests
	 * definitions on demand and caches them. Throws while disconnected so the
	 * canvas treats the request as retryable rather than caching a miss.
	 *
	 * @param provider - The service provider key (e.g. "db_mysql").
	 * @returns The full service definition, or undefined when the server has none.
	 */
	const handleGetNodeSchema = useCallback(async (provider: string): Promise<Record<string, unknown> | undefined> => {
		const c = getClient();
		if (!c) throw new Error('Not connected to server');
		return (await c.getService(provider)) as Record<string, unknown> | undefined;
	}, []);

	/**
	 * Handles opening a link in a webview (currently a no-op in the new model).
	 *
	 * @param url         - The URL to open.
	 * @param displayName - Optional display name for the tab.
	 */
	const handleOpenLink = useCallback((url: string, displayName?: string) => {
		const docs = getDocs();
		if (!docs) return;
		const label = displayName || 'Webview';
		docs.openStaticDocument(`webview:${url}`, label);
	}, []);

	/**
	 * Handles view state changes (canvas scroll, zoom, etc.).
	 *
	 * @param viewState - The updated viewport state.
	 */
	const handleViewStateChange = useCallback(
		(viewState: ViewState) => {
			// Persist view state (tab, viewport) back to the editor instance. The
			// spread re-types the interface as a plain record (interfaces have no
			// implicit index signature) without any casting.
			onViewStateChangeProp?.({ ...viewState });
		},
		[onViewStateChangeProp]
	);

	/**
	 * Handles workspace preference changes from the ProjectView.
	 *
	 * Persists via the workspace context so canvas prefs (per-pipeline idle
	 * timeout, toolbar position, …) survive reloads.
	 *
	 * @param updatedPrefs - The partial preferences to merge.
	 */
	const handlePrefsChange = useCallback(
		(updatedPrefs: Record<string, unknown>) => {
			updatePrefs(updatedPrefs);
		},
		[updatePrefs]
	);

	// --- Run-log bindings (replay + activity timeline) ------------------------

	/**
	 * Stream-bound DVR session factory for the ProjectView sections — wraps
	 * `client.log.openEventStream` with this project's id merged into the
	 * stream ref. The section owns the returned session's lifetime.
	 *
	 * @param stream - Section-supplied source + runKind.
	 * @returns A DVR session over that stream (inert stub before connect).
	 */
	const openEventStream = useCallback(
		(stream: { source: string; runKind: 'dev' | 'deploy' }): TaskEventSession => {
			const c = getClient();
			if (!c || !projectId) {
				// Inert stand-in until the connection exists: satisfies the session
				// surface with no-ops; the section re-creates it after connect.
				return {
					seek: async () => {},
					getStatus: async () => null,
					play: async () => {},
					getTrace: async () => ({ events: [] }),
					pause: () => {},
					ingestLive: () => {},
					closeEventStream: () => {},
				};
			}
			// This view only hosts DEV sections now (deploy monitoring lives on
			// the per-team deployment tab); the scope IS the kind — an unscoped
			// stream ref addresses the caller's own dev continuum.
			return (c as any).log.openEventStream({ projectId, source: stream.source });
		},
		[projectId]
	);

	/**
	 * Stream-bound chapters fetch for the activity timeline — wraps
	 * `client.log.chapters` the same way.
	 *
	 * @param stream - Section-supplied source + runKind.
	 * @returns Chapters, activity spans, and stream timeline metadata.
	 */
	const fetchTimeline = useCallback(
		async (stream: { source: string; runKind: 'dev' | 'deploy' }): Promise<TaskTimeline> => {
			const c = getClient();
			if (!c || !projectId) return { chapters: [], segments: [], horizonSeq: 0, completed: true };
			// Dev continuum: unscoped ref (see openEventStream above).
			return (c as any).log.chapters({ projectId, source: stream.source });
		},
		[projectId]
	);

	// --- Monitor registration -------------------------------------------------

	useEffect(() => {
		const pid = pipeline?.project_id;
		const c = getClient();
		if (!pid || !c || !isConnected) return;

		// Register for the HOST's own needs (status map + canvas). The DVR
		// sessions register their own monitors (all classes) — the wire
		// carries the union and this feed receives it.
		const monitorKey = { projectId: pid, source: '*' };
		const monitorTypes = ['summary', 'flow'];
		c.addMonitor(monitorKey, monitorTypes).catch((err: unknown) => console.error('[ProjectProvider] addMonitor failed:', err));

		return () => {
			c.removeMonitor(monitorKey, monitorTypes).catch((err: unknown) => console.error('[ProjectProvider] removeMonitor failed:', err));
		};
	}, [pipeline?.project_id, isConnected]);

	// --- Deploy lifecycle capabilities (the DEPLOY page) ----------------------
	// ProjectView composes the DeployPanel itself (capability-fed,
	// like SourcePanel); this host supplies the closures + live rows.

	const { deployments, teams: deployTeams, teamName, refresh: refreshDeployments } = useDeployments();

	// LIVE where-live FACTS for this project (team, pointer, state, schedule
	// records) from the shared deployments poll — raw only: ProjectView
	// resolves source names against the pipeline it holds; the panel's
	// registry snapshot is fetched separately.
	// Live deploy-run state per team (the where-live running badges), folded
	// from the connection's task events: the catch-up snapshot seeds it and
	// begin/end flip it — no polling. The '*' task subscription that feeds
	// it is registered below (refcounted with the sidebar's).
	const [deployRunsByTeam, setDeployRunsByTeam] = useState<Record<string, Record<string, boolean>>>({});
	const deployRunsRef = useRef(deployRunsByTeam);
	useEffect(() => {
		deployRunsRef.current = deployRunsByTeam;
	}, [deployRunsByTeam]);

	useEffect(() => {
		const pid = pipeline?.project_id;
		const c = getClient();
		if (!pid || !c || !isConnected) {
			deployRunsRef.current = {};
			setDeployRunsByTeam({});
			return;
		}
		c.addMonitor({ token: '*' }, ['task']).catch((err: unknown) => console.error('[ProjectProvider] task monitor failed:', err));
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: any }) => {
			if (event?.event !== 'apaevt_task' || !event.body) return;
			const folded = foldProjectDeployRuns(event.body, deployRunsRef.current, pid);
			if (folded) {
				deployRunsRef.current = folded;
				setDeployRunsByTeam(folded);
			}
		});
		return () => {
			unsub();
			c.removeMonitor({ token: '*' }, ['task']).catch(() => {});
		};
	}, [pipeline?.project_id, isConnected]);

	const teamDeployments = useMemo<TeamDeployment[]>(
		() =>
			deployments
				.filter((dep) => dep.projectId === projectId && dep.state !== 'removed')
				.map((dep) => {
					const schedules = (dep.schedules ?? {}) as Record<string, { cron?: string; paused?: boolean; ttl?: number; lastRunAt?: number }>;
					return {
						teamId: dep.teamId as string,
						teamName: teamName(dep.teamId as string),
						version: dep.version ?? 0,
						// A record without a state stamp is a live pointer —
						// 'enabled' is the only default inside the vocabulary.
						state: (dep.state ?? 'enabled') as TeamDeployment['state'],
						deployedAt: dep.deployedAt ?? dep.updatedAt ?? 0,
						schedules: Object.fromEntries(Object.entries(schedules).map(([sourceId, sched]) => [sourceId, { cron: sched.cron ?? '', paused: sched.paused === true, ...(sched.ttl ? { ttl: sched.ttl } : {}), ...(sched.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}) }])),
						...(deployRunsByTeam[dep.teamId as string] ? { runningSources: deployRunsByTeam[dep.teamId as string] } : {}),
					};
				}),
		[deployments, projectId, teamName, deployRunsByTeam]
	);

	/** Registry snapshot fetch — the PANEL owns calling and refreshing this. */
	const fetchDeployLifecycle = useCallback(async (): Promise<DeploySnapshot> => {
		// Nothing fetchable — the panel renders its empty states.
		if (!client || !isConnected || !projectId) return { versions: [] };
		const versions = await client.deploy.versions(projectId);
		return {
			versions: ((versions.rows ?? []) as DeployArtifact[]).map((v) => ({
				version: v.version ?? 0,
				sha256: v.sha256 ?? '',
				publishedAt: v.publishedAt ?? 0,
				publishedBy: v.publishedBy?.display || v.publishedBy?.userId || '',
				...(v.comment ? { comment: v.comment } : {}),
			})),
		};
	}, [client, isConnected, projectId]);

	/** Publish the SAVED pipeline (the panel re-fetches its snapshot after). */
	const handleDeployPublish = useCallback(
		async (comment: string, deployTo?: string): Promise<void> => {
			if (!client || !pipeline) throw new Error('Not connected');
			// Snapshot carries a display name: the registry's pipelineName is
			// what every deploy surface renders (names live in filenames here).
			const documentName = projectDisplayName(filename);
			// The spread builds publish()'s required-name shape statically —
			// a truthiness check alone would not narrow the property type.
			const snapshot = { ...pipeline, name: pipeline.name || documentName };
			await client.deploy.publish(snapshot, {
				...(comment ? { comment } : {}),
				...(deployTo ? { deployTo } : {}),
			});
			refreshDeployments();
		},
		[client, pipeline, filename, refreshDeployments]
	);

	/** Point a team at a version (promotion and rollback alike). */
	const handleDeployVersion = useCallback(
		async (version: number, teamId: string): Promise<void> => {
			if (!client) throw new Error('Not connected');
			await client.deploy.deploy(projectId, version, teamId);
			refreshDeployments();
		},
		[client, projectId, refreshDeployments]
	);

	/** Toggle one team deployment's kill switch (where-live state dot). */
	const handleDeploySetDisabled = useCallback(
		async (teamId: string, disabled: boolean): Promise<void> => {
			if (!client) throw new Error('Not connected');
			if (disabled) await client.deploy.disable(projectId, teamId);
			else await client.deploy.enable(projectId, teamId);
			refreshDeployments();
		},
		[client, projectId, refreshDeployments]
	);

	/** Set/clear one source's schedule from the where-live pill editor. */
	const handleDeploySetSchedule = useCallback(
		async (teamId: string, sourceId: string, cron: string | null, ttl: number | null): Promise<void> => {
			if (!client) throw new Error('Not connected');
			await client.deploy.setSchedule(projectId, sourceId, cron, teamId, { ...(ttl !== null ? { ttl } : {}) });
			refreshDeployments();
		},
		[client, projectId, refreshDeployments]
	);

	/** Pause/resume one source's schedule (the editor's footer verb). */
	const handleDeploySetSchedulePaused = useCallback(
		async (teamId: string, sourceId: string, paused: boolean): Promise<void> => {
			if (!client) throw new Error('Not connected');
			if (paused) await client.deploy.pauseSchedule(projectId, sourceId, teamId);
			else await client.deploy.resumeSchedule(projectId, sourceId, teamId);
			refreshDeployments();
		},
		[client, projectId, refreshDeployments]
	);

	/** Fetch one immutable artifact (the version cards' record drawer). */
	const handleDeployFetchArtifact = useCallback(
		async (version: number) => {
			if (!client) throw new Error('Not connected');
			return client.deploy.artifact(projectId, version);
		},
		[client, projectId]
	);

	/** Cron preview via the server's single evaluator (schedule editor). */
	const handleDeployPreviewSchedule = useCallback(
		async (cron: string, count: number) => {
			if (!client) throw new Error('Not connected');
			return client.deploy.preview(cron, count);
		},
		[client]
	);

	// Where-live row / version-badge click → the deployment record drawer.
	// This page OWNS its record panel (the grid-view pattern: the surface
	// that opens a record renders it) — keyed team id, or null when closed.
	const [openDeployment, setOpenDeployment] = useState<{ teamId: string; sourceId?: string } | null>(null);
	/** Opens a deployment record drawer: the TEAM record (no sourceId) or
	    one source's record. */
	const handleOpenDeployment = useCallback((teamId: string, sourceId?: string) => {
		setOpenDeployment({ teamId, ...(sourceId ? { sourceId } : {}) });
	}, []);

	// --- Render --------------------------------------------------------------

	// Workspace-prefs accessor for shared persistence (DetailPanel widths
	// via persistKey). The shell mounts its own PrefsProvider, but this app
	// bundles shared by SUBPATH (its own module instances), so the shell's
	// context object never reaches these components — the provider must be
	// mounted from the SAME bundled instance, here.
	const prefsApi = useMemo(
		() => ({
			getPref: (key: string) => (prefs as Record<string, unknown> | undefined)?.[key],
			setPref: (key: string, value: unknown) => updatePrefs({ [key]: value }),
		}),
		[prefs, updatePrefs]
	);

	return (
		<div style={styles.container}>
			<PrefsProvider value={prefsApi}>
				<ProjectView
					project={pipeline}
					documentTitle={(() => {
						const docState = getDocs()?.getState();
						return (docState ? Object.values(docState.editors).find((editor) => editor.documentUri === uri)?.label : undefined) || projectDisplayName(filename);
					})()}
					{...(isReadonly ? {} : { fetchDeployLifecycle, teamDeployments, deployTeams, onDeployPublish: handleDeployPublish, onDeployVersion: handleDeployVersion, onOpenDeployment: handleOpenDeployment, onDeploySetDisabled: handleDeploySetDisabled, onDeploySetSchedule: handleDeploySetSchedule, onDeploySetSchedulePaused: handleDeploySetSchedulePaused, onDeployPreviewSchedule: handleDeployPreviewSchedule, fetchDeployArtifact: handleDeployFetchArtifact, onSaveDocument: () => performSave(filename, pipeline) })}
					servicesJson={servicesJson}
					isConnected={isConnected}
					isSubscribed={isSubscribed}
					statusMap={statusMap}
					serverHost={getHttpUrl()}
					isDirty={isDirty}
					isNew={isNew}
					isReadonly={isReadonly}
					{...(initialViewState ? { initialViewState: initialViewState as ViewState } : {})}
					initialPrefs={prefs}
					liveLogEvents={liveLogEvents}
					openEventStream={isConnected ? openEventStream : undefined}
					fetchTimeline={fetchTimeline}
					onContentChanged={handleContentChanged}
					onValidate={handleValidate}
					getNodeSchema={handleGetNodeSchema}
					onPipelineAction={handlePipelineAction}
					onViewStateChange={handleViewStateChange}
					onPrefsChange={handlePrefsChange}
					onOpenLink={handleOpenLink}
					onSave={handleSave}
					onExport={handleExport}
					envKeys={envKeys}
				/>
				{/* Deployment record drawer — keyed by identity so switching teams
				    remounts fresh state (React key identity rule). Inside the
				    PrefsProvider so the drawer's width persistence reaches the
				    workspace prefs. */}
				{openDeployment && <DeploymentProvider key={`${openDeployment.teamId}:${openDeployment.sourceId ?? ''}:${projectId}`} teamId={openDeployment.teamId} {...(openDeployment.sourceId ? { sourceId: openDeployment.sourceId } : {})} projectId={projectId} onClose={() => setOpenDeployment(null)} onOpenSource={(sourceId: string) => setOpenDeployment({ teamId: openDeployment.teamId, sourceId })} />}
			</PrefsProvider>
			{saveDialogOpen && <SaveDialog client={client} isConnected={isConnected} existingPaths={existingPaths} onConfirm={handleSaveDialogConfirm} onCancel={() => setSaveDialogOpen(false)} />}
			{pendingRun && <ConfirmDialog title="Unsaved Changes" message="The pipeline has unsaved changes. Save before running?" confirmLabel="Save & Run" cancelLabel="Cancel" onConfirm={handleSaveAndRun} onCancel={() => setPendingRun(null)} />}
			{pipelineError && <ConfirmDialog title="Pipeline Error" message={pipelineError} confirmLabel="OK" onConfirm={() => setPipelineError(null)} onCancel={() => setPipelineError(null)} />}
		</div>
	);
};

export default ProjectProvider;
