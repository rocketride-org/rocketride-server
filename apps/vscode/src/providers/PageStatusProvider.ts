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
 * Status Page Provider for Pipeline Status Monitoring
 * 
 * Provides a comprehensive status dashboard for pipeline and task monitoring
 * using a webview-based interface including:
 * - Real-time pipeline execution status
 * - Pipeline flow visualization with toggleable views
 * - Error and warning log display with structured parsing
 * - Host parameter support for dynamic URL generation
 * - External link opening through VS Code integration
 * - Live connection management with DAP command forwarding
 * 
 * Listens to Debug Adapter Protocol (DAP) events and connection state changes
 * to provide comprehensive pipeline monitoring capabilities.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { TaskStatus, GenericEvent, GenericResponse } from '../shared/types';
import { getLogger } from '../shared/util/output';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { ConnectionStatus, ConnectionState } from '../shared/types';
import type { PageStatusIncomingMessage, PageStatusOutgoingMessage } from '../shared/types/pageStatus';
import { getPipelineFilesTreeProvider } from '../extension';

/**
 * Interface for tracking monitoring state per view
 */
interface ViewMonitoringState {
	fileUri: vscode.Uri;
	displayName: string;
	panel: vscode.WebviewPanel;
	projectId: string;
	sourceId: string;
	isMonitoring: boolean;
	isDisposed: boolean;
}

/**
 * Status page provider for pipeline status monitoring with live connection
 */
export class PageStatusProvider {
	private webviewPanels: Map<string, ViewMonitoringState> = new Map();
	private taskStatusData: Map<string, TaskStatus | undefined> = new Map();
	private disposables: vscode.Disposable[] = [];
	private logger = getLogger();               // Handles output logging to VS Code channels

	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Creates a new PageStatusProvider
	 * 
	 * @param context VS Code extension context for command registration
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupEventListeners();
		this.registerCommands();
	}

	/**
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			// Status page commands - wrap async handlers properly
			vscode.commands.registerCommand('rocketride.page.status.open', async (displayName: string, fileUri: vscode.Uri, projectId: string, sourceId: string) => {
				try {
					await this.show(displayName, fileUri, projectId, sourceId);
				} catch (error) {
					this.logger.error(`Opening status page for ${projectId}.${sourceId}: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.page.state.close', (projectId: string, sourceId: string) => {
				try {
					this.close(projectId, sourceId);
				} catch (error) {
					this.logger.error(`Closing status page for ${projectId}.${sourceId}: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.status.page.closeAll', () => {
				try {
					this.closeAll();
				} catch (error) {
					this.logger.error(`Closing all status pages: ${error}`);
				}
			})
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach(command => this.context.subscriptions.push(command));
	}

	/**
	 * Sets up event listeners for connection and DAP events
	 */
	private setupEventListeners(): void {
		// Listen for connection state changes and broadcast to all webviews
		const connectionStateListener = this.connectionManager.on('connectionStateChanged', (connectionStatus: ConnectionStatus) => {
			// Handle this asynchronously to avoid blocking the event
			this.handleConnectionStateChange(connectionStatus).catch(error => {
				this.logger.error(`Handle connectionStateChange: ${error}`);
			});
		});

		// Listen for DAP events and route to appropriate webviews
		const eventListener = this.connectionManager.on('event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Keep track of disposables
		this.disposables.push(connectionStateListener, eventListener);
	}

	/**
	 * Handles connection state changes asynchronously
	 * 
	 * @param connectionStatus The new connection status
	 */
	private async handleConnectionStateChange(connectionStatus: ConnectionStatus): Promise<void> {
		if (connectionStatus.state === ConnectionState.CONNECTED) {
			// Start monitoring for connected views when connection is established
			try {
				await this.startMonitoringForAllViews();
			} catch (error) {
				this.logger.error(`Starting monitoring for all views: ${error}`);
			}
		} else {
			// Stop monitoring for connected views on connection termination
			try {
				await this.stopMonitoringForAllViews();
			} catch (error) {
				this.logger.error(`Stopping monitoring for all views: ${error}`);
			}
		}

		// Let everyone know about our new connection state
		const message: PageStatusIncomingMessage = {
			type: 'connectionState',
			state: connectionStatus.state
		};

		// Broadcast to all webviews
		const broadcastPromises = Array.from(this.webviewPanels.values()).map(async (viewState) => {
			try {
				if (!viewState.isDisposed) {
					await viewState.panel.webview.postMessage(message);
				}
			} catch (error) {
				this.logger.error(`Posting message to webview ${viewState.projectId}.${viewState.sourceId}: ${error}`);
			}
		});

		// Wait for them all to be sent
		await Promise.allSettled(broadcastPromises);
	}

	/**
	 * Handles events and routes them to the appropriate webviews
	 * 
	 * @param event The DAP event received from the connection manager
	 */
	private handleEvent(event: GenericEvent): void {
		switch (event.event) {
			case 'apaevt_status_update': {
				// Parse the event to extract project_id and source_id
				const projectId = event.body?.project_id || 'default';
				const sourceId = event.body?.source || 'default';
				const key = `${projectId}.${sourceId}`;

				// Check if we have a webview for this project/source
				const viewState = this.webviewPanels.get(key);
				if (!viewState || viewState.isDisposed) {
					return; // No webview interested in this event
				}

				const taskStatus = event.body as TaskStatus | undefined;
				if (taskStatus) {
					// Handle async update without blocking the event handler
					this.updateStatus(projectId, sourceId, taskStatus).catch(error => {
						this.logger.error(`Updating status for ${projectId}.${sourceId}: ${error}`);
					});
				}
				break;
			}

			case 'apaevt_flow': {
				// Forward pipeline trace events to all open webviews
				const body = event.body;
				if (!body?.trace) break;

				const traceMessage: PageStatusIncomingMessage = {
					type: 'traceEvent',
					pipelineId: body.id ?? 0,
					op: body.op || 'enter',
					pipes: body.pipes || [],
					trace: body.trace || {}
				};

				// Broadcast to all webviews
				for (const viewState of this.webviewPanels.values()) {
					if (!viewState.isDisposed) {
						viewState.panel.webview.postMessage(traceMessage).then(
							undefined,
							(error: unknown) => this.logger.error(`Posting trace event: ${error}`)
						);
					}
				}
				break;
			}
		}
	}

	/**
	 * Starts monitoring for a specific view
	 * 
	 * @param projectId Project identifier
	 * @param sourceId Source identifier
	 */
	private async startMonitoring(projectId: string, sourceId: string): Promise<void> {
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);

		// If we are already monitoring, we are not connected, or we are disposed, do nothing
		if (!viewState || viewState.isMonitoring || viewState.isDisposed || !this.connectionManager.isConnected()) {
			return;
		}

		try {
			// Send DAP command to start monitoring
			await this.connectionManager.request('rrext_monitor', {
				projectId: projectId,
				source: sourceId,
				types: ['summary', 'flow']
			});

			// Mark as monitoring
			viewState.isMonitoring = true;
		} catch (error) {
			this.logger.error(`Starting monitoring for ${projectId}.${sourceId}: ${error}`);
			// Ensure monitoring state is reset on failure
			viewState.isMonitoring = false;
		}
	}

	/**
	 * Stops monitoring for a specific view.
	 *
	 * @param projectId Project identifier
	 * @param sourceId Source identifier
	 * @param options.clearStatus If true (default), clear cached status so the UI shows Offline.
	 *        Pass false when stopping due to connection loss so the last known status stays visible.
	 */
	private async stopMonitoring(
		projectId: string,
		sourceId: string,
		options: { clearStatus?: boolean } = {}
	): Promise<void> {
		const { clearStatus = true } = options;
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);

		// If we are not monitoring
		if (!viewState || !viewState.isMonitoring) {
			return;
		}

		// Clear status only when explicitly requested (e.g. panel closed). When connection is lost,
		// keep last known status so the UI does not incorrectly show "Offline" while the task may still be running.
		if (clearStatus) {
			this.clearStatus(projectId, sourceId);
		}

		// If we are connected...
		if (this.connectionManager.isConnected()) {
			try {
				// Send DAP command to stop monitoring
				await this.connectionManager.request('rrext_monitor', {
					projectId: projectId,
					source: sourceId,
				});
			} catch (error) {
				// Output the error
				this.logger.error(`Stopping monitoring for ${projectId}.${sourceId}: ${error}`);
			}
		}

		// Mark as not monitoring
		viewState.isMonitoring = false;
	}

	/**
	 * Starts monitoring for all currently open views when connection is established
	 */
	private async startMonitoringForAllViews(): Promise<void> {
		const monitoringPromises = Array.from(this.webviewPanels.entries()).map(async ([key, viewState]) => {
			try {
				await this.startMonitoring(viewState.projectId, viewState.sourceId);
			} catch (error) {
				this.logger.error(`Starting all-view monitoring for ${key}: ${error}`);
			}
		});

		await Promise.allSettled(monitoringPromises);
	}

	/**
	 * Stops monitoring for all currently open views when connection is lost.
	 * Does not clear cached status; on reconnect we (re)subscribe and the server sends
	 * current state (or empty "not running" if the task is gone), so we get correct state then.
	 */
	private async stopMonitoringForAllViews(): Promise<void> {
		const monitoringPromises = Array.from(this.webviewPanels.entries()).map(async ([key, viewState]) => {
			try {
				await this.stopMonitoring(viewState.projectId, viewState.sourceId, { clearStatus: false });
			} catch (error) {
				this.logger.error(`Stopping all-view monitoring for ${key}: ${error}`);
			}
		});

		await Promise.allSettled(monitoringPromises);
	}

	/**
	 * Shows the status page webview panel for a specific pipeline
	 * 
	 * @param projectId Unique identifier for the project
	 * @param sourceId Source identifier
	 */
	public async show(
		displayName: string,
		fileUri: vscode.Uri,
		projectId: string,
		sourceId: string,
	): Promise<void> {
		const key = `${projectId}.${sourceId}`;

		// If panel already exists for this pipeline, just reveal it
		const existingViewState = this.webviewPanels.get(key);
		if (existingViewState && !existingViewState.isDisposed) {
			existingViewState.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Create a meaningful title for the panel
		const isUnknownTask = fileUri.scheme === 'rocketride';
		const panelTitle = isUnknownTask
			? `${displayName} (${projectId.substring(0, 8)}…)`
			: `${displayName} (${path.basename(fileUri.fsPath)})`;

		// Create new webview panel
		const panel = vscode.window.createWebviewPanel(
			'rocketride.pageStatus',
			panelTitle,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.context.extensionUri]
			}
		);

		// Create view state
		const viewState: ViewMonitoringState = {
			displayName: displayName,
			fileUri: fileUri,
			panel: panel,
			projectId: projectId,
			sourceId: sourceId,
			isMonitoring: false,
			isDisposed: false
		};

		// Store the view state
		this.webviewPanels.set(key, viewState);

		// Set webview content
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Handle webview disposal
		panel.onDidDispose(() => {
			// Handle cleanup asynchronously to avoid blocking disposal
			this.handlePanelDisposal(projectId, sourceId).catch(error => {
				this.logger.error(`Disposing panel for ${projectId}.${sourceId}: ${error}`);
			});
		});

		// Handle messages from webview
		panel.webview.onDidReceiveMessage((message) => {
			// Handle messages asynchronously to avoid blocking the UI
			this.handleWebviewMessage(message, viewState).catch(error => {
				this.logger.error(`Handling webview message for ${viewState.projectId}.${viewState.sourceId}: ${error}`);
			});
		});

		// Start monitoring if connected
		if (this.connectionManager.isConnected()) {
			try {
				await this.startMonitoring(projectId, sourceId);
			} catch (error) {
				this.logger.error(`Starting monitoring for new view ${projectId}.${sourceId}: ${error}`);
			}
		}
	}

	/**
	 * Handles panel disposal cleanup asynchronously
	 * 
	 * @param projectId Project identifier
	 * @param sourceId Source identifier
	 */
	private async handlePanelDisposal(projectId: string, sourceId: string): Promise<void> {
		const key = `${projectId}.${sourceId}`;

		// Mark as disposed immediately to prevent events from reaching the webview
		const viewState = this.webviewPanels.get(key);
		if (viewState) {
			viewState.isDisposed = true;
		}

		// Stop monitoring before cleanup
		try {
			await this.stopMonitoring(projectId, sourceId);
		} catch (error) {
			this.logger.error(`Stopping monitoring during disposal for ${key}: ${error}`);
		}

		// Clean up data
		this.webviewPanels.delete(key);
		this.taskStatusData.delete(key);
	}

	/**
	 * Updates the webview with current status data for a specific pipeline
	 * 
	 * @param projectId Unique identifier for the project
	 * @param sourceId Source identifier
	 */
	private async updateWebview(projectId: string, sourceId: string): Promise<void> {
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);
		if (!viewState || viewState.isDisposed) {
			return;
		}


		try {
			const taskStatus = this.taskStatusData.get(key);
			const connectionStatus = this.connectionManager.getConnectionStatus();
			const host = this.connectionManager.getHttpUrl();

			const updateMessage: PageStatusIncomingMessage = {
				type: 'update',
				taskStatus: taskStatus,
				host: host,
				state: connectionStatus.state
			};

			await viewState.panel.webview.postMessage(updateMessage);
		} catch (error) {
			console.error(`Error updating webview for ${key}:`, error);
			throw error;
		}
	}

	/**
	 * Updates the status page with new task status data for a specific pipeline
	 * 
	 * @param projectId Unique identifier for the project
	 * @param sourceId Source identifier
	 * @param taskStatus The new task status data or undefined to clear it
	 */
	public async updateStatus(
		projectId: string,
		sourceId: string,
		taskStatus?: TaskStatus): Promise<void> {
		const key = `${projectId}.${sourceId}`;

		// Update the status data - may be undefined if no status
		this.taskStatusData.set(key, taskStatus);

		// Refresh sidebar Pipelines tree so error/warning counts and lines update
		try {
			getPipelineFilesTreeProvider()?.refresh();
		} catch {
			// Sidebar may not be ready yet; ignore
		}

		// Update webview if it's active
		try {
			await this.updateWebview(projectId, sourceId);
		} catch (error) {
			this.logger.error(`Updating webview for ${key}: ${error}`);
			throw error;
		}
	}

	/**
	 * Returns task status for a given project and source (for use by sidebar tree).
	 */
	public getTaskStatus(projectId: string, sourceId: string): TaskStatus | undefined {
		return this.taskStatusData.get(`${projectId}.${sourceId}`);
	}

	/**
	 * Reveals the Errors tab and scrolls to the Warnings or Errors section in the status page webview.
	 * Call after show() so the panel is open. No-op if the panel for this project/source is not open.
	 */
	public revealErrorsSection(projectId: string, sourceId: string, section: 'errors' | 'warnings'): void {
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);
		if (!viewState || viewState.isDisposed) return;
		viewState.panel.reveal(vscode.ViewColumn.One);
		viewState.panel.webview.postMessage({ type: 'scrollToSection', section });
	}

	/**
	 * Clears the current status data for a specific pipeline
	 * 
	 * @param projectId Unique identifier for the project
	 * @param sourceId Source identifier
	 */
	public clearStatus(projectId: string, sourceId: string): void {
		// Handle async update without making this method async
		this.updateStatus(projectId, sourceId).catch(error => {
			this.logger.error(`Clearing status for ${projectId}.${sourceId}: ${error}`);
		});
	}

	/**
	 * Closes the status page webview for a specific pipeline
	 *
	 * @param projectId Unique identifier for the project
	 * @param sourceId Unique identifier for the source
	 */
	public close(projectId: string, sourceId: string): void {
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);
		if (viewState && !viewState.isDisposed) {
			viewState.panel.dispose(); // This will trigger onDidDispose which handles cleanup
		}
	}

	/**
	 * Closes all status page webviews
	 */
	public closeAll(): void {
		for (const viewState of this.webviewPanels.values()) {
			if (!viewState.isDisposed)
				viewState.panel.dispose();
		}
	}

	/**
	 * Checks if a status page is currently visible for a specific pipeline
	 * 
	 * @param projectId Unique identifier for the project
	 * @param sourceId Unique identifier for the source
	 */
	public isVisible(projectId: string, sourceId: string): boolean {
		const key = `${projectId}.${sourceId}`;
		const viewState = this.webviewPanels.get(key);

		if (!viewState || viewState.isDisposed)
			return false;

		return viewState.panel.visible;
	}

	/**
	 * Gets all currently open project IDs
	 */
	public getOpenProjectIds(): string[] {
		return Array.from(this.webviewPanels.keys());
	}

	/**
	 * Checks if there are any open status pages
	 */
	public hasData(): boolean {
		return this.webviewPanels.size > 0;
	}

	/**
	 * Opens a link in a new webview panel with VSCode API bridging and full theme support
	 */
	private async openLink(message: { url: string }, projectId: string, sourceId: string) {
		if (message.url && typeof message.url === 'string') {
			const key = `${projectId}.${sourceId}`;
			const taskStatus = this.taskStatusData.get(key);
			const viewState = this.webviewPanels.get(key);

			if (!taskStatus || !viewState) {
				return;
			}

			// Create the web panel
			const panel = vscode.window.createWebviewPanel(
				'externalContent',
				viewState.displayName,
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true
				}
			);

			// Get the .env settings
			const env: Record<string, string | boolean> = ConfigManager.getInstance().getEnv();
			env['devMode'] = true;

			// Bridge VSCode API to iframe
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
					<iframe id="app-iframe" src="${message.url}${message.url.includes('?') ? '&' : '?'}_t=${Date.now()}" allow="clipboard-read; clipboard-write"></iframe>
					<script>
						(function() {
							const vscode = acquireVsCodeApi();
							const iframe = document.getElementById('app-iframe');
							const envVars = ${JSON.stringify(env)};
							let iframeOrigin = '*';
							try { iframeOrigin = new URL(iframe.src).origin; } catch(e) {}

							// macOS fix: Finder drag events don't reach cross-origin iframes
							// in Electron webviews, so we bridge them to the iframe via postMessage.
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

							// Extract VSCode theme colors
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
							
							// Send combined env and theme data to iframe
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
							
							// Listen for messages FROM iframe
							window.addEventListener('message', (event) => {
								// Only handle messages from our iframe
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
								}
							});

							// Listen for messages from extension host
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
							});
						})();
					</script>
				</body>
				</html>
			`;

			// Handle messages from the webview
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
			});

			// Listen for theme changes in VSCode
			const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
				panel.webview.postMessage({
					type: 'themeChanged'
				});
			});

			panel.onDidDispose(() => {
				messageDisposable.dispose();
				themeChangeDisposable.dispose();
			});
		}
	}
	/**
	 * Handles messages received from the webview
	 * 
	 * @param message The message from the webview
	 * @param projectId The project ID for the webview that sent the message
	 * @param sourceId The source ID for the webview that sent the message
	 */
	private async handleWebviewMessage(message: PageStatusOutgoingMessage, viewState: ViewMonitoringState): Promise<void> {
		try {
			switch (message.type) {
				case 'ready': {
					// Webview is ready - send current data and connection state
					await this.updateWebview(viewState.projectId, viewState.sourceId);
					break;
				}

				case 'openExternal': {
					// Handle external link opening
					if (message.url) {
						await this.openLink(message, viewState.projectId, viewState.sourceId);
					}
					break;
				}

				case 'pipelineAction': {
					await this.handlePipelineAction(message.action, viewState, message.tracing);
					break;
				}
			}
		} catch (error) {
			this.logger.error(`Handling webview message of type ${message.type}: ${error}`);
			throw error;
		}
	}

	/**
	 * Handles pipeline action commands (attach, debug, stop, execute)
	 * 
	 * @param action The action to perform
	 * @param projectId The project ID
	 * @param sourceId The source ID
	 */
	private async handlePipelineAction(action: 'stop' | 'run' | 'restart', viewState: ViewMonitoringState, tracing?: boolean): Promise<void> {
		try {
			switch (action) {
				case 'stop': {
					// Use DAP command to stop the running pipeline process
					try {
						// We need the token to attach...
						const response = await this.connectionManager.request('rrext_get_token', {
							projectId: viewState.projectId,
							source: viewState.sourceId
						}) as GenericResponse | undefined;

						// Get the token of the task
						const token = response?.body?.token as string | undefined;

						// Send the terminate command
						await this.connectionManager.request(
							'terminate', {
						}, token);
					} catch (error: unknown) {
						this.logger.error(`Unable to execute pipeline: ${error}`);
						vscode.window.showErrorMessage(String(error));
					}
					break;
				}

				case 'run': {
					// Read the pipeline file
					const fileContent = await vscode.workspace.fs.readFile(viewState.fileUri);

					// Get it into a string
					const pipelineText = Buffer.from(fileContent).toString('utf8');

					// Convert to json
					const pipelineJson = JSON.parse(pipelineText);

					// Substitute .env settings
					const pipelineTransformed = ConfigManager.getInstance().substituteEnvVariables(pipelineJson);

					// Use DAP command to execute pipeline
					// When tracing is enabled, capture full pipeline trace data
					try {
						await this.connectionManager.request('execute', {
							projectId: viewState.projectId,
							source: viewState.sourceId,
							pipeline: pipelineTransformed,
							...(tracing ? { pipelineTraceLevel: 'full' } : {}),
							args: ConfigManager.getInstance().getEffectiveEngineArgs()
						});
					} catch (error: unknown) {
						this.logger.error(`Unable to execute pipeline: ${error}`);
						vscode.window.showErrorMessage(String(error));
					}
					break;
				}

				case 'restart': {
					// Read the pipeline file
					const fileContent = await vscode.workspace.fs.readFile(viewState.fileUri);

					// Get it into a a string
					const pipelineText = Buffer.from(fileContent).toString('utf8');

					// Convert to json
					const pipelineJson = JSON.parse(pipelineText);

					// Substitute and .env settings
					const pipelineTransformed = ConfigManager.getInstance().substituteEnvVariables(pipelineJson);

					// Use DAP command to execute pipeline without debugging
					try {
						// We need the token to attach...
						const response = await this.connectionManager.request('rrext_get_token', {
							projectId: viewState.projectId,
							source: viewState.sourceId
						}) as GenericResponse | undefined;

						// Get the token of the task
						const token = response?.body?.token as string | undefined;

						await this.connectionManager.request('restart', {
							token: token,
							projectId: viewState.projectId,
							source: viewState.sourceId,
							pipeline: pipelineTransformed
						}, '*');
					} catch (error: unknown) {
						this.logger.error(`Unable to execute pipeline: ${error}`);
						vscode.window.showErrorMessage(String(error));
					}
					break;
				}

				default: {
					this.logger.error(`Unknown pipeline action: ${action}`);
					break;
				}
			}
		} catch (error) {
			this.logger.error(`Handling pipeline action ${action}: ${error}`);
		}
	}

	/**
	 * Generates HTML content for the status page webview
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-status.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			// Replace template placeholders
			htmlContent = htmlContent
				.replace(/\{\{nonce\}\}/g, nonce)
				.replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Convert resource URLs to webview URIs
			return htmlContent.replace(
				/(?:src|href)="(\/static\/[^"]+)"/g,
				(match: string, relativePath: string): string => {
					const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
					const resourceUri = webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath)
					);
					return match.replace(relativePath, resourceUri.toString());
				}
			);
		} catch (error) {
			this.logger.error(`Loading status page HTML: ${error}`);
			return this.getErrorHtml(error, htmlPath.fsPath);
		}
	}

	/**
	 * Generates fallback HTML when the main HTML file can't be loaded
	 */
	private getErrorHtml(error: unknown, expectedPath: string): string {
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Status Page Error</title>
		</head>
		<body>
			<div style="padding: 20px; color: #f44336;">
				<h3>Error Loading Status Page</h3>
				<p><strong>Error:</strong> ${error}</p>
				<p>Run <code>npm run build:webview</code> to build the webview components.</p>
				<p>Expected file: <code>${expectedPath}</code></p>
			</div>
		</body>
		</html>`;
	}

	/**
	 * Generates a random nonce string for Content Security Policy
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
	public async dispose(): Promise<void> {
		// Stop all monitoring and close all panels
		this.closeAll();

		// Wait a bit for panels to dispose cleanly
		await new Promise(resolve => setTimeout(resolve, 100));

		// Dispose of all event listeners
		this.disposables.forEach(disposable => {
			try {
				disposable.dispose();
			} catch (error) {
				this.logger.error(`Error disposing resource: ${error}`);
			}
		});
		this.disposables = [];
	}
}
