// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMainProvider — Extension host provider for the unified sidebar.
 *
 * Finds and parses .pipe files, watches for file changes, forwards task
 * events to the webview, and handles action messages (open, run, stop).
 *
 * The webview (SidebarMainWebview.tsx) receives ProjectEntry[] and raw
 * task events, tracks active-task state locally, and renders <SidebarMain>
 * from shared-ui.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { PipelineFileParser, ParsedPipelineFile, ServiceClassInfo } from '../shared/util/pipelineParser';
import { GenericEvent } from '../shared/types';
import { getPageProjectProvider } from '../extension';

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

export class SidebarMainProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'rocketride.sidebar.main';

	private _view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();

	// ── Pipeline file state ──────────────────────────────────────────────────
	private parsedFiles = new Map<string, ParsedPipelineFile>();

	constructor(private readonly extensionUri: vscode.Uri) {
		this.setupFileWatching();
		this.setupEventListeners();
		this.loadPipelineFiles();
	}

	// =========================================================================
	// WEBVIEW LIFECYCLE
	// =========================================================================

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
				}
			} catch (error) {
				console.error('[SidebarMainProvider] Message handling error:', error);
			}
		});

		webviewView.onDidDispose(() => {
			this._view = undefined;
		});
	}

	// =========================================================================
	// FILE WATCHING
	// =========================================================================

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

	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		this.parsedFiles.delete(uri.fsPath);
		this.sendEntriesUpdate();
	}

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

	private setupEventListeners(): void {
		const connState = this.connectionManager.on('connectionStateChanged', () => {
			this.sendFullUpdate();
		});
		const connected = this.connectionManager.on('connected', () => {
			this.sendFullUpdate();
			// Subscribe to task lifecycle events
			const client = this.connectionManager.getClient();
			if (client) {
				client.addMonitor({ token: '*' }, ['task', 'output']).catch((err) => {
					console.error('[SidebarMainProvider] Failed to subscribe to task events:', err);
				});
			}
		});
		const disconnected = this.connectionManager.on('disconnected', () => {
			this.sendFullUpdate();
		});
		const error = this.connectionManager.on('error', () => {
			this.sendFullUpdate();
		});
		const configChange = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('rocketride')) {
				this.sendFullUpdate();
			}
		});

		// Re-parse when service definitions arrive
		const servicesUpdated = this.connectionManager.on('servicesUpdated', () => {
			this.loadPipelineFiles();
		});

		this.disposables.push(connState, connected, disconnected, error, configChange, servicesUpdated);

		// Forward server events to webview
		this.connectionManager.on('event', (event: GenericEvent) => {
			if (event?.event === 'apaevt_task') {
				// Forward task event to webview for state tracking
				this._view?.webview.postMessage({
					type: 'taskEvent',
					event: event.body,
				});
			} else if (event?.event === 'apaevt_status_update') {
				// Forward status updates (errors/warnings) to webview
				const projectId = event.body?.project_id;
				const sourceId = event.body?.source;
				if (projectId && sourceId) {
					const statusProvider = getPageProjectProvider();
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

	/** Sends connection state + entries to the webview. */
	private async sendFullUpdate(): Promise<void> {
		if (!this._view) return;

		const status = this.connectionManager.getConnectionStatus();
		const config = this.configManager.getConfig();

		this._view.webview.postMessage({
			type: 'update',
			data: {
				connectionState: status.state,
				connectionMode: config.connectionMode,
				entries: this.buildEntries(),
				unknownTasks: [],
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

	private async openPipelineFile(fsPath: string): Promise<void> {
		try {
			// fsPath may be relative — resolve against workspace
			const uri = this.resolveFileUri(fsPath);
			await vscode.commands.executeCommand('vscode.openWith', uri, 'rocketride.PageProject');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open pipeline: ${error}`);
		}
	}

	private async runPipeline(fsPath: string, sourceId?: string): Promise<void> {
		try {
			const uri = this.resolveFileUri(fsPath);
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

	private async handlePipelineRestart(uri: vscode.Uri, parsedFile: ParsedPipelineFile): Promise<void> {
		if (!parsedFile.isValid || !parsedFile.projectId) return;

		const pageProjectProvider = getPageProjectProvider();
		if (pageProjectProvider?.isSaveForRun(uri)) return;

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
		const client = this.connectionManager.getClient();
		if (client) {
			client.removeMonitor({ token: '*' }, ['task', 'output']).catch(() => {});
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
