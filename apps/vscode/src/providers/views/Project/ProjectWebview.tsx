// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProjectWebview — VS Code webview bridge for the pipeline editor.
 *
 * Receives messages from the extension host via useMessaging, manages local
 * state, and renders <ProjectView> with props. User actions from ProjectView
 * flow back as messages to the extension host.
 *
 * Architecture:
 *   ProjectHost (Node.js) ↔ postMessage ↔ ProjectWebview (browser) → ProjectView (pure UI)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import { applyTheme } from 'shell';
import type { IProject, ThemeTokens } from 'shell';
// Project module is imported via subpath (not the 'shared' barrel): the
// barrel is the shell's MF share and must stay canvas-free; this webview
// bundles the project module directly.
import { ProjectView, parseServerEvent, isDevLiveEvent, isTeamLiveEvent } from 'shared/modules/project';
import { registerServiceIcons } from 'shared/components/canvas/util/Icon';
import { foldProjectDeployRuns } from 'shared/modules/sidebar/taskFold';
import type { TaskLifecycleEvent } from 'shared/modules/sidebar/taskFold';
import type { TaskEventMessage, TaskEventSession, TaskStatus, TaskTimeline, ViewState } from 'shared/modules/project';
import { CheckoutModal } from 'shell';
import type { CheckoutPlan, PlanAction } from 'shell';
import { DeploymentRecordPanel, TeamDeploymentRecordPanel } from 'shared/components/deploy-panel';
import type { DeploySnapshot } from 'shared/components/deploy-panel';
import { useMessaging } from '../hooks/useMessaging';
import type { ProjectHostToWebview, ProjectWebviewToHost } from '../../types/projectTypes';
import type { DeployTeamRefDTO, TeamDeploymentRowDTO, DeploymentLoadPayload, SchedulePreviewResultDTO } from '../../types/deployTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Live-event feed cap: past this the feed is trimmed to the newest
 * LIVE_EVENTS_KEEP in one cut (the ProjectView sections detect the shrink
 * and re-feed their seq-deduped buffers, so nothing in their DVR caps is
 * lost). VS Code is live-only v1 — no run-log replay bindings yet.
 */
const LIVE_EVENTS_MAX = 20000;

/** Post-trim feed length (see {@link LIVE_EVENTS_MAX}). */
const LIVE_EVENTS_KEEP = 10000;

/** Safety timeout for deploy host round-trips so a lost reply never hangs (ms). */
const DEPLOY_REQUEST_TIMEOUT_MS = 30000;

/** Coalescing window for push-triggered deployment re-fetches (ms). */
const DEPLOYMENT_REFETCH_COALESCE_MS = 400;

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectWebview: React.FC = () => {
	// --- State (populated from host messages) ---------------------------------

	const [project, setProject] = useState<any>(null);
	const [projectId, setProjectId] = useState<string>('');
	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [isConnected, setIsConnected] = useState(false);
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	// Raw stamped live events (header eventTime + seq) for this project — the
	// ProjectView sections' buffers and folds feed from this append-only array.
	const [liveLogEvents, setLiveLogEvents] = useState<TaskEventMessage[]>([]);
	const [viewState, setViewState] = useState<ViewState | undefined>(undefined);
	const [prefs, setPrefs] = useState<Record<string, unknown> | undefined>(undefined);
	const [serverHost, setServerHost] = useState<string>('');
	const [oauthReturnUrl, setOauthReturnUrl] = useState<string | undefined>(undefined);
	const [pendingOAuthTokens, setPendingOAuthTokens] = useState<{ tokens: string; state: string } | undefined>(undefined);
	const [isDirty, setIsDirty] = useState(false);
	const [isNew, setIsNew] = useState(false);
	const [subscribed, setSubscribed] = useState(true);
	const [isReadonly, setIsReadonly] = useState(false);
	const [showCheckout, setShowCheckout] = useState(false);
	const [envKeys, setEnvKeys] = useState<string[]>([]);
	const [cloudConnectionConfigured, setCloudConnectionConfigured] = useState(false);

	// Deploy lifecycle: LIVE rows pushed by deploy:data (badges/where-live);
	// the panel's registry snapshot resolves through pendingLifecycleFetches.
	const [deployTeams, setDeployTeams] = useState<DeployTeamRefDTO[]>([]);
	const [teamDeployments, setTeamDeployments] = useState<TeamDeploymentRowDTO[]>([]);

	// Live deploy-run state per team (the where-live running badges), folded
	// from relayed task events — the catch-up snapshot on panel open seeds
	// it; begin/end flip it. Ref advances synchronously for event bursts.
	const [deployRunsByTeam, setDeployRunsByTeam] = useState<Record<string, Record<string, boolean>>>({});
	const deployRunsRef = useRef<Record<string, Record<string, boolean>>>({});
	// Outstanding fetchDeployLifecycle promises — deploy:data is the full
	// snapshot (not requestId'd), so ONE push settles every waiter.
	const pendingLifecycleFetches = useRef<Array<{ resolve: (s: DeploySnapshot) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>([]);
	// Pending publish/deploy round-trips keyed by requestId.
	const pendingDeployActions = useRef<Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
	// Pending artifact fetches (the version cards' record drawer) keyed by
	// requestId — value-resolving, unlike the void action acks above.
	const pendingArtifactFetches = useRef<Map<number, { resolve: (pipeline: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
	const deployRequestCounter = useRef(0);

	// Deployment record DRAWER (the Add Node model: a component this webview
	// loads into a DetailPanel): open team, its pushed snapshot, and the
	// requestId-correlated round-trips of the deployment:* protocol.
	const [openDeployment, setOpenDeployment] = useState<{ teamId: string; sourceId?: string } | null>(null);
	const openDeploymentRef = useRef<{ teamId: string; sourceId?: string } | null>(null);
	useEffect(() => {
		openDeploymentRef.current = openDeployment;
	}, [openDeployment]);
	const [deploymentData, setDeploymentData] = useState<DeploymentLoadPayload | null>(null);
	const [deploymentError, setDeploymentError] = useState('');
	const pendingDeploymentRequests = useRef<Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
	const deploymentRequestCounter = useRef(0);

	// Run-log session round-trips (the DVR): pending promises keyed by
	// requestId, live play callbacks keyed by session id — the SAME
	// component-owned shape as every other protocol in this webview.
	const pendingLogRequests = useRef<Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
	const logPlayCallbacks = useRef<Map<string, (item: { event: TaskEventMessage }) => void>>(new Map());
	const logRequestCounter = useRef(0);
	const logSessionCounter = useRef(0);

	// Checkout flow state — populated by host responses to checkout:* messages
	const [checkoutPlans, setCheckoutPlans] = useState<CheckoutPlan[]>([]);
	const [checkoutPlansError, setCheckoutPlansError] = useState<string | null>(null);
	const checkoutResolvers = useRef<{
		plans?: { resolve: (v: CheckoutPlan[]) => void; reject: (e: Error) => void };
		session?: { resolve: (v: { clientSecret: string; subscriptionId: string }) => void; reject: (e: Error) => void };
		confirm?: { resolve: () => void; reject: (e: Error) => void };
	}>({});

	// --- Stable refs for message handler closures ----------------------------

	const projectIdRef = useRef(projectId);
	useEffect(() => {
		projectIdRef.current = projectId;
	}, [projectId]);

	// Pending validate requests (request-ID → Promise resolver)
	const pendingValidates = useRef<Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>>(new Map());
	const validateCounter = useRef(0);

	// Pending node-schema requests (request-ID → Promise resolver)
	const pendingNodeSchemas = useRef<Map<number, { resolve: (v: Record<string, any> | undefined) => void; reject: (e: Error) => void }>>(new Map());
	const nodeSchemaCounter = useRef(0);

	// --- Messaging ------------------------------------------------------------

	const sendMessageRef = useRef<(msg: ProjectWebviewToHost) => void>(() => {});
	const getStateRef = useRef<() => ViewState | null>(() => null);

	const handleMessage = useCallback((msg: ProjectHostToWebview) => {
		switch (msg.type) {
			case 'project:load': {
				// Restore saved webview state if available (survives tab switches)
				const saved = getStateRef.current();
				const vs = saved && Object.keys(saved).length > 0 ? saved : msg.viewState;

				setProject(msg.project);
				setProjectId(msg.project?.project_id ?? '');
				registerServiceIcons({ services: msg.services, icons: msg.icons });
				setServicesJson(msg.services);
				setIsConnected(msg.isConnected);
				if (msg.isSubscribed !== undefined) setSubscribed(msg.isSubscribed);
				setIsReadonly(msg.isReadonly ?? false);
				setStatusMap(msg.statuses ?? {});
				setCloudConnectionConfigured(msg.cloudConnectionConfigured ?? false);
				setViewState({
					mode: vs?.mode ?? 'design',
					flowViewMode: vs?.flowViewMode ?? 'pipeline',
					viewport: vs?.viewport,
				});
				setPrefs(msg.prefs ?? {});
				setLiveLogEvents([]);
				if (msg.serverHost) setServerHost(msg.serverHost);
				// Unconditional: a load without a return URL must clear any stale
				// one, and a reload must not keep tokens from a previous session.
				setOauthReturnUrl(msg.oauthReturnUrl);
				setPendingOAuthTokens(undefined);
				setEnvKeys(msg.envKeys ?? []);
				break;
			}
			case 'project:oauthTokens':
				setPendingOAuthTokens({ tokens: msg.tokens, state: msg.state });
				break;
			case 'shell:init':
				if (msg.theme) applyTheme(msg.theme as ThemeTokens);
				setIsConnected(msg.isConnected);
				sendMessageRef.current({ type: 'view:initialized' });
				break;
			case 'shell:themeChange':
				applyTheme(msg.tokens as ThemeTokens);
				break;
			case 'project:update':
				setProject(msg.project);
				break;
			case 'project:services':
				registerServiceIcons({ services: msg.services, icons: msg.icons });
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
			case 'project:nodeSchemaResponse': {
				const pending = pendingNodeSchemas.current.get(msg.requestId);
				if (pending) {
					pendingNodeSchemas.current.delete(msg.requestId);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve(msg.service);
				}
				break;
			}
			case 'shell:event': {
				const pid = projectIdRef.current;
				// statusMap keeps feeding the canvas (per-node badges + page
				// error counts); the raw stamped envelope goes to the sections.
				// The firehose parse is DEV-scoped: deploy events ride this
				// connection whenever a team-scoped subscription is open.
				const parsed = parseServerEvent(msg.event, pid, 'dev');
				if (parsed.statusUpdate) {
					setStatusMap((prev) => ({ ...prev, [parsed.statusUpdate!.source]: parsed.statusUpdate!.status }));
				}

				// Accumulate this project's STAMPED task events for the DEV
				// sections. Membership (stamps present + project match + not
				// a deploy run) is the shared classification — deploy events
				// ride this connection whenever a team-scoped subscription is
				// open and must never enter the dev feed.
				const raw = msg.event as TaskEventMessage;
				if (isDevLiveEvent(raw, pid)) {
					setLiveLogEvents((prev) => {
						const next = [...prev, raw];
						// Rare chunky trim; sections re-feed (seq-deduped) on shrink.
						return next.length > LIVE_EVENTS_MAX ? next.slice(next.length - LIVE_EVENTS_KEEP) : next;
					});
				}

				// Where-live running badges: fold every deploy-run lifecycle
				// event for THIS project into the per-team run map.
				if (raw?.event === 'apaevt_task' && raw.body) {
					const foldedRuns = foldProjectDeployRuns(raw.body as TaskLifecycleEvent, deployRunsRef.current, pid);
					if (foldedRuns) {
						deployRunsRef.current = foldedRuns;
						setDeployRunsByTeam(foldedRuns);
					}
				}

				// Deployment drawer push wiring: invalidations and this team's
				// task lifecycle events schedule a coalesced record re-fetch
				// (replacing the old poll), and the team's stamped events feed
				// the record's live report cards.
				{
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
				}
				break;
			}
			case 'project:envKeysUpdate':
				setEnvKeys(msg.envKeys);
				break;
			case 'project:cloudConnectionConfigured':
				setCloudConnectionConfigured(msg.cloudConnectionConfigured);
				break;
			case 'shell:connectionChange':
				if (msg.isConnected) {
					setStatusMap({});
					setLiveLogEvents([]);
				}
				setIsConnected(msg.isConnected);
				if ((msg as any).isSubscribed !== undefined) setSubscribed((msg as any).isSubscribed);
				if (msg.serverHost) setServerHost(msg.serverHost);
				break;
			case 'checkout:required':
				// Host says subscription is required — show inline prompt (handled by ProjectView's Subscribe button)
				console.log(`[ProjectWebview] checkout:required received, stripeKey=${!!(typeof process !== 'undefined' && (process.env as any).RR_STRIPE_PUBLISHABLE_KEY)}`);
				setShowCheckout(true);
				break;
			case 'checkout:subscriptionUpdate':
				setSubscribed((msg as any).isSubscribed);
				if ((msg as any).isSubscribed) setShowCheckout(false);
				break;
			case 'checkout:plansResult': {
				const r = checkoutResolvers.current.plans;
				if (r) {
					checkoutResolvers.current.plans = undefined;
					if ((msg as any).error) r.reject(new Error((msg as any).error));
					else r.resolve((msg as any).plans ?? []);
				}
				break;
			}
			case 'checkout:sessionResult': {
				const r = checkoutResolvers.current.session;
				if (r) {
					checkoutResolvers.current.session = undefined;
					if ((msg as any).error) r.reject(new Error((msg as any).error));
					else r.resolve({ clientSecret: (msg as any).clientSecret, subscriptionId: (msg as any).subscriptionId });
				}
				break;
			}
			case 'checkout:confirmResult': {
				const r = checkoutResolvers.current.confirm;
				if (r) {
					checkoutResolvers.current.confirm = undefined;
					if ((msg as any).error) r.reject(new Error((msg as any).error));
					else r.resolve();
				}
				break;
			}
			case 'deploy:data': {
				// LIVE rows for badges/where-live, and the settlement of every
				// outstanding registry-snapshot fetch — one push answers all.
				setDeployTeams(msg.teams);
				setTeamDeployments(msg.deployments);
				const waiting = pendingLifecycleFetches.current;
				pendingLifecycleFetches.current = [];
				for (const waiter of waiting) {
					clearTimeout(waiter.timer);
					waiter.resolve({ versions: msg.versions });
				}
				break;
			}
			case 'deploy:artifactResult': {
				// Settle the pending artifact fetch for this correlation id.
				const pending = pendingArtifactFetches.current.get(msg.requestId);
				if (pending) {
					pendingArtifactFetches.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error || !msg.pipeline) pending.reject(new Error(msg.error || 'Artifact fetch failed'));
					else pending.resolve(msg.pipeline);
				}
				break;
			}
			case 'deploy:actionResult': {
				// Settle the pending publish/deploy promise for this correlation id.
				const pending = pendingDeployActions.current.get(msg.requestId);
				if (pending) {
					pendingDeployActions.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve();
				}
				break;
			}
			case 'deployment:load': {
				// Stale-drawer guard: only the OPEN record's pushes apply
				// (sourceId absent on both sides for the team record).
				if (msg.teamId !== openDeploymentRef.current?.teamId || (msg.sourceId ?? null) !== (openDeploymentRef.current?.sourceId ?? null)) break;
				const { type: _ignored, teamId: _team, ...payload } = msg;
				setDeploymentData(payload as DeploymentLoadPayload);
				setDeploymentError('');
				break;
			}
			case 'deployment:error': {
				// Same record guard as deployment:load — a stale source fetch's
				// error must not land on a different drawer of the same team.
				if (msg.teamId !== openDeploymentRef.current?.teamId || (msg.sourceId ?? null) !== (openDeploymentRef.current?.sourceId ?? null)) break;
				setDeploymentError(msg.error);
				break;
			}
			case 'deployment:actionResult': {
				const pending = pendingDeploymentRequests.current.get(msg.requestId);
				if (pending) {
					pendingDeploymentRequests.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve(undefined);
				}
				break;
			}
			case 'deployment:previewResult': {
				const pending = pendingDeploymentRequests.current.get(msg.requestId);
				if (pending) {
					pendingDeploymentRequests.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve(msg.result);
				}
				break;
			}
			case 'logsession:result': {
				const pending = pendingLogRequests.current.get(msg.requestId);
				if (pending) {
					pendingLogRequests.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve(msg.result);
				}
				break;
			}
			case 'logsession:event':
				logPlayCallbacks.current.get(msg.sessionId)?.(msg.item as { event: TaskEventMessage });
				break;
			case 'deployment:validateResult': {
				const pending = pendingDeploymentRequests.current.get(msg.requestId);
				if (pending) {
					pendingDeploymentRequests.current.delete(msg.requestId);
					clearTimeout(pending.timer);
					pending.resolve(msg.result);
				}
				break;
			}
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
				// Merge: the host broadcasts only the keys that changed, not the whole bag.
				setPrefs((prev) => ({ ...prev, ...(msg.prefs ?? {}) }));
				break;
			case 'project:dirtyState':
				setIsDirty(msg.isDirty);
				setIsNew(msg.isNew);
				break;
		}
	}, []);

	const { sendMessage, getState, setState } = useMessaging<ProjectWebviewToHost, ProjectHostToWebview, ViewState>({
		onMessage: handleMessage,
	});
	useEffect(() => {
		sendMessageRef.current = sendMessage;
	}, [sendMessage]);
	useEffect(() => {
		getStateRef.current = getState;
	}, [getState]);

	// --- ProjectView callbacks → outgoing messages ---------------------------

	const handleContentChanged = useCallback(
		(updatedProject: any) => {
			setProject(updatedProject);
			sendMessage({ type: 'project:contentChanged', project: updatedProject });
		},
		[sendMessage]
	);

	const handleValidate = useCallback(
		async (pipeline: any): Promise<any> => {
			return new Promise((resolve, reject) => {
				const requestId = ++validateCounter.current;
				pendingValidates.current.set(requestId, { resolve, reject });
				sendMessage({ type: 'project:validate', requestId, pipeline });
				// Timeout: resolve with empty result after 15s to avoid hanging
				setTimeout(() => {
					if (pendingValidates.current.has(requestId)) {
						pendingValidates.current.get(requestId)!.resolve({ errors: [], warnings: [] });
						pendingValidates.current.delete(requestId);
					}
				}, 15000);
			});
		},
		[sendMessage]
	);

	/**
	 * Fetches the FULL definition (config schema) for one service provider
	 * from the extension host. The bulk services payload is summary-only, so
	 * the canvas requests definitions on demand and caches them. Rejects on
	 * host error or timeout so the canvas treats the request as retryable.
	 */
	const handleGetNodeSchema = useCallback(
		async (provider: string): Promise<Record<string, any> | undefined> => {
			return new Promise((resolve, reject) => {
				const requestId = ++nodeSchemaCounter.current;
				pendingNodeSchemas.current.set(requestId, { resolve, reject });
				sendMessage({ type: 'project:getNodeSchema', requestId, provider });
				// Timeout: reject after 15s so a lost reply never hangs the canvas
				setTimeout(() => {
					if (pendingNodeSchemas.current.has(requestId)) {
						pendingNodeSchemas.current.delete(requestId);
						reject(new Error(`Node schema request timed out for '${provider}'`));
					}
				}, 15000);
			});
		},
		[sendMessage]
	);

	const handlePipelineAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			sendMessage({ type: 'status:pipelineAction', action, source });
		},
		[sendMessage]
	);

	const handleMissingEnvVars = useCallback(
		(keys: string[]) => {
			sendMessage({ type: 'status:missingEnvVars', keys });
		},
		[sendMessage]
	);

	const handleViewStateChange = useCallback(
		(vs: ViewState) => {
			// Keep local state current so the next run message carries the latest trace level
			setViewState(vs);
			// Persist to VS Code webview state (survives tab switches)
			const current = getState() ?? ({} as ViewState);
			setState({ ...current, ...vs });
			sendMessage({ type: 'project:viewStateChange', viewState: vs });
		},
		[sendMessage, getState, setState]
	);

	const handlePrefsChange = useCallback(
		(updatedPrefs: Record<string, unknown>) => {
			sendMessage({ type: 'project:prefsChange', prefs: updatedPrefs });
		},
		[sendMessage]
	);

	const handleOpenLink = useCallback(
		(url: string, displayName?: string) => {
			sendMessage({ type: 'project:openLink', url, displayName });
		},
		[sendMessage]
	);

	const handleOpenExternal = useCallback(
		(url: string) => {
			sendMessage({ type: 'project:openExternal', url });
		},
		[sendMessage]
	);

	const clearPendingOAuthTokens = useCallback(() => {
		setPendingOAuthTokens(undefined);
	}, []);

	const handleOpenCloudSetup = useCallback(() => {
		sendMessage({ type: 'project:openCloudSetup' });
	}, [sendMessage]);

	const handleSave = useCallback(() => {
		sendMessage({ type: 'project:requestSave' });
	}, [sendMessage]);

	// --- Checkout callbacks (bridge to host via postMessage) ------------------

	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.plans = { resolve, reject };
			sendMessage({ type: 'checkout:fetchPlans' } as any);
		});
	}, [sendMessage]);

	const handleCreateCheckout = useCallback(
		(priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
			return new Promise((resolve, reject) => {
				checkoutResolvers.current.session = { resolve, reject };
				sendMessage({ type: 'checkout:createSession', priceId } as any);
			});
		},
		[sendMessage]
	);

	const handleConfirmPending = useCallback(
		(subscriptionId: string, priceId: string): Promise<void> => {
			return new Promise((resolve, reject) => {
				checkoutResolvers.current.confirm = { resolve, reject };
				sendMessage({ type: 'checkout:confirmPending', subscriptionId, priceId } as any);
			});
		},
		[sendMessage]
	);

	const handleCheckoutSuccess = useCallback(() => {
		setShowCheckout(false);
		setSubscribed(true);
	}, []);

	// --- Deploy lifecycle capabilities (the DEPLOY page) ----------------------
	// ProjectView composes the DeployPanel itself (capability-fed);
	// this webview supplies the closures over the deploy:* message protocol.

	/** Registry snapshot fetch — posts deploy:fetch; the next deploy:data
	    push settles it (and every other outstanding waiter). */
	const fetchDeployLifecycle = useCallback((): Promise<DeploySnapshot> => {
		return new Promise<DeploySnapshot>((resolve, reject) => {
			// A lost reply rejects — the panel keeps its last-known data.
			const timer = setTimeout(() => {
				const at = pendingLifecycleFetches.current.findIndex((waiter) => waiter.resolve === resolve);
				if (at >= 0) {
					pendingLifecycleFetches.current.splice(at, 1);
					reject(new Error('The server did not respond in time'));
				}
			}, DEPLOY_REQUEST_TIMEOUT_MS);
			pendingLifecycleFetches.current.push({ resolve, reject, timer });
			sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
		});
		// isConnected is a deliberate dep: a reconnect mints a new fetcher
		// identity, which makes the panel re-fetch (its mount effect keys on it).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isConnected]);

	/** One requestId-correlated deploy action settled by deploy:actionResult. */
	const deployRequest = useCallback((build: (requestId: number) => ProjectWebviewToHost): Promise<void> => {
		return new Promise<void>((resolve, reject) => {
			// Step 1: allocate the correlation id and arm the timeout guard.
			const requestId = ++deployRequestCounter.current;
			const timer = setTimeout(() => {
				if (pendingDeployActions.current.has(requestId)) {
					pendingDeployActions.current.delete(requestId);
					reject(new Error('The server did not respond in time'));
				}
			}, DEPLOY_REQUEST_TIMEOUT_MS);
			// Step 2: register the resolver and post the message.
			pendingDeployActions.current.set(requestId, { resolve, reject, timer });
			sendMessageRef.current(build(requestId));
		});
	}, []);

	/** Fetch one immutable artifact (the version cards' record drawer). */
	const fetchDeployArtifact = useCallback((version: number): Promise<IProject | undefined> => {
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			// Step 1: allocate the correlation id and arm the timeout guard.
			const requestId = ++deployRequestCounter.current;
			const timer = setTimeout(() => {
				if (pendingArtifactFetches.current.has(requestId)) {
					pendingArtifactFetches.current.delete(requestId);
					reject(new Error('The server did not respond in time'));
				}
			}, DEPLOY_REQUEST_TIMEOUT_MS);
			// Step 2: register the resolver and post the message.
			pendingArtifactFetches.current.set(requestId, { resolve, reject, timer });
			sendMessageRef.current({ type: 'deploy:artifact', requestId, projectId: projectIdRef.current, version });
			// The registry stores the saved pipeline document verbatim, so the
			// raw artifact record IS the IProject the record drawer renders.
		}).then((artifact) => artifact as unknown as IProject);
	}, []);

	/** Publish the SAVED document (the host snapshots it; only metadata travels). */
	const handleDeployPublish = useCallback(
		async (comment: string, deployTo?: string): Promise<void> => {
			await deployRequest((requestId) => ({ type: 'deploy:publish', requestId, comment, ...(deployTo ? { deployTo } : {}) }));
		},
		[deployRequest]
	);

	/** Point a team at a version (promotion and rollback alike). */
	const handleDeployVersion = useCallback(
		async (version: number, teamId: string): Promise<void> => {
			await deployRequest((requestId) => ({ type: 'deploy:deploy', requestId, projectId: projectIdRef.current, version, teamId }));
		},
		[deployRequest]
	);

	/** Where-live / version-badge click → a deployment record drawer (this
	    webview owns its record panels, the grid-view pattern): the TEAM
	    record without a sourceId, one source's record with it. */
	const handleOpenDeployment = useCallback((teamId: string, sourceId?: string): void => {
		setDeploymentData(null);
		setDeploymentError('');
		setOpenDeployment({ teamId, ...(sourceId ? { sourceId } : {}) });
		sendMessageRef.current({ type: 'deployment:fetch', teamId, ...(sourceId ? { sourceId } : {}) });
	}, []);

	// The open drawer refreshes on PUSH, not on a cadence: apaevt_deploy
	// invalidations and this team's task lifecycle events (relayed through
	// shell:event, see the message handler) schedule a coalesced re-fetch.
	const deployRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scheduleDeploymentRefetch = useCallback((): void => {
		if (deployRefetchTimer.current) return; // A re-fetch is already pending.
		deployRefetchTimer.current = setTimeout(() => {
			deployRefetchTimer.current = null;
			const open = openDeploymentRef.current;
			if (!open) return;
			sendMessageRef.current({ type: 'deployment:fetch', teamId: open.teamId, ...(open.sourceId ? { sourceId: open.sourceId } : {}) });
		}, DEPLOYMENT_REFETCH_COALESCE_MS);
	}, []);
	useEffect(
		() => () => {
			if (deployRefetchTimer.current) clearTimeout(deployRefetchTimer.current);
		},
		[]
	);

	// The open drawer's live feed: this team's stamped deploy-run events,
	// routed into the record's report cards (cleared on drawer switch).
	const [deployLiveEvents, setDeployLiveEvents] = useState<TaskEventMessage[]>([]);
	useEffect(() => {
		setDeployLiveEvents([]);
	}, [openDeployment?.teamId, openDeployment?.sourceId]);

	/** One requestId-correlated deployment round-trip (actionResult /
	    previewResult / validateResult settle it; lost replies time out). */
	const deploymentRequest = useCallback((build: (requestId: number) => ProjectWebviewToHost): Promise<unknown> => {
		return new Promise<unknown>((resolve, reject) => {
			const requestId = ++deploymentRequestCounter.current;
			const timer = setTimeout(() => {
				if (pendingDeploymentRequests.current.has(requestId)) {
					pendingDeploymentRequests.current.delete(requestId);
					reject(new Error('The server did not respond in time'));
				}
			}, DEPLOY_REQUEST_TIMEOUT_MS);
			pendingDeploymentRequests.current.set(requestId, { resolve, reject, timer });
			sendMessageRef.current(build(requestId));
		});
	}, []);

	/** The provider owns the TextDocument; deploy:publish saves host-side —
	    the panel just needs a resolvable save step for its flow. */
	const handleDeploySaveDocument = useCallback(async (): Promise<void> => {}, []);

	// --- Run-log DVR bindings (logsession:* — identical contract to cloud) ----

	/** One requestId-correlated log-session round-trip (logsession:result
	    settles it; lost replies time out — the standard shape). */
	const logRequest = useCallback((build: (requestId: number) => ProjectWebviewToHost): Promise<unknown> => {
		return new Promise<unknown>((resolve, reject) => {
			const requestId = ++logRequestCounter.current;
			const timer = setTimeout(() => {
				if (pendingLogRequests.current.has(requestId)) {
					pendingLogRequests.current.delete(requestId);
					reject(new Error('The server did not respond in time'));
				}
			}, DEPLOY_REQUEST_TIMEOUT_MS);
			pendingLogRequests.current.set(requestId, { resolve, reject, timer });
			sendMessageRef.current(build(requestId));
		});
	}, []);

	/** Opens a run-log session: a real {@link TaskEventSession} whose every
	    member speaks the logsession:* protocol — the components cannot tell
	    which transport is underneath. teamId scopes to a deploy continuum. */
	const openLogSession = useCallback(
		(source: string, teamId?: string): TaskEventSession => {
			const sessionId = `ls_${++logSessionCounter.current}`;
			sendMessageRef.current({ type: 'logsession:open', sessionId, source, ...(teamId ? { teamId } : {}) });
			return {
				seek: (pos) => logRequest((requestId) => ({ type: 'logsession:call', sessionId, requestId, method: 'seek', args: [pos] })) as Promise<void>,
				getStatus: () => logRequest((requestId) => ({ type: 'logsession:call', sessionId, requestId, method: 'getStatus', args: [] })) as Promise<Record<string, unknown> | null>,
				getTrace: (traceId) => logRequest((requestId) => ({ type: 'logsession:call', sessionId, requestId, method: 'getTrace', args: [traceId] })) as Promise<{ events: TaskEventMessage[] }>,
				play: (pos, speed, cb) => {
					// Register the delivery sink FIRST — items may arrive
					// before the ack settles.
					logPlayCallbacks.current.set(sessionId, cb);
					return logRequest((requestId) => ({ type: 'logsession:play', sessionId, requestId, pos: pos === undefined ? null : pos, speed })) as Promise<void>;
				},
				pause: () => {
					sendMessageRef.current({ type: 'logsession:pause', sessionId });
				},
				// The dev page's hook feeds live events for near-live merging.
				ingestLive: (message) => {
					sendMessageRef.current({ type: 'logsession:ingest', sessionId, event: message });
				},
				closeEventStream: () => {
					logPlayCallbacks.current.delete(sessionId);
					sendMessageRef.current({ type: 'logsession:close', sessionId });
				},
			};
		},
		[logRequest]
	);

	/** Chapters/timeline fetch for one source (session-independent). */
	const fetchLogTimeline = useCallback((source: string, teamId?: string): Promise<TaskTimeline> => logRequest((requestId) => ({ type: 'logsession:chapters', requestId, source, ...(teamId ? { teamId } : {}) })) as Promise<TaskTimeline>, [logRequest]);

	/** Dev-continuum DVR session factory for ProjectView's sections. */
	const openEventStream = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => openLogSession(stream.source), [openLogSession]);

	/** Dev-continuum chapters fetch for ProjectView's sections. */
	const fetchTimeline = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => fetchLogTimeline(stream.source), [fetchLogTimeline]);

	// --- Wait for initial state from host before rendering -------------------

	if (!viewState || !prefs) return null;

	// --- Render --------------------------------------------------------------

	const stripeKey = process.env.RR_STRIPE_PUBLISHABLE_KEY || '';

	return (
		<>
			<ProjectView
				project={project}
				servicesJson={servicesJson}
				isConnected={isConnected}
				cloudConnectionConfigured={cloudConnectionConfigured}
				isSubscribed={subscribed}
				statusMap={statusMap}
				serverHost={serverHost}
				isDirty={isDirty}
				isNew={isNew}
				initialViewState={viewState}
				initialPrefs={prefs}
				liveLogEvents={liveLogEvents}
				onContentChanged={handleContentChanged}
				onValidate={handleValidate}
				getNodeSchema={handleGetNodeSchema}
				onPipelineAction={handlePipelineAction}
				onViewStateChange={handleViewStateChange}
				onPrefsChange={handlePrefsChange}
				onOpenLink={handleOpenLink}
				onOpenCloudSetup={handleOpenCloudSetup}
				oauthReturnUrl={oauthReturnUrl}
				onOpenExternal={handleOpenExternal}
				pendingOAuthTokens={pendingOAuthTokens}
				clearPendingOAuthTokens={clearPendingOAuthTokens}
				onSave={handleSave}
				isReadonly={isReadonly}
				envKeys={envKeys}
				onMissingEnvVars={handleMissingEnvVars}
				openEventStream={isConnected ? openEventStream : undefined}
				fetchTimeline={fetchTimeline}
				{...(!isReadonly && projectId
					? {
							fetchDeployLifecycle,
							// Where-live rows enriched with the folded run state
							// (the running badges track live without polling).
							teamDeployments: teamDeployments.map((d) => ({ ...d, ...(deployRunsByTeam[d.teamId] ? { runningSources: deployRunsByTeam[d.teamId] } : {}) })),
							deployTeams,
							onDeployPublish: handleDeployPublish,
							onDeployVersion: handleDeployVersion,
							onOpenDeployment: handleOpenDeployment,
							// Where-live interactions ride the SAME deployment:* protocol
							// as the record drawer (teamId is on every message); the rows
							// refresh via deploy:fetch once the mutation resolves.
							onDeploySetDisabled: async (teamId: string, disabled: boolean) => {
								await deploymentRequest((requestId) => ({ type: 'deployment:setDisabled', teamId, requestId, disabled }));
								sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
							},
							onDeploySetSchedule: async (teamId: string, sourceId: string, cron: string | null, ttl: number | null) => {
								await deploymentRequest((requestId) => ({ type: 'deployment:setSchedule', teamId, requestId, sourceId, cron, ttl }));
								sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
							},
							onDeploySetSchedulePaused: async (teamId: string, sourceId: string, paused: boolean) => {
								await deploymentRequest((requestId) => ({ type: 'deployment:setSchedulePaused', teamId, requestId, sourceId, paused }));
								sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
							},
							onDeployPreviewSchedule: async (cron: string, count: number) => (await deploymentRequest((requestId) => ({ type: 'deployment:preview', teamId: '', requestId, cron, count }))) as SchedulePreviewResultDTO,
							fetchDeployArtifact,
							onSaveDocument: handleDeploySaveDocument,
						}
					: {})}
			/>
			{/* Deployment record drawer — a component this webview loads into
			    the DetailPanel (Add Node model). ONE panel instance across
			    loading -> loaded (no width flash). DVR rides the run-log
			    session bridge — identical contract to cloud. */}
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
									// Verbs ack, then THIS webview re-fetches the record.
									onSetDisabled: async (disabled: boolean) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:setDisabled', teamId: openDeployment.teamId, requestId, disabled }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId });
										sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
									},
									onDeployVersion: async (version: number) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:deployVersion', teamId: openDeployment.teamId, requestId, version }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId });
										sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
									},
									...(deploymentData.canControl
										? {
												onRemove: async () => {
													await deploymentRequest((requestId) => ({ type: 'deployment:remove', teamId: openDeployment.teamId, requestId }));
													// The record is gone — the drawer closes itself.
													setOpenDeployment(null);
													sendMessageRef.current({ type: 'deploy:fetch', projectId: projectIdRef.current });
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
											return (await deploymentRequest((requestId) => ({ type: 'deployment:validate', teamId: openDeployment.teamId, requestId, pipeline: pipelineToValidate }))) as { errors: unknown[]; warnings: unknown[] };
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
									// Verbs ack, then THIS webview re-fetches the record
									// (host refresh died with the source-scoped payload).
									...(deploymentData.sourcePaused !== undefined ? { sourcePaused: deploymentData.sourcePaused } : {}),
									...(deploymentData.sourceConfig ? { sourceConfig: deploymentData.sourceConfig } : {}),
									onSetSourceConfig: async (traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null, debugOut: boolean) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:setSourceConfig', teamId: openDeployment.teamId, requestId, sourceId: openDeployment.sourceId as string, traceLevel, debugOut }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId, sourceId: openDeployment.sourceId });
									},
									onSetSchedulePaused: async (paused: boolean) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:setSchedulePaused', teamId: openDeployment.teamId, requestId, sourceId: openDeployment.sourceId as string, paused }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId, sourceId: openDeployment.sourceId });
									},
									onRunSource: async (sourceId) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:runSource', teamId: openDeployment.teamId, requestId, sourceId }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId, sourceId: openDeployment.sourceId });
									},
									onStopSource: async (sourceId) => {
										await deploymentRequest((requestId) => ({ type: 'deployment:stopSource', teamId: openDeployment.teamId, requestId, sourceId }));
										sendMessageRef.current({ type: 'deployment:fetch', teamId: openDeployment.teamId, sourceId: openDeployment.sourceId });
									},
								},
							}
						: {})}
				/>
			)}
			{showCheckout && stripeKey && <CheckoutModal appName="RocketRide" appDescription="Visual AI pipeline editor — run and deploy pipelines on RocketRide Cloud." stripePublishableKey={stripeKey} onFetchPlans={handleFetchPlans} onCreateCheckout={handleCreateCheckout} onConfirmPending={handleConfirmPending} onSuccess={handleCheckoutSuccess} onClose={() => setShowCheckout(false)} onActionClick={(_plan: CheckoutPlan, action: PlanAction) => sendMessageRef.current({ type: 'project:openLink', url: action.type === 'mailto' ? `mailto:${action.url}${action.subject ? `?subject=${encodeURIComponent(action.subject)}` : ''}` : action.url, browser: true })} />}
		</>
	);
};

export default ProjectWebview;
