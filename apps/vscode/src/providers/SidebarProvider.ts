// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarProvider — Extension host provider for the tool-registry sidebar.
 *
 * The sidebar webview is a BUS REALM; this provider's host side is bus-
 * native: it serves the workspace-FS capability (host.fs.*) and the
 * file-keyed pipeline verbs (host.pipeline.openFile/runFile/...), publishes
 * the strip's tool rows (retained devtools:rows), the fronted tool document
 * (retained devtools:activeDoc), host-driven tab selection (signal
 * sidebar:modeSelect), and per-source diagnostics (signal
 * pipeline:sourceDiagnostics). Connection/auth/deploy state rides the
 * BusHost mirrors (shell:status / shell:deployStatus / shell:cloudAuth);
 * strip prefs are plain pref keys over host.prefs.*.
 *
 * The ONLY remaining postMessage traffic: sidebar:command (unrestricted
 * executeCommand — a deliberate host decision) and view:ready (the page-
 * lifecycle marker the watcher reset keys off — HTML rewrites reboot the
 * page without re-resolving the webview).
 *
 * The meatier concerns live in sibling modules:
 *   - sidebar/toolRows.ts      — pinned tool rows + catalog (icons inlined)
 *   - sidebar/pipelineFiles.ts — .pipe stamping invariant, restart-on-save,
 *                                and the open/run/stop actions
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';
import { isDeployRunBody } from 'shared/tools/pipelines/runKind';
import { getLogger } from '../shared/util/output';
import { getPipelineProvider } from '../extension';
import { DevToolStore } from './DevToolStore';
import type { BusHost } from './toolhost/busHost';
import { readPref, writePref } from './PrefsBag';
// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { PipelineHostOpMap } from 'shared/ops/pipelineOps';
import type { HostFsOpMap } from 'shared/ops/fsOps';
import { WorkspaceFsService } from './toolhost/workspaceFsService';
import { ToolRows } from './sidebar/toolRows';
import type { ToolRowDTO } from './sidebar/toolRows';
import { PipelineFiles } from './sidebar/pipelineFiles';

/** Prefs-bag key for the persisted sidebar mode. The webview reads and
 *  writes it over host.prefs.* (as it does 'sidebarTabOrder' and
 *  'disabledBuiltins'); the host only touches it in setModeExternal. */
const SIDEBAR_MODE_KEY = 'sidebarMode';

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();

	// ── Sidebar mode (persisted per workspace) ───────────────────────────────
	// NO App Builder state here: MY APPS discovery runs in the WEBVIEW's
	// AppDev controller (shared tools/appdev) over the generic workspace-FS
	// service — the extension host no longer knows what an .rrapp binding is.
	private sidebarMode: string = 'apps';

	private logger = getLogger();

	/** Generic workspace-FS capability for the webview's tool controllers. */
	private workspaceFs = new WorkspaceFsService();

	/** Pinned tool rows + the dev-tool catalog (icons inlined). */
	private toolRows: ToolRows;

	/** The host's .pipe concerns: stamping, restart-on-save, open/run/stop. */
	private pipelineFiles: PipelineFiles;

	/** The engine origin baked into the current webview HTML's CSP. */
	private htmlEngineOrigin = '';

	/** Detaches this webview's bus-realm attachment (fresh per resolve). */
	private detachBusRealm?: () => void;

	/**
	 * Creates the sidebar provider.
	 * Sets up file watchers and event listeners.
	 *
	 * @param extensionUri - The extension root for webview resources.
	 * @param context - Extension context; persists the sidebar mode across reloads.
	 * @param devTools - The pinned dev-tools store feeding the tool tabs.
	 * @param busHost - The shell bus root (this webview attaches as a spoke;
	 *   tool peer traffic rides its retained/signal lanes).
	 */
	constructor(private readonly extensionUri: vscode.Uri, private readonly context?: vscode.ExtensionContext, private readonly devTools?: DevToolStore, private readonly busHost?: BusHost) {
		// Restore the last mode (previously session-only — it died on reload)
		// and the persisted strip order.
		// DELIBERATE per-host default: 'apps' in VS Code, 'agent' on web. A
		// persisted mode whose tool is disabled falls back in SidebarChrome.
		this.sidebarMode = (this.context ? readPref<string>(this.context, SIDEBAR_MODE_KEY) : undefined) ?? 'apps';
		this.toolRows = new ToolRows(this.connectionManager, this.devTools, this.context);
		this.pipelineFiles = new PipelineFiles(this.connectionManager, this.configManager);
		// The workspace-FS capability (declared in shared/ops/fsOps) is served
		// HERE too: this provider owns the service and the watch lifecycle.
		// Events ride the realm-registered sidebar.fs.event op — broadcast;
		// only realms that registered the handler hear it, and they filter by
		// their own sub keys.
		if (this.busHost) {
			const busHost = this.busHost;
			registerOpHandlers<HostFsOpMap>(busHost.rootBus, {
				'host.fs.findFiles': (p) => this.workspaceFs.findFiles(p.include, p.exclude),
				'host.fs.workspaceRoots': () => this.workspaceFs.workspaceRoots(),
				'host.fs.readText': (p) => this.workspaceFs.readText(p.path),
				'host.fs.readBase64': (p) => this.workspaceFs.readBase64(p.path, p.maxBytes),
				'host.fs.watch': (p) => {
					this.workspaceFs.watch(p.sub, p.globs, (path) => busHost.broadcastEmitOp('sidebar.fs.event', { sub: p.sub, path }));
				},
				'host.fs.unwatch': (p) => {
					this.workspaceFs.unwatch(p.sub);
				},
			});
		}
		// The file-keyed pipeline verbs (declared in shared/ops/pipelineOps)
		// are served HERE: this provider owns the stamping/run/stop policy
		// module (pipelineFiles) they act through.
		if (this.busHost) {
			registerOpHandlers<PipelineHostOpMap>(this.busHost.rootBus, {
				'host.pipeline.openFile': (p) => {
					void this.pipelineFiles.openPipelineFile(p.fsPath);
				},
				'host.pipeline.runFile': (p) => {
					void this.pipelineFiles.runPipeline(p.fsPath, p.sourceId);
				},
				'host.pipeline.stopSource': (p) => {
					void this.pipelineFiles.stopPipeline(p.projectId, p.sourceId);
				},
				'host.pipeline.openStatus': async (p) => {
					await vscode.commands.executeCommand('rocketride.page.status.open', p.projectId, p.sourceId, p.displayName);
				},
			});
		}
		// Seed the retained rows topic with the last-known cache so a webview's
		// first paint (replay) already has its final tab set — the slow fresh
		// compose (icon fetches) replaces it in place, never reshuffles.
		this.publishToolRows(this.toolRows.cachedRows());
		this.disposables.push(...this.pipelineFiles.setupFileWatching());
		this.setupEventListeners();
		this.disposables.push({ dispose: () => this.workspaceFs.dispose() });
		// Pin/unpin from anywhere (the picker, the tool panel's Remove row)
		// refreshes the tabs.
		if (this.devTools) {
			const sub = this.devTools.onDidChange(() => this.pushToolsUpdate());
			this.disposables.push(sub);
		}
	}

	// =========================================================================
	// WEBVIEW LIFECYCLE
	// =========================================================================

	/** Called by VS Code when the sidebar view becomes visible for the first time. */
	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._view = webviewView;

		// Shell bus spoke: a re-resolved webview is a FRESH realm — detach
		// the previous attachment (rejects its in-flight requests, clears
		// its registrations) before attaching the new one.
		this.detachBusRealm?.();
		this.detachBusRealm = this.busHost?.attachWebview(webviewView.webview, 'sidebar');

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const html = this.getHtmlForWebview(webviewView.webview);
		webviewView.webview.html = html;

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						// A fresh page restarts its service-subscription ids —
						// drop the previous page's watchers. Everything the page
						// DISPLAYS replays off the retained topics.
						this.workspaceFs.resetSubscriptions();
						break;
					case 'sidebar:command':
						vscode.commands.executeCommand(message.command, ...(message.args ?? []));
						break;
				}
			} catch (error) {
				this.logger.error(`Sidebar message '${String((message as { type?: string })?.type)}' failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		webviewView.onDidDispose(() => {
			this.detachBusRealm?.();
			this.detachBusRealm = undefined;
			this._view = undefined;
		});
	}

	// =========================================================================
	// STRIP STATE
	// =========================================================================


	/**
	 * Sets the sidebar mode FROM THE HOST (a tool panel gained focus) —
	 * persists it and pushes a dedicated mode update (the full-update path
	 * deliberately seeds the webview's mode only once).
	 *
	 * @param mode - The mode to select (e.g. `tool:<appId>`).
	 */
	public setModeExternal(mode: string): void {
		this.sidebarMode = mode;
		if (this.context) void writePref(this.context, SIDEBAR_MODE_KEY, mode, 'workspace');
		// Reveal the RocketRide sidebar (keeping keyboard focus where it is)
		// so the tool's sidebar body is actually on screen, then switch its
		// strip to the tool's tab. A SIGNAL, not retained — a focus event,
		// not state (the persisted value is the pref).
		this._view?.show?.(true);
		this.busHost?.retained.signal('sidebar:modeSelect', { mode });
	}

	/**
	 * Publishes the editor's fronted tool document — the tool sidebar mounts
	 * follow it (highlight the fronted document, clear on null). RETAINED:
	 * replay covers a freshly booted webview. Both-null is a VALUE, not a
	 * retraction — "a non-tool tab is fronted" clears selections, which is
	 * different from "no signal yet" (mounts fall back to their own state).
	 *
	 * @param appId - The fronted tool's app id, or null for a non-tool tab.
	 * @param docKey - The fronted tool document's key, or null.
	 */
	public notifyToolActiveDoc(appId: string | null, docKey: string | null): void {
		this.busHost?.retained.publish('devtools:activeDoc', { appId, docKey });
	}

	/** Publishes fresh tool rows + catalog (pin/unpin, account change). */
	private pushToolsUpdate(): void {
		void Promise.all([this.toolRows.buildToolRows().catch((): ToolRowDTO[] => this.toolRows.cachedRows()), this.toolRows.buildAvailableTools().catch((): ToolRowDTO[] | undefined => undefined)]).then(([tools, available]) => {
			this.publishToolRows(tools, available);
		});
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/**
	 * Host-side listeners. Everything the webview DISPLAYS rides the retained
	 * mirrors now (shell:status / shell:deployStatus / shell:cloudAuth /
	 * shell:account — BusHost.startMirrors); what remains here is genuinely
	 * host work: the CSP reboot, the task monitor, fresh tool rows on
	 * identity changes, and the diagnostics fold.
	 */
	private setupEventListeners(): void {
		// connectionManager.on() returns the SHARED manager (a Node
		// EventEmitter), and ITS dispose() tears down the whole extension's
		// connection — disposal must wrap off() with the named handler.
		//
		// LOAD-BEARING: an engine-origin change invalidates the webview's CSP
		// (the dev-tool sidebar mounts load remote chunks from the engine) —
		// re-render the HTML; the rebooted realm replays its topics.
		const connStateHandler = () => {
			if (this._view && this.htmlEngineOrigin !== this.engineOrigin()) {
				this._view.webview.html = this.getHtmlForWebview(this._view.webview);
			}
		};
		this.connectionManager.on('shell:statusChange', connStateHandler);
		const connectedHandler = async () => {
			// Subscribe to task lifecycle events.
			// 'task' only: the wildcard 'output' subscription existed to feed
			// the removed Rocket Ride: Console mirror — per-editor monitors
			// subscribe to output themselves for the Log pane.
			const client = this.connectionManager.getClient();
			if (client) {
				client.addMonitor({ token: '*' }, ['task']).catch((err) => {
					this.logger.error(`Sidebar task-event subscription failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			// A fresh identity carries a fresh catalog (names, icons, store).
			this.pushToolsUpdate();
		};
		this.connectionManager.on('shell:connected', connectedHandler);
		const accountHandler = () => this.pushToolsUpdate();
		this.connectionManager.on('shell:accountUpdate', accountHandler);

		this.disposables.push(
			{ dispose: () => this.connectionManager.off('shell:statusChange', connStateHandler) },
			{ dispose: () => this.connectionManager.off('shell:connected', connectedHandler) },
			{ dispose: () => this.connectionManager.off('shell:accountUpdate', accountHandler) }
		);

		// Forward server events to webview
		// NO apaevt_task forwarding: the webview folds task events from its
		// OWN engine client now. Status updates still relay because they read
		// the canvas editor's host-side diagnostics cache (migrates with it).
		this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_status_update') {
				// Forward status updates (errors/warnings) to webview.
				// Deploy runs never touch the dev lists (THE one host-side
				// classifier, shared with PipelineProvider's status cache) —
				// their status belongs to the deployment surfaces, and the '*'
				// subscription delivers them here whenever a team-scoped run
				// is visible.
				if (isDeployRunBody(event.body)) return;
				const projectId = event.body?.project_id;
				const sourceId = event.body?.source;
				if (projectId && sourceId) {
					const statusProvider = getPipelineProvider();
					const ts = statusProvider?.getTaskStatus(projectId, sourceId);
					// A SIGNAL (fire-and-forget like the push it replaces): the
					// realm's diagnostics module keeps its own fold; per-source
					// retention would be a dynamically-keyed leak.
					this.busHost?.retained.signal('pipeline:sourceDiagnostics', {
						projectId,
						sourceId,
						errors: ts?.errors ?? [],
						warnings: ts?.warnings ?? [],
					});
				}
			}
		});
	}

	// =========================================================================
	// UPDATES
	// =========================================================================

	/**
	 * The Dev Tools panel's RESET after a publish: re-authenticates to pull
	 * a fresh app registry (manifests, versions) from the server, recreates
	 * any open tool panel whose mounted version went stale, and reboots THIS
	 * sidebar webview so its loaded devToolSidebar containers are dropped —
	 * a loaded MF remote cannot be repointed in a live realm. The reboot is
	 * cheap by design: retained bridge state replays into the fresh realm.
	 */
	public async refreshDevTools(): Promise<void> {
		try {
			await this.connectionManager.disconnect();
			await this.connectionManager.connect();
		} catch {
			// A failed reconnect surfaces through the normal status pipeline
			// (status bar, connection rows) — nothing extra to report here.
		}
		// Open frame panels first (each is its own webview realm; stale ones
		// are disposed and recreated against the fresh catalog) ...
		await vscode.commands.executeCommand('rocketride.devtool.refreshStale');
		// ... then this sidebar's own realm.
		if (this._view) {
			this._view.webview.html = this.getHtmlForWebview(this._view.webview);
		}
	}

	/**
	 * Publishes the strip's tool rows (RETAINED `devtools:rows` — replay
	 * seeds any webview, including one rebooted by a CSP change, with no
	 * handshake). `available` is OMITTED while the catalog is unknown
	 * (disconnected, cached-only seed, failed compose): the webview keeps its
	 * last catalog instead of wiping the Modules list.
	 */
	private publishToolRows(tools: ToolRowDTO[], available?: ToolRowDTO[]): void {
		this.busHost?.retained.publish('devtools:rows', { tools, ...(available ? { available } : {}) });
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/** Reads the static HTML template and rewrites resource URIs for the webview. */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'page-sidebar.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Dev-tool sidebar mounts load the tool's remote FROM THE ENGINE:
			// widen the CSP with the engine origin (scripts = remote chunks;
			// styles = the remote's async CSS chunks; connect = MF fetches +
			// the mount's SDK websocket). Computed at render time; an
			// engine-origin change re-renders the HTML (see the statusChange
			// listener).
			const origin = this.engineOrigin();
			this.htmlEngineOrigin = origin;
			if (origin) {
				const wsOrigin = origin.replace(/^http/, 'ws');
				htmlContent = htmlContent
					.replace(/script-src /, `script-src ${origin} `)
					.replace(/style-src /, `style-src ${origin} `)
					.replace(/connect-src /, `connect-src ${origin} ${wsOrigin} `)
					.replace(/img-src /, `img-src ${origin} `);
			}

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading sidebar: ${error}</p></body></html>`;
		}
	}

	/**
	 * The engine origin the webview CSP should carry. getHttpUrl() is total —
	 * the live engine URI when connected, the configured hostUrl (or the
	 * local default) otherwise — so the first render already bakes the origin
	 * the connection will land on: the common startup (sidebar resolves while
	 * connecting, engine lands seconds later) produces no CSP mismatch and no
	 * webview reboot. A disconnect keeps the last expected origin for the
	 * same reason; only a genuine engine switch changes it. '' only when the
	 * URL is unparsable.
	 */
	private engineOrigin(): string {
		try {
			return new URL(this.connectionManager.getHttpUrl() || '').origin;
		} catch {
			return '';
		}
	}

	/** Generates a 32-character random nonce for Content Security Policy. */
	private generateNonce(): string {
		// Cryptographic source — a CSP nonce must be unpredictable.
		return crypto.randomBytes(24).toString('base64url');
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Unsubscribes from task events and disposes all listeners. */
	public dispose(): void {
		const client = this.connectionManager.getClient();
		if (client) {
			client.removeMonitor({ token: '*' }, ['task']).catch(() => {});
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
