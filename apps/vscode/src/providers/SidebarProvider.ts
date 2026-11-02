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
import { decidePipeFile, emptyPipelineSkeleton, readPipeProjectId, withProjectId, EMPTY_FILE_SETTLE_MS } from '../shared/util/pipeFileDecision';
import type { PipeFileEvent } from '../shared/util/pipeFileDecision';
import { SerialQueue } from '../shared/util/serialQueue';
import { ReloadingCache, isUnderNodeModules } from '../shared/util/reloadingCache';
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

/** Resolves after `ms`: the watcher's "give the other writer a moment" wait. */
function settle(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();
	private deployManager = DeployManager.getDeployInstance();

	// ── Pipeline file state ──────────────────────────────────────────────────
	/**
	 * The parsed .pipe files, keyed by path. Handlers write through
	 * cacheParsedFile; loadPipelineFiles rebuilds the map and installs it in
	 * one assignment, with the writes made meanwhile re-applied, and of two
	 * overlapping reloads only the newer installs (see ReloadingCache).
	 */
	private cache = new ReloadingCache<ParsedPipelineFile>();
	/**
	 * Created files are handled one at a time, behind the initial load. Each
	 * handler judges its file against parsedFiles and adds its file to
	 * parsedFiles afterwards, so two running side by side would each see a
	 * cache without the other's file, and a project_id the two share would go
	 * unreported.
	 */
	private createdFileQueue = new SerialQueue();

	// ── App Builder state ────────────────────────────────────────────────────
	// Cached workspace scan (re-run on .rrapp / package.json events) and the
	// current sidebar mode (session-scoped; the webview restores it from updates).
	private scannedApps: ScannedApp[] = [];
	// Cached MY APPS rows — building them reads icon files off disk, and
	// sendFullUpdate must not await that; rescans refresh this cache
	// out-of-band and push appsUpdate when it lands.
	private appRows: AppRowDTO[] = [];
	/** Coalesces .rrapp / package.json event bursts into one workspace rescan. */
	private rescanTimer?: NodeJS.Timeout;
	/**
	 * Monotonic rescan counter (the fetchSeq pattern): connect/auth/watcher
	 * rescans overlap, and only the NEWEST run may commit its scan/rows —
	 * a slower earlier run must not overwrite fresher state.
	 */
	private rescanSeq = 0;
	private sidebarMode: 'pipelines' | 'apps' | 'nodes' = 'apps';

	private logger = getLogger();

	/** The installed parsed-file cache, read only; writes go through cacheParsedFile. */
	private get parsedFiles(): ReadonlyMap<string, ParsedPipelineFile> {
		return this.cache.entries;
	}
	/** Set by dispose(): a settle wait that outlives the provider must not write. */
	private disposed = false;
	/** `<fsPath>\n<project_id>` pairs the duplicate warning was already shown for. */
	private duplicatePromptsShown = new Set<string>();

	/**
	 * Creates the sidebar provider.
	 * Sets up file watchers and event listeners, and kicks off initial file load.
	 */
	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupFileWatching();
		this.setupEventListeners();
		// First on the created-file queue: no created file is judged against a
		// cache the initial load is still filling.
		void this.createdFileQueue
			.enqueue(() => this.loadPipelineFiles())
			.catch((error) => {
				this.logger.error(`Initial pipeline file load failed (${error instanceof Error ? error.message : String(error)}).`);
			});
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

	/**
	 * Watches for .pipe / .pipe.json create/delete/change events in the workspace.
	 *
	 * findFiles excludes node_modules; the watcher does not, and the default
	 * files.watcherExclude leaves a top-level node_modules/x.pipe through. Every
	 * event is filtered here, once, by whole path segment, before any handler
	 * runs: a .pipe file inside an installed package is never written to (the
	 * created and changed reconciles write) and never cached (a reload would not
	 * list it, so it would appear and vanish).
	 */
	private setupFileWatching(): void {
		const watcherPipe = vscode.workspace.createFileSystemWatcher('**/*.pipe');
		const watcherPipeJson = vscode.workspace.createFileSystemWatcher('**/*.pipe.json');
		const outsideNodeModules =
			(handle: (uri: vscode.Uri) => void) =>
			(uri: vscode.Uri): void => {
				// Relative to the workspace folder, the way findFiles applies its exclude.
				if (isUnderNodeModules(vscode.workspace.asRelativePath(uri, false))) return;
				handle(uri);
			};

		this.disposables.push(
			watcherPipe,
			watcherPipe.onDidCreate(outsideNodeModules((uri) => this.enqueueCreatedFile(uri))),
			watcherPipe.onDidDelete(outsideNodeModules((uri) => this.handleFileDeleted(uri))),
			watcherPipe.onDidChange(outsideNodeModules((uri) => this.handleFileChanged(uri))),
			watcherPipeJson,
			watcherPipeJson.onDidCreate(outsideNodeModules((uri) => this.enqueueCreatedFile(uri))),
			watcherPipeJson.onDidDelete(outsideNodeModules((uri) => this.handleFileDeleted(uri))),
			watcherPipeJson.onDidChange(outsideNodeModules((uri) => this.handleFileChanged(uri)))
		);

		// App discovery is .rrapp-driven, and the marker's adjacent
		// package.json (appManifest block) verifies the binding — events on
		// either can add/remove/rename an app. node_modules is excluded (its
		// package.json churn is enormous and never a binding).
		const watcherMarker = vscode.workspace.createFileSystemWatcher('**/*.rrapp');
		const watcherPkg = vscode.workspace.createFileSystemWatcher('**/package.json');
		// Debounced: installs and branch switches touch many binding files at
		// once — one rescan after the burst settles.
		const scheduleRescan = (): void => {
			if (this.rescanTimer) clearTimeout(this.rescanTimer);
			this.rescanTimer = setTimeout(() => {
				this.rescanTimer = undefined;
				void this.rescanApps();
			}, 500);
		};
		const onBindingEvent = (uri: vscode.Uri): void => {
			// Workspace-relative, the way the app scan applies its exclude.
			if (isUnderNodeModules(vscode.workspace.asRelativePath(uri, false))) return;
			scheduleRescan();
		};
		this.disposables.push(
			watcherMarker,
			watcherMarker.onDidCreate(onBindingEvent),
			watcherMarker.onDidDelete(onBindingEvent),
			watcherMarker.onDidChange(onBindingEvent),
			watcherPkg,
			watcherPkg.onDidCreate(onBindingEvent),
			watcherPkg.onDidDelete(onBindingEvent),
			watcherPkg.onDidChange(onBindingEvent),
			// Adding/removing a workspace folder fires no binding-file event, but
			// scanWorkspaceApps only searches the CURRENT folder set — rescan so
			// MY APPS never goes stale against a changed workspace.
			vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRescan()),
			{
				dispose: () => { if (this.rescanTimer) clearTimeout(this.rescanTimer); },
			}
		);
	}

	// =========================================================================
	// APP BUILDER (MY APPS)
	// =========================================================================

	/** Re-scans the workspace for .rrapp-bound apps and pushes the fresh rows. */
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
	 * Builds the MY APPS rows from the workspace scan alone: every row is a
	 * .rrapp-bound working copy. The server catalog is deliberately not
	 * consulted — the sidebar lists what is on disk, nothing else.
	 */
	private async buildAppRows(): Promise<AppRowDTO[]> {
		const rows: AppRowDTO[] = [];
		for (const app of this.scannedApps) {
			rows.push({ id: app.id, name: app.name, folder: app.folder, iconUrl: await appIconDataUri(app.icon) });
		}
		// Scan order is marker-path order (a binding-priority detail); the
		// list the user sees sorts by display name.
		rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		return rows;
	}

	/**
	 * Queues a created .pipe file for handleFileCreated. Files created together
	 * (a checkout, a copied folder) arrive as a burst of events; handled side by
	 * side, each would be judged against a cache that holds none of the others.
	 * A handler that fails is logged and does not hold up the next one.
	 */
	private enqueueCreatedFile(uri: vscode.Uri): void {
		void this.createdFileQueue
			.enqueue(() => this.handleFileCreated(uri))
			.catch((error) => {
				this.logger.error(`Pipeline ${vscode.workspace.asRelativePath(uri)}: create handling failed (${error instanceof Error ? error.message : String(error)}).`);
			});
	}

	/**
	 * Handles a newly created .pipe file. A genuinely new, empty file gets the
	 * starter skeleton and a pipeline without a project_id gets one; see
	 * reconcileProjectId for what the watcher may and may not write. Runs on
	 * createdFileQueue, one file at a time and after the initial load. Only
	 * the created file is parsed into the cache, as handleFileChanged does: a
	 * checkout that adds a hundred files must not run a hundred workspace
	 * scans, and the next queued file needs no more than this one's entry.
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		// The queue can hold a file past dispose(), and dispose() can land during
		// the settle wait inside reconcileProjectId; a disposed provider has
		// nothing to refresh.
		if (this.disposed) return;
		// node_modules events never get here: setupFileWatching filters them.
		await this.reconcileProjectId(uri, 'created');
		if (this.disposed) return;
		const text = await this.readPipeText(uri);
		// Gone again already (a checkout, a temporary file): nothing to show.
		if (text === undefined) return;
		this.cacheParsedFile(uri.fsPath, PipelineFileParser.parseContent(text, uri.fsPath, this.getServiceClassInfoMap()));
		vscode.commands.executeCommand('setContext', 'rocketride.noPipelineFiles', false);
		this.sendEntriesUpdate();
	}

	/** Removes the deleted file from the parsed-files cache and updates the webview. */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		if (this.disposed) return;
		this.cacheParsedFile(uri.fsPath, null);
		this.sendEntriesUpdate();
	}

	/** Re-parses a changed .pipe file, ensures project_id, and optionally restarts. */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		await this.reconcileProjectId(uri, 'changed');
		// dispose() can land during the settle wait inside reconcileProjectId.
		if (this.disposed) return;

		// Re-parse the changed file. Deleted meanwhile (a checkout, a temporary
		// file): the delete handler already dropped it, and a parse of a missing
		// path must not put it back as an invalid entry.
		const text = await this.readPipeText(uri);
		if (this.disposed) return;
		if (text === undefined) {
			this.cacheParsedFile(uri.fsPath, null);
			this.sendEntriesUpdate();
			return;
		}
		const parsedFile = PipelineFileParser.parseContent(text, uri.fsPath, this.getServiceClassInfoMap());
		this.cacheParsedFile(uri.fsPath, parsedFile);

		this.sendEntriesUpdate();

		// Handle pipeline restart based on configuration
		await this.handlePipelineRestart(uri, parsedFile);
	}

	/**
	 * The one way a watcher handler writes to the parsed-file cache. A reload
	 * in progress builds its own map and would drop the write on its swap, so
	 * the cache also records the write for the reload to re-apply. `null`
	 * deletes.
	 */
	private cacheParsedFile(fsPath: string, parsed: ParsedPipelineFile | null): void {
		this.cache.write(fsPath, parsed);
	}

	// =========================================================================
	// PROJECT ID RECONCILIATION (issue #2466)
	// =========================================================================

	/**
	 * The only path through which the watcher writes to a user's file. What
	 * happens is decided by the pure decidePipeFile(); this method reads,
	 * waits, prompts and writes.
	 */
	private async reconcileProjectId(uri: vscode.Uri, event: PipeFileEvent, settled = false): Promise<void> {
		if (this.disposed) return;
		const text = await this.readPipeText(uri);
		// Not readable (not there yet, or already gone): nothing to decide.
		if (text === undefined) return;

		const decision = decidePipeFile({ event, filePath: uri.fsPath, text, known: [...this.parsedFiles.values()], settled });
		switch (decision.kind) {
			case 'leave':
				return;
			case 'confirm-empty':
				// A file another program is still saving reads as empty for a
				// moment. Look again once it has had time to land.
				await settle(EMPTY_FILE_SETTLE_MS);
				await this.reconcileProjectId(uri, event, true);
				return;
			case 'seed-empty': {
				// Only reachable through the settled re-entry above. Look once more
				// right before writing: a save that landed since the settled read
				// must not be replaced by the skeleton. writePipeText re-checks the
				// disposed flag.
				const latest = await this.readPipeText(uri);
				if (latest === undefined || latest.trim() !== '') return;
				await this.writePipeText(uri, emptyPipelineSkeleton(crypto.randomUUID()), 'new empty file, wrote the starter pipeline');
				return;
			}
			case 'assign-id':
				// Only a pipeline without a usable id gets here; assignProjectId
				// re-reads the file and writes only while that is still so.
				await this.assignProjectId(uri, null, 'had no project_id, assigned one');
				return;
			case 'ask-duplicate':
				// Deliberately not awaited: the warning stays open until the user
				// acts, and the rest of the handler (sidebar refresh, re-parse,
				// restart) must not wait for that. The prompt is marked as shown
				// before it opens and both files are re-read before any write, so
				// a detached, late answer is safe.
				void this.offerNewProjectId(uri, decision.projectId, decision.otherPath).catch((error) => {
					this.logger.error(`Pipeline ${vscode.workspace.asRelativePath(uri)}: duplicate id prompt failed (${error instanceof Error ? error.message : String(error)}).`);
				});
				return;
		}
	}

	/**
	 * Writes a fresh project_id into the file, keeping its formatting. The file
	 * is read again first and left alone if its id is no longer `expectedId`:
	 * the user may have edited it since the decision was made (the duplicate
	 * warning can sit open for a long time).
	 */
	private async assignProjectId(uri: vscode.Uri, expectedId: string | null, why: string): Promise<void> {
		const text = await this.readPipeText(uri);
		if (text === undefined || readPipeProjectId(text) !== expectedId) return;
		const next = withProjectId(text, crypto.randomUUID());
		if (next === undefined) return;
		await this.writePipeText(uri, next, why);
	}

	/**
	 * A genuine duplicate: another file carries the same id. Nothing is written
	 * unless the user asks for it. The clash is confirmed against the disk
	 * first, because a rename delivers delete and create in no fixed order and
	 * the cache can briefly still hold the file's previous path, and again
	 * after the user answers, because the warning can stay open for a long
	 * time and the clash may have been resolved meanwhile.
	 */
	private async offerNewProjectId(uri: vscode.Uri, projectId: string, otherPath: string): Promise<void> {
		const other = await PipelineFileParser.parseFile(otherPath, this.getServiceClassInfoMap());
		if (other.projectId !== projectId) return;

		const file = vscode.workspace.asRelativePath(uri);
		const otherFile = vscode.workspace.asRelativePath(otherPath);
		this.logger.info(`Pipeline ${file}: project_id ${projectId} is also used by ${otherFile}. File left unchanged.`);

		// Ask once per file and id for the session: every save of a file the
		// user chose to keep as it is would otherwise ask again.
		const promptKey = `${uri.fsPath}\n${projectId}`;
		if (this.duplicatePromptsShown.has(promptKey)) return;
		this.duplicatePromptsShown.add(promptKey);

		const assign = 'Assign new id';
		// Defence in depth: VS Code renders [label](target) in notification text
		// as a link, and a file name in a cloned repository can contain that
		// syntax. Break it so the warning carries no link the extension did not write.
		const plain = (name: string): string => name.replace(/\]\(/g, '] (');
		const choice = await vscode.window.showWarningMessage(`${plain(file)} has the same project_id as ${plain(otherFile)}. Pipelines with the same id cannot be told apart when they run. The file was not changed.`, assign);
		if (choice !== assign) return;
		// The warning can stay open for minutes: rewrite only while the clash still exists.
		const stillOther = await PipelineFileParser.parseFile(otherPath, this.getServiceClassInfoMap());
		if (stillOther.projectId !== projectId) return;
		await this.assignProjectId(uri, projectId, `duplicate of ${otherFile}, new id assigned at the user's request`);
	}

	/** The file's text, or undefined when it cannot be read (not there yet, or gone). */
	private async readPipeText(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			return undefined;
		}
	}

	/** Writes `text` to the file and records why in the output channel. */
	private async writePipeText(uri: vscode.Uri, text: string, why: string): Promise<void> {
		// Every write path awaits a read or a prompt first, and the provider
		// may be disposed meanwhile. Checked here so no path can forget it.
		if (this.disposed) return;
		const file = vscode.workspace.asRelativePath(uri);
		try {
			await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
			this.logger.info(`Pipeline ${file}: ${why}.`);
		} catch (error) {
			this.logger.error(`Pipeline ${file}: write failed (${error instanceof Error ? error.message : String(error)}).`);
		}
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
			void this.loadPipelineFiles().catch((error) => {
				this.logger.error(`Pipeline file reload after a services update failed (${error instanceof Error ? error.message : String(error)}).`);
			});
		};
		this.connectionManager.on('shell:servicesUpdated', servicesUpdatedHandler);

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

	/**
	 * Scans the workspace for .pipe / .pipe.json files, parses them, and updates
	 * the webview. The cache is replaced in one assignment once every file is
	 * parsed: the refresh button and a services update reload outside the
	 * created-file queue, and a handler deciding during such a reload must see
	 * the previous cache whole, not one being refilled.
	 *
	 * The delete and change handlers write to that previous cache meanwhile,
	 * and the swap would drop their writes: a file deleted during the reload
	 * would come back, a changed one would keep its old sources and id. The
	 * cache records their writes and re-applies them after the swap. Of two
	 * overlapping reloads only the newer installs its map; the older waits for
	 * the newer to finish before it returns, whether it was superseded while
	 * parsing or failed, so the created-file queue, which runs the initial
	 * load first, continues against the newer reload's map, or, when that
	 * reload failed, against the current one (ReloadingCache holds this logic,
	 * with its tests).
	 *
	 * Invariant that keeps the queue deadlock-free: only the initial load runs
	 * on createdFileQueue. The refresh button and a services update reload
	 * outside it on purpose; a queued load awaiting settled() on a load queued
	 * behind it would wait on itself (see serialQueue.ts).
	 */
	private async loadPipelineFiles(): Promise<void> {
		const seq = this.cache.beginReload();
		let parsed: Map<string, ParsedPipelineFile>;
		try {
			const [pipeFiles, pipeJsonFiles] = await Promise.all([vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**'), vscode.workspace.findFiles('**/*.pipe.json', '**/node_modules/**')]);
			parsed = new Map<string, ParsedPipelineFile>();
			for (const uri of [...pipeFiles, ...pipeJsonFiles]) {
				parsed.set(uri.fsPath, await PipelineFileParser.parseFile(uri.fsPath, this.getServiceClassInfoMap()));
			}
		} catch (error) {
			// Nothing to install. When this was the newest reload, whoever waits on
			// it goes on with the current cache; when a newer one is in flight, wait
			// for it like a superseded load does, so the created-file queue does
			// not run against the constructor's empty map because a scan failed.
			this.cache.finishReload(seq, undefined);
			await this.cache.settled();
			throw error;
		}

		if (!this.cache.finishReload(seq, parsed)) {
			// A newer reload has started since: it saw everything this one saw.
			// Wait for it, so whatever is queued behind this load finds its map.
			await this.cache.settled();
			return;
		}

		vscode.commands.executeCommand('setContext', 'rocketride.noPipelineFiles', this.parsedFiles.size === 0);
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
		this.disposed = true;
		const client = this.connectionManager.getClient();
		if (client) {
			client.removeMonitor({ token: '*' }, ['task']).catch(() => {});
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
