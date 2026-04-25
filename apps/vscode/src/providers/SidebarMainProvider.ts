// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMainProvider — Unified RocketRide sidebar webview provider.
 *
 * Replaces PageConnectionProvider + SidebarFilesProvider with a single
 * webview containing navigation, pipeline file tree, and connection status.
 *
 * Pipeline file watching, parsing, active-task tracking, project-ID dedup,
 * unknown-task detection, and error/warning aggregation all live here in
 * the extension host.  The React webview receives a flat serialisable
 * snapshot via postMessage and renders the tree.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { DashboardResponse, DashboardTask } from 'rocketride';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { PipelineFileParser, ParsedPipelineFile, ServiceClassInfo } from '../shared/util/pipelineParser';
import { GenericEvent } from '../shared/types';
import { getPageProjectProvider } from '../extension';

// =============================================================================
// TYPES — serialisable shapes sent to the webview
// =============================================================================

/** A single source component inside a pipeline file (sent to webview). */
export interface PipelineSourceDTO {
	id: string;
	name: string;
	provider?: string;
	warnings: string[];
	running: boolean;
	taskErrors: string[];
	taskWarnings: string[];
}

/** A pipeline file entry (sent to webview). */
export interface PipelineFileDTO {
	/** Absolute fsPath — used as stable key. */
	fsPath: string;
	/** Display label (file name). */
	label: string;
	/** Relative directory (undefined when in workspace root). */
	dir?: string;
	/** Whether the pipeline JSON parsed successfully. */
	valid: boolean;
	/** project_id from the parsed file. */
	projectId?: string;
	/** Whether any source in this file is currently running. */
	running: boolean;
	/** Aggregate error count across all sources. */
	errorCount: number;
	/** Aggregate warning count across all sources. */
	warningCount: number;
	/** Source components (empty when invalid). */
	sources: PipelineSourceDTO[];
}

/** An unknown task running on the server with no local .pipe file. */
export interface UnknownTaskDTO {
	projectId: string;
	sourceId: string;
	displayName: string;
	projectLabel: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const POLL_INTERVAL_MS = 5_000;

// =============================================================================
// PROVIDER
// =============================================================================

export class SidebarMainProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastTasks: DashboardTask[] = [];

	// ── Pipeline file state ──────────────────────────────────────────────────
	private parsedFiles = new Map<string, ParsedPipelineFile>();
	private activePipelines = new Set<string>();
	private unknownTasks = new Map<string, { projectId: string; sourceId: string; displayName?: string }>();

	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupFileWatching();
		this.setupEventListeners();
		this.loadPipelineFiles();
	}

	// =========================================================================
	// WEBVIEW LIFECYCLE
	// =========================================================================

	/** Called by VS Code when the sidebar view becomes visible. */
	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const html = this.getHtmlForWebview(webviewView.webview);
		console.log('[SidebarMainProvider] HTML length:', html.length, 'first 200 chars:', html.substring(0, 200));
		webviewView.webview.html = html;

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready':
						await this.sendFullUpdate();
						if (this.connectionManager.isConnected()) {
							this.startPolling();
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
					case 'stopTask':
						this.stopPipeline(message.projectId, message.source);
						break;
				}
			} catch (error) {
				console.error('[SidebarMainProvider] Message handling error:', error);
			}
		});

		webviewView.onDidDispose(() => {
			this._view = undefined;
			this.stopPolling();
		});
	}

	// =========================================================================
	// FILE WATCHING
	// =========================================================================

	/** Watch .pipe and .pipe.json for create/delete/change events. */
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
	}

	/**
	 * Handles newly created .pipe files.
	 * Empty files get a valid pipeline template; non-empty files with valid
	 * pipeline JSON get a project_id assigned if missing or duplicated.
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(raw).toString('utf8').trim();

			if (!text) {
				// Empty file — initialise with valid pipeline template
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
					// Invalid JSON — leave as-is; sidebar will show Parse Error
				}
			}
		} catch {
			// File can't be read yet — proceed with reload
		}
		await this.loadPipelineFiles();
	}

	/** Removes a deleted file from the parsed cache and refreshes. */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		this.parsedFiles.delete(uri.fsPath);
		this.sendPipelineUpdate();
	}

	/**
	 * Handles file modification events.  Same philosophy as handleFileCreated.
	 * Also triggers pipeline-restart logic based on user config.
	 */
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
					// Invalid JSON — leave as-is
				}
			}
		} catch {
			// File can't be read — skip
		}

		// Re-parse the changed file
		const parsedFile = await PipelineFileParser.parseFile(uri.fsPath, this.getServiceClassInfoMap());
		this.parsedFiles.set(uri.fsPath, parsedFile);

		// Remove matching unknown tasks if this file now covers them
		if (parsedFile.isValid && parsedFile.projectId) {
			for (const sc of parsedFile.sourceComponents) {
				this.unknownTasks.delete(this.activeKey(parsedFile.projectId, sc.id));
			}
		}

		this.sendPipelineUpdate();

		// Handle pipeline restart based on configuration
		await this.handlePipelineRestart(uri, parsedFile);
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	private setupEventListeners(): void {
		const connState = this.connectionManager.on('connectionStateChanged', () => {
			this.sendFullUpdate();
		});
		const connected = this.connectionManager.on('connected', () => {
			this.sendFullUpdate();
			this.startPolling();
			// Subscribe to task lifecycle events so the server pushes apaevt_task
			const client = this.connectionManager.getClient();
			if (client) {
				client.addMonitor({ token: '*' }, ['task', 'output']).catch((err) => {
					console.error('[SidebarMainProvider] Failed to subscribe to task events:', err);
				});
			}
		});
		const disconnected = this.connectionManager.on('disconnected', () => {
			this.lastTasks = [];
			this.activePipelines.clear();
			this.unknownTasks.clear();
			this.sendFullUpdate();
			this.stopPolling();
		});
		const error = this.connectionManager.on('error', () => {
			this.sendFullUpdate();
		});
		const configChange = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendFullUpdate();
			}
		});

		// Re-parse all files when service definitions arrive so that source
		// components are correctly identified via classType
		const servicesUpdated = this.connectionManager.on('servicesUpdated', () => {
			this.loadPipelineFiles();
		});

		this.disposables.push(connState, connected, disconnected, error, configChange, servicesUpdated);

		// Listen for server events that update task state
		this.connectionManager.on('event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_dashboard') {
				this.fetchTasks();
			} else if (event?.event === 'apaevt_task') {
				this.handleTaskEvent(event);
			} else if (event?.event === 'apaevt_status_update') {
				// PageProjectProvider caches the new status synchronously in its
				// event handler which runs before ours (same EventEmitter), so by
				// the time we rebuild DTOs the fresh errors/warnings are available.
				this.sendPipelineUpdate();
			}
		});
	}

	// =========================================================================
	// TASK EVENT HANDLING (ported from SidebarFilesProvider)
	// =========================================================================

	/** Processes apaevt_task events to track active/unknown pipelines. */
	private handleTaskEvent(event: GenericEvent): void {
		const projectId = event.body?.projectId || 'default';
		const sourceId = event.body?.source || 'default';
		const action = event.body?.action;
		const key = this.activeKey(projectId, sourceId);

		// Track which files just became active so the webview can expand them
		const newlyStarted = new Set<string>();

		switch (action) {
			case 'begin':
			case 'restart':
				if (!this.activePipelines.has(key)) {
					this.activePipelines.add(key);
					// Find the file(s) that own this source
					for (const [fsPath, pf] of this.parsedFiles) {
						if (pf.isValid && pf.projectId === projectId && pf.sourceComponents.some((c) => c.id === sourceId)) {
							newlyStarted.add(fsPath);
						}
					}
				}
				if (!this.isKnownTask(projectId, sourceId)) {
					this.unknownTasks.set(key, { projectId, sourceId });
				}
				break;

			case 'running':
				// Full resync of running tasks
				this.activePipelines.clear();
				this.unknownTasks.clear();
				for (const task of event.body?.tasks ?? []) {
					const k = this.activeKey(task.projectId, task.source);
					this.activePipelines.add(k);
					if (!this.isKnownTask(task.projectId, task.source)) {
						this.unknownTasks.set(k, { projectId: task.projectId, sourceId: task.source });
					}
				}
				break;

			case 'end':
				this.activePipelines.delete(key);
				this.unknownTasks.delete(key);
				break;
		}

		this.sendPipelineUpdate(newlyStarted.size > 0 ? [...newlyStarted] : undefined);
	}

	/** Composite key for active-pipeline tracking. */
	private activeKey(projectId: string, sourceId: string): string {
		return `${projectId}.${sourceId}`;
	}

	/** Returns true when a task matches a known local .pipe file. */
	private isKnownTask(projectId: string, sourceId: string): boolean {
		for (const pf of this.parsedFiles.values()) {
			if (pf.isValid && pf.projectId === projectId && pf.sourceComponents.some((c) => c.id === sourceId)) {
				return true;
			}
		}
		return false;
	}

	// =========================================================================
	// DATA — FULL UPDATE
	// =========================================================================

	/** Sends connection state + pipeline tree to the webview. */
	private async sendFullUpdate(): Promise<void> {
		if (!this._view) return;

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();

		let cloudUserName = '';
		if (config.connectionMode === 'cloud') {
			cloudUserName = await CloudAuthProvider.getInstance().getUserName();
		}

		this._view.webview.postMessage({
			type: 'update',
			data: {
				connectionState: status.state,
				connectionMode: config.connectionMode,
				cloudUserName,
				tasks: this.lastTasks,
				pipelineFiles: this.buildPipelineFileDTOs(),
				unknownTasks: this.buildUnknownTaskDTOs(),
			},
		});
	}

	/** Sends only pipeline-tree data (no connection state). */
	private sendPipelineUpdate(expandFiles?: string[]): void {
		if (!this._view) return;
		this._view.webview.postMessage({
			type: 'pipelineUpdate',
			pipelineFiles: this.buildPipelineFileDTOs(),
			unknownTasks: this.buildUnknownTaskDTOs(),
			expandFiles: expandFiles ?? [],
		});
	}

	// =========================================================================
	// DATA — DASHBOARD POLLING
	// =========================================================================

	private async fetchTasks(): Promise<void> {
		if (!this._view || !this.connectionManager.isConnected()) return;

		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const dashboard: DashboardResponse = await client.getDashboard();
			if (dashboard?.tasks) {
				this.lastTasks = dashboard.tasks;
				this._view.webview.postMessage({
					type: 'tasksUpdate',
					tasks: this.lastTasks,
				});
			}
		} catch {
			// Silently ignore — dashboard may not be available yet
		}
	}

	private startPolling(): void {
		this.stopPolling();
		this.fetchTasks();
		this.pollTimer = setInterval(() => this.fetchTasks(), POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// =========================================================================
	// PIPELINE FILE LOADING
	// =========================================================================

	/** Discovers and parses all .pipe / .pipe.json files in the workspace. */
	private async loadPipelineFiles(): Promise<void> {
		const [pipeFiles, pipeJsonFiles] = await Promise.all([vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**'), vscode.workspace.findFiles('**/*.pipe.json', '**/node_modules/**')]);
		const files = [...pipeFiles, ...pipeJsonFiles];

		this.parsedFiles.clear();

		for (const uri of files) {
			const parsedFile = await PipelineFileParser.parseFile(uri.fsPath, this.getServiceClassInfoMap());
			this.parsedFiles.set(uri.fsPath, parsedFile);

			// Remove matching unknown tasks
			if (parsedFile.isValid && parsedFile.projectId) {
				for (const sc of parsedFile.sourceComponents) {
					this.unknownTasks.delete(this.activeKey(parsedFile.projectId, sc.id));
				}
			}
		}

		// Update "no pipeline files" context for welcome view
		vscode.commands.executeCommand('setContext', 'rocketride.noPipelineFiles', files.length === 0);

		this.sendPipelineUpdate();
	}

	/** Returns the service catalog for source-component detection. */
	private getServiceClassInfoMap(): Record<string, ServiceClassInfo> | undefined {
		const cached = this.connectionManager.getCachedServices();
		return cached?.services as Record<string, ServiceClassInfo> | undefined;
	}

	// =========================================================================
	// DTO BUILDERS
	// =========================================================================

	/** Builds the serialisable pipeline-file array for the webview. */
	private buildPipelineFileDTOs(): PipelineFileDTO[] {
		const statusProvider = getPageProjectProvider();
		const services = this.connectionManager.getCachedServices()?.services ?? {};
		const dtos: PipelineFileDTO[] = [];

		for (const [fsPath, pf] of this.parsedFiles) {
			const fileName = path.basename(fsPath);
			const relativePath = vscode.workspace.asRelativePath(fsPath);
			const dir = path.dirname(relativePath) !== '.' ? path.dirname(relativePath) : undefined;

			let running = false;
			let errorCount = 0;
			let warningCount = 0;
			const sources: PipelineSourceDTO[] = [];

			if (pf.isValid && pf.projectId) {
				// Sort sources alphabetically
				const sorted = [...pf.sourceComponents].sort((a, b) => {
					const na = (a.name || a.id || '').toLowerCase();
					const nb = (b.name || b.id || '').toLowerCase();
					return na.localeCompare(nb, undefined, { sensitivity: 'base' });
				});

				for (const sc of sorted) {
					const key = this.activeKey(pf.projectId!, sc.id);
					const isActive = this.activePipelines.has(key);
					if (isActive) running = true;

					// Task errors/warnings from PageProjectProvider
					const ts = statusProvider?.getTaskStatus(pf.projectId!, sc.id);
					const taskErrors = ts?.errors ?? [];
					const taskWarnings = ts?.warnings ?? [];
					errorCount += taskErrors.length;
					warningCount += taskWarnings.length;

					// Resolve display name: component name → service title → component id
					const providerDef = sc.provider ? (services[sc.provider] as { title?: string } | undefined) : undefined;
					const displayName = sc.name || providerDef?.title || sc.id;

					sources.push({
						id: sc.id,
						name: displayName,
						provider: sc.provider,
						warnings: sc.warnings,
						running: isActive,
						taskErrors,
						taskWarnings,
					});
				}
			}

			dtos.push({ fsPath, label: fileName, dir, valid: pf.isValid, projectId: pf.projectId, running, errorCount, warningCount, sources });
		}

		// Sort by file name
		dtos.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
		return dtos;
	}

	/** Builds the unknown-task array for the webview. */
	private buildUnknownTaskDTOs(): UnknownTaskDTO[] {
		return Array.from(this.unknownTasks.values()).map((t) => {
			// Cross-reference with dashboard tasks for friendly names
			const dashTask = this.lastTasks.find((dt) => dt.projectId === t.projectId && dt.source === t.sourceId);
			const displayName = dashTask?.name || t.displayName || t.sourceId;
			const projectLabel = t.projectId.substring(0, 8);
			return { projectId: t.projectId, sourceId: t.sourceId, displayName, projectLabel };
		});
	}

	// =========================================================================
	// PIPELINE ACTIONS
	// =========================================================================

	/** Opens a .pipe file in the custom pipeline editor. */
	private async openPipelineFile(fsPath: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(fsPath);
			await vscode.commands.executeCommand('vscode.openWith', uri, 'rocketride.PageProject');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open pipeline: ${error}`);
		}
	}

	/** Runs a pipeline (optionally targeting a specific source). */
	private async runPipeline(fsPath: string, sourceId?: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(fsPath);
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));

			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const pipeName = path.basename(fsPath).replace(/\.pipe(?:\.json)?$/, '');
			await client.use({
				pipeline: pipelineJson,
				source: sourceId ?? '',
				args: ConfigManager.getInstance().getEffectiveEngineArgs(),
				name: pipeName,
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to run pipeline: ${error}`);
		}
	}

	/** Stops a running pipeline by project + source. */
	private async stopPipeline(projectId: string, sourceId: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const token = await client.getTaskToken({ projectId, source: sourceId });
			if (token) await client.terminate(token);
		} catch (err) {
			console.error('[SidebarMainProvider] stopPipeline failed:', err);
		}
	}

	/** Restarts a pipeline component (reads fresh JSON from disk). */
	private async restartPipeline(projectId: string, sourceId: string, uri: vscode.Uri): Promise<void> {
		try {
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const token = await client.getTaskToken({ projectId, source: sourceId });
			await client.restart({ token, projectId, source: sourceId, pipeline: pipelineJson });
		} catch (error) {
			console.error(`[SidebarMainProvider] restartPipeline failed: ${error}`);
			vscode.window.showErrorMessage(String(error));
		}
	}

	// =========================================================================
	// PIPELINE RESTART ON SAVE
	// =========================================================================

	/** Auto-restart logic mirrored from SidebarFilesProvider. */
	private async handlePipelineRestart(uri: vscode.Uri, parsedFile: ParsedPipelineFile): Promise<void> {
		if (!parsedFile.isValid || !parsedFile.projectId) return;

		// Skip if this save was triggered by a Run button click
		const pageProjectProvider = getPageProjectProvider();
		if (pageProjectProvider?.isSaveForRun(uri)) return;

		// Find running components in this file
		const runningComponents = parsedFile.sourceComponents.filter((c) => {
			return this.activePipelines.has(this.activeKey(parsedFile.projectId!, c.id));
		});
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

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'webview', 'sidebar-main.html');

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

	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.stopPolling();
		// Unsubscribe the wildcard task monitor
		const client = this.connectionManager.getClient();
		if (client) {
			client.removeMonitor({ token: '*' }, ['task', 'output']).catch(() => {});
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
