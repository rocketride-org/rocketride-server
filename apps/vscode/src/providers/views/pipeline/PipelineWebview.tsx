// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PipelineWebview — the pipeline editor page as a shell bus realm.
 *
 * Boot state rides host.pipeline.load (the panel's identity is stamped in
 * the served HTML as data-rr-doc); per-document state rides the
 * pipeline:doc:<doc> topics; deploy and the DVR ride the client.deploy
 * and client.log op families.
 * Renders the shared ProjectView (its name follows the SHARED module —
 * cross-app, out of this rename's scope).
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import type { IProject } from 'shell';
// Project module is imported via subpath (not the 'shared' barrel): the
// barrel is the shell's MF share and must stay canvas-free; this webview
// bundles the project module directly.
import { ProjectView, parseServerEvent, isDevLiveEvent, isTeamLiveEvent } from 'shared/tools/pipelines';
import { mergeProjectPreferences } from 'shared/tools/pipelines/utils/prefs';
import { registerServiceIcons } from 'shared/tools/pipelines/panels/design/canvas';
import { foldProjectDeployRuns } from 'shared/tools/pipelines/sidebar/taskFold';
import type { TaskLifecycleEvent } from 'shared/tools/pipelines/sidebar/taskFold';
import type { TaskEventMessage, TaskEventSession, TaskStatus, TaskTimeline, ViewState } from 'shared/tools/pipelines';
import { CheckoutModal } from 'shell';
import type { CheckoutPlan, PlanAction } from 'shell';
import { DeploymentRecordPanel, TeamDeploymentRecordPanel } from 'shared/panels/deploy';
import type { DeploySnapshot } from 'shared/panels/deploy';
import { createBridgedPrefsStore, useGridConfigAnswering, ConnectionManager } from 'shell';
import { isAppSubscribed } from 'shared/utils/subscriptionGate';
import { PIPE_BUILDER_APP_ID } from '../../../shared/types';
import { fetchDeployLifecycle as fetchLifecycleOp, fetchDeployment as fetchDeploymentOp, deploymentActions, toWireTeamId } from './deployOps';
import { useMessaging } from '../hooks/useMessaging';
import { useStripeKey } from '../hooks/useStripeKey';
import { CheckoutUnavailableNotice } from '../components';
import type { PipelineHostToWebview, PipelineWebviewToHost } from '../../types/pipelineTypes';
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

const PipelineWebview: React.FC = () => {
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
	// Server-supplied Stripe publishable key — matches the connected server's
	// Stripe account instead of a build-time value.
	const { key: stripeKey, reason: stripeKeyReason } = useStripeKey();
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

	// Run-log session ids (the DVR) — sessions are brokered at the root; play
	// items arrive on per-session realm-registered ops.
	const logSessionCounter = useRef(0);

	// --- Stable refs for message handler closures ----------------------------

	const projectIdRef = useRef(projectId);
	useEffect(() => {
		projectIdRef.current = projectId;
	}, [projectId]);


	// Stable ref into the message fold below — the bus listeners deliver
	// through it so the big switch stays the one fold for both carriers.
	const handleMessageRef = useRef<(msg: PipelineHostToWebview) => void>(() => {});
	// This panel's bus identity (the document URI, or task:<pid>.<sid> for
	// the readonly live-task viewer) — stamped into the served HTML, present
	// before any script ran.
	const docRef = useRef<string>(document.body.dataset.rrDoc ?? '');
	// OAuth tokens were just applied: the next contentSet must reach disk
	// without a manual save (the one-shot coupling, stamped realm-side).
	const saveAfterOAuthRef = useRef(false);

	// --- Framework state off the bus (mirror events + retained topics) --------
	// Connection, services, env keys, and cloud-setup state all ride the
	// bus's generic lanes now — no typed host pushes.
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		const applyConnection = (): void => {
			const connected = cm.isConnected();
			if (connected) {
				setStatusMap({});
				setLiveLogEvents([]);
			}
			setIsConnected(connected);
			const host = cm.getHttpUrl();
			if (host) setServerHost(host);
		};
		const applyServices = (payload: { services: Record<string, unknown>; icons?: Record<string, string> } | null): void => {
			if (!payload?.services) return;
			registerServiceIcons({ services: payload.services as Record<string, any>, icons: payload.icons ?? {} });
			setServicesJson(payload.services as Record<string, any>);
		};
		applyConnection();
		applyServices(cm.getCachedServices() as { services: Record<string, unknown>; icons?: Record<string, string> } | null);
		const doc = docRef.current;
		// The document's boot state — pulled, with one retry when the first
		// attempt raced the connection (the load op itself is host-local).
		const applyLoad = (payload: Record<string, any>): void => {
			// Restore saved webview state if available (survives tab switches)
			const saved = getStateRef.current();
			const vs = (saved && Object.keys(saved).length > 0 ? saved : payload.viewState) as ViewState | undefined;
			setProject(payload.project);
			setProjectId((payload.project as { project_id?: string } | undefined)?.project_id ?? '');
			if (payload.isSubscribed !== undefined) setSubscribed(payload.isSubscribed);
			setIsReadonly(payload.isReadonly ?? false);
			setStatusMap(payload.statuses ?? {});
			setViewState({
				mode: vs?.mode ?? 'design',
				flowViewMode: vs?.flowViewMode ?? 'pipeline',
				viewport: vs?.viewport,
			});
			setPrefs(payload.prefs ?? {});
			setLiveLogEvents([]);
			// Unconditional: a load without a return URL must clear any stale
			// one, and a reload must not keep tokens from a previous session.
			setOauthReturnUrl(payload.oauthReturnUrl);
			setPendingOAuthTokens(undefined);
			if (payload.envKeys) setEnvKeys(payload.envKeys);
		};
		void cm.request('host.pipeline.load', { doc } as never).then(
			(payload) => applyLoad(payload as Record<string, any>),
			() => {
				const offRetry = cm.on('shell:connected', () => {
					offRetry();
					void cm.request('host.pipeline.load', { doc } as never).then((payload) => applyLoad(payload as Record<string, any>), () => {});
				});
			}
		);

		const offs = [
			// The document's dirty state (RETAINED; retracted when the editor
			// closes — an undefined delivery is that retraction).
			cm.subscribe(`pipeline:doc:${doc}`, (snap) => {
				const d = snap as { isDirty?: boolean; isNew?: boolean } | undefined;
				if (!d) return;
				if (typeof d.isDirty === 'boolean') setIsDirty(d.isDirty);
				if (typeof d.isNew === 'boolean') setIsNew(d.isNew);
			}),
			// The canvas echo (undo/redo, external edits) — a SIGNAL.
			cm.subscribe(`pipeline:doc:${doc}:canvas`, (payload) => {
				const c = payload as { project?: unknown } | undefined;
				if (c?.project !== undefined) setProject(c.project);
			}),
			// OAuth tokens — retained until APPLIED; this page retracts after
			// taking them (a one-shot credential, not state) and stamps the
			// applying content change with saveAfter.
			cm.subscribe(`pipeline:doc:${doc}:oauth`, (snap) => {
				const t = snap as { tokens?: string; state?: string } | undefined;
				if (!t?.tokens || !t.state) return;
				saveAfterOAuthRef.current = true;
				setPendingOAuthTokens({ tokens: t.tokens, state: t.state });
				cm.publish(`pipeline:doc:${doc}:oauth`, undefined);
			}),
			// The host's run gate asks for the Subscribe overlay — a SIGNAL
			// (one-shot): replaying it after a later subscribe would reopen it.
			cm.subscribe(`pipeline:doc:${doc}:checkout`, (payload) => {
				if ((payload as { required?: boolean } | undefined)?.required) setShowCheckout(true);
			}),
			// Subscription state follows the MIRRORED account — the host no
			// longer pushes it (every realm can derive the same answer).
			cm.on('shell:accountUpdate', () => {
				const sub = isAppSubscribed(cm.getAccountInfo(), PIPE_BUILDER_APP_ID);
				setSubscribed(sub);
				if (sub) setShowCheckout(false);
			}),
			// Global-scoped project-preference changes from any editor.
			cm.subscribe('pipeline:prefs', (payload) => {
				const pr = payload as { prefs?: Record<string, unknown> } | undefined;
				if (pr?.prefs) setPrefs((prev) => mergeProjectPreferences(prev, pr.prefs ?? {}));
			}),
			// The engine event stream arrives realm-locally (mirror.event →
			// shell:event) — feed the same fold the typed push used to.
			cm.on('shell:event', (payload) => {
				handleMessageRef.current({ type: 'shell:event', event: (payload as { event?: unknown })?.event ?? payload } as PipelineHostToWebview);
			}),
			cm.on('shell:statusChange', applyConnection),
			cm.on('shell:servicesUpdated', (payload) => applyServices(payload as { services: Record<string, unknown>; icons?: Record<string, string> })),
			cm.subscribe('pipeline:env', (snap) => {
				const keys = (snap as { envKeys?: string[] } | undefined)?.envKeys;
				if (Array.isArray(keys)) setEnvKeys(keys);
			}),
			cm.subscribe('pipeline:cloudSetup', (snap) => {
				const v = (snap as { cloudConnectionConfigured?: boolean } | undefined)?.cloudConnectionConfigured;
				if (typeof v === 'boolean') setCloudConnectionConfigured(v);
			}),
		];
		return () => offs.forEach((off) => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// --- Monitoring (realm-owned, brokered) ------------------------------------
	// summary/flow feed the canvas + status map; output/task feed the live
	// log and run-active timeline; the global {token:'*'} pair carries deploy
	// invalidations + ALL visible runs' lifecycle (each registration also
	// triggers the server's catch-up snapshot). The broker owns cross-realm
	// refcounts and resubscribes on reconnect — this realm registers once per
	// projectId and removes on unmount (fixing the old host-side bug where
	// the first panel to close unregistered the global pair for everyone).
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
			if (added || disposed || !cm.isConnected()) return;
			added = true;
			void cm.request('client.addMonitor', { key: projectKey, types: projectTypes } as never).catch(() => {
				added = false;
			});
			void cm.request('client.addMonitor', { key: globalKey, types: globalTypes } as never).catch(() => {});
		};
		add();
		const off = cm.on('shell:connected', add);
		return () => {
			disposed = true;
			off();
			if (added) {
				cm.emitOp('client.removeMonitor', { key: projectKey, types: projectTypes });
				cm.emitOp('client.removeMonitor', { key: globalKey, types: globalTypes });
			}
		};
	}, [projectId]);

	// --- Messaging ------------------------------------------------------------

	const sendMessageRef = useRef<(msg: PipelineWebviewToHost) => void>(() => {});

	// This realm's prefs store — hydrated once from the host's memento bag
	// over the bus (host.prefs.*; the same lane every framework page uses);
	// grid layouts answer synchronously from it, so DataGrid persistence
	// works in this webview exactly as in the web shell.
	const prefsBridgeRef = useRef<ReturnType<typeof createBridgedPrefsStore> | null>(null);
	if (!prefsBridgeRef.current) {
		prefsBridgeRef.current = createBridgedPrefsStore((key, value, scope) => ConnectionManager.getInstance().emitOp('host.prefs.set', { key, value, scope }));
	}
	useGridConfigAnswering(prefsBridgeRef.current.store);
	useEffect(() => {
		void ConnectionManager.getInstance().request('host.prefs.snapshot', {} as never).then(
			(snap) => prefsBridgeRef.current?.seed(snap as Record<string, unknown>),
			() => prefsBridgeRef.current?.seed({})
		);
	}, []);
	const getStateRef = useRef<() => ViewState | null>(() => null);

	const handleMessage = useCallback((msg: PipelineHostToWebview) => {
		switch (msg.type) {
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
		}
	}, []);

	const { sendMessage, getState, setState } = useMessaging<PipelineWebviewToHost, PipelineHostToWebview, ViewState>({
		onMessage: handleMessage,
	});
	useEffect(() => {
		handleMessageRef.current = handleMessage;
	}, [handleMessage]);
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
			const saveAfter = saveAfterOAuthRef.current;
			saveAfterOAuthRef.current = false;
			ConnectionManager.getInstance().emitOp('host.pipeline.contentSet', { doc: docRef.current, project: updatedProject, ...(saveAfter ? { saveAfter } : {}) });
		},
		[sendMessage]
	);

	const handleValidate = useCallback(async (pipeline: any): Promise<any> => {
		// Brokered client.validate. CONTRACT: the old path resolved with an
		// EMPTY result on timeout/failure (the canvas has never seen a
		// rejection here) — preserve that by catching everything.
		try {
			return await ConnectionManager.getInstance().request('client.validate', pipeline as never, { timeoutMs: 15000 });
		} catch {
			return { errors: [], warnings: [] };
		}
	}, []);

	/**
	 * Fetches the FULL definition (config schema) for one service provider
	 * from the extension host. The bulk services payload is summary-only, so
	 * the canvas requests definitions on demand and caches them. Rejects on
	 * host error or timeout so the canvas treats the request as retryable.
	 */
	const handleGetNodeSchema = useCallback(async (provider: string): Promise<Record<string, any> | undefined> => {
		// Brokered client.getService — rejects on error/timeout so the canvas
		// treats the request as retryable (unchanged contract).
		return (await ConnectionManager.getInstance().request('client.getService', { service: provider } as never, { timeoutMs: 15000 })) as Record<string, any> | undefined;
	}, []);

	const handlePipelineAction = useCallback((action: 'run' | 'stop' | 'restart', source?: string) => {
		const cm = ConnectionManager.getInstance();
		if (action === 'stop') {
			if (source) cm.emitOp('host.pipeline.stop', { doc: docRef.current, source });
			return;
		}
		cm.emitOp('host.pipeline.run', { doc: docRef.current, action, source });
	}, []);

	const handleMissingEnvVars = useCallback((keys: string[]) => {
		ConnectionManager.getInstance().emitOp('host.pipeline.missingEnv', { keys });
	}, []);

	const handleViewStateChange = useCallback(
		(vs: ViewState) => {
			// Keep local state current so the next run message carries the latest trace level
			setViewState(vs);
			// Persist to VS Code webview state (survives tab switches)
			const current = getState() ?? ({} as ViewState);
			setState({ ...current, ...vs });
			ConnectionManager.getInstance().emitOp('host.pipeline.viewState', { doc: docRef.current, viewState: vs });
		},
		[sendMessage, getState, setState]
	);

	const handlePrefsChange = useCallback(
		(updatedPrefs: Record<string, unknown>) => {
			setPrefs((prev) => mergeProjectPreferences(prev, updatedPrefs));
			ConnectionManager.getInstance().emitOp('host.pipeline.prefsChange', { prefs: updatedPrefs });
		},
		[sendMessage]
	);

	const handleOpenLink = useCallback((url: string, displayName?: string) => {
		ConnectionManager.getInstance().emitOp('host.pipeline.openLink', { url, displayName });
	}, []);

	const handleOpenExternal = useCallback(
		(url: string) => {
			ConnectionManager.getInstance().emitOp('host.pipeline.oauthStart', { doc: docRef.current, url });
		},
		[sendMessage]
	);

	const clearPendingOAuthTokens = useCallback(() => {
		setPendingOAuthTokens(undefined);
	}, []);

	const handleOpenCloudSetup = useCallback(() => {
		// Focus the Development tab only — the prompt must not stage a
		// connection-mode change the user never typed.
		ConnectionManager.getInstance().emitOp('host.openPage', { page: 'settings', args: ['development'] });
	}, []);

	const handleSave = useCallback(() => {
		ConnectionManager.getInstance().emitOp('host.pipeline.save', { doc: docRef.current });
	}, []);

	// --- Checkout callbacks — brokered client.billing.* bus ops ---------------

	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return ConnectionManager.getInstance().request('client.billing.getProductPrices', { appId: PIPE_BUILDER_APP_ID } as never) as Promise<CheckoutPlan[]>;
	}, []);

	const handleCreateCheckout = useCallback((priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> => {
		const cm = ConnectionManager.getInstance();
		const orgId = cm.getAccountInfo()?.organization?.id;
		if (!orgId) return Promise.reject(new Error('No organisation found'));
		return cm.request('client.billing.createCheckoutSession', { orgId, appId: PIPE_BUILDER_APP_ID, priceId } as never) as Promise<{ clientSecret: string; subscriptionId: string }>;
	}, []);

	const handleConfirmPending = useCallback(async (subscriptionId: string, priceId: string): Promise<void> => {
		await ConnectionManager.getInstance().request('client.billing.confirmPending', { appId: PIPE_BUILDER_APP_ID, subscriptionId, priceId } as never);
	}, []);

	const handleCheckoutSuccess = useCallback(() => {
		setShowCheckout(false);
		setSubscribed(true);
	}, []);

	// --- Deploy lifecycle capabilities (the DEPLOY page) ----------------------
	// ProjectView composes the DeployPanel itself (capability-fed);
	// this webview supplies the closures over the deploy:* message protocol.

	/** Registry snapshot fetch — the realm's own client.deploy.* calls now
	    (each caller awaits ITS result; the old deploy:data push settled every
	    outstanding waiter at once). Applies the LIVE rows as it resolves. */
	const fetchDeployLifecycle = useCallback(async (): Promise<DeploySnapshot> => {
		const snapshot = await fetchLifecycleOp(projectIdRef.current);
		setDeployTeams(snapshot.teams);
		setTeamDeployments(snapshot.deployments);
		return { versions: snapshot.versions };
		// isConnected is a deliberate dep: a reconnect mints a new fetcher
		// identity, which makes the panel re-fetch (its mount effect keys on it).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isConnected]);

	/** Fetch one immutable artifact (the version cards' record drawer). The
	    registry stores the saved pipeline document verbatim, so the raw
	    artifact record IS the IProject the record drawer renders. */
	const fetchDeployArtifact = useCallback((version: number): Promise<IProject | undefined> => {
		return deploymentActions.artifact(projectIdRef.current, version).then((artifact) => artifact as unknown as IProject);
	}, []);

	/** Publish the SAVED document — the host snapshots the TextDocument; only
	    metadata travels. A host-side failure arrives as this call's rejection. */
	const handleDeployPublish = useCallback(
		async (comment: string, deployTo?: string): Promise<void> => {
			await ConnectionManager.getInstance().request('host.pipeline.publish', { doc: docRef.current, comment, ...(deployTo ? { deployTo } : {}) } as never);
		},
		[]
	);

	/** Point a team at a version (promotion and rollback alike). The caller
	    owns the refresh now — the old host re-push settled stale waiters. */
	const handleDeployVersion = useCallback(
		async (version: number, teamId: string): Promise<void> => {
			await deploymentActions.deployVersion(projectIdRef.current, teamId, version);
			void fetchDeployLifecycle();
		},
		[fetchDeployLifecycle]
	);

	/** Where-live / version-badge click → a deployment record drawer (this
	    webview owns its record panels, the grid-view pattern): the TEAM
	    record without a sourceId, one source's record with it. */
	const loadDeployment = useCallback((teamId: string, sourceId?: string): void => {
		// The drawer's run state is push-driven: the team-scoped task monitor's
		// events trigger the re-fetches (brokered refcounts dedupe; released
		// per-connection server-side, matching open-again-later usage).
		void ConnectionManager.getInstance().request('client.addMonitor', { key: { projectId: projectIdRef.current, source: '*', teamId: toWireTeamId(teamId) }, types: ['task'] } as never).catch(() => {});
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

	const handleOpenDeployment = useCallback((teamId: string, sourceId?: string): void => {
		setDeploymentData(null);
		setDeploymentError('');
		// Set the ref SYNCHRONOUSLY so a fast fetch cannot lose the guard race
		// against the state effect.
		openDeploymentRef.current = { teamId, ...(sourceId ? { sourceId } : {}) };
		setOpenDeployment({ teamId, ...(sourceId ? { sourceId } : {}) });
		loadDeployment(teamId, sourceId);
	}, [loadDeployment]);

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
			loadDeployment(open.teamId, open.sourceId);
		}, DEPLOYMENT_REFETCH_COALESCE_MS);
	}, [loadDeployment]);
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

	/** The provider owns the TextDocument; deploy:publish saves host-side —
	    the panel just needs a resolvable save step for its flow. */
	const handleDeploySaveDocument = useCallback(async (): Promise<void> => {}, []);

	// --- Run-log DVR bindings (logsession:* — identical contract to cloud) ----

	/** Opens a run-log session: a real {@link TaskEventSession} whose every
	    member speaks the logsession:* protocol — the components cannot tell
	    which transport is underneath. teamId scopes to a deploy continuum. */
	const openLogSession = useCallback(
		(source: string, teamId?: string): TaskEventSession => {
			// Realm-allocated id, globally unique (sessions are brokered at the
			// root by id across every realm).
			const sessionId = `ls_${Math.random().toString(36).slice(2, 10)}_${++logSessionCounter.current}`;
			const cm = ConnectionManager.getInstance();
			// Play items arrive on THIS realm's `log.event.<sessionId>` op —
			// registration is the routing (and the delivery sink must exist
			// before play's ack settles).
			let offEvents: (() => void) | null = null;
			cm.emitOp('client.log.openStream', { sessionId, projectId: projectIdRef.current, source, ...(teamId ? { teamId } : {}) });
			const call = <T,>(method: 'seek' | 'getStatus' | 'getTrace', args: unknown[]): Promise<T> => cm.request('client.log.streamCall', { sessionId, method, args } as never, { timeoutMs: DEPLOY_REQUEST_TIMEOUT_MS }) as Promise<T>;
			return {
				seek: (pos) => call<void>('seek', [pos]),
				getStatus: () => call<Record<string, unknown> | null>('getStatus', []),
				getTrace: (traceId) => call<{ events: TaskEventMessage[] }>('getTrace', [traceId]),
				play: (pos, speed, cb) => {
					offEvents?.();
					offEvents = cm.handle(`log.event.${sessionId}`, (item) => cb(item as { event: TaskEventMessage }));
					// LONG-LIVED by contract: the promise resolves at STREAM
					// COMPLETION — give it the maximum timer budget (2^31-1 ms;
					// larger overflows setTimeout and fires immediately).
					return cm.request('client.log.streamPlay', { sessionId, pos: pos === undefined ? null : pos, speed } as never, { timeoutMs: 0x7fffffff }) as Promise<void>;
				},
				pause: () => cm.emitOp('client.log.streamPause', { sessionId }),
				// The dev page's hook feeds live events for near-live merging.
				ingestLive: (message) => cm.emitOp('client.log.streamIngest', { sessionId, event: message }),
				closeEventStream: () => {
					offEvents?.();
					offEvents = null;
					cm.emitOp('client.log.streamClose', { sessionId });
				},
			};
		},
		[]
	);

	/** Chapters/timeline fetch for one source (session-independent). */
	const fetchLogTimeline = useCallback((source: string, teamId?: string): Promise<TaskTimeline> => ConnectionManager.getInstance().request('client.log.chapters', { projectId: projectIdRef.current, source, ...(teamId ? { teamId } : {}) } as never, { timeoutMs: DEPLOY_REQUEST_TIMEOUT_MS }) as Promise<TaskTimeline>, []);

	/** Dev-continuum DVR session factory for ProjectView's sections. */
	const openEventStream = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => openLogSession(stream.source), [openLogSession]);

	/** Dev-continuum chapters fetch for ProjectView's sections. */
	const fetchTimeline = useCallback((stream: { source: string; runKind: 'dev' | 'deploy' }) => fetchLogTimeline(stream.source), [fetchLogTimeline]);

	// --- Wait for initial state from host before rendering -------------------

	if (!viewState || !prefs) return null;

	// --- Render --------------------------------------------------------------

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
							deploy: {
								fetchLifecycle: fetchDeployLifecycle,
								publish: handleDeployPublish,
								deployVersion: handleDeployVersion,
								// Where-live rows enriched with the folded run state
								// (the running badges track live without polling).
								teamDeployments: teamDeployments.map((d) => ({ ...d, ...(deployRunsByTeam[d.teamId] ? { runningSources: deployRunsByTeam[d.teamId] } : {}) })),
								teams: deployTeams,
								openDeployment: handleOpenDeployment,
								// Where-live interactions ride the SAME client.deploy.* ops
								// as the record drawer (teamId on every call); the rows
								// refresh via fetchLifecycle once the mutation resolves.
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
								saveDocument: handleDeploySaveDocument,
							},
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
									// Verbs ack, then THIS webview re-fetches the record
									// (host refresh died with the source-scoped payload).
									...(deploymentData.sourcePaused !== undefined ? { sourcePaused: deploymentData.sourcePaused } : {}),
									...(deploymentData.sourceConfig ? { sourceConfig: deploymentData.sourceConfig } : {}),
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
			{showCheckout && stripeKey && <CheckoutModal appName="RocketRide" appDescription="Visual AI pipeline editor: run and deploy pipelines on RocketRide Cloud." stripePublishableKey={stripeKey} onFetchPlans={handleFetchPlans} onCreateCheckout={handleCreateCheckout} onConfirmPending={handleConfirmPending} onSuccess={handleCheckoutSuccess} onClose={() => setShowCheckout(false)} onActionClick={(_plan: CheckoutPlan, action: PlanAction) => ConnectionManager.getInstance().emitOp('host.pipeline.openLink', { url: action.type === 'mailto' ? `mailto:${action.url}${action.subject ? `?subject=${encodeURIComponent(action.subject)}` : ''}` : action.url, browser: true })} />}
			{showCheckout && !stripeKey && <CheckoutUnavailableNotice reason={stripeKeyReason} onClose={() => setShowCheckout(false)} />}
		</>
	);
};

export default PipelineWebview;
