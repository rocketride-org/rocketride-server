// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE EDITOR — the tool's whole editor frame, host-agnostic
// =============================================================================
//
// Everything the pipeline editor does identically in every host lives HERE:
// the services catalog, env-key autocomplete, monitor registration, server
// event folding (status map, live DVR feed, deploy-run badges), validation
// and node schemas, the deploy capability closures and record drawers, the
// run-log DVR sessions, and the editor's preference partition. All of it
// runs on the realm's own client and the bus's generic lanes — which is what
// makes one component possible at all.
//
// What a HOST still owns is the DOCUMENT and its policy, expressed as
// {@link IPipelineEditorHost}: where the bytes live (save/publish snapshot),
// how a run is launched (settings resolution, dirty-save choreography), how
// a subscription is sold, and where links open. VS Code implements it over
// its TextDocument and host.pipeline.* ops; the cloud implements it over the
// Documents store. Neither reimplements anything above.
// =============================================================================

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';

import type { IProject } from 'shell';
import { createMirroredPrefsStore, ConnectionManager, PrefsProvider } from 'shell';
import ProjectView from './ProjectView';
import { parseServerEvent, isDevLiveEvent, isTeamLiveEvent } from './hostEvents';
import { registerServiceIcons } from './panels/design/canvas';
import { foldProjectDeployRuns } from './sidebar/taskFold';
import type { TaskLifecycleEvent } from './sidebar/taskFold';
import type { TaskStatus, ViewState } from './types';
import { PIPELINE_PARTITION } from './types';
import type { TaskEventMessage, TaskEventSession, TaskTimeline } from './panels/development/hooks/useTaskEvents';
import { DeploymentRecordPanel, TeamDeploymentRecordPanel } from './panels/deploy';
import type { DeploySnapshot } from './panels/deploy';
import { fetchDeployLifecycle as fetchLifecycleOp, fetchDeployment as fetchDeploymentOp, deploymentActions, toWireTeamId } from './deploy/deployOps';
import type { DeployTeamRefDTO, TeamDeploymentRowDTO, DeploymentLoadPayload, SchedulePreviewResultDTO } from './deploy/deployTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Live-event feed cap: past this the feed is trimmed to the newest
 * LIVE_EVENTS_KEEP in one cut (the ProjectView sections detect the shrink
 * and re-feed their seq-deduped buffers, so nothing in their DVR caps is
 * lost).
 */
const LIVE_EVENTS_MAX = 20000;

/** Post-trim feed length (see {@link LIVE_EVENTS_MAX}). */
const LIVE_EVENTS_KEEP = 10000;

/** Safety timeout for brokered round-trips so a lost reply never hangs (ms). */
const REQUEST_TIMEOUT_MS = 30000;

/** Coalescing window for push-triggered deployment re-fetches (ms). */
const DEPLOYMENT_REFETCH_COALESCE_MS = 400;

// =============================================================================
// THE HOST SEAM
// =============================================================================

/**
 * What a host contributes to the editor — the document and its policy.
 * Everything else is the shared frame's.
 */
export interface IPipelineEditorHost {
	/** Document display name for the page header (shell hosts; VS Code omits
	 *  it — its editor tab already names the document). */
	documentTitle?: string;
	/** Whether the document has unsaved changes. */
	isDirty: boolean;
	/** Whether the document has never been saved. */
	isNew: boolean;
	/** Read-only surfaces (live-task viewers) hide editing and deploy. */
	isReadonly?: boolean;
	/** Initial view state (mode, flow mode, viewport), where the host
	 *  persists one. */
	initialViewState?: ViewState;
	/** View-state change — the host persists it (editor state, webview
	 *  state, …). */
	onViewStateChange?: (viewState: ViewState) => void;
	/** The canvas edited the pipeline — the host owns the dirty document. */
	onContentChanged: (project: unknown) => void;
	/** Saves the document (the host runs its own save-as/prompt flow). */
	save(): void;
	/** Awaited save for the publish flow — MUST reject on failure so a
	 *  failed save aborts the publish (a host whose publish path saves
	 *  internally resolves immediately). */
	saveDocument(): Promise<void>;
	/** Publishes the SAVED document to the registry. */
	publish(comment: string, deployTo?: string): Promise<void>;
	/** Launches/stops a run — the host resolves settings (trace level, TTL,
	 *  task args) and its own dirty-save choreography. */
	runAction(action: 'run' | 'stop' | 'restart', source?: string): void;
	/** Whether running is paid for; gates run affordances. */
	isSubscribed: boolean;
	/** Opens the host's subscription/checkout flow (the lock icon's click). */
	promptSubscribe(): void;
	/** Opens a link surface for a canvas-requested URL. */
	openLink(url: string, displayName?: string): void;
	/** Exports the pipeline as a download (hosts with a browser context). */
	exportDocument?(): void;
	/** Opens the host's RocketRide Cloud setup flow. */
	openCloudSetup?(): void;
	/** Whether a Cloud connection is configured (the canvas prompt). */
	cloudConnectionConfigured?: boolean;
	/** OAuth broker return URL for the canvas social-login buttons. */
	oauthReturnUrl?: string;
	/** Opens an external URL for the OAuth round-trip. */
	onOpenExternal?(url: string): void;
	/** Tokens produced by a completed OAuth round-trip, one-shot. */
	pendingOAuthTokens?: { tokens: string; state: string };
	/** Consumes {@link pendingOAuthTokens}. */
	clearPendingOAuthTokens?(): void;
	/** The canvas found config fields referencing unset env vars. */
	onMissingEnvVars?(keys: string[]): void;
	/**
	 * Optional env-key push feed. The frame always fetches the realm
	 * client's key list on connect; a host that can see keys CHANGE (the
	 * Variables page saved) delivers fresh lists here. Returns unsubscribe.
	 */
	envKeysFeed?(apply: (keys: string[]) => void): () => void;
}

/** Props for {@link PipelineEditor}. */
export interface IPipelineEditorProps {
	/** The parsed pipeline document (null while loading). */
	project: unknown | null;
	/** The host seam — see {@link IPipelineEditorHost}. */
	host: IPipelineEditorHost;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The pipeline editor frame — ProjectView plus everything around it that is
 * identical in every host. See the file header for the split.
 */
export const PipelineEditor: React.FC<IPipelineEditorProps> = ({ project, host }) => {
	const projectId = (project as { project_id?: string } | null)?.project_id ?? '';

	// --- Framework state off the bus (mirrors + retained topics) --------------

	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [isConnected, setIsConnected] = useState(false);
	const [serverHost, setServerHost] = useState('');
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	// Raw stamped live events (header eventTime + seq) for this project — the
	// ProjectView sections' buffers and folds feed from this append-only array.
	const [liveLogEvents, setLiveLogEvents] = useState<TaskEventMessage[]>([]);
	const [envKeys, setEnvKeys] = useState<string[]>([]);

	const projectIdRef = useRef(projectId);
	useEffect(() => {
		projectIdRef.current = projectId;
	}, [projectId]);

	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		const applyConnection = (): void => {
			const connected = cm.isConnected();
			if (connected) {
				// Stale per-connection facts reset on (re)connect.
				setStatusMap({});
				setLiveLogEvents([]);
			}
			setIsConnected(connected);
			const url = cm.getHttpUrl();
			if (url) setServerHost(url);
		};
		const applyServices = (payload: { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string } | null): void => {
			if (!payload?.services || payload.servicesError) return;
			if (Object.keys(payload.services).length === 0) return;
			registerServiceIcons({ services: payload.services as Record<string, { icon?: string }>, icons: payload.icons ?? {} });
			setServicesJson(payload.services as Record<string, any>);
		};
		applyConnection();
		applyServices(cm.getCachedServices() as { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string } | null);
		const offs = [
			cm.on('shell:statusChange', applyConnection),
			cm.on('shell:servicesUpdated', (payload) => applyServices(payload as { services: Record<string, unknown>; icons?: Record<string, string>; servicesError?: string })),
		];
		return () => offs.forEach((off) => off());
	}, []);

	// --- Env-variable keys (the config widgets' ${...} autocomplete) ----------
	// Always fetched from the realm client on connect; the host's feed pushes
	// CHANGES (a saved Variables page) on top.

	useEffect(() => {
		if (!isConnected) {
			setEnvKeys([]);
			return;
		}
		const client = ConnectionManager.getInstance().getClient();
		client?.account
			.getEnvironmentKeys()
			.then((keys) => setEnvKeys(keys ?? []))
			.catch(() => setEnvKeys([]));
	}, [isConnected]);
	const envKeysFeed = host.envKeysFeed;
	useEffect(() => (envKeysFeed ? envKeysFeed(setEnvKeys) : undefined), [envKeysFeed]);

	// --- Monitoring (realm-owned; the realm client forwards to the broker) ----
	// summary/flow feed the canvas + status map; output/task feed the live
	// log and run-active timeline; the global {token:'*'} pair carries deploy
	// invalidations + ALL visible runs' lifecycle (each registration also
	// triggers the server's catch-up snapshot).
	useEffect(() => {
		if (!projectId) return;
		const cm = ConnectionManager.getInstance();
		const projectKey = { projectId, source: '*' };
		const projectTypes = ['summary', 'flow', 'output', 'task'];
		const globalKey = { token: '*' };
		const globalTypes = ['deploy', 'task'];
		let added = false;
		let disposed = false;
		const add = (): void => {
			const client = cm.getClient();
			if (added || disposed || !cm.isConnected() || !client) return;
			added = true;
			void client.addMonitor(projectKey, projectTypes).catch(() => {
				added = false;
			});
			void client.addMonitor(globalKey, globalTypes).catch(() => {});
		};
		add();
		const off = cm.on('shell:connected', add);
		return () => {
			disposed = true;
			off();
			const client = cm.getClient();
			if (added && client) {
				void client.removeMonitor(projectKey, projectTypes).catch(() => {});
				void client.removeMonitor(globalKey, globalTypes).catch(() => {});
			}
		};
	}, [projectId]);

	// --- Deploy state fed by events -------------------------------------------

	const [deployTeams, setDeployTeams] = useState<DeployTeamRefDTO[]>([]);
	const [teamDeployments, setTeamDeployments] = useState<TeamDeploymentRowDTO[]>([]);

	// Live deploy-run state per team (the where-live running badges), folded
	// from the connection's task events — the catch-up snapshot seeds it;
	// begin/end flip it. Ref advances synchronously for event bursts.
	const [deployRunsByTeam, setDeployRunsByTeam] = useState<Record<string, Record<string, boolean>>>({});
	const deployRunsRef = useRef<Record<string, Record<string, boolean>>>({});

	// Deployment record DRAWER: open team, its fetched record, errors.
	const [openDeployment, setOpenDeployment] = useState<{ teamId: string; sourceId?: string } | null>(null);
	const openDeploymentRef = useRef<{ teamId: string; sourceId?: string } | null>(null);
	useEffect(() => {
		openDeploymentRef.current = openDeployment;
	}, [openDeployment]);
	const [deploymentData, setDeploymentData] = useState<DeploymentLoadPayload | null>(null);
	const [deploymentError, setDeploymentError] = useState('');

	// The open drawer's live feed: this team's stamped deploy-run events,
	// routed into the record's report cards (cleared on drawer switch).
	const [deployLiveEvents, setDeployLiveEvents] = useState<TaskEventMessage[]>([]);
	useEffect(() => {
		setDeployLiveEvents([]);
	}, [openDeployment?.teamId, openDeployment?.sourceId]);

	// --- Server event fold -----------------------------------------------------

	// Declared before the event effect so the fold can schedule re-fetches.
	const deployRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadDeploymentRef = useRef<(teamId: string, sourceId?: string) => void>(() => {});
	const scheduleDeploymentRefetch = useCallback((): void => {
		if (deployRefetchTimer.current) return; // A re-fetch is already pending.
		deployRefetchTimer.current = setTimeout(() => {
			deployRefetchTimer.current = null;
			const open = openDeploymentRef.current;
			if (!open) return;
			loadDeploymentRef.current(open.teamId, open.sourceId);
		}, DEPLOYMENT_REFETCH_COALESCE_MS);
	}, []);
	useEffect(
		() => () => {
			if (deployRefetchTimer.current) clearTimeout(deployRefetchTimer.current);
		},
		[]
	);

	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		return cm.on('shell:event', ({ event }) => {
			const pid = projectIdRef.current;
			// statusMap keeps feeding the canvas (per-node badges + page error
			// counts); the raw stamped envelope goes to the sections. The
			// firehose parse is DEV-scoped: deploy events ride this connection
			// whenever a team-scoped subscription is open.
			const parsed = parseServerEvent(event, pid, 'dev');
			if (parsed.statusUpdate) {
				setStatusMap((prev) => ({ ...prev, [parsed.statusUpdate!.source]: parsed.statusUpdate!.status }));
			}

			// Accumulate this project's STAMPED task events for the DEV
			// sections. Membership (stamps present + project match + not a
			// deploy run) is the shared classification.
			const raw = event as unknown as TaskEventMessage;
			if (isDevLiveEvent(raw, pid)) {
				setLiveLogEvents((prev) => {
					const next = [...prev, raw];
					// Rare chunky trim; sections re-feed (seq-deduped) on shrink.
					return next.length > LIVE_EVENTS_MAX ? next.slice(next.length - LIVE_EVENTS_KEEP) : next;
				});
			}

			// Where-live running badges: fold every deploy-run lifecycle event
			// for THIS project into the per-team run map.
			if (raw?.event === 'apaevt_task' && raw.body) {
				const foldedRuns = foldProjectDeployRuns(raw.body as TaskLifecycleEvent, deployRunsRef.current, pid);
				if (foldedRuns) {
					deployRunsRef.current = foldedRuns;
					setDeployRunsByTeam(foldedRuns);
				}
			}

			// Deployment drawer push wiring: invalidations and this team's task
			// lifecycle events schedule a coalesced record re-fetch, and the
			// team's stamped events feed the record's live report cards.
			const open = openDeploymentRef.current;
			const ev = raw as { event?: string; body?: { projectId?: string; teamId?: string; action?: string; runKind?: string } };
			if (open) {
				if (ev.event === 'apaevt_deploy' && ev.body?.projectId === pid && (ev.body.teamId === open.teamId || ev.body.action === 'publish')) {
					scheduleDeploymentRefetch();
				} else if (ev.event === 'apaevt_task' && ev.body?.runKind === 'deploy' && ev.body.teamId === open.teamId) {
					scheduleDeploymentRefetch();
				}
				if (isTeamLiveEvent(raw, pid, open.teamId)) {
					setDeployLiveEvents((prev) => {
						const next = [...prev, raw];
						return next.length > LIVE_EVENTS_MAX ? next.slice(next.length - LIVE_EVENTS_KEEP) : next;
					});
				}
			}
		});
	}, [scheduleDeploymentRefetch]);

	// --- Engine calls on the realm client --------------------------------------

	const handleValidate = useCallback(async (pipeline: any): Promise<any> => {
		// CONTRACT: resolves with an EMPTY result on failure — the canvas has
		// never seen a rejection here.
		try {
			const client = ConnectionManager.getInstance().getClient();
			if (!client) return { errors: [], warnings: [] };
			return await client.validate(pipeline);
		} catch {
			return { errors: [], warnings: [] };
		}
	}, []);

	/** On-demand full service definition (the bulk payload is summary-only).
	 *  Rejects on error so the canvas treats the request as retryable. */
	const handleGetNodeSchema = useCallback(async (provider: string): Promise<Record<string, any> | undefined> => {
		const client = ConnectionManager.getInstance().getClient();
		if (!client) throw new Error('Not connected to server');
		return (await client.getService(provider)) as Record<string, any> | undefined;
	}, []);

	// --- Run-log DVR (the brokered session family — identical in every realm) --

	const logSessionCounter = useRef(0);

	/** Opens a run-log session: a real {@link TaskEventSession} whose every
	 *  member speaks the client.log.stream* protocol — in-process at a
	 *  framework root, bridged in a webview realm. teamId scopes to a deploy
	 *  continuum. */
	const openLogSession = useCallback((source: string, teamId?: string): TaskEventSession => {
		// Realm-allocated id, globally unique (sessions are brokered at the
		// root by id across every realm).
		const sessionId = `ls_${Math.random().toString(36).slice(2, 10)}_${++logSessionCounter.current}`;
		const cm = ConnectionManager.getInstance();
		// Play items arrive on THIS realm's `log.event.<sessionId>` op —
		// registration is the routing.
		let offEvents: (() => void) | null = null;
		cm.emitOp('client.log.openStream', { sessionId, projectId: projectIdRef.current, source, ...(teamId ? { teamId } : {}) });
		const call = <T,>(method: 'seek' | 'getStatus' | 'getTrace', args: unknown[]): Promise<T> => cm.request('client.log.streamCall', { sessionId, method, args } as never, { timeoutMs: REQUEST_TIMEOUT_MS }) as Promise<T>;
		return {
			seek: (pos) => call<void>('seek', [pos]),
			getStatus: () => call<Record<string, unknown> | null>('getStatus', []),
			getTrace: (traceId) => call<{ events: TaskEventMessage[] }>('getTrace', [traceId]),
			play: (pos, speed, cb) => {
				offEvents?.();
				offEvents = cm.handle(`log.event.${sessionId}`, (item) => cb(item as { event: TaskEventMessage }));
				// LONG-LIVED by contract: the promise resolves at STREAM
				// COMPLETION — give it the maximum timer budget.
				return cm.request('client.log.streamPlay', { sessionId, pos: pos === undefined ? null : pos, speed } as never, { timeoutMs: 0x7fffffff }) as Promise<void>;
			},
			pause: () => cm.emitOp('client.log.streamPause', { sessionId }),
			ingestLive: (message) => cm.emitOp('client.log.streamIngest', { sessionId, event: message }),
			closeEventStream: () => {
				offEvents?.();
				offEvents = null;
				cm.emitOp('client.log.streamClose', { sessionId });
			},
		};
	}, []);

	/** Chapters/timeline fetch for one source (session-independent). */
	const fetchLogTimeline = useCallback((source: string, teamId?: string): Promise<TaskTimeline> => {
		const client = ConnectionManager.getInstance().getClient();
		if (!client) return Promise.reject(new Error('Not connected to server'));
		return client.log.chapters({ projectId: projectIdRef.current, source, ...(teamId ? { teamId } : {}) }) as unknown as Promise<TaskTimeline>;
	}, []);

	/** Dev-continuum DVR session factory for ProjectView's sections. */
	const openEventStream = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => openLogSession(stream.source), [openLogSession]);

	/** Dev-continuum chapters fetch for ProjectView's sections. */
	const fetchTimeline = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => fetchLogTimeline(stream.source), [fetchLogTimeline]);

	// --- Deploy lifecycle (the DEPLOY page) ------------------------------------
	// ProjectView composes the DeployPanel itself (capability-fed); this frame
	// supplies the closures over the realm client's deploy surface.

	/** Registry snapshot fetch (each caller awaits ITS result). Applies the
	 *  LIVE rows as it resolves. */
	const fetchDeployLifecycle = useCallback(async (): Promise<DeploySnapshot> => {
		const snapshot = await fetchLifecycleOp(projectIdRef.current);
		setDeployTeams(snapshot.teams);
		setTeamDeployments(snapshot.deployments);
		return { versions: snapshot.versions };
		// isConnected is a deliberate dep: a reconnect mints a new fetcher
		// identity, which makes the panel re-fetch (its mount effect keys on it).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isConnected]);

	/** Fetch one immutable artifact (the version cards' record drawer). */
	const fetchDeployArtifact = useCallback((version: number): Promise<IProject | undefined> => {
		return deploymentActions.artifact(projectIdRef.current, version).then((artifact) => artifact as unknown as IProject);
	}, []);

	/** Point a team at a version (promotion and rollback alike). */
	const handleDeployVersion = useCallback(
		async (version: number, teamId: string): Promise<void> => {
			await deploymentActions.deployVersion(projectIdRef.current, teamId, version);
			void fetchDeployLifecycle();
		},
		[fetchDeployLifecycle]
	);

	/** Where-live row / version-badge click → a deployment record drawer: the
	 *  TEAM record without a sourceId, one source's record with it. */
	const loadDeployment = useCallback((teamId: string, sourceId?: string): void => {
		// The drawer's run state is push-driven: the team-scoped task monitor's
		// events trigger the re-fetches (brokered refcounts dedupe).
		void ConnectionManager.getInstance().getClient()?.addMonitor({ projectId: projectIdRef.current, source: '*', teamId: toWireTeamId(teamId) }, ['task']).catch(() => {});
		fetchDeploymentOp(projectIdRef.current, teamId, sourceId).then(
			(payload) => {
				// Stale-drawer guard: only the OPEN record's result applies.
				const open = openDeploymentRef.current;
				if (open?.teamId !== teamId || (sourceId ?? null) !== (open?.sourceId ?? null)) return;
				setDeploymentData(payload);
				setDeploymentError('');
			},
			(error: unknown) => {
				const open = openDeploymentRef.current;
				if (open?.teamId !== teamId || (sourceId ?? null) !== (open?.sourceId ?? null)) return;
				setDeploymentError(error instanceof Error ? error.message : String(error));
			}
		);
	}, []);
	useEffect(() => {
		loadDeploymentRef.current = loadDeployment;
	}, [loadDeployment]);

	const handleOpenDeployment = useCallback(
		(teamId: string, sourceId?: string): void => {
			setDeploymentData(null);
			setDeploymentError('');
			// Set the ref SYNCHRONOUSLY so a fast fetch cannot lose the guard
			// race against the state effect.
			openDeploymentRef.current = { teamId, ...(sourceId ? { sourceId } : {}) };
			setOpenDeployment({ teamId, ...(sourceId ? { sourceId } : {}) });
			loadDeployment(teamId, sourceId);
		},
		[loadDeployment]
	);

	// --- Preferences (the editor's own partition) -------------------------------

	// The pipeline editor's PREFERENCES — the editor is a built-in tool, so
	// they live in the TOOL's partition, not in whatever app happens to be
	// active. Per-document state does not come through here; it rides the
	// editor's view state, which the host persists.
	const editorPrefs = useMemo(() => createMirroredPrefsStore(ConnectionManager.getInstance(), PIPELINE_PARTITION), []);
	useEffect(() => editorPrefs.dispose, [editorPrefs]);
	// The canvas and the drawers read prefs through context — mounted from
	// THIS bundled module instance so it reaches them in every bundling
	// topology (MF subpath bundles do not share the shell's provider object).
	const prefsApi = useMemo(
		() => ({
			getPref: (key: string) => editorPrefs.store.get(key),
			setPref: (key: string, value: unknown) => editorPrefs.store.set(key, value),
		}),
		[editorPrefs]
	);

	// --- Render ----------------------------------------------------------------

	const isReadonly = host.isReadonly === true;

	return (
		<PrefsProvider value={prefsApi}>
			<ProjectView
				project={project}
				{...(host.documentTitle !== undefined ? { documentTitle: host.documentTitle } : {})}
				servicesJson={servicesJson}
				isConnected={isConnected}
				{...(host.cloudConnectionConfigured !== undefined ? { cloudConnectionConfigured: host.cloudConnectionConfigured } : {})}
				isSubscribed={host.isSubscribed}
				statusMap={statusMap}
				serverHost={serverHost}
				isDirty={host.isDirty}
				isNew={host.isNew}
				isReadonly={isReadonly}
				{...(host.initialViewState ? { initialViewState: host.initialViewState } : {})}
				prefs={editorPrefs.store}
				liveLogEvents={liveLogEvents}
				onContentChanged={host.onContentChanged}
				onValidate={handleValidate}
				getNodeSchema={handleGetNodeSchema}
				onPipelineAction={host.runAction}
				{...(host.onViewStateChange ? { onViewStateChange: host.onViewStateChange } : {})}
				onOpenLink={host.openLink}
				{...(host.openCloudSetup ? { onOpenCloudSetup: host.openCloudSetup } : {})}
				{...(host.oauthReturnUrl !== undefined ? { oauthReturnUrl: host.oauthReturnUrl } : {})}
				{...(host.onOpenExternal ? { onOpenExternal: host.onOpenExternal } : {})}
				{...(host.pendingOAuthTokens !== undefined ? { pendingOAuthTokens: host.pendingOAuthTokens } : {})}
				{...(host.clearPendingOAuthTokens ? { clearPendingOAuthTokens: host.clearPendingOAuthTokens } : {})}
				onSave={host.save}
				{...(host.exportDocument ? { onExport: host.exportDocument } : {})}
				envKeys={envKeys}
				{...(host.onMissingEnvVars ? { onMissingEnvVars: host.onMissingEnvVars } : {})}
				openEventStream={isConnected ? openEventStream : undefined}
				fetchTimeline={fetchTimeline}
				{...(!isReadonly && projectId
					? {
							deploy: {
								fetchLifecycle: fetchDeployLifecycle,
								publish: host.publish,
								deployVersion: handleDeployVersion,
								// Where-live rows enriched with the folded run state
								// (the running badges track live without polling).
								teamDeployments: teamDeployments.map((d) => ({ ...d, ...(deployRunsByTeam[d.teamId] ? { runningSources: deployRunsByTeam[d.teamId] } : {}) })),
								teams: deployTeams,
								openDeployment: handleOpenDeployment,
								setDisabled: async (teamId: string, disabled: boolean) => {
									await deploymentActions.setDisabled(projectIdRef.current, teamId, disabled);
									void fetchDeployLifecycle();
								},
								remove: async (teamId: string) => {
									await deploymentActions.remove(projectIdRef.current, teamId);
									void fetchDeployLifecycle();
								},
								setSchedule: async (teamId: string, sourceId: string, cron: string | null, ttl: number | null) => {
									await deploymentActions.setSchedule(projectIdRef.current, teamId, sourceId, cron, ttl);
									void fetchDeployLifecycle();
								},
								setSchedulePaused: async (teamId: string, sourceId: string, paused: boolean) => {
									await deploymentActions.setSchedulePaused(projectIdRef.current, teamId, sourceId, paused);
									void fetchDeployLifecycle();
								},
								previewSchedule: async (cron: string, count: number) => (await deploymentActions.preview(cron, count)) as SchedulePreviewResultDTO,
								fetchArtifact: fetchDeployArtifact,
								saveDocument: host.saveDocument,
							},
						}
					: {})}
			/>
			{/* Deployment record drawer — ONE panel instance across loading →
			    loaded (no width flash); DVR rides the brokered log sessions. */}
			{openDeployment && !openDeployment.sourceId && (
				<TeamDeploymentRecordPanel
					key={`team:${openDeployment.teamId}`}
					open
					onClose={() => setOpenDeployment(null)}
					fallbackTitle={`${deployTeams.find((t) => t.id === openDeployment.teamId)?.name ?? openDeployment.teamId} / ${projectId}`}
					{...(deploymentError ? { loadError: deploymentError } : {})}
					{...(deploymentData
						? {
								data: {
									teamName: deploymentData.teamName,
									deployment: deploymentData.deployment,
									versions: deploymentData.versions,
									history: deploymentData.history,
									schedules: deploymentData.schedules,
									...(deploymentData.nextRuns ? { nextRuns: deploymentData.nextRuns } : {}),
									runningSources: deploymentData.runningSources,
									canControl: deploymentData.canControl,
									isConnected,
									fetchTimeline: (sourceId: string) => fetchLogTimeline(sourceId, openDeployment.teamId),
									onOpenSource: (sourceId: string) => handleOpenDeployment(openDeployment.teamId, sourceId),
									// Verbs ack, then THIS frame re-fetches the record.
									onSetDisabled: async (disabled: boolean) => {
										await deploymentActions.setDisabled(projectIdRef.current, openDeployment.teamId, disabled);
										loadDeployment(openDeployment.teamId);
										void fetchDeployLifecycle();
									},
									onDeployVersion: async (version: number) => {
										await deploymentActions.deployVersion(projectIdRef.current, openDeployment.teamId, version);
										loadDeployment(openDeployment.teamId);
										void fetchDeployLifecycle();
									},
									...(deploymentData.canControl
										? {
												onRemove: async () => {
													await deploymentActions.remove(projectIdRef.current, openDeployment.teamId);
													// The record is gone — the drawer closes itself.
													setOpenDeployment(null);
													void fetchDeployLifecycle();
												},
											}
										: {}),
								},
							}
						: {})}
				/>
			)}
			{openDeployment && openDeployment.sourceId && (
				<DeploymentRecordPanel
					key={`${openDeployment.teamId}:${openDeployment.sourceId}`}
					open
					onClose={() => setOpenDeployment(null)}
					fallbackTitle={`${deployTeams.find((t) => t.id === openDeployment.teamId)?.name ?? openDeployment.teamId} / ${projectId}`}
					{...(deploymentError ? { loadError: deploymentError } : {})}
					{...(deploymentData
						? {
								data: {
									teamName: deploymentData.teamName,
									deployment: deploymentData.deployment,
									pipeline: deploymentData.pipeline as never,
									servicesJson: deploymentData.servicesJson as never,
									handleValidatePipeline: (async (pipelineToValidate: unknown) => {
										try {
											return deploymentActions.validate(pipelineToValidate as Record<string, unknown>);
										} catch {
											return { errors: [], warnings: [] };
										}
									}) as never,
									sourceId: deploymentData.sourceId ?? openDeployment.sourceId,
									...(deploymentData.sourceName ? { sourceName: deploymentData.sourceName } : {}),
									history: deploymentData.history,
									...(deploymentData.nextRun ? { nextRun: deploymentData.nextRun } : {}),
									runningSources: deploymentData.runningSources,
									canControl: deploymentData.canControl,
									isConnected,
									openSession: (sourceId: string) => openLogSession(sourceId, openDeployment.teamId),
									fetchTimeline: (sourceId: string) => fetchLogTimeline(sourceId, openDeployment.teamId),
									liveEvents: deployLiveEvents,
									...(deploymentData.sourcePaused !== undefined ? { sourcePaused: deploymentData.sourcePaused } : {}),
									...(deploymentData.sourceConfig ? { sourceConfig: deploymentData.sourceConfig } : {}),
									// Verbs ack, then THIS frame re-fetches the record.
									onSetSourceConfig: async (traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null, debugOut: boolean) => {
										await deploymentActions.setSourceConfig(projectIdRef.current, openDeployment.teamId, openDeployment.sourceId as string, traceLevel, debugOut);
										loadDeployment(openDeployment.teamId, openDeployment.sourceId);
									},
									onSetSchedulePaused: async (paused: boolean) => {
										await deploymentActions.setSchedulePaused(projectIdRef.current, openDeployment.teamId, openDeployment.sourceId as string, paused);
										loadDeployment(openDeployment.teamId, openDeployment.sourceId);
									},
									onRunSource: async (sourceId) => {
										await deploymentActions.runSource(projectIdRef.current, openDeployment.teamId, sourceId);
										loadDeployment(openDeployment.teamId, openDeployment.sourceId);
									},
									onStopSource: async (sourceId) => {
										await deploymentActions.stopSource(projectIdRef.current, openDeployment.teamId, sourceId);
										loadDeployment(openDeployment.teamId, openDeployment.sourceId);
									},
								},
							}
						: {})}
				/>
			)}
		</PrefsProvider>
	);
};

export default PipelineEditor;
