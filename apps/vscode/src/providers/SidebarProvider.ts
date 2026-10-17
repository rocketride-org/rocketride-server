// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarProvider — Extension host provider for the unified sidebar.
 *
 * Manages two independent connections:
 *   - ConnectionManager (dev) — where pipelines run during development
 *   - DeployManager (deploy) — where pipelines are deployed for production
 *
 * Finds and parses .pipe files, watches for file changes, forwards task
 * events from both connections to the webview, fetches team lists when
 * cloud-signed-in, and handles action messages (open, run, stop, mode
 * switch, team switch, deploy target switch).
 *
 * The webview (SidebarWebview.tsx) receives ProjectEntry[], task events,
 * connection state for both dev and deploy, team lists, and auth state.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../config';
import { ConnectionManager, isCloudConnected } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
// Deep import on purpose: the tools/pipelines BARREL exports the discovery
// controller, which carries sidebar view types the extension host's no-DOM
// compile must never see. parse.ts is the pure parsing contract.
import { parsePipelineContent } from 'shared/tools/pipelines/parse';
import type { ParsedPipelineFile, ServiceClassInfo } from 'shared/tools/pipelines/parse';
import { GenericEvent, PIPE_BUILDER_APP_ID } from '../shared/types';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { isDeployRunBody } from '../shared/util/runClassification';
import { checkMissingEnvVars } from '../shared/util/envVarCheck';
import { getLogger } from '../shared/util/output';
import { getProjectProvider } from '../extension';
import { DevToolStore } from './DevToolStore';
import { DevToolBridge } from './DevToolBridge';
import { WorkspaceFsService } from './toolhost/workspaceFsService';

/** workspaceState key for the persisted sidebar mode. */
const SIDEBAR_MODE_KEY = 'rr.sidebarMode';

/** workspaceState key for the persisted strip tab order. */
const TAB_ORDER_KEY = 'rr.sidebarTabOrder';

/** workspaceState key for the last-known pinned tool rows (name + inlined
 *  icon), keyed by app id — the strip seed renders from this cache before
 *  any connection exists, so tool tabs paint instantly in their final shape. */
const TOOL_META_KEY = 'rr.devToolMeta';

/** Upper bound on one tool-icon fetch — a hung engine endpoint degrades that
 *  icon, never the update it rides in. */
const ICON_FETCH_TIMEOUT_MS = 5000;

/** One pinned dev-tool row sent to the webview (shared ToolTab shape). */
interface ToolRowDTO {
	id: string;
	name: string;
	iconUrl?: string;
	version?: string;
	/** Short description (the modules list's second line). */
	description?: string;
	/** MF container name — the sidebar's devToolSidebar mount loads by it. */
	moduleId?: string;
	/** Registry version resolving the remote entry URL. */
	registryVersion?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// =============================================================================
// PROVIDER
// =============================================================================

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();
	private deployManager = DeployManager.getDeployInstance();

	// ── Sidebar mode (persisted per workspace) ───────────────────────────────
	// NO App Builder state here: MY APPS discovery runs in the WEBVIEW's
	// AppDev controller (shared tools/appdev) over the generic workspace-FS
	// service — the extension host no longer knows what an .rrapp binding is.
	private sidebarMode: string = 'apps';

	/** Persisted strip tab order (mode ids + `tool:<appId>` ids). */
	private tabOrder: string[] = [];

	private logger = getLogger();

	/** Generic workspace-FS capability for the webview's tool controllers. */
	private workspaceFs = new WorkspaceFsService();

	/**
	 * Creates the sidebar provider.
	 * Sets up file watchers and event listeners, and kicks off initial file load.
	 *
	 * @param extensionUri - The extension root for webview resources.
	 * @param context - Extension context; persists the sidebar mode across reloads.
	 * @param devTools - The pinned dev-tools store feeding the tool tabs.
	 */
	/** The engine origin baked into the current webview HTML's CSP. */
	private htmlEngineOrigin = '';

	constructor(private readonly extensionUri: vscode.Uri, private readonly context?: vscode.ExtensionContext, private readonly devTools?: DevToolStore, private readonly devToolBridge?: DevToolBridge) {
		// Restore the last mode (previously session-only — it died on reload)
		// and the persisted strip order.
		this.sidebarMode = this.context?.workspaceState.get<string>(SIDEBAR_MODE_KEY) ?? 'apps';
		this.tabOrder = this.context?.workspaceState.get<string[]>(TAB_ORDER_KEY) ?? [];
		this.setupFileWatching();
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

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const html = this.getHtmlForWebview(webviewView.webview);
		webviewView.webview.html = html;

		// Peer relay: panel→sidebar messages land here once the sidebar lives.
		this.devToolBridge?.registerSidebar((appId, payload) => {
			void this._view?.webview.postMessage({ type: 'devtool:peer', appId, payload });
		});

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				// Generic tool-host capability services (workspace FS for the
				// tool controllers running in this webview) — routed before
				// the UI messages; the host stays ignorant of what the
				// controllers are scanning for.
				if (this.workspaceFs.handle(message, (m) => void this._view?.webview.postMessage(m))) return;

				switch (message.type) {
					case 'view:ready':
						// A fresh page restarts its service-subscription ids —
						// drop the previous page's watchers before anything else.
						this.workspaceFs.resetSubscriptions();
						// Seed the mode strip FIRST (synchronous, from persisted
						// state alone) so its first paint already has the final
						// tab set and order — the full update below is slow
						// (icon fetches, dashboard) and must not be what shapes
						// the strip.
						this.sendStripSeed();
						this.sendFullUpdate();
						// Replay the fronted tool document — a fresh webview
						// must not boot with every tool sidebar unselected
						// while a tool tab is in front.
						void this._view?.webview.postMessage({ type: 'devtool:activeDoc', ...this.activeToolDoc });
						// Replay each tool's retained frame→sidebar state so a
						// reloaded sidebar re-renders its mounts without any
						// ask-the-frame handshake (peer direction discipline).
						this.devToolBridge?.replayRetainedToSidebar();
						if (this.connectionManager.isConnected()) {
							try {
								const client = this.connectionManager.getClient();
								const dashboard = client ? await client.getDashboard() : null;
								if (dashboard?.tasks) {
									this._view?.webview.postMessage({ type: 'dashboardSnapshot', tasks: dashboard.tasks });
								}
							} catch {
								/* ignore */
							}
						}
						break;
					case 'connect':
						await this.connectionManager.connect();
						break;
					case 'disconnect':
						await this.connectionManager.disconnect();
						break;
					case 'command':
						vscode.commands.executeCommand(message.command, ...(message.args ?? []));
						break;
					case 'openFile':
						this.openPipelineFile(message.fsPath);
						break;
					case 'runPipeline':
						this.runPipeline(message.fsPath, message.sourceId);
						break;
					case 'stopPipeline':
						this.stopPipeline(message.projectId, message.sourceId);
						break;
					case 'openUnknownTask':
						vscode.commands.executeCommand('rocketride.page.status.open', message.projectId, message.sourceId, message.displayName);
						break;
					case 'openApp':
						vscode.commands.executeCommand('rocketride.app.open', message.appId);
						break;
					case 'setSidebarMode':
						// Persisted per workspace and included in every full update
						// so a reloaded webview restores the user's last mode.
						this.sidebarMode = message.mode;
						void this.context?.workspaceState.update(SIDEBAR_MODE_KEY, message.mode);
						break;
					case 'openTool':
						vscode.commands.executeCommand('rocketride.devtool.open', message.toolId);
						break;
					case 'focusTool':
						// Strip tab selection: bring an open window of the tool
						// forward; never create one for a mere tab switch.
						vscode.commands.executeCommand('rocketride.devtool.reveal', message.toolId);
						break;
					case 'removeTool':
						this.devTools?.remove(message.toolId);
						break;
					case 'reorderTabs':
						// Full strip order (modes + tools) — persisted per
						// workspace; the webview already reordered optimistically.
						this.tabOrder = message.order;
						void this.context?.workspaceState.update(TAB_ORDER_KEY, message.order);
						break;
					case 'showToolReadme':
						vscode.commands.executeCommand('rocketride.devtool.readme', message.toolId);
						break;
					case 'devtool:peer':
						// Sidebar mount → the tool's frame panel (buffered while
						// the panel opens). Payloads are opaque to the host; by
						// the peer contract these are USER actions, so a message
						// to a closed panel summons it.
						this.devToolBridge?.toPanel(message.appId, message.payload);
						break;
					case 'openToolDocument':
						// A tool's sidebar mount opens one of ITS documents (the
						// DevToolProps.documents API) — e.g. a connection's tab.
						vscode.commands.executeCommand('rocketride.devtool.open', message.appId, message.docKey, message.title);
						break;
					case 'closeToolDocument':
						vscode.commands.executeCommand('rocketride.devtool.close', message.appId, message.docKey);
						break;
					case 'setDevelopmentMode':
						await this.configManager.updateConnectionMode('development', message.mode);
						this.sendFullUpdate();
						break;
					case 'setDeployTargetMode':
						await this.configManager.updateConnectionMode('deployment', message.mode);
						// Reconnect the DEPLOY manager (not dev) when deploy mode changes
						await this.deployManager.disconnect();
						await this.deployManager.initialize();
						this.sendFullUpdate();
						break;
				}
			} catch (error) {
				this.logger.error(`Sidebar message '${String((message as { type?: string })?.type)}' failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		webviewView.onDidDispose(() => {
			this._view = undefined;
		});
	}

	// =========================================================================
	// FILE WATCHING
	// =========================================================================

	/** Watches for .pipe / .pipe.json create/delete/change events in the workspace. */
	private setupFileWatching(): void {
		const watcherPipe = vscode.workspace.createFileSystemWatcher('**/*.pipe');
		const watcherPipeJson = vscode.workspace.createFileSystemWatcher('**/*.pipe.json');

		this.disposables.push(
			watcherPipe,
			watcherPipe.onDidCreate((uri) => this.handleFileCreated(uri)),
			watcherPipe.onDidChange((uri) => this.handleFileChanged(uri)),
			watcherPipeJson,
			watcherPipeJson.onDidCreate((uri) => this.handleFileCreated(uri)),
			watcherPipeJson.onDidChange((uri) => this.handleFileChanged(uri))
		);

		// NO .rrapp / package.json watchers here: app-binding discovery is the
		// webview AppDev controller's job (shared tools/appdev), watching
		// through the generic workspace-FS service.
	}

	// =========================================================================
	// DEV TOOLS (pinned tool tabs)
	// =========================================================================

	/** Fetched tool icons as data: URIs, by source URL — immutable per URL. */
	private toolIconCache = new Map<string, string>();

	/**
	 * Fetches an engine-served icon and inlines it as a data: URI — the same
	 * CSP story as the MY APPS rows (data: URIs): the webview renders
	 * instantly from the payload, with no cross-origin load to be blocked or
	 * to arrive late (the tab is hidden until its icon is in hand).
	 */
	private async iconDataUri(url: string): Promise<string | undefined> {
		const cached = this.toolIconCache.get(url);
		if (cached) return cached;
		// Time-boxed: this await chain sits inside the extras compose, and a
		// hung engine must cost this one icon, not stall the whole update.
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), ICON_FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: abort.signal });
			if (!res.ok) return undefined;
			const contentType = res.headers.get('content-type')?.split(';')[0] || 'image/svg+xml';
			const dataUri = `data:${contentType};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
			this.toolIconCache.set(url, dataUri);
			return dataUri;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Builds the pinned-tool rows: the workspace's pinned ids resolved against
	 * the connection's account apps (name, version, icon inlined as a data:
	 * URI). A pinned id the account no longer carries still rows up by id so
	 * the user can unpin it.
	 */
	private async buildToolRows(): Promise<ToolRowDTO[]> {
		const pinned = this.devTools?.getAll() ?? [];
		if (pinned.length === 0) return [];
		const base = (this.connectionManager.getHttpUrl() || '').replace(/\/$/, '');
		const apps = (this.connectionManager.getClient()?.getAccountInfo()?.apps ?? []) as Array<{ id: string; name?: string; icon?: string; version?: string; moduleId?: string; registryVersion?: number }>;
		const byId = new Map(apps.filter((a) => a?.id).map((a) => [a.id, a]));
		const cached = this.readToolMeta();
		const rows = await Promise.all(pinned.map(async (id): Promise<ToolRowDTO> => {
			const row = byId.get(id);
			// Not in the account payload (disconnected, or genuinely gone):
			// the last-known row keeps the tab stable; a never-seen id still
			// rows up bare so the user can unpin it.
			if (!row) return cached[id] ?? { id, name: id };
			const icon = row.icon;
			const iconUrl = icon ? (icon.startsWith('/') && base ? `${base}${icon}` : icon) : undefined;
			return {
				id,
				name: row.name ?? id,
				iconUrl: iconUrl ? await this.iconDataUri(iconUrl) : undefined,
				version: row.version,
				moduleId: row.moduleId,
				registryVersion: row.registryVersion,
			};
		}));
		// Persist the rows (fresh where resolved, last-known otherwise) keyed
		// by pinned id — the next boot's strip seed renders from this cache
		// before any connection exists. Unpinned ids fall out naturally.
		const meta = Object.fromEntries(rows.map((r) => [r.id, r]));
		if (JSON.stringify(meta) !== JSON.stringify(cached)) {
			void this.context?.workspaceState.update(TOOL_META_KEY, meta);
		}
		return rows;
	}

	/** The persisted last-known tool rows, by app id (see {@link TOOL_META_KEY}). */
	private readToolMeta(): Record<string, ToolRowDTO> {
		return this.context?.workspaceState.get<Record<string, ToolRowDTO>>(TOOL_META_KEY) ?? {};
	}

	/**
	 * Posts the synchronous strip bootstrap: pinned tool rows from the
	 * last-known cache, the persisted tab order, and the persisted mode. Sent
	 * on `view:ready` BEFORE the full update, so the strip's first paint
	 * already has its final tab set and order — late-resolving fresh rows
	 * replace the cached ones in place instead of reshuffling the strip.
	 */
	private sendStripSeed(): void {
		const pinned = this.devTools?.getAll() ?? [];
		const cached = this.readToolMeta();
		const tools = pinned.map((id): ToolRowDTO => cached[id] ?? { id, name: id });
		void this._view?.webview.postMessage({ type: 'stripSeed', tools, tabOrder: this.tabOrder, sidebarMode: this.sidebarMode });
	}

	/**
	 * Builds the full dev-tool catalog (the modules list): every account app
	 * carrying the devTool category, installed or not, icons inlined.
	 */
	private async buildAvailableTools(): Promise<ToolRowDTO[]> {
		if (!this.connectionManager.isConnected()) return [];
		const base = (this.connectionManager.getHttpUrl() || '').replace(/\/$/, '');
		const apps = (this.connectionManager.getClient()?.getAccountInfo()?.apps ?? []) as Array<{ id: string; name?: string; icon?: string; version?: string; description?: string; categories?: string[]; moduleId?: string; registryVersion?: number }>;
		const rows = apps.filter((a) => a?.id && a.categories?.some((c) => c.toLowerCase() === 'devtool'));
		const built = await Promise.all(rows.map(async (a) => {
			const iconUrl = a.icon ? (a.icon.startsWith('/') && base ? `${base}${a.icon}` : a.icon) : undefined;
			return {
				id: a.id,
				name: a.name ?? a.id,
				iconUrl: iconUrl ? await this.iconDataUri(iconUrl) : undefined,
				version: a.version,
				description: a.description,
				moduleId: a.moduleId,
				registryVersion: a.registryVersion,
			};
		}));
		return built.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Sets the sidebar mode FROM THE HOST (a tool panel gained focus) —
	 * persists it and pushes a dedicated mode update (the full-update path
	 * deliberately seeds the webview's mode only once).
	 *
	 * @param mode - The mode to select (e.g. `tool:<appId>`).
	 */
	public setModeExternal(mode: string): void {
		this.sidebarMode = mode;
		void this.context?.workspaceState.update(SIDEBAR_MODE_KEY, mode);
		// Reveal the RocketRide sidebar (keeping keyboard focus where it is)
		// so the tool's sidebar body is actually on screen, then switch its
		// strip to the tool's tab.
		this._view?.show?.(true);
		void this._view?.webview.postMessage({ type: 'modeUpdate', mode });
	}

	/** The fronted tool document (replayed to a freshly booted webview). */
	private activeToolDoc: { appId: string | null; docKey: string | null } = { appId: null, docKey: null };

	/**
	 * Relays the editor's fronted tool document to the sidebar webview — the
	 * tool sidebar mounts follow it (highlight the fronted document, clear on
	 * null).
	 *
	 * @param appId - The fronted tool's app id, or null for a non-tool tab.
	 * @param docKey - The fronted tool document's key, or null.
	 */
	public notifyToolActiveDoc(appId: string | null, docKey: string | null): void {
		this.activeToolDoc = { appId, docKey };
		void this._view?.webview.postMessage({ type: 'devtool:activeDoc', appId, docKey });
	}

	/** Pushes the fresh tool rows + catalog to the webview (pin/unpin, account change). */
	private pushToolsUpdate(): void {
		void Promise.all([this.buildToolRows(), this.buildAvailableTools()]).then(([tools, available]) => {
			this._view?.webview.postMessage({ type: 'toolsUpdate', tools, available });
		});
	}

	/** Handles a newly created .pipe file — assigns a project_id if missing. */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(raw).toString('utf8').trim();

			if (!text) {
				const parsed = { project_id: crypto.randomUUID(), components: [] };
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
			} else {
				try {
					const result = JSON.parse(text);
					if (result && typeof result === 'object' && !Array.isArray(result)) {
						const parsed = result as Record<string, unknown>;
						if (Array.isArray(parsed.components)) {
							const existingIds = await this.collectProjectIds(uri.fsPath);
							const projectId = typeof parsed.project_id === 'string' && parsed.project_id.trim() !== '' ? parsed.project_id : null;
							const isDuplicate = projectId !== null && existingIds.has(projectId);
							if (!projectId || isDuplicate) {
								parsed.project_id = crypto.randomUUID();
								await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
							}
						}
					}
				} catch {
					// Invalid JSON — leave as-is
				}
			}
		} catch {
			// File can't be read yet
		}
	}

	/** Re-parses a changed .pipe file, ensures project_id, and optionally restarts. */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(raw).toString('utf8');
			const trimmed = text.trim();

			if (!trimmed) {
				const parsed = { project_id: crypto.randomUUID(), components: [] };
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
			} else {
				try {
					const result = JSON.parse(text);
					if (result && typeof result === 'object' && !Array.isArray(result)) {
						const root = result as Record<string, unknown>;
						const target = root.pipeline && typeof root.pipeline === 'object' && !Array.isArray(root.pipeline) ? (root.pipeline as Record<string, unknown>) : root;
						if (Array.isArray(target.components)) {
							const existingIds = await this.collectProjectIds(uri.fsPath);
							const projectId = typeof target.project_id === 'string' && target.project_id.trim() !== '' ? target.project_id : null;
							const isDuplicate = projectId !== null && existingIds.has(projectId);
							if (!projectId || isDuplicate) {
								target.project_id = crypto.randomUUID();
								await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(result, null, 2), 'utf8'));
							}
						}
					}
				} catch {
					// Invalid JSON
				}
			}
		} catch {
			// File can't be read
		}

		// Re-parse the changed file for the restart decision only — the
		// sidebar's entry list is the webview controller's business now.
		const text = await this.readFileText(uri);
		if (text === null) return;
		const parsedFile = parsePipelineContent(text, uri.fsPath, this.getServiceClassInfoMap());

		// Handle pipeline restart based on configuration
		await this.handlePipelineRestart(uri, parsedFile);
	}

	/** Reads a file as UTF-8, or null when unreadable. */
	private async readFileText(uri: vscode.Uri): Promise<string | null> {
		try {
			return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			return null;
		}
	}

	/**
	 * The project_ids of every OTHER pipeline file in the workspace — the
	 * duplicate check behind project-id stamping. Collected on demand (this
	 * provider keeps no parse cache anymore; stamping is its one remaining
	 * .pipe concern — the always-on invariant).
	 *
	 * @param excludeFsPath - The file being stamped (its own id is not a duplicate).
	 * @returns The set of ids in use.
	 */
	private async collectProjectIds(excludeFsPath: string): Promise<Set<string>> {
		const ids = new Set<string>();
		const files = await vscode.workspace.findFiles('{**/*.pipe,**/*.pipe.json}', '**/node_modules/**');
		await Promise.all(files.filter((f) => f.fsPath !== excludeFsPath).map(async (file) => {
			const text = await this.readFileText(file);
			if (text === null) return;
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const body = (parsed.pipeline && typeof parsed.pipeline === 'object' ? parsed.pipeline : parsed) as Record<string, unknown>;
				if (typeof body.project_id === 'string' && body.project_id.trim() !== '') ids.add(body.project_id);
			} catch {
				// Not valid JSON — carries no claimable id.
			}
		}));
		return ids;
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	/** Subscribes to connection, deploy, config, and cloud-auth events. */
	private setupEventListeners(): void {
		// connectionManager.on()/deployManager.on() return the SHARED manager
		// (a Node EventEmitter), and ITS dispose() tears down the whole
		// extension's connection — disposal must wrap off() with the named
		// handler instead of disposing the return value.
		const connStateHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:statusChange', connStateHandler);
		const connectedHandler = async () => {
			// Subscribe to task lifecycle events
			const client = this.connectionManager.getClient();
			if (client) {
				// 'task' only: the wildcard 'output' subscription existed to feed
				// the removed Rocket Ride: Console mirror — per-editor monitors
				// subscribe to output themselves for the Log pane.
				client.addMonitor({ token: '*' }, ['task']).catch((err) => {
					this.logger.error(`Sidebar task-event subscription failed: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			// Teams come from ConnectResult — no fetch needed, just update the webview
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:connected', connectedHandler);
		const disconnectedHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:disconnected', disconnectedHandler);
		const errorHandler = () => {
			this.sendFullUpdate();
		};
		this.connectionManager.on('shell:error', errorHandler);
		const configChange = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendFullUpdate();
			}
		});

		// Re-parse when service definitions arrive

		// Re-fetch teams when cloud auth state changes (sign-in/sign-out)
		const cloudAuth = CloudAuthProvider.getInstance();
		const cloudAuthHandler = async () => {
			this.sendFullUpdate();
		};
		cloudAuth.onDidChange.on('changed', cloudAuthHandler);

		// ── Deploy manager events ────────────────────────────────────────────
		const deployConnStateHandler = () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:statusChange', deployConnStateHandler);
		const deployConnectedHandler = async () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:connected', deployConnectedHandler);
		const deployDisconnectedHandler = () => {
			this.sendFullUpdate();
		};
		this.deployManager.on('shell:disconnected', deployDisconnectedHandler);

		this.disposables.push(
			{ dispose: () => this.connectionManager.off('shell:statusChange', connStateHandler) },
			{ dispose: () => this.connectionManager.off('shell:connected', connectedHandler) },
			{ dispose: () => this.connectionManager.off('shell:disconnected', disconnectedHandler) },
			{ dispose: () => this.connectionManager.off('shell:error', errorHandler) },
			configChange,
			{ dispose: () => this.deployManager.off('shell:statusChange', deployConnStateHandler) },
			{ dispose: () => this.deployManager.off('shell:connected', deployConnectedHandler) },
			{ dispose: () => this.deployManager.off('shell:disconnected', deployDisconnectedHandler) },
			{ dispose: () => cloudAuth.onDidChange.removeListener('changed', cloudAuthHandler) }
		);

		// Forward server events to webview
		// NO apaevt_task forwarding: the webview folds task events from its
		// OWN engine client now. Status updates still relay because they read
		// the canvas editor's host-side diagnostics cache (migrates with it).
		this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_status_update') {
				// Forward status updates (errors/warnings) to webview.
				// Deploy runs never touch the dev lists (THE one host-side
				// classifier, shared with ProjectProvider's status cache) —
				// their status belongs to the deployment surfaces, and the '*'
				// subscription delivers them here whenever a team-scoped run
				// is visible.
				if (isDeployRunBody(event.body)) return;
				const projectId = event.body?.project_id;
				const sourceId = event.body?.source;
				if (projectId && sourceId) {
					const statusProvider = getProjectProvider();
					const ts = statusProvider?.getTaskStatus(projectId, sourceId);
					this._view?.webview.postMessage({
						type: 'statusUpdate',
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
	// DATA
	// =========================================================================

	/**
	 * Sends connection state + entries + apps to the webview — the
	 * SYNCHRONOUS local state only, posted with no awaits in front of it.
	 * After a CSP reboot this message is the wiped page's one shot at its
	 * rows, so nothing network-derived may sit between the call and the
	 * post. The slow fields (user identity, tool rows, catalog, devToolHost)
	 * follow out-of-band via {@link sendUpdateExtras}.
	 */
	private sendFullUpdate(): void {
		if (!this._view) return;

		// An engine-origin change invalidates the webview's CSP (the dev-tool
		// sidebar mounts load remote chunks from the engine): re-render the
		// HTML — the webview reboots and re-handshakes via view:ready.
		if (this.htmlEngineOrigin !== this.engineOrigin()) {
			this._view.webview.html = this.getHtmlForWebview(this._view.webview);
			return;
		}

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();
		const deployStatus = this.deployManager.getConnectionStatus();

		this._view.webview.postMessage({
			type: 'update',
			data: {
				// Dev connection
				connectionState: status.state,
				connectionMode: config.development.connectionMode,
				devProgressMessage: status.progressMessage,
				devProgressLogLine: status.progressLogLine,
				// Deploy connection
				deployConnectionState: deployStatus.state,
				deployConnectionMode: config.deployment.connectionMode,
				deployProgressMessage: deployStatus.progressMessage,
				deployProgressLogLine: deployStatus.progressLogLine,
				// Shared
				cloudConnected: isCloudConnected(),
				// Subscription
				isSubscribed: isSubscribed(this.connectionManager.getClient(), PIPE_BUILDER_APP_ID),
				// NO entries/tasks: the webview's PIPELINES CONTROLLER discovers
				// files itself and folds task events from its own client.
				sidebarMode: this.sidebarMode,
				tabOrder: this.tabOrder,
			},
		});

		// The network-derived half rides behind, individually guarded — a
		// hung icon fetch or a failed identity lookup must not cost the rows
		// just posted.
		void this.sendUpdateExtras();
	}

	/** Monotonic extras counter — a newer compose supersedes an in-flight one. */
	private extrasSeq = 0;

	/**
	 * Composes and posts the network-derived half of a full update: user
	 * identity, pinned tool rows, the dev-tool catalog, and the devToolHost
	 * connection facts. Every await is individually guarded so one bad
	 * endpoint degrades its own field — the sync update this follows is on
	 * screen either way.
	 */
	private async sendUpdateExtras(): Promise<void> {
		const mine = ++this.extrasSeq;
		const config = this.configManager.getConfig();

		// Resolve user identity from whichever connection is cloud-connected.
		// Dev takes priority; local/docker/service connections don't have real
		// user identity. The cloud-auth name is a fallback and optional.
		const devAccount = this.connectionManager.getClient()?.getAccountInfo();
		const deployAccount = this.deployManager.getClient()?.getAccountInfo();
		const account = (config.development.connectionMode === 'cloud' ? devAccount : null) ?? (config.deployment.connectionMode === 'cloud' ? deployAccount : null);
		let cloudName: string | undefined;
		if (!account?.displayName && isCloudConnected()) {
			try {
				cloudName = await CloudAuthProvider.getInstance().getUserName();
			} catch {
				/* identity is cosmetic — never block the update on it */
			}
		}
		const userName = account?.displayName || cloudName || undefined;
		const userEmail = account?.email || undefined;

		// Pinned tool rows: fall back to the last-known cache (the strip-seed
		// source) rather than wiping the tabs — an empty list would also drop
		// a selected tool mode back to Pipelines.
		const tools = await this.buildToolRows().catch((): ToolRowDTO[] => {
			const cached = this.readToolMeta();
			return (this.devTools?.getAll() ?? []).map((id) => cached[id] ?? { id, name: id });
		});
		const availableTools = await this.buildAvailableTools().catch((): ToolRowDTO[] => []);
		// Connection facts for the sidebar's devToolSidebar mounts (its own
		// SDK connection + remote entry URLs).
		const devToolHost = this.connectionManager.isConnected()
			? {
				engineHttpUrl: (this.connectionManager.getHttpUrl() || 'http://localhost:5565').replace(/\/$/, ''),
				authToken: await this.connectionManager.resolveAuthCredential().catch(() => ''),
			}
			: null;

		// Superseded by a newer full update, or the view died: drop silently.
		if (mine !== this.extrasSeq || !this._view) return;
		this._view.webview.postMessage({ type: 'extrasUpdate', userName, userEmail, tools, availableTools, devToolHost });
	}

	/** Returns the cached service class definitions (restart-flow parsing). */
	private getServiceClassInfoMap(): Record<string, ServiceClassInfo> | undefined {
		const cached = this.connectionManager.getCachedServices();
		return cached?.services as Record<string, ServiceClassInfo> | undefined;
	}

	// =========================================================================
	// PIPELINE ACTIONS
	// =========================================================================

	/** Opens a .pipe file in the custom editor. */
	private async openPipelineFile(fsPath: string): Promise<void> {
		try {
			// fsPath may be relative — resolve against workspace
			const uri = this.resolveFileUri(fsPath);
			await vscode.commands.executeCommand('vscode.openWith', uri, 'rocketride.PageProject');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open pipeline: ${error}`);
		}
	}

	/** Reads the pipeline JSON from disk and sends it to the engine via client.use(). */
	private async runPipeline(fsPath: string, sourceId?: string): Promise<void> {
		try {
			const uri = this.resolveFileUri(fsPath);
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));

			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			// Gate: check for missing ROCKETRIDE_* env vars
			const missing = await checkMissingEnvVars(client, pipelineJson);
			if (missing.length > 0) return;

			const pipeName = path.basename(fsPath).replace(/\.pipe(?:\.json)?$/, '');
			// Same per-task settings as editor launches (ProjectProvider.runPipeline)
			// — a pipeline must run identically regardless of where it is started.
			const cfg = ConfigManager.getInstance().getConfig();
			await client.use({
				pipeline: pipelineJson,
				source: sourceId ?? '',
				pipelineTraceLevel: cfg.pipelineTraceLevel,
				args: ConfigManager.getInstance().getTaskArgs(),
				name: pipeName,
				...(cfg.pipelineTtl !== undefined ? { ttl: cfg.pipelineTtl } : {}),
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to run pipeline: ${error}`);
		}
	}

	/** Terminates a running pipeline task by project + source. */
	private async stopPipeline(projectId: string, sourceId: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const token = await client.getTaskToken({ projectId, source: sourceId });
			if (token) await client.terminate(token);
		} catch (err) {
			console.error('[SidebarProvider] stopPipeline failed:', err);
		}
	}

	/** Restarts a running pipeline task with the latest file content. */
	private async restartPipeline(projectId: string, sourceId: string, uri: vscode.Uri): Promise<void> {
		try {
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const token = await client.getTaskToken({ projectId, source: sourceId });
			await client.restart({ token, projectId, source: sourceId, pipeline: pipelineJson });
		} catch (error) {
			console.error(`[SidebarProvider] restartPipeline failed: ${error}`);
			vscode.window.showErrorMessage(String(error));
		}
	}

	/** Resolves a relative path to a workspace URI, or treats it as absolute. */
	private resolveFileUri(filePath: string): vscode.Uri {
		if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
		const folders = vscode.workspace.workspaceFolders;
		if (folders?.length) return vscode.Uri.joinPath(folders[0].uri, filePath);
		return vscode.Uri.file(filePath);
	}

	// =========================================================================
	// PIPELINE RESTART ON SAVE
	// =========================================================================

	/** After a file save, optionally prompts or auto-restarts running pipeline tasks. */
	private async handlePipelineRestart(uri: vscode.Uri, parsedFile: ParsedPipelineFile): Promise<void> {
		if (!parsedFile.isValid || !parsedFile.projectId) return;

		const projectProvider = getProjectProvider();
		if (projectProvider?.isSaveForRun(uri)) return;

		// Check which sources are running by asking the webview... but we don't
		// have that state here anymore. Instead, check via the server directly.
		const client = this.connectionManager.getClient();
		if (!client) return;

		const runningComponents: { id: string; name?: string }[] = [];
		for (const c of parsedFile.sourceComponents) {
			try {
				const token = await client.getTaskToken({ projectId: parsedFile.projectId, source: c.id });
				if (token) runningComponents.push(c);
			} catch {
				// Not running
			}
		}

		if (runningComponents.length === 0) return;

		const config = this.configManager.getConfig();
		const restartBehavior = config?.pipelineRestartBehavior || 'prompt';
		const fileName = path.basename(uri.fsPath);

		switch (restartBehavior) {
			case 'manual':
				break;
			case 'auto':
				for (const c of runningComponents) {
					await this.restartPipeline(parsedFile.projectId!, c.id, uri);
				}
				break;
			case 'prompt': {
				const names = runningComponents.map((c) => c.name || c.id).join(', ');
				const msg = runningComponents.length === 1 ? `Pipeline component "${names}" in ${fileName} is running. Restart it?` : `${runningComponents.length} components (${names}) in ${fileName} are running. Restart them?`;
				const choice = await vscode.window.showInformationMessage(msg, 'Yes', 'No');
				if (choice === 'Yes') {
					for (const c of runningComponents) {
						await this.restartPipeline(parsedFile.projectId!, c.id, uri);
					}
				}
				break;
			}
		}
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
