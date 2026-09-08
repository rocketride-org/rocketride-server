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
import { PipelineFileParser, ParsedPipelineFile, ServiceClassInfo } from '../shared/util/pipelineParser';
import { GenericEvent, PIPE_BUILDER_APP_ID } from '../shared/types';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { isDeployRunBody } from '../shared/util/runClassification';
import { checkMissingEnvVars } from '../shared/util/envVarCheck';
import { getLogger } from '../shared/util/output';
import { getProjectProvider } from '../extension';
import { scanWorkspaceApps, appIconDataUri } from '../appdev/appScan';
import type { ScannedApp } from '../appdev/appScan';

// =============================================================================
// TYPES — App Builder sidebar rows (structural mirror of shared AppListItem)
// =============================================================================

/** One MY APPS row sent to the webview (shared AppListItem shape). */
interface AppRowDTO {
	id: string;
	name: string;
	status: 'local' | 'dev' | 'draft' | 'pending' | 'approved' | 'rejected' | 'live';
	folder?: string;
	/** Host-resolved icon (a data: URI here — loadable under the webview CSP
	 * regardless of localResourceRoots, which only cover the extension dir). */
	iconUrl?: string;
}

// =============================================================================
// TYPES — serialisable ProjectEntry sent to webview
// =============================================================================

interface ProjectEntryDTO {
	path: string;
	projectId?: string;
	sources?: { id: string; name: string; provider?: string }[];
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

	// ── Pipeline file state ──────────────────────────────────────────────────
	private parsedFiles = new Map<string, ParsedPipelineFile>();

	// ── App Builder state ────────────────────────────────────────────────────
	// Cached workspace scan (re-run on package.json events) and the current
	// sidebar mode (session-scoped; the webview restores it from updates).
	private scannedApps: ScannedApp[] = [];
	// Cached MY APPS rows — sendFullUpdate must not await the catalog RPC
	// (it would stall every webview update on a slow server); rescans
	// refresh this cache out-of-band and push appsUpdate when it lands.
	private appRows: AppRowDTO[] = [];
	/** Coalesces package.json event bursts into one workspace rescan. */
	private rescanTimer?: NodeJS.Timeout;
	/**
	 * Monotonic rescan counter (the fetchSeq pattern): connect/auth/watcher
	 * rescans overlap, and only the NEWEST run may commit its scan/rows —
	 * a slower earlier run must not overwrite fresher state.
	 */
	private rescanSeq = 0;
	private sidebarMode: 'pipelines' | 'apps' | 'nodes' = 'pipelines';

	private logger = getLogger();

	/**
	 * Creates the sidebar provider.
	 * Sets up file watchers and event listeners, and kicks off initial file load.
	 */
	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupFileWatching();
		this.setupEventListeners();
		this.loadPipelineFiles();
		void this.rescanApps();
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

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendFullUpdate();
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
					case 'refresh':
						await this.loadPipelineFiles();
						break;
					case 'openUnknownTask':
						vscode.commands.executeCommand('rocketride.page.status.open', message.projectId, message.sourceId, message.displayName);
						break;
					case 'openApp':
						vscode.commands.executeCommand('rocketride.app.open', message.appId);
						break;
					case 'setSidebarMode':
						// Session-scoped persistence: included in every full update
						// so a reloaded webview restores the user's last mode.
						this.sidebarMode = message.mode;
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
					case 'cloudSignIn': {
						const auth = CloudAuthProvider.getInstance();
						await auth.signIn(process.env.RR_ZITADEL_URL || '', process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '');
						break;
					}
				}
			} catch (error) {
				console.error('[SidebarProvider] Message handling error:', error);
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
			watcherPipe.onDidDelete((uri) => this.handleFileDeleted(uri)),
			watcherPipe.onDidChange((uri) => this.handleFileChanged(uri)),
			watcherPipeJson,
			watcherPipeJson.onDidCreate((uri) => this.handleFileCreated(uri)),
			watcherPipeJson.onDidDelete((uri) => this.handleFileDeleted(uri)),
			watcherPipeJson.onDidChange((uri) => this.handleFileChanged(uri))
		);

		// App bindings live in package.json appManifest blocks — any
		// package.json event can add/remove/rename an app. node_modules is
		// excluded (its package.json churn is enormous and never a binding).
		const watcherPkg = vscode.workspace.createFileSystemWatcher('**/package.json');
		const onPkgEvent = (uri: vscode.Uri): void => {
			if (uri.fsPath.includes('node_modules')) return;
			// Debounced: installs and branch switches touch many package.json
			// files at once — one rescan after the burst settles.
			if (this.rescanTimer) clearTimeout(this.rescanTimer);
			this.rescanTimer = setTimeout(() => {
				this.rescanTimer = undefined;
				void this.rescanApps();
			}, 500);
		};
		this.disposables.push(watcherPkg, watcherPkg.onDidCreate(onPkgEvent), watcherPkg.onDidDelete(onPkgEvent), watcherPkg.onDidChange(onPkgEvent), {
			dispose: () => { if (this.rescanTimer) clearTimeout(this.rescanTimer); },
		});
	}

	// =========================================================================
	// APP BUILDER (MY APPS)
	// =========================================================================

	/** Re-scans the workspace for app bindings and pushes the merged list. */
	private async rescanApps(): Promise<void> {
		// Capture this run's sequence; a newer rescan supersedes it at every
		// await point below.
		const mine = ++this.rescanSeq;
		const scanned = await scanWorkspaceApps();
		if (mine !== this.rescanSeq) return;
		this.scannedApps = scanned;
		const rows = await this.buildAppRows();
		if (mine !== this.rescanSeq) return;
		this.appRows = rows;
		if (this._view) {
			this._view.webview.postMessage({ type: 'appsUpdate', apps: this.appRows });
		}
	}

	/**
	 * Builds the MY APPS rows: the workspace scan merged with the server's
	 * list_mine statuses when cloud-signed-in. Merge key is the app id
	 * (bind, don't sync). Local-only rows read 'local'; server statuses win
	 * for bound apps; server-only apps appear without a folder.
	 */
	private async buildAppRows(): Promise<AppRowDTO[]> {
		const rows = new Map<string, AppRowDTO>();
		for (const app of this.scannedApps) {
			rows.set(app.id, { id: app.id, name: app.name, status: 'local', folder: app.folder, iconUrl: await appIconDataUri(app.icon) });
		}

		// Server statuses — best-effort: OSS engines reject the marketplace
		// command (NotImplementedError) and signed-out sessions have no org.
		try {
			const client = this.connectionManager.getClient();
			if (client && this.connectionManager.isConnected() && isCloudConnected()) {
				const res = (await client.call('rrext_app_catalog', { subcommand: 'list_mine' })) as { apps?: Array<{ id: string; name?: string; status?: string }> };
				for (const server of res?.apps ?? []) {
					const status = (server.status ?? 'draft') as AppRowDTO['status'];
					const bound = rows.get(server.id);
					if (bound) {
						bound.status = status;
					} else {
						rows.set(server.id, { id: server.id, name: server.name ?? server.id, status });
					}
				}
			}
		} catch {
			/* marketplace unavailable (OSS / signed out) — workspace rows stand */
		}

		return [...rows.values()];
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
							const existingIds = new Set([...this.parsedFiles.values()].map((f) => f.projectId).filter((id): id is string => typeof id === 'string' && id.trim() !== ''));
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
		await this.loadPipelineFiles();
	}

	/** Removes the deleted file from the parsed-files cache and updates the webview. */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		this.parsedFiles.delete(uri.fsPath);
		this.sendEntriesUpdate();
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
							const existingIds = new Set(
								[...this.parsedFiles.values()]
									.filter((f) => f.filePath !== uri.fsPath)
									.map((f) => f.projectId)
									.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
							);
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

		// Re-parse the changed file
		const parsedFile = await PipelineFileParser.parseFile(uri.fsPath, this.getServiceClassInfoMap());
		this.parsedFiles.set(uri.fsPath, parsedFile);

		this.sendEntriesUpdate();

		// Handle pipeline restart based on configuration
		await this.handlePipelineRestart(uri, parsedFile);
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
					console.error('[SidebarProvider] Failed to subscribe to task events:', err);
				});
			}
			// Teams come from ConnectResult — no fetch needed, just update the webview
			this.sendFullUpdate();
			// Server app statuses arrive out-of-band: sendFullUpdate posts the
			// cached rows, so refresh the cache now that the server answers.
			void this.rescanApps();
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
		const servicesUpdatedHandler = () => {
			this.loadPipelineFiles();
		};
		this.connectionManager.on('shell:servicesUpdated', servicesUpdatedHandler);

		// Re-fetch teams when cloud auth state changes (sign-in/sign-out)
		const cloudAuth = CloudAuthProvider.getInstance();
		const cloudAuthHandler = async () => {
			this.sendFullUpdate();
			// Sign-in/sign-out changes which server statuses list_mine returns
			void this.rescanApps();
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
			{ dispose: () => this.connectionManager.off('shell:servicesUpdated', servicesUpdatedHandler) },
			{ dispose: () => this.deployManager.off('shell:statusChange', deployConnStateHandler) },
			{ dispose: () => this.deployManager.off('shell:connected', deployConnectedHandler) },
			{ dispose: () => this.deployManager.off('shell:disconnected', deployDisconnectedHandler) },
			{ dispose: () => cloudAuth.onDidChange.removeListener('changed', cloudAuthHandler) }
		);

		// Forward server events to webview
		this.connectionManager.on('shell:event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_task') {
				// Forward task event to webview for state tracking
				this._view?.webview.postMessage({
					type: 'taskEvent',
					event: event.body,
				});
			} else if (event?.event === 'apaevt_status_update') {
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

	/** Sends connection state + entries + user identity to the webview. */
	private async sendFullUpdate(): Promise<void> {
		if (!this._view) return;

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();

		// Resolve user identity from whichever connection is cloud-connected.
		// Dev takes priority; local/docker/service connections don't have real user identity.
		const devAccount = this.connectionManager.getClient()?.getAccountInfo();
		const deployAccount = this.deployManager.getClient()?.getAccountInfo();
		const account = (config.development.connectionMode === 'cloud' ? devAccount : null) ?? (config.deployment.connectionMode === 'cloud' ? deployAccount : null);

		const cloudAuth = CloudAuthProvider.getInstance();
		const cloudConnected = isCloudConnected();

		const userName = account?.displayName || (cloudConnected ? await cloudAuth.getUserName() : undefined) || undefined;
		const userEmail = account?.email || undefined;

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
				cloudConnected,
				userName: userName || undefined,
				userEmail: userEmail || undefined,
				// Subscription
				isSubscribed: isSubscribed(this.connectionManager.getClient(), PIPE_BUILDER_APP_ID),
				// Pipeline data
				entries: this.buildEntries(),
				unknownTasks: [],
				// App Builder (MY APPS) — the cached rows; rescanApps refreshes
				// them out-of-band so this update never awaits the catalog RPC
				apps: this.appRows,
				sidebarMode: this.sidebarMode,
			},
		});
	}

	/** Sends only updated entries. */
	private sendEntriesUpdate(): void {
		if (!this._view) return;
		this._view.webview.postMessage({
			type: 'entriesUpdate',
			entries: this.buildEntries(),
		});
	}

	// =========================================================================
	// PIPELINE FILE LOADING
	// =========================================================================

	/** Scans the workspace for .pipe / .pipe.json files, parses them, and updates the webview. */
	private async loadPipelineFiles(): Promise<void> {
		const [pipeFiles, pipeJsonFiles] = await Promise.all([vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**'), vscode.workspace.findFiles('**/*.pipe.json', '**/node_modules/**')]);
		const files = [...pipeFiles, ...pipeJsonFiles];

		this.parsedFiles.clear();

		for (const uri of files) {
			const parsedFile = await PipelineFileParser.parseFile(uri.fsPath, this.getServiceClassInfoMap());
			this.parsedFiles.set(uri.fsPath, parsedFile);
		}

		vscode.commands.executeCommand('setContext', 'rocketride.noPipelineFiles', files.length === 0);
		this.sendEntriesUpdate();
	}

	/** Returns the cached service class definitions (used to resolve source display names). */
	private getServiceClassInfoMap(): Record<string, ServiceClassInfo> | undefined {
		const cached = this.connectionManager.getCachedServices();
		return cached?.services as Record<string, ServiceClassInfo> | undefined;
	}

	// =========================================================================
	// ENTRY BUILDER
	// =========================================================================

	/** Builds the flat ProjectEntry[] array for the webview. */
	private buildEntries(): ProjectEntryDTO[] {
		const services = this.connectionManager.getCachedServices()?.services ?? {};
		const entries: ProjectEntryDTO[] = [];

		for (const [fsPath, pf] of this.parsedFiles) {
			const relativePath = vscode.workspace.asRelativePath(fsPath);

			if (!pf.isValid) {
				entries.push({ path: relativePath });
				continue;
			}

			// Build sources with resolved display names
			const sources = pf.sourceComponents
				.map((sc) => {
					const providerDef = sc.provider ? (services[sc.provider] as { title?: string } | undefined) : undefined;
					return {
						id: sc.id,
						name: sc.name || providerDef?.title || sc.id,
						provider: sc.provider,
					};
				})
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			entries.push({
				path: relativePath,
				projectId: pf.projectId,
				sources,
			});
		}

		entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
		return entries;
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
				...(cfg.pipelineReplicas > 0 ? { replicas: cfg.pipelineReplicas } : {}),
				...(cfg.pipelineTorchThreads > 0 ? { torchThreads: cfg.pipelineTorchThreads } : {}),
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

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading sidebar: ${error}</p></body></html>`;
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
