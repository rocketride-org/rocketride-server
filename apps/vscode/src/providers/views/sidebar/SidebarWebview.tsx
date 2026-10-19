// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarWebview — the tool-registry sidebar as a shell bus realm.
 *
 * Everything this page displays rides the bus: connection/deploy/cloud-auth
 * facts off the retained mirrors (shell:status / shell:deployStatus /
 * shell:cloudAuth / shell:account), the strip's tool rows off retained
 * devtools:rows, the fronted tool document off retained devtools:activeDoc,
 * host-driven selection off the sidebar:modeSelect signal, diagnostics off
 * the pipeline:sourceDiagnostics signal, prefs over host.prefs.*, actions
 * over host.* emitOps, and workspace FS over host.fs.*. The only remaining
 * postMessage is sidebar:command (+ the view:ready boot marker).
 *
 * Renders <SidebarChrome> over the builtin-tool registry plus the pinned
 * store tools, with a <SidebarFooter> footerSlot. Each builtin sidebar
 * mounts under its own ToolHostProvider carrying ITS scoped prefs
 * partition; store-tool panels mount remotely via DevToolSidebarMount.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import 'shell/themes/rocketride-default.css';
import '../../../themes/rocketride-vscode.css';
import './sidebar.css';

import { SidebarChrome, ToolPanel } from 'shared/tools/core/chrome/SidebarChrome';
import { ToolHostProvider } from 'shared/tools/core';
import { useToolStrip } from 'shared/tools/core/chrome/useToolStrip';
import type { BuiltinToolServices } from 'shared/tools/core';
import { ConnectionManager, SidebarFooter, createBridgedPrefsStore, createSidebarBusPeer } from 'shell';
import { registerBuiltinTools } from 'shared/tools/builtins';
import { pushSourceDiagnostics } from 'shared/tools/pipelines/diagnostics';
import type { ConnectionInfo, SidebarMode, ToolTab } from 'shared/tools/core/chrome/types';
import { useMessaging } from '../hooks/useMessaging';
import { DevToolSidebarMount } from './DevToolSidebarMount';
import type { DevToolHostInfo } from './DevToolSidebarMount';
import type { SidebarHostToWebview, SidebarWebviewToHost } from './messages';
import { createBusWorkspaceFs } from './svcFsClient';
import { buildFooterMenuItems } from './footerMenu';
import { isAppSubscribed } from 'shared/utils/subscriptionGate';
import { PIPE_BUILDER_APP_ID } from '../../../shared/types';
import { attachBusRealm } from '../hooks/busRealm';

// A TOOL IS AN APP: the builtin tools register once per realm; this host's
// sidebar renders them by iterating the registry.
registerBuiltinTools();

// SHELL BUS SPOKE: attach this realm to the extension host's router once
// per realm lifetime — request('client.*') reaches the broker, the mirror
// feed re-emits root state locally (busRealm.ts).


const SidebarViewWebview: React.FC = () => {
	// Attach this realm to the shell bus FIRST (idempotent; failure-isolated
	// inside) — mirror state and brokered client.* ops ride it.
	attachBusRealm();

	// ── Dev connection state ────────────────────────────────────────────────
	const [connection, setConnection] = useState<ConnectionInfo>({ state: 'disconnected' });
	const [developmentMode, setDevelopmentMode] = useState('local');
	const [devProgressMessage, setDevProgressMessage] = useState<string | undefined>();

	// ── Subscription state ─────────────────────────────────────────────────
	const [subscribed, setSubscribed] = useState(true);

	// ── Deploy connection state ─────────────────────────────────────────────
	const [deployConnectionState, setDeployConnectionState] = useState('disconnected');
	const [deployTargetMode, setDeployTargetMode] = useState<string | null>(null);
	const [deployProgressMessage, setDeployProgressMessage] = useState<string | undefined>();

	// Entries, tasks, and the MY APPS list live in the TOOLS now (shared
	// tools/pipelines, tools/appdev) — this webview only provides services.

	// Builtin tools the user DISABLED (host-persisted; seeded by stripSeed).
	const [disabledBuiltins, setDisabledBuiltins] = useState<string[]>([]);

	// ── Pinned dev tools (icon tabs on the mode strip) + the catalog ───────
	const [tools, setTools] = useState<ToolTab[]>([]);
	const [availableTools, setAvailableTools] = useState<ToolTab[]>([]);
	// Persisted strip order (modes + tool tabs); seeded from the host, set
	// optimistically on drag.
	const [tabOrder, setTabOrder] = useState<string[]>([]);
	const [devToolHost, setDevToolHost] = useState<DevToolHostInfo | null>(null);
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>('apps');
	// Tools whose sidebar mount has been ACTIVATED — a tool pane loads its
	// remote only once its tab has been selected (user click, or host focus
	// sync from its frame panel); never merely because the tool is pinned.
	const [activatedTools, setActivatedTools] = useState<ReadonlySet<string>>(new Set());
	// The editor's fronted tool document (host-tracked). undefined = no
	// signal received yet (mounts fall back to their own state); appId null
	// = a non-tool tab is fronted.
	const [activeToolDoc, setActiveToolDoc] = useState<{ appId: string | null; docKey: string | null } | undefined>(undefined);
	// The host-persisted mode seeds the strip ONCE: an `update` composed
	// before the persist round trip completed carries the previous value and
	// must not revert a selection the user just made.
	const sidebarModeSeededRef = useRef(false);

	// ── Engine progress log (last N lines for popup display) ───────────────
	const MAX_PROGRESS_LINES = 15;
	const [devProgressLog, setDevProgressLog] = useState<string[]>([]);
	const [deployProgressLog, setDeployProgressLog] = useState<string[]>([]);

	// ── Shared auth + identity ──────────────────────────────────────────────
	const [userName, setUserName] = useState<string | undefined>();
	const [userEmail, setUserEmail] = useState<string | undefined>();
	const [cloudConnected, setCloudSignedIn] = useState(false);

	// ── Messaging ───────────────────────────────────────────────────────────

	// The ONLY remaining postMessage traffic is sidebar:command (unrestricted
	// executeCommand — a deliberate host decision) and the view:ready boot
	// signal (the page-lifecycle marker the host's watcher reset keys off).
	const { sendMessage } = useMessaging<SidebarWebviewToHost, SidebarHostToWebview>({});

	// The clients below are created ONCE and capture the latest sendMessage
	// through this ref — their identities (and every peer/capability they
	// hand out) stay stable for the realm's lifetime.
	const sendRef = useRef(sendMessage);
	sendRef.current = sendMessage;

	// ── Workspace-FS capability ─────────────────────────────────────────────
	// The ToolWorkspaceFs the shared tool code runs against — host.fs.* ops
	// (the bus correlates) + the realm-registered sidebar.fs.event push.
	const workspaceFs = useMemo(() => createBusWorkspaceFs(), []);

	// ── Tool peers (bus-carried) ────────────────────────────────────────────
	// Stable sidebar-side peers per tool, riding the bus's retained/signal
	// lanes (shell busPeer): frame traffic arrives on the tool's topics, and
	// each peer holds payloads until the tool's lazy mount subscribes.
	const sidebarPeers = useMemo(() => {
		const cache = new Map<string, ReturnType<typeof createSidebarBusPeer>>();
		return (appId: string) => {
			let peer = cache.get(appId);
			if (!peer) {
				peer = createSidebarBusPeer(appId, ConnectionManager.getInstance());
				cache.set(appId, peer);
			}
			return peer;
		};
	}, []);

	// This realm's prefs backend: a hydrate-once bridged store over the bus —
	// `host.prefs.snapshot` seeds it (resolving its `ready`), writes ride
	// `host.prefs.set` (the same ops the account and pipeline pages use).
	// Per-tool partitions are carved off it in the builtin strip items.
	const prefsBridge = useMemo(() => createBridgedPrefsStore((key, value, scope) => ConnectionManager.getInstance().emitOp('host.prefs.set', { key, value, scope } as never)), []);
	useEffect(() => {
		void ConnectionManager.getInstance()
			.request('host.prefs.snapshot', {} as never)
			.then((values) => {
				const snap = (values ?? {}) as Record<string, unknown>;
				prefsBridge.seed(snap);
				// The strip prefs ride the same bag: the persisted mode (seed
				// once — a user selection made before the snapshot landed must
				// not be reverted), the strip order, and the disabled builtins.
				const mode = snap['sidebarMode'];
				if (typeof mode === 'string' && !sidebarModeSeededRef.current) {
					sidebarModeSeededRef.current = true;
					setSidebarMode(mode as SidebarMode);
				}
				const order = snap['sidebarTabOrder'];
				if (Array.isArray(order)) setTabOrder(order as string[]);
				const disabled = snap['disabledBuiltins'];
				if (Array.isArray(disabled)) setDisabledBuiltins(disabled as string[]);
			})
			.catch(() => {
				/* snapshot unavailable — defaults stand */
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- one hydration per realm
	}, []);

	// Host-driven strip state over the bus: the fronted tool document
	// (RETAINED — replay covers a freshly booted webview; both-null is the
	// explicit "non-tool tab fronted" value) and host-driven tab selection
	// (a SIGNAL — a tool panel gained focus; always applies).
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		const offs = [
			// ── Connection facts, derived from the mirrors ──────────────────
			// Dev half: read the RAW status off the shell:status snapshot —
			// the realm CM's normalize collapses the transitional states
			// (connecting / downloading-engine / auth-failed) the footer
			// renders. configMode is the CONFIGURED dev mode.
			cm.subscribe('shell:status', (snap) => {
				const s = snap as { status?: { state?: string; connectionMode?: string; progressMessage?: string; progressLogLine?: string }; configMode?: string } | undefined;
				const st = s?.status;
				if (!st) return;
				const mode = s?.configMode ?? st.connectionMode;
				setConnection({ state: st.state as ConnectionInfo['state'], mode });
				if (mode) setDevelopmentMode(mode);
				setDevProgressMessage(st.progressMessage);
				// Accumulate engine log lines; clear on connect. Publishes are
				// per status tick (nothing coalesces), so every line arrives.
				if (st.state === 'connected') setDevProgressLog([]);
				else if (st.progressLogLine) setDevProgressLog((prev) => (prev[prev.length - 1] === st.progressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), st.progressLogLine!]));
			}),
			// Deploy half — host-only state (DeployManager), mirrored whole.
			cm.subscribe('shell:deployStatus', (snap) => {
				const s = snap as { status?: { state?: string; progressMessage?: string; progressLogLine?: string }; configMode?: string | null } | undefined;
				const st = s?.status;
				if (!st) return;
				if (st.state) setDeployConnectionState(st.state);
				setDeployTargetMode(s?.configMode ?? null);
				setDeployProgressMessage(st.progressMessage);
				if (st.state === 'connected') setDeployProgressLog([]);
				else if (st.progressLogLine) setDeployProgressLog((prev) => (prev[prev.length - 1] === st.progressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), st.progressLogLine!]));
			}),
			// Staged cloud auth + identity (host-resolved fallback included).
			cm.subscribe('shell:cloudAuth', (snap) => {
				const a = snap as { connected?: boolean; userName?: string; userEmail?: string } | undefined;
				if (!a) return;
				if (a.connected !== undefined) setCloudSignedIn(a.connected);
				setUserName(a.userName || undefined);
				setUserEmail(a.userEmail || undefined);
			}),
			// Subscription gate — the shared predicate over the mirrored account.
			cm.on('shell:accountUpdate', () => setSubscribed(isAppSubscribed(cm.getAccountInfo(), PIPE_BUILDER_APP_ID))),
			// devToolSidebar mount facts: the MF entry URL only, derived from
			// the mirrored engine base; no token ever crosses into this realm.
			cm.on('shell:statusChange', () => {
				setDevToolHost(cm.isConnected() ? { engineHttpUrl: (cm.getHttpUrl() || 'http://localhost:5565').replace(/\/$/, '') } : null);
			}),
			// The strip's tool rows + the dev-tool catalog (RETAINED — the
			// cached seed replays into any fresh webview, the slow compose
			// replaces it in place; a snapshot without `available` keeps the
			// last catalog instead of wiping the Modules list).
			cm.subscribe('devtools:rows', (snap) => {
				const rows = snap as { tools?: ToolTab[]; available?: ToolTab[] } | undefined;
				if (!rows?.tools) return;
				setTools(rows.tools);
				if (rows.available) setAvailableTools(rows.available);
			}),
			cm.subscribe('devtools:activeDoc', (snap) => {
				const d = snap as { appId: string | null; docKey: string | null } | undefined;
				if (d) setActiveToolDoc({ appId: d.appId, docKey: d.docKey });
			}),
			// Per-source diagnostics from the canvas editor's host-side cache —
			// a signal into the PIPELINES TOOL's ingress.
			cm.subscribe('pipeline:sourceDiagnostics', (payload) => {
				const d = payload as { projectId?: string; sourceId?: string; errors?: string[]; warnings?: string[] } | undefined;
				if (d?.projectId && d.sourceId) pushSourceDiagnostics({ projectId: d.projectId, sourceId: d.sourceId, errors: d.errors ?? [], warnings: d.warnings ?? [] });
			}),
			cm.subscribe('sidebar:modeSelect', (payload) => {
				const m = payload as { mode?: SidebarMode } | undefined;
				if (!m?.mode) return;
				sidebarModeSeededRef.current = true;
				setSidebarMode(m.mode);
			}),
		];
		return () => offs.forEach((off) => off());
	}, []);

	// NO realm socket: the controllers reach the engine over the SHELL BUS
	// (request('client.*') to the extension host's broker), and the realm
	// singleton's connection state is bus-mirrored (busRealm.ts). The
	// devToolHost facts carry only the MF entry URL now.

	// The PIPELINES and APPDEV controllers run inside their TOOLS (shared
	// tools/pipelines, tools/appdev) against the services provided below.

	// ── Host verbs for the tools ─────────────────────────────────────────────

	const onOpenFile = useCallback((path: string) => {
		ConnectionManager.getInstance().emitOp('host.pipeline.openFile', { fsPath: path } as never);
	}, []);

	const onSourceAction = useCallback((action: string, filePath: string, sourceId: string, projectId?: string) => {
		const cm = ConnectionManager.getInstance();
		switch (action) {
			case 'run':
				cm.emitOp('host.pipeline.runFile', { fsPath: filePath, sourceId } as never);
				break;
			case 'stop':
				if (projectId) cm.emitOp('host.pipeline.stopSource', { projectId, sourceId } as never);
				break;
		}
	}, []);

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'sidebar:command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);

	const onOpenUnknownTask = useCallback((projectId: string, sourceId: string, displayName: string) => {
		ConnectionManager.getInstance().emitOp('host.pipeline.openStatus', { projectId, sourceId, displayName } as never);
	}, []);

	/** The tools' generic page surface, mapped onto this host's pages. Keys
	 *  this host has no page for ('desktop', 'agent:<id>') no-op. */
	const openPage = useCallback((key: string) => {
		if (key.startsWith('intro:')) {
			sendMessage({ type: 'sidebar:command', command: 'rocketride.page.intro.open', args: [key.slice('intro:'.length)] });
			return;
		}
		if (key === 'newapp') {
			sendMessage({ type: 'sidebar:command', command: 'rocketride.app.create' });
			return;
		}
		if (key.startsWith('app:')) {
			ConnectionManager.getInstance().emitOp('host.app.open', { appId: key.slice('app:'.length) } as never);
			return;
		}
	}, [sendMessage]);

	// The ONE services object the builtin tools read (ToolContext). Tools
	// own their state; this host contributes generic verbs plus the
	// workspace-FS capability its extension host serves.
	const toolServices = useMemo<BuiltinToolServices>(() => ({
		workspaceFs,
		openPage,
		openFile: onOpenFile,
		pipelineAction: onSourceAction,
		newPipeline: () => sendRef.current({ type: 'sidebar:command', command: 'rocketride.sidebar.files.createFile' }),
		openUnknownTask: onOpenUnknownTask,
		isSubscribed: subscribed,
	}), [workspaceFs, openPage, onOpenFile, onSourceAction, onOpenUnknownTask, subscribed]);

	/** Flips one builtin's enabled state (optimistic; persisted as a pref). */
	const onToggleBuiltin = useCallback((id: string, enabled: boolean) => {
		setDisabledBuiltins((prev) => {
			const next = enabled ? prev.filter((d) => d !== id) : [...prev.filter((d) => d !== id), id];
			ConnectionManager.getInstance().emitOp('host.prefs.set', { key: 'disabledBuiltins', value: next, scope: 'workspace' } as never);
			return next;
		});
	}, []);

	// Shared builtin-strip glue: items (with per-tool scoped prefs), store
	// rows, and the activation/deactivation discipline. Builtins have no
	// isolated frame document in this host, so the hook's stable loopback
	// peers satisfy the contract.
	const revealTool = useCallback((toolId: string) => {
		ConnectionManager.getInstance().emitOp('host.devtools.reveal', { appId: toolId } as never);
	}, []);
	const { builtinItems, builtinStoreRows, focusTool: onFocusTool, deactivateReplacedTab, announceBuiltinSelected } = useToolStrip({
		host: 'vscode',
		services: toolServices,
		prefsStore: prefsBridge.store,
		disabledBuiltins,
		revealTool,
	});

	// ── Store-tool callbacks ────────────────────────────────────────────────

	/** Tool tab → open/focus the tool's frame panel — the existing
	 *  host.openToolPanel op (the bus peer's summon rides the same one). */
	const onOpenTool = useCallback((toolId: string) => {
		ConnectionManager.getInstance().emitOp('host.openToolPanel', { appId: toolId } as never);
	}, []);

	/** Tool panel Remove row → unpin — the existing host.devtools.remove op
	 *  (the details pages ride the same one; changes broadcast back on
	 *  host.devtools.changed). */
	const onRemoveTool = useCallback((toolId: string) => {
		ConnectionManager.getInstance().emitOp('host.devtools.remove', { appId: toolId } as never);
	}, []);

	/** Dev Tools panel RESET → ext host re-fetches the app registry and
	 *  reloads every loaded tool (stale frame panels + this webview). */
	// emitOp on purpose: the RESET reboots THIS webview's own page mid-flight,
	// so a request would die with its caller.
	const onRefreshTools = useCallback(() => {
		ConnectionManager.getInstance().emitOp('host.devtools.refresh', {} as never);
	}, []);

	/** Modules-list row → the tool's details page (README + Install/Remove). */
	const onShowTool = useCallback((toolId: string) => {
		ConnectionManager.getInstance().emitOp('host.devtools.readme', { appId: toolId } as never);
	}, []);

	/** Drag-reorder → apply optimistically, persist as a workspace pref. */
	const onReorderTabs = useCallback((orderedIds: string[]) => {
		setTabOrder(orderedIds);
		ConnectionManager.getInstance().emitOp('host.prefs.set', { key: 'sidebarTabOrder', value: orderedIds, scope: 'workspace' } as never);
	}, []);

	// Lazy activation: a tool's sidebar mount loads only once its tab has been
	// selected — by the user, or by the host syncing focus from the tool's
	// frame panel (modeUpdate). Activation is sticky for the document's
	// lifetime so TabPanel's keep-mounted semantics preserve its state.
	useEffect(() => {
		if (!sidebarMode.startsWith('tool:')) return;
		const id = sidebarMode.slice('tool:'.length);
		setActivatedTools((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, [sidebarMode]);

	/** Stable documents API for one tool's sidebar mount — opens/closes the
	 *  tool's per-document editor panels (e.g. one per database connection)
	 *  through the extension host. One object per tool, like the peers. */
	const documentsRef = useRef(new Map<string, { open: (docKey: string, title: string) => void; close: (docKey: string) => void }>());
	const getDocumentsApi = useCallback((appId: string) => {
		const cached = documentsRef.current.get(appId);
		if (cached) return cached;
		const api = {
			open: (docKey: string, title: string) => ConnectionManager.getInstance().emitOp('host.devtools.openDoc', { appId, docKey, title } as never),
			close: (docKey: string) => ConnectionManager.getInstance().emitOp('host.devtools.closeDoc', { appId, docKey } as never),
		};
		documentsRef.current.set(appId, api);
		return api;
	}, []);

	/** Tool tab body — the tool's devToolSidebar mounted natively, falling
	 *  back to the built-in card when the tool declares none. Tools never
	 *  activated render just the card: pinning N tools must not boot N
	 *  remotes (and their SDK connections) behind hidden tabs. */
	const renderToolPanel = useCallback((id: string): React.ReactNode => {
		const tool = tools.find((t) => t.id === id);
		if (!tool) return null;
		const card = <ToolPanel tool={tool} onOpen={onOpenTool} onRemove={onRemoveTool} />;
		if (!activatedTools.has(id)) return card;
		// Host-tracked selection for THIS tool: its fronted docKey, null when
		// another tab is fronted, undefined before any signal arrived.
		const activeDocKey = activeToolDoc === undefined ? undefined : (activeToolDoc.appId === id ? activeToolDoc.docKey : null);
		return (
			<DevToolSidebarMount
				tool={tool}
				host={devToolHost}
				peer={sidebarPeers(id)}
				documents={getDocumentsApi(id)}
				{...(activeDocKey !== undefined ? { activeDocKey } : {})}
				fallback={card}
			/>
		);
	}, [tools, devToolHost, activatedTools, activeToolDoc, sidebarPeers, getDocumentsApi, onOpenTool, onRemoveTool]);

	// The TRUE previous mode, mirrored from state so externally applied
	// changes (modeUpdate, stripSeed) update it silently — only a chrome
	// selection below emits the deactivation for the tab it replaces.
	const prevSidebarModeRef = useRef<SidebarMode>(sidebarMode);
	useEffect(() => { prevSidebarModeRef.current = sidebarMode; }, [sidebarMode]);

	/** Mode strip selection — local state now, host persists via message. */
	const onSidebarModeChange = useCallback(
		(mode: SidebarMode) => {
			deactivateReplacedTab(prevSidebarModeRef.current, mode);
			// Builtins mount in the strip itself — their activation (the
			// single-pane contract) rides the selection; MF pins get theirs
			// via SidebarChrome's onFocusTool.
			announceBuiltinSelected(mode);
			// A user selection counts as the seed: a snapshot resolving after
			// this click must not revert it.
			sidebarModeSeededRef.current = true;
			setSidebarMode(mode);
			ConnectionManager.getInstance().emitOp('host.prefs.set', { key: 'sidebarMode', value: mode, scope: 'workspace' } as never);
		},
		[deactivateReplacedTab, announceBuiltinSelected]
	);

	// ── Footer ──────────────────────────────────────────────────────────────
	// Items derive from the connection facts (footerMenu.tsx); clicks run
	// extension-host commands.
	const runCommand = useCallback((command: string, args?: unknown[]) => {
		sendMessage({ type: 'sidebar:command', command, ...(args !== undefined ? { args } : {}) });
	}, [sendMessage]);

	const footerMenuItems = useMemo(
		() =>
			buildFooterMenuItems(
				{
					connectionState: connection.state,
					developmentMode,
					devProgressMessage,
					devProgressLog,
					deployConnectionState,
					deployTargetMode,
					deployProgressMessage,
					deployProgressLog,
					cloudConnected,
					subscribed,
				},
				runCommand
			),
		[connection.state, developmentMode, devProgressMessage, devProgressLog, deployConnectionState, deployTargetMode, deployProgressMessage, deployProgressLog, cloudConnected, subscribed, runCommand]
	);

	const footerSlot = <SidebarFooter collapsed={false} userName={userName} userEmail={userEmail} onOpenDocs={onOpenDocs} menuItems={footerMenuItems} />;

	// ── Render ───────────────────────────────────────────────────────────────

	// No headerSlot: the VS Code host has no home-app destination, so it injects no
	// host-specific top nav. The "Home" button is a SaaS-shell concept owned by the
	// web host (rocket-ui), intentionally absent from shared / this extension.

	return (
		<ToolHostProvider value={toolServices}>
			<SidebarChrome items={builtinItems} footerSlot={footerSlot} sidebarMode={sidebarMode} onSidebarModeChange={onSidebarModeChange} toolTabs={{ tools, available: availableTools, onOpenTool, onFocusTool, onShowTool, onRemoveTool, onRefreshTools, renderToolPanel, builtins: builtinStoreRows, onToggleBuiltin }} tabOrder={tabOrder} onReorderTabs={onReorderTabs} />
		</ToolHostProvider>
	);
};

export default SidebarViewWebview;
