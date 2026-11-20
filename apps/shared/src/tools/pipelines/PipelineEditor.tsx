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
import type { EndpointKeyMinter } from './components/pipeline-actions/endpointKey';
import type { OpenToolHandler } from './components/pipeline-actions/PipelineActions';
import { NewPipelineForm } from './components/NewPipelineForm';
import { DeveloperIdBanner } from './components/DeveloperIdBanner';
import type { NewPipelineIdentity } from './components/NewPipelineForm';

import type { IProject } from 'shell';
import { createMirroredPrefsStore, ConnectionManager, PrefsProvider, useAuthUser } from 'shell';
import ProjectView from './ProjectView';
import type { IAssetsHost } from '../../components/assets';
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
import { defaultStoreBlock, registryIdOf } from 'rocketride';

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
	/** Opens a docs URL in the host's browser (node documentation, the
	 *  endpoint modal's links). Never a node's front end: that is `openTool`. */
	openLink(url: string, displayName?: string): void;
	/** Opens a node's front end (plan §3.6): the app `appId` (`rocketride.chat`,
	 *  `rocketride.dropper`, `rocketride.sql`) as the tool document bound to
	 *  the running control's `address` and the node `nodeId` — rocket-ui opens
	 *  `tool:<appId>/<address>/<nodeId>`, VS Code the dev-tool panel. No URL,
	 *  no credential. A host without a tool workbench omits it; the node's
	 *  button is then not shown. */
	openTool?: OpenToolHandler;
	/** Mints the owner's scoped API key for one endpoint address (`task.data`,
	 *  that address, the home team; plan §2.4) — the endpoint modal's Create
	 *  API key. A host that cannot mint keys (OSS) rejects; the modal says so. */
	createEndpointKey?: EndpointKeyMinter;
	/** The org's developer id, '' when none is claimed (plan §2.1). A host
	 *  whose shell identity already carries it may omit this. */
	getDeveloperId?(): Promise<string>;
	/** Claims the org's developer id (org admins); answers the registered id. */
	registerDeveloper?(developerId: string): Promise<string>;
	/** The New Pipeline form's identity (plan §2.1, §9): developer id, create
	 *  target, names in use. A host that offers this shows the form for an
	 *  untitled document that has no pipeline yet. */
	newPipelineIdentity?(): Promise<NewPipelineIdentity>;
	/** Creates `pipelines/<name>/<name>.pipe` with `project_id: <name>` and the
	 *  display name, retires the untitled document and opens the file; a
	 *  rejection carries the validation message and re-enables the form. */
	createPipeline?(name: string, displayName: string, project: unknown): Promise<void>;
	/** Closes the untitled document without creating anything. */
	cancelNew?(): void;
	/**
	 * Reads a UTF-8 text file BESIDE the open pipeline file (`./README.md`,
	 * `./icon.svg`, a README-referenced asset; '/'-separated, relative to the
	 * pipe's folder), resolving null when it does not exist or the path
	 * leaves the folder, and rejecting on any other failure. With the three
	 * ops below it forms the PACKAGE › Assets host ({@link IAssetsHost}); a
	 * host that cannot reach the pipe's folder omits them and the pane says so.
	 */
	readFile?(relPath: string): Promise<string | null>;
	/** An image beside the pipeline file as a `data:` URI; null when missing, not an image, or outside the folder. */
	readImageDataUri?(relPath: string): Promise<string | null>;
	/** Writes a file beside the pipeline file (folders created as needed); rejects outside the folder. */
	writeFile?(relPath: string, data: Uint8Array | string): Promise<void>;
	/** The host's native file picker (an image, or a markdown file); null on cancel. */
	pickFile?(accept: 'image' | 'markdown'): Promise<{ name: string; data: Uint8Array } | null>;
	/** Opens a file beside the pipeline file in the host's text editor. */
	openFile?(relPath: string): Promise<void>;
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
	// The caller's developer id, the first segment of every address (plan §2.2),
	// for the API Params page's call examples. Absent until the org registered one,
	// and in a host without the shell identity context (the examples then show
	// a placeholder).
	const authUser = useAuthUser();
	// The org's developer id: the shell identity carries it where a shell
	// signs the user in (rocket-ui); a host without that context (the VS Code
	// webview) answers it through the host seam. '' = the org has none yet
	// (the onboarding banner), undefined = unknown (no banner either way).
	const [hostDeveloperId, setHostDeveloperId] = useState<string | undefined>(undefined);
	// A lookup that failed (the connection was down) is retried on the next
	// connection status change, so a recovered connection shows the banner.
	const [developerIdLookup, setDeveloperIdLookup] = useState(0);
	useEffect(() => {
		const off = ConnectionManager.getInstance().on('shell:statusChange', () => setDeveloperIdLookup((n) => n + 1));
		return () => {
			off();
		};
	}, []);
	useEffect(() => {
		if (!host.getDeveloperId) return;
		let live = true;
		void host
			.getDeveloperId()
			.then((id) => {
				if (live) setHostDeveloperId(id);
			})
			.catch(() => {
				if (live) setHostDeveloperId(undefined);
			});
		return () => {
			live = false;
		};
	}, [host, developerIdLookup]);
	// A claim made here wins over a shell identity that has not refreshed yet.
	const knownDeveloperId = hostDeveloperId || (authUser?.organization ? (authUser.organization.developerId || '') : hostDeveloperId);
	const developerId = knownDeveloperId || undefined;
	// Who may claim: org admins. Unknown (no shell identity, the VS Code
	// webview) shows the form and lets the server decide.
	const canRegisterDeveloper = authUser?.organization ? authUser.organization.permissions.includes('org.admin') : undefined;
	/** Claim through the host, then show the claimed id at once. */
	const registerDeveloper = useMemo(
		() =>
			host.registerDeveloper
				? async (id: string): Promise<string> => {
						const assigned = await host.registerDeveloper!(id);
						setHostDeveloperId(assigned);
						return assigned;
					}
				: undefined,
		[host]
	);

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
		// The registry name needs the developer id; an invalidation that arrived
		// while it was still unknown was dropped, so an open drawer re-fetches
		// once the name can be matched
		if (developerId && openDeploymentRef.current) scheduleDeploymentRefetch();
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
				if (ev.event === 'apaevt_deploy' && ev.body && ev.body.projectId === registryIdOf(pid, developerId) && (ev.body.teamId === open.teamId || ev.body.action === 'publish')) {
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
	}, [scheduleDeploymentRefetch, developerId]);

	// --- Engine calls on the realm client --------------------------------------

	const handleValidate = useCallback(async (pipeline: any): Promise<any> => {
		// CONTRACT: resolves with an EMPTY result on failure — the canvas has
		// never seen a rejection here.
		try {
			const client = ConnectionManager.getInstance().getClient();
			if (!client) return { errors: [], warnings: [] };
			return await client.validate({ pipeline });
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

	// The drawer's run state is push-driven: the team-scoped task monitor's
	// events trigger the re-fetches. Armed once per opened team, released when
	// the drawer closes, the team changes, or the editor unmounts.
	const openTeamId = openDeployment?.teamId;
	useEffect(() => {
		if (!openTeamId) return;
		const key = { projectId: projectIdRef.current, source: '*', teamId: toWireTeamId(openTeamId) };
		let armed = false;
		const client = ConnectionManager.getInstance().getClient();
		void client?.addMonitor(key, ['task']).then(() => {
			armed = true;
		}).catch(() => {});
		return () => {
			if (!armed) return;
			void ConnectionManager.getInstance().getClient()?.removeMonitor(key, ['task']).catch(() => {});
		};
	}, [openTeamId]);

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

	// --- New Pipeline form (the unbound state) -----------------------------------

	// An untitled document with no pipeline id yet is the NEW PIPELINE form
	// (plan §2.1, §9): the author names the pipeline (its short id) and the host
	// creates the bundle and opens it. The canvas never shows an unnamed pipe.
	const currentProjectId = (project as { project_id?: unknown } | null)?.project_id;
	const showNewForm = host.isNew && !!host.createPipeline && !!host.newPipelineIdentity && (typeof currentProjectId !== 'string' || currentProjectId === '');
	const [newIdentity, setNewIdentity] = useState<NewPipelineIdentity | null>(null);
	const [newIdentityError, setNewIdentityError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	useEffect(() => {
		if (!showNewForm || !host.newPipelineIdentity) return;
		let live = true;
		void host.newPipelineIdentity().then(
			(i) => {
				if (live) setNewIdentity(i);
			},
			(err: unknown) => {
				if (live) setNewIdentityError(err instanceof Error ? err.message : String(err));
			}
		);
		return () => {
			live = false;
		};
	}, [host, showNewForm, developerIdLookup]);
	const handleCreatePipeline = useCallback(
		(name: string, displayName: string) => {
			if (!host.createPipeline) return;
			setCreateError(null);
			setCreating(true);
			// The document's content rides along: an untitled pipeline that
			// already has components keeps them under its new id, and a new
			// pipeline is born LISTABLE: the default store block is stamped here
			// (plan §9) unless the document already carries one. Resolution means
			// the host created the files and moved the document over (this editor
			// goes away); a rejection re-enables the form.
			const base = project && typeof project === 'object' ? (project as Record<string, unknown>) : {};
			const seeded = { ...base, store: base.store ?? defaultStoreBlock() };
			host.createPipeline(name, displayName, seeded).catch((err: unknown) => {
				setCreateError(err instanceof Error ? err.message : String(err));
				setCreating(false);
			});
		},
		[host, project]
	);

	// PACKAGE › Assets needs the four file ops together; a host with only
	// some of them (or none) gets no pane, never a half-working one.
	const { readFile, readImageDataUri, writeFile, pickFile, openFile } = host;
	const assetsHost = useMemo<IAssetsHost | undefined>(
		() =>
			readFile && readImageDataUri && writeFile && pickFile
				? { readFile, readImageDataUri, writeFile, pickFile, ...(openFile ? { openFile } : {}) }
				: undefined,
		[readFile, readImageDataUri, writeFile, pickFile, openFile]
	);

	// --- Render ----------------------------------------------------------------

	const isReadonly = host.isReadonly === true;

	if (showNewForm) {
		if (!newIdentity) {
			return <div style={{ padding: 24, fontSize: 12, color: 'var(--rr-text-secondary)' }}>{newIdentityError ? `Could not load your identity: ${newIdentityError}` : 'Loading…'}</div>;
		}
		return (
			<>
				<DeveloperIdBanner developerId={knownDeveloperId} onRegister={registerDeveloper} canRegister={canRegisterDeveloper} />
				<NewPipelineForm identity={{ ...newIdentity, developerId: knownDeveloperId || newIdentity.developerId }} creating={creating} error={createError} onCreate={handleCreatePipeline} onCancel={() => host.cancelNew?.()} />
			</>
		);
	}

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
				{...(developerId ? { developerId } : {})}
				knownDeveloperId={knownDeveloperId}
				onRegisterDeveloper={registerDeveloper}
				canRegisterDeveloper={canRegisterDeveloper}
				onPipelineAction={host.runAction}
				{...(host.onViewStateChange ? { onViewStateChange: host.onViewStateChange } : {})}
				onOpenLink={host.openLink} onOpenTool={host.openTool} onCreateEndpointKey={host.createEndpointKey}
				{...(host.openCloudSetup ? { onOpenCloudSetup: host.openCloudSetup } : {})}
				{...(host.oauthReturnUrl !== undefined ? { oauthReturnUrl: host.oauthReturnUrl } : {})}
				{...(host.onOpenExternal ? { onOpenExternal: host.onOpenExternal } : {})}
				{...(host.pendingOAuthTokens !== undefined ? { pendingOAuthTokens: host.pendingOAuthTokens } : {})}
				{...(host.clearPendingOAuthTokens ? { clearPendingOAuthTokens: host.clearPendingOAuthTokens } : {})}
				onSave={host.save}
				{...(host.exportDocument ? { onExport: host.exportDocument } : {})}
				{...(assetsHost ? { assetsHost } : {})}
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
