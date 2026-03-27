// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Pipeline Editor Provider for Custom .pipeline File Editor
 *
 * Provides a visual editor for .pipeline files using a webview-based interface.
 * The editor shows a full-screen webview with the RocketRide pipeline visual UI
 * instead of the default text editor.
 *
 * Features:
 * - Custom visual editor for .pipeline files
 * - Two-way synchronization between webview and file content
 * - Save functionality from webview to file
 * - Retains context when hidden for better performance
 * - Real-time pipeline status updates via DAP events
 */

import * as vscode from 'vscode';
import { TaskStatus, GenericEvent, GenericResponse, ConnectionState } from '../shared/types';
import { ConnectionManager } from '../connection/connection';
import { ConfigManager } from '../config';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

/**
 * Interface for tracking editor state per document
 */
const CANVAS_PREFERENCES_KEY = 'canvasPreferences';

interface EditorState {
	document: vscode.TextDocument;
	webviewPanel: vscode.WebviewPanel;
	projectId?: string;
	isMonitoring: boolean;
	isDisposed: boolean;
	isReady: boolean;
	cachedStatuses: Record<string, TaskStatus>; // Cache status updates until webview is ready
}

export class PageEditorProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<string, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	private savesForRun: Set<string> = new Set(); // Track saves that are part of Run operations

	/**
	 * Creates a new PageEditorProvider
	 *
	 * @param context VS Code extension context for command registration
	 */
	constructor(private readonly context: vscode.ExtensionContext) {
		this.registerCommands();
		this.setupEventListeners();
	}

	/**
	 * Checks if a file save is part of a Run operation
	 *
	 * @param uri The file URI to check
	 * @returns true if this save is part of a Run operation
	 */
	public isSaveForRun(uri: vscode.Uri): boolean {
		return this.savesForRun.has(uri.toString());
	}

	/**
	 * Sets up event listeners for DAP events and connection state changes
	 */
	private setupEventListeners(): void {
		// Listen for DAP events and route to appropriate webviews
		const eventListener = this.connectionManager.on('event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Listen for connection state changes to start monitoring when connected
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					await this.startMonitoringForAllEditors();
				} else {
					await this.stopMonitoringForAllEditors();
				}

				// Broadcast connection state to all open editor webviews
				this.broadcastConnectionState(this.connectionManager.isConnected());
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		// When services cache is updated, push to all open page editor webviews
		const servicesUpdatedListener = this.connectionManager.on('servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
			this.broadcastServicesToAllEditors(payload);
		});

		// Keep track of disposables
		this.disposables.push(eventListener, connectionStateListener, servicesUpdatedListener);
	}

	/**
	 * Sends current or updated services to all open page editor webviews that are ready.
	 */
	private broadcastServicesToAllEditors(payload: { services: Record<string, unknown>; servicesError?: string }): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview
					.postMessage({
						type: 'servicesUpdate',
						services: payload.services,
						servicesError: payload.servicesError,
					})
					.then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post servicesUpdate to webview: ${err}`);
					});
			}
		}
	}

	/**
	 * Broadcasts connection state to all open page editor webviews.
	 */
	private broadcastConnectionState(isConnected: boolean): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'connectionState', isConnected }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post connectionState to webview: ${err}`);
				});
			}
		}
	}

	/**
	 * Handles events and routes them to the appropriate webviews
	 *
	 * @param event The DAP event received from the connection manager
	 */
	private handleEvent(event: GenericEvent): void {
		switch (event.event) {
			case 'apaevt_status_update': {
				// Parse the event to extract project_id
				const projectId = event.body?.project_id;
				const source = event.body?.source;

				if (!projectId || !source) {
					return;
				}

				// Find editor for this project (match by projectId only)
				const editorState = Array.from(this.editorStates.values()).find((state) => !state.isDisposed && state.projectId === projectId);

				if (!editorState) {
					return;
				}

				const taskStatus = event.body as TaskStatus;

				// Always cache the status update
				editorState.cachedStatuses[source] = taskStatus;

				// If webview is ready, forward immediately
				if (editorState.isReady) {
					editorState.webviewPanel.webview.postMessage({
						type: 'taskStatusUpdate',
						source: source,
						taskStatus: taskStatus,
						host: this.connectionManager.getHttpUrl(),
					});
				}
				break;
			}

			case 'apaevt_task': {
				// Running list is used by SidebarFilesProvider; we rely on apaevt_status_update for canvas state.
				break;
			}
		}
	}

	/**
	 * Extracts project_id and source from pipeline document
	 *
	 * @param document The pipeline document
	 * @returns Object containing projectId and sourceId, or undefined values if parsing fails
	 */
	private extractPipelineIds(document: vscode.TextDocument): { projectId?: string; sourceId?: string } {
		try {
			const content = document.getText();
			const parsed = JSON.parse(content);

			return {
				projectId: parsed.project_id,
				sourceId: parsed.source,
			};
		} catch {
			// If parsing fails, return undefined values
			return { projectId: undefined, sourceId: undefined };
		}
	}

	/**
	 * Starts monitoring for a specific editor (monitors all components in the project)
	 *
	 * @param documentUri The document URI to start monitoring for
	 */
	private async startMonitoring(documentUri: string): Promise<void> {
		const editorState = this.editorStates.get(documentUri);

		// If we are already monitoring, not connected, disposed, or missing projectId, do nothing
		if (!editorState || editorState.isMonitoring || editorState.isDisposed || !editorState.projectId || !this.connectionManager.isConnected()) {
			return;
		}

		try {
			// Send DAP command to start monitoring all components (*) for this project
			await this.connectionManager.request('rrext_monitor', {
				projectId: editorState.projectId,
				source: '*', // Monitor ALL components in this project
				types: ['summary'],
			});

			// Mark as monitoring
			editorState.isMonitoring = true;
		} catch (error) {
			this.logger.error(`Starting monitoring for project ${editorState.projectId}: ${error}`);
			// Ensure monitoring state is reset on failure
			editorState.isMonitoring = false;
		}
	}

	/**
	 * Stops monitoring for a specific editor
	 *
	 * @param documentUri The document URI to stop monitoring for
	 */
	private async stopMonitoring(documentUri: string): Promise<void> {
		const editorState = this.editorStates.get(documentUri);

		// If we are not monitoring or missing projectId, nothing to stop
		if (!editorState || !editorState.isMonitoring || !editorState.projectId) {
			return;
		}

		// If we are connected, send stop monitoring command
		if (this.connectionManager.isConnected()) {
			try {
				// Send DAP command to stop monitoring (no types parameter)
				await this.connectionManager.request('rrext_monitor', {
					projectId: editorState.projectId,
					source: '*',
				});
			} catch (error) {
				this.logger.error(`Stopping monitoring for project ${editorState.projectId}: ${error}`);
			}
		}

		// Mark as not monitoring
		editorState.isMonitoring = false;
	}

	/**
	 * Starts monitoring for all currently open editors when connection is established.
	 * Also re-sends each editor's cached statuses to its webview so the canvas shows
	 * the last known running state immediately (e.g. chat_1/chat_2 as Processing).
	 */
	private async startMonitoringForAllEditors(): Promise<void> {
		for (const [documentUri, editorState] of this.editorStates) {
			try {
				await this.startMonitoring(documentUri);
				// Re-push cached statuses so the canvas reflects last known state after reconnect
				if (!editorState.isDisposed && editorState.isReady && editorState.webviewPanel.webview) {
					for (const [source, taskStatus] of Object.entries(editorState.cachedStatuses)) {
						editorState.webviewPanel.webview.postMessage({
							type: 'taskStatusUpdate',
							source,
							taskStatus,
							host: this.connectionManager.getHttpUrl(),
						});
					}
				}
			} catch (error) {
				this.logger.error(`Starting monitoring for ${documentUri}: ${error}`);
			}
		}
	}

	/**
	 * Stops monitoring for all editors when connection is lost
	 */
	private async stopMonitoringForAllEditors(): Promise<void> {
		// Just mark all as not monitoring - connection is already gone
		for (const editorState of this.editorStates.values()) {
			editorState.isMonitoring = false;
		}
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.openPipelineAsText', (uri: vscode.Uri) => {
				const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
				if (targetUri) {
					vscode.commands.executeCommand('vscode.openWith', targetUri, 'default');
				} else {
					vscode.window.showErrorMessage('No pipeline file selected');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.save', async () => {
				// Save current editor if it's a pipeline editor
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.files.save');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.refresh', async () => {
				// Refresh current pipeline editor
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					// Force reload of the editor content
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			}),
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	/**
	 * Called by VS Code when a .pipeline file is opened with this editor
	 *
	 * @param document The text document being edited
	 * @param webviewPanel The webview panel for the custom editor
	 * @param _token Cancellation token
	 */
	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const webview = webviewPanel.webview;

		// Show a clean pipeline name in the tab (strip .pipe or .pipe.json extension)
		const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
		webviewPanel.title = fileName.replace(/\.pipe(\.json)?$/i, '');

		// Extract project_id and source from document
		const { projectId, sourceId: _sourceId } = this.extractPipelineIds(document);

		// Create editor state tracking
		const editorState: EditorState = {
			document,
			webviewPanel,
			projectId,
			isMonitoring: false,
			isDisposed: false,
			isReady: false,
			cachedStatuses: {},
		};

		// Store editor state using document URI as key
		this.editorStates.set(document.uri.toString(), editorState);

		// Configure webview security and capabilities
		webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		// Load the webview content
		webview.html = this.getHtmlForWebview(webview);

		// Handle messages from the webview
		webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'ready': {
					// Mark webview as ready
					editorState.isReady = true;

					// Send initial document content
					this.updateWebview(webview, document);

					// Send OAuth2 root URL from extension settings (refresh path for services OAuth2 endpoint)
					const oauth2RootUrl = vscode.workspace.getConfiguration('rocketride').get<string>('oauth2RootUrl', 'https://oauth2.rocketride.ai');
					webview
						.postMessage({
							type: 'oauth2Config',
							oauth2RootUrl,
						})
						.then(undefined, (err: unknown) => {
							this.logger.error(`Failed to post oauth2Config to webview: ${err}`);
						});

					// Send persisted canvas preferences (snap-to-grid, navigation mode, etc.)
					const storedPrefs = this.context.workspaceState.get<Record<string, unknown>>(CANVAS_PREFERENCES_KEY) ?? {};
					webview.postMessage({ type: 'preferences', preferences: storedPrefs }).then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post preferences to webview: ${err}`);
					});

					// Send cached services so the editor shows something immediately
					const cached = this.connectionManager.getCachedServices();
					webview.postMessage({
						type: 'servicesUpdate',
						services: cached.services,
						servicesError: cached.servicesError,
					});

					// Kick off background refresh; when done, servicesUpdated will push to all editors
					this.connectionManager.refreshServices().catch((err) => {
						this.logger.error(`Background services refresh failed: ${err}`);
					});

					// Send all cached status updates
					const cachedCount = Object.keys(editorState.cachedStatuses).length;
					if (cachedCount > 0) {
						for (const [source, taskStatus] of Object.entries(editorState.cachedStatuses)) {
							webview.postMessage({
								type: 'taskStatusUpdate',
								source: source,
								taskStatus: taskStatus,
								host: this.connectionManager.getHttpUrl(),
							});
						}
					}

					// Send initial connection state
					webview.postMessage({ type: 'connectionState', isConnected: this.connectionManager.isConnected() }).then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post connectionState to webview: ${err}`);
					});

					// Now start monitoring for future updates (if not already monitoring)
					if (!editorState.isMonitoring) {
						try {
							await this.startMonitoring(document.uri.toString());
						} catch (error) {
							this.logger.error(`Starting monitoring after webview ready: ${error}`);
						}
					}
					break;
				}

				case 'save':
					// Handle save requests from the pipeline editor
					this.saveDocument(document, data.content);
					break;

				case 'requestUndo':
					void vscode.commands.executeCommand('undo');
					break;

				case 'requestRedo':
					void vscode.commands.executeCommand('redo');
					break;

				case 'contentChanged': {
					// Mark document dirty with current canvas content (do not save to disk)
					if (typeof data.content === 'string') {
						this.applyDocumentEdit(document, data.content);
					}
					break;
				}

				case 'run': {
					// Save to disk then execute the pipeline.
					// The file watcher fires asynchronously after the disk write and checks
					// handlePipelineRestart. We flag savesForRun so it skips the restart
					// prompt, and clear the flag after a delay to cover the async watcher.
					if (typeof data.content === 'string' && typeof data.source === 'string') {
						const uriKey = document.uri.toString();
						this.savesForRun.add(uriKey);
						try {
							await this.saveDocument(document, data.content);
							const parsed = JSON.parse(document.getText());
							await this.runPipeline({ pipeline: { ...parsed, source: data.source } });
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : String(error);
							vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
						}
						// Clear after a delay so the async file watcher has time to check the flag
						setTimeout(() => this.savesForRun.delete(uriKey), 2000);
					}
					break;
				}

				case 'stop': {
					// Stop a running pipeline for the given source node
					if (typeof data.source === 'string') {
						await this.stopPipeline(data.source, document);
					}
					break;
				}

				case 'openStatus': {
					// Open the status page for a source node
					if (typeof data.source === 'string') {
						try {
							const parsed = JSON.parse(document.getText());
							const projectId = parsed.project_id ?? '';
							const displayName = data.source;
							await vscode.commands.executeCommand('rocketride.page.status.open', displayName, document.uri, projectId, data.source);
						} catch (error: unknown) {
							this.logger.error(`[PageEditorProvider] Failed to open status page: ${error}`);
						}
					}
					break;
				}

				case 'openExternal':
					if (data.url) {
						this.openLink(data.url, data.displayName);
					}
					break;

				case 'setPreference':
					if (typeof data.key === 'string') {
						const current = this.context.workspaceState.get<Record<string, unknown>>(CANVAS_PREFERENCES_KEY) ?? {};
						this.context.workspaceState.update(CANVAS_PREFERENCES_KEY, { ...current, [data.key]: data.value }).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist preference: ${err}`);
						});
					}
					break;

				case 'validate': {
					this.logger.output(`${icons.pipeline} Validating pipeline...`);
					const pipeline = ConfigManager.getInstance().substituteEnvVariables(data.pipeline);
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const result = await client.validate({ pipeline });
						this.logger.output(`${icons.success} Pipeline validation passed`);
						webview.postMessage({ type: 'validateResponse', result });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.output(`${icons.error} Pipeline validation failed: ${msg}`);
						webview.postMessage({ type: 'validateResponse', result: null, error: msg });
					}
					break;
				}
			}
		});

		// Listen for document changes (including undo/redo) and sync content to webview so canvas stays in sync
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				const { projectId } = this.extractPipelineIds(e.document);
				editorState.projectId = projectId;
				this.updateWebview(webview, e.document);
			}
		});

		// Listen for theme changes in VSCode and notify the webview
		const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme((_theme) => {
			webview
				.postMessage({
					type: 'themeChanged',
				})
				.then(
					() => {},
					(error) => this.logger.error(`[PageEditorProvider] Error sending theme change message: ${error}`)
				);
		});

		// Clean up when panel is disposed
		webviewPanel.onDidDispose(async () => {
			// Stop monitoring before disposing
			await this.stopMonitoring(document.uri.toString());

			// Clear cached statuses
			editorState.cachedStatuses = {};

			editorState.isDisposed = true;
			this.editorStates.delete(document.uri.toString());

			themeChangeDisposable.dispose();
			changeDocumentSubscription.dispose();
		});

		// Send initial content to webview
		this.updateWebview(webview, document);

		// Start monitoring immediately if connected (status updates will be cached until webview is ready)
		if (this.connectionManager.isConnected()) {
			this.startMonitoring(document.uri.toString()).catch((error) => {
				this.logger.error(`Starting initial monitoring: ${error}`);
			});
		}
	}

	/**
	 * Updates the webview with current document content
	 *
	 * @param webview The webview to update
	 * @param document The document with current content
	 */
	private updateWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
		webview.postMessage({
			type: 'update',
			content: document.getText(),
		});
	}

	/**
	 * Normalizes pipeline JSON to verbose (pretty-printed) format for consistent comparison and display.
	 * Accepts string or object; returns a string with 2-space indentation.
	 */
	private toVerboseJson(content: string | Record<string, unknown>): string {
		const obj = typeof content === 'string' ? JSON.parse(content) : content;
		return JSON.stringify(obj, null, 2);
	}

	/**
	 * Applies content to the document (marks dirty). Does not save to disk.
	 * Formats as verbose JSON and skips the edit if content is unchanged.
	 * @returns { changed, applied } - changed: content differed from document; applied: edit was applied successfully
	 */
	private async applyDocumentEdit(document: vscode.TextDocument, content: string): Promise<{ changed: boolean; applied: boolean }> {
		let normalizedNew: string;
		try {
			normalizedNew = this.toVerboseJson(content);
		} catch {
			// Invalid JSON: apply as-is and let the user see the problem
			normalizedNew = content;
		}
		const currentText = document.getText();
		let normalizedCurrent: string;
		try {
			normalizedCurrent = this.toVerboseJson(currentText);
		} catch {
			normalizedCurrent = currentText;
		}
		if (normalizedNew === normalizedCurrent) {
			return { changed: false, applied: false };
		}
		const docLen = currentText.length;
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(docLen));
		edit.replace(document.uri, fullRange, normalizedNew);
		const success = await vscode.workspace.applyEdit(edit);
		if (!success) {
			this.logger.error('[PageEditorProvider] Failed to apply document edit');
		}
		return { changed: true, applied: success };
	}

	/**
	 * Saves new content to the document. Uses applyDocumentEdit then persists to disk if the document changed.
	 *
	 * @param document The document to update
	 * @param content The new content to save (JSON string or object)
	 */
	private async saveDocument(document: vscode.TextDocument, content: string | Record<string, unknown>): Promise<void> {
		const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
		const { changed, applied } = await this.applyDocumentEdit(document, contentStr);
		if (applied) {
			await document.save();
		} else if (changed) {
			vscode.window.showErrorMessage('Failed to save pipeline file');
		}
	}

	/**
	 * Runs a pipeline by sending execute command to the backend
	 */
	private async runPipeline(document: { pipeline: Record<string, unknown> }): Promise<void> {
		try {
			const project = document.pipeline;

			// Substitute environment variables
			const projectTransformed = ConfigManager.getInstance().substituteEnvVariables(project);

			// Get the source and project id from the flat project
			const projectId = project.project_id;
			const source = project.source;

			// Use DAP command to execute pipeline (always trace from canvas)
			await this.connectionManager.request('execute', {
				projectId: projectId,
				source: source,
				pipeline: projectTransformed,
				pipelineTraceLevel: 'full',
				args: ConfigManager.getInstance().getEffectiveEngineArgs(),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
		}
	}

	/**
	 * Stops a running pipeline by sending terminate command to the backend
	 */
	private async stopPipeline(componentId: string, document: vscode.TextDocument): Promise<void> {
		try {
			const parsed = JSON.parse(document.getText());
			const projectId = parsed.project_id;

			if (!projectId || !componentId) {
				this.logger.error(`[PageEditorProvider] Missing projectId or componentId: projectId=${projectId}, componentId=${componentId}`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			// Get the token for the running task
			const response = (await this.connectionManager.request('rrext_get_token', {
				projectId: projectId,
				source: componentId,
			})) as GenericResponse | undefined;

			const token = response?.body?.token;

			if (!token) {
				this.logger.error('[PageEditorProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			// Send terminate command
			await this.connectionManager.request('terminate', {}, token);
		} catch (error: unknown) {
			this.logger.error(`[PageEditorProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	/**
	 * Opens a URL in an embedded VS Code WebviewPanel with an iframe.
	 *
	 * Mirrors PageStatusProvider.openLink — bridges drag-and-drop, clipboard,
	 * theme colors, and env variables to the iframe.
	 */
	private openLink(url: string, displayName?: string): void {
		const panel = vscode.window.createWebviewPanel('externalContent', displayName || 'Pipeline', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

		const env: Record<string, string | boolean> = ConfigManager.getInstance().getEnv();
		env['devMode'] = true;

		panel.webview.html = `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					body { margin: 0; padding: 0; }
					iframe { width: 100%; height: 100vh; border: none; }
				</style>
			</head>
			<body>
				<iframe id="app-iframe" src="${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}" allow="clipboard-read; clipboard-write"></iframe>
				<script>
					(function() {
						const vscode = acquireVsCodeApi();
						const iframe = document.getElementById('app-iframe');
						const envVars = ${JSON.stringify(env)};
						let iframeOrigin = '*';
						try { iframeOrigin = new URL(iframe.src).origin; } catch(e) {}

						['dragenter', 'dragover'].forEach(eventName => {
							document.addEventListener(eventName, (e) => {
								e.preventDefault();
								e.stopPropagation();
								try { iframe.contentWindow.postMessage({ type: 'dragHover', x: e.clientX, y: e.clientY }, iframeOrigin); } catch(err) {}
							});
						});
						document.addEventListener('dragleave', (e) => {
							if (e.relatedTarget === null) {
								try { iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin); } catch(err) {}
							}
						});

						document.addEventListener('drop', async (e) => {
							e.preventDefault();
							e.stopPropagation();
							const files = e.dataTransfer && e.dataTransfer.files;
							if (!files || files.length === 0) return;

							const fileDataArray = [];
							for (let i = 0; i < files.length; i++) {
								const file = files[i];
								const buffer = await file.arrayBuffer();
								fileDataArray.push({
									name: file.name,
									type: file.type || 'application/octet-stream',
									size: file.size,
									lastModified: file.lastModified,
									buffer: buffer
								});
							}

							try {
								iframe.contentWindow.postMessage({
									type: 'bridgedFileDrop',
									files: fileDataArray
								}, iframeOrigin, fileDataArray.map(f => f.buffer));
								iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin);
							} catch (err) {
								console.error('[Parent] Error bridging file drop to iframe:', err);
							}
						});

						function getVSCodeThemeColors() {
							const style = getComputedStyle(document.body);
							const getColor = (varName, fallback = '') => {
								const value = style.getPropertyValue(varName).trim();
								return value || fallback;
							};
							return {
								'--bg-primary': getColor('--vscode-editor-background'),
								'--bg-secondary': getColor('--vscode-sideBar-background'),
								'--bg-tertiary': getColor('--vscode-editorWidget-background'),
								'--bg-hover': getColor('--vscode-list-hoverBackground'),
								'--text-primary': getColor('--vscode-editor-foreground'),
								'--text-secondary': getColor('--vscode-descriptionForeground'),
								'--text-muted': getColor('--vscode-disabledForeground'),
								'--border-color': getColor('--vscode-panel-border'),
								'--border-hover': getColor('--vscode-focusBorder'),
								'--accent-primary': getColor('--vscode-focusBorder'),
								'--accent-secondary': getColor('--vscode-button-background'),
								'--accent-hover': getColor('--vscode-button-hoverBackground'),
								'--success-color': getColor('--vscode-terminal-ansiGreen'),
								'--error-color': getColor('--vscode-errorForeground'),
								'--warning-color': getColor('--vscode-editorWarning-foreground'),
								'--info-color': getColor('--vscode-editorInfo-foreground'),
								'--code-bg': getColor('--vscode-textCodeBlock-background'),
								'--input-bg': getColor('--vscode-input-background'),
								'--input-border': getColor('--vscode-input-border'),
								'--shadow-sm': getColor('--vscode-widget-shadow'),
								'--shadow-md': getColor('--vscode-widget-shadow'),
								'--shadow-lg': getColor('--vscode-widget-shadow')
							};
						}

						function sendDataToIframe() {
							const colors = getVSCodeThemeColors();
							try {
								iframe.contentWindow.postMessage({
									type: 'vscodeData',
									env: envVars,
									theme: colors
								}, iframeOrigin);
							} catch (error) {
								console.error('[Parent] Error sending data to iframe:', error);
							}
						}

						window.addEventListener('message', (event) => {
							if (event.source === iframe.contentWindow) {
								if (event.data.type === 'ready') {
									sendDataToIframe();
								}
								if (event.data.type === 'requestPaste') {
									vscode.postMessage({ type: 'requestPaste' });
								}
								if (event.data.type === 'copyText' && event.data.text) {
									vscode.postMessage({ type: 'copyText', text: event.data.text });
								}
								if (event.data.type === 'requestFileDialog') {
									vscode.postMessage({ type: 'requestFileDialog' });
								}
							}
						});

						window.addEventListener('message', (event) => {
							const msg = event.data;
							if (msg.type === 'themeChanged') {
								setTimeout(() => {
									sendDataToIframe();
								}, 50);
							}
							if (msg.type === 'pasteContent' && msg.text && iframe.contentWindow) {
								iframe.contentWindow.postMessage({
									type: 'paste',
									text: msg.text
								}, iframeOrigin);
							}
							if (msg.type === 'nativeFilesSelected' && iframe.contentWindow) {
								iframe.contentWindow.postMessage({
									type: 'nativeFilesSelected',
									files: msg.files
								}, iframeOrigin);
							}
						});
					})();
				</script>
			</body>
			</html>
		`;

		const messageDisposable = panel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string }) => {
			if (msg.type === 'requestPaste') {
				const text = await vscode.env.clipboard.readText();
				if (text) {
					panel.webview.postMessage({ type: 'pasteContent', text });
				}
			}
			if (msg.type === 'copyText' && msg.text) {
				await vscode.env.clipboard.writeText(msg.text);
			}
			if (msg.type === 'requestFileDialog') {
				const uris = await vscode.window.showOpenDialog({
					canSelectMany: true,
					canSelectFiles: true,
					canSelectFolders: false,
					title: 'Select files to upload',
				});
				if (uris && uris.length > 0) {
					const path = require('path');
					const fileDataArray: { name: string; type: string; size: number; lastModified: number; buffer: number[] }[] = [];
					for (const uri of uris) {
						const bytes = await vscode.workspace.fs.readFile(uri);
						fileDataArray.push({
							name: path.basename(uri.fsPath),
							type: 'application/octet-stream',
							size: bytes.length,
							lastModified: Date.now(),
							buffer: Array.from(bytes),
						});
					}
					panel.webview.postMessage({
						type: 'nativeFilesSelected',
						files: fileDataArray,
					});
				}
			}
		});

		const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
			panel.webview.postMessage({
				type: 'themeChanged',
			});
		});

		panel.onDidDispose(() => {
			messageDisposable.dispose();
			themeChangeDisposable.dispose();
		});
	}

	/**
	 * Generates HTML content for the pipeline editor webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-editor.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			// Replace template placeholders
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Convert resource URLs to webview URIs
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			this.logger.error(`Error loading pipeline editor HTML: ${error}`);
			return this.getErrorHtml(error, htmlPath.fsPath);
		}
	}

	/**
	 * Generates fallback HTML for when the main HTML file can't be loaded
	 */
	private getErrorHtml(error: unknown, expectedPath: string): string {
		return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Pipeline Editor Error</title>
        </head>
        <body>
            <div style="padding: 20px; color: #f44336;">
                <h3>Error Loading Pipeline Editor</h3>
                <p><strong>Error:</strong> ${error}</p>
                <p>Run <code>npm run build:webview</code> to build the webview components.</p>
                <p>Expected file: <code>${expectedPath}</code></p>
            </div>
        </body>
        </html>`;
	}

	/**
	 * Generates a random nonce for Content Security Policy
	 */
	private generateNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	public dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
