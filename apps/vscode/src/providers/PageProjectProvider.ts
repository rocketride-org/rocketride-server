// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageProjectProvider — Unified custom editor for .pipeline files.
 *
 * Combines the former PageEditorProvider (canvas editing, file I/O, undo/redo)
 * and PageStatusProvider (status, trace, flow monitoring) into a single provider
 * that renders the shared-ui ProjectView component.
 *
 * Uses the ProjectViewIncoming / ProjectViewOutgoing message protocol to
 * communicate with the PageProject webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { TaskStatus, GenericEvent, ConnectionState } from '../shared/types';
import { ConnectionManager } from '../connection/connection';
import { ConfigManager } from '../config';
import type { PipelineConfig } from 'rocketride';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { PipelineFileParser } from '../shared/util/pipelineParser';

// =============================================================================
// CONSTANTS
// =============================================================================

const PREFS_KEY = 'rocketride.prefs';
const LAYOUTS_KEY = 'rocketride.layouts';

// =============================================================================
// TYPES
// =============================================================================

interface EditorState {
	document: vscode.TextDocument;
	webviewPanel: vscode.WebviewPanel;
	projectId?: string;
	isDisposed: boolean;
	isReady: boolean;
	cachedStatuses: Record<string, TaskStatus>;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class PageProjectProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<vscode.WebviewPanel, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	private savesForRun: Set<string> = new Set();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.registerCommands();
		this.setupEventListeners();
	}

	// =========================================================================
	// SAVE-FOR-RUN CHECK
	// =========================================================================

	public isSaveForRun(uri: vscode.Uri): boolean {
		return this.savesForRun.has(uri.toString());
	}

	public getTaskStatus(projectId: string, sourceId: string): TaskStatus | undefined {
		for (const editorState of this.editorStates.values()) {
			if (editorState.projectId === projectId) {
				return editorState.cachedStatuses[sourceId];
			}
		}
		return undefined;
	}

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	private setupEventListeners(): void {
		const eventListener = this.connectionManager.on('event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		const connectionStateListener = this.connectionManager.on('connectionStateChanged', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					this.onConnectedClearStaleData();
				}
				this.broadcastConnectionState(this.connectionManager.isConnected());
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		const servicesUpdatedListener = this.connectionManager.on('servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
			this.broadcastServicesToAllEditors(payload);
		});

		this.disposables.push(eventListener, connectionStateListener, servicesUpdatedListener);
	}

	// =========================================================================
	// EVENT ROUTING
	// =========================================================================

	private handleEvent(event: GenericEvent): void {
		switch (event.event) {
			case 'apaevt_status_update': {
				const projectId = event.body?.project_id;
				const source = event.body?.source;
				if (!projectId || !source) return;

				const taskStatus = event.body as TaskStatus;
				let dispatched = false;
				for (const editorState of this.editorStates.values()) {
					if (editorState.isDisposed || editorState.projectId !== projectId) continue;
					editorState.cachedStatuses[source] = taskStatus;
					if (editorState.isReady) {
						editorState.webviewPanel.webview.postMessage({ type: 'status:update', taskStatus });
					}
					dispatched = true;
				}
				if (!dispatched) return;
				break;
			}

			case 'apaevt_flow': {
				const body = event.body;
				if (!body?.trace) break;

				const flowProjectId = body.project_id;
				if (!flowProjectId) break;

				const traceEvent: Record<string, unknown> = {
					pipelineId: body.id ?? 0,
					op: body.op || 'enter',
					pipes: body.pipes || [],
					trace: body.op === 'end' ? {} : body.trace || {},
					source: body.source,
				};
				if (body.op === 'end' && body.trace && Object.keys(body.trace).length > 0) {
					traceEvent.pipelineResult = body.trace;
				}

				for (const editorState of this.editorStates.values()) {
					if (editorState.isDisposed || !editorState.isReady) continue;
					if (editorState.projectId !== flowProjectId) continue;
					editorState.webviewPanel.webview.postMessage({ type: 'trace:event', event: traceEvent });
				}
				break;
			}
		}
	}

	// =========================================================================
	// BROADCASTING
	// =========================================================================

	private broadcastServicesToAllEditors(payload: { services: Record<string, unknown>; servicesError?: string }): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview
					.postMessage({
						type: 'canvas:services',
						services: payload.services,
					})
					.then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post services to webview: ${err}`);
					});
			}
		}
	}

	private broadcastConnectionState(isConnected: boolean): void {
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'project:connectionState', isConnected }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post connectionState to webview: ${err}`);
				});
			}
		}
	}

	// =========================================================================
	// MONITORING
	// =========================================================================

	private async startMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || editorState.isDisposed || !editorState.projectId || !this.connectionManager.isConnected()) {
			return;
		}

		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('No client available');
			await client.addMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow']);
		} catch (error) {
			this.logger.error(`Starting monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private async stopMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || !editorState.projectId) return;

		try {
			const client = this.connectionManager.getClient();
			if (client) await client.removeMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow']);
		} catch (error) {
			this.logger.error(`Stopping monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private onConnectedClearStaleData(): void {
		for (const editorState of this.editorStates.values()) {
			editorState.cachedStatuses = {};
		}
	}

	// =========================================================================
	// COMMANDS
	// =========================================================================

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
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.files.save');
				}
			}),

			vscode.commands.registerCommand('rocketride.editor.refresh', async () => {
				if (vscode.window.activeTextEditor?.document.languageId === 'pipeline') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			}),
		];

		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	// =========================================================================
	// RESOLVE CUSTOM TEXT EDITOR
	// =========================================================================

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const webview = webviewPanel.webview;

		const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
		webviewPanel.title = fileName.replace(/\.pipe(\.json)?$/i, '');

		const { projectId } = this.extractPipelineIds(document);

		const editorState: EditorState = {
			document,
			webviewPanel,
			projectId,
			isDisposed: false,
			isReady: false,
			cachedStatuses: {},
		};

		this.editorStates.set(webviewPanel, editorState);

		webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		webview.html = this.getHtmlForWebview(webview);

		// --- Handle messages from the webview (ProjectViewOutgoing) -----------

		webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'ready': {
					editorState.isReady = true;

					// Build project from document
					const text = document.getText();
					const parsed = PipelineFileParser.parseContent(text, document.uri.fsPath);
					let project: Record<string, unknown> | undefined;
					if (parsed.isValid) {
						try {
							project = JSON.parse(this.enrichComponentNames(text));
						} catch {
							/* invalid JSON */
						}
					}

					// Load layout defaults + prefs
					const layouts = this.context.workspaceState.get<Record<string, Record<string, unknown>>>(LAYOUTS_KEY) ?? {};
					const layout = layouts[document.uri.toString()] ?? {};
					const storedPrefs = this.context.workspaceState.get<Record<string, unknown>>(PREFS_KEY) ?? {};
					const cached = this.connectionManager.getCachedServices();

					// Send everything in one message
					webview.postMessage({
						type: 'project:load',
						project,
						viewState: { mode: 'design', ...layout },
						prefs: storedPrefs,
						services: cached.services,
						isConnected: this.connectionManager.isConnected(),
						statuses: editorState.cachedStatuses,
						serverHost: this.connectionManager.getHttpUrl(),
					});

					// Kick off background services refresh
					this.connectionManager.refreshServices().catch((err) => {
						this.logger.error(`Background services refresh failed: ${err}`);
					});

					// Start monitoring
					try {
						await this.startMonitoring(webviewPanel);
					} catch (error) {
						this.logger.error(`Starting monitoring after webview ready: ${error}`);
					}
					break;
				}

				// Canvas messages
				case 'canvas:contentChanged': {
					if (data.project) {
						const content = typeof data.project === 'string' ? data.project : JSON.stringify(data.project);
						this.applyDocumentEdit(document, content);
					}
					break;
				}

				case 'canvas:validate': {
					this.logger.output(`${icons.pipeline} Validating pipeline...`);
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const result = await client.validate({ pipeline: data.pipeline });
						this.logger.output(`${icons.success} Pipeline validation passed`);
						webview.postMessage({ type: 'canvas:validateResponse', requestId: data.requestId, result });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.output(`${icons.error} Pipeline validation failed: ${msg}`);
						webview.postMessage({ type: 'canvas:validateResponse', requestId: data.requestId, result: { errors: [], warnings: [] }, error: msg });
					}
					break;
				}

				case 'canvas:requestSave':
				case 'project:requestSave': {
					await this.saveDocument(document, document.getText());
					break;
				}

				// Status messages
				case 'status:pipelineAction': {
					const action = data.action as 'run' | 'stop' | 'restart';
					const source = data.source as string | undefined;
					if (action === 'run' || action === 'restart') {
						const uriKey = document.uri.toString();
						this.savesForRun.add(uriKey);
						try {
							await this.saveDocument(document, document.getText());
							const parsed = JSON.parse(document.getText());
							const pipeName = path.basename(document.uri.fsPath, '.pipe');
							await this.runPipeline({ pipeline: { ...parsed, source: source ?? parsed.source } }, pipeName);
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : String(error);
							vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
						}
						setTimeout(() => this.savesForRun.delete(uriKey), 2000);
					} else if (action === 'stop') {
						if (source) {
							await this.stopPipeline(source, document);
						}
					}
					break;
				}

				// Link opening
				case 'project:openLink': {
					if (data.url) {
						this.openLink(data.url as string, data.displayName as string | undefined);
					}
					break;
				}

				// Trace messages
				case 'trace:clear':
					// No-op on host side
					break;

				// View state change — not persisted in VS Code
				case 'project:viewStateChange': {
					// Update layouts (per-document defaults for future opens)
					if (data.viewState) {
						const allLayouts = this.context.workspaceState.get<Record<string, unknown>>(LAYOUTS_KEY) ?? {};
						allLayouts[document.uri.toString()] = data.viewState;
						this.context.workspaceState.update(LAYOUTS_KEY, allLayouts).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist layout: ${err}`);
						});
					}
					break;
				}

				// Prefs change — persist globally
				case 'project:prefsChange': {
					if (data.prefs) {
						this.context.workspaceState.update(PREFS_KEY, data.prefs).then(undefined, (err: unknown) => {
							this.logger.error(`Failed to persist prefs: ${err}`);
						});
					}
					break;
				}
			}
		});

		// Listen for document changes (undo/redo) and sync to webview
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				const { projectId: newProjectId } = this.extractPipelineIds(e.document);
				editorState.projectId = newProjectId;
				this.sendCanvasUpdate(webview, e.document);
			}
		});

		// Clean up when panel is disposed
		webviewPanel.onDidDispose(async () => {
			await this.stopMonitoring(webviewPanel);
			editorState.cachedStatuses = {};
			editorState.isDisposed = true;
			this.editorStates.delete(webviewPanel);
			changeDocumentSubscription.dispose();
		});

		// Start monitoring immediately if connected
		if (this.connectionManager.isConnected()) {
			this.startMonitoring(webviewPanel).catch((error) => {
				this.logger.error(`Starting initial monitoring: ${error}`);
			});
		}
	}

	// =========================================================================
	// DOCUMENT I/O
	// =========================================================================

	private sendCanvasUpdate(webview: vscode.Webview, document: vscode.TextDocument): void {
		const text = document.getText();
		const parsed = PipelineFileParser.parseContent(text, document.uri.fsPath);
		if (!parsed.isValid) {
			return;
		}

		const enriched = this.enrichComponentNames(text);
		try {
			const project = JSON.parse(enriched);
			webview.postMessage({ type: 'canvas:update', project });
		} catch {
			// Invalid JSON — skip
		}
	}

	private enrichComponentNames(text: string): string {
		const cached = this.connectionManager.getCachedServices();
		const services = cached?.services;
		if (!services || Object.keys(services).length === 0) return text;

		const pipeline = JSON.parse(text);
		const components = pipeline.components as Array<{ provider: string; name?: string }> | undefined;
		if (!components) return text;

		let changed = false;
		for (const component of components) {
			if (!component.name) {
				const service = services[component.provider] as { title?: string } | undefined;
				if (service?.title) {
					component.name = service.title;
					changed = true;
				}
			}
		}

		return changed ? JSON.stringify(pipeline, null, 2) : text;
	}

	private toVerboseJson(content: string | Record<string, unknown>): string {
		const obj = typeof content === 'string' ? JSON.parse(content) : content;
		return JSON.stringify(obj, null, 2);
	}

	private async applyDocumentEdit(document: vscode.TextDocument, content: string): Promise<{ changed: boolean; applied: boolean }> {
		let normalizedNew: string;
		try {
			normalizedNew = this.toVerboseJson(content);
		} catch {
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

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentText.length));
		edit.replace(document.uri, fullRange, normalizedNew);
		const success = await vscode.workspace.applyEdit(edit);
		if (!success) {
			this.logger.error('[PageProjectProvider] Failed to apply document edit');
		}
		return { changed: true, applied: success };
	}

	private async saveDocument(document: vscode.TextDocument, content: string | Record<string, unknown>): Promise<void> {
		const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
		const { changed, applied } = await this.applyDocumentEdit(document, contentStr);
		if (applied) {
			await document.save();
		} else if (changed) {
			vscode.window.showErrorMessage('Failed to save pipeline file');
		}
	}

	private extractPipelineIds(document: vscode.TextDocument): { projectId?: string; sourceId?: string } {
		try {
			const content = document.getText();
			const parsed = JSON.parse(content);
			return { projectId: parsed.project_id, sourceId: parsed.source };
		} catch {
			return { projectId: undefined, sourceId: undefined };
		}
	}

	// =========================================================================
	// PIPELINE EXECUTION
	// =========================================================================

	private async runPipeline(document: { pipeline: PipelineConfig }, name?: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const project = document.pipeline;

			await client.use({
				pipeline: project,
				source: project.source,
				pipelineTraceLevel: 'full',
				args: ConfigManager.getInstance().getEffectiveEngineArgs(),
				name,
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
		}
	}

	private async stopPipeline(componentId: string, document: vscode.TextDocument): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const parsed = JSON.parse(document.getText());
			const projectId = parsed.project_id;

			if (!projectId || !componentId) {
				this.logger.error(`[PageProjectProvider] Missing projectId or componentId`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			const token = await client.getTaskToken({ projectId, source: componentId });

			if (!token) {
				this.logger.error('[PageProjectProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			await client.terminate(token);
		} catch (error: unknown) {
			this.logger.error(`[PageProjectProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	// =========================================================================
	// OPEN LINK
	// =========================================================================

	/**
	 * Opens a URL in an embedded VS Code WebviewPanel with an iframe.
	 * Bridges theme colors, env vars, clipboard, and drag-and-drop to the iframe.
	 */
	private openLink(url: string, displayName?: string): void {
		const panel = vscode.window.createWebviewPanel('externalContent', displayName || 'Pipeline', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

		const env: Record<string, string | boolean> = ConfigManager.getInstance().getEnv();
		env['devMode'] = true;

		panel.webview.html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{margin:0;padding:0}iframe{width:100%;height:100vh;border:none}</style>
</head><body>
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
			fileDataArray.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, lastModified: file.lastModified, buffer: buffer });
		}
		try {
			iframe.contentWindow.postMessage({ type: 'bridgedFileDrop', files: fileDataArray }, iframeOrigin, fileDataArray.map(f => f.buffer));
			iframe.contentWindow.postMessage({ type: 'dragLeave' }, iframeOrigin);
		} catch (err) { console.error('[Parent] Error bridging file drop to iframe:', err); }
	});

	function getVSCodeThemeColors() {
		const style = getComputedStyle(document.body);
		const getColor = (varName, fallback = '') => { const value = style.getPropertyValue(varName).trim(); return value || fallback; };
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
		try { iframe.contentWindow.postMessage({ type: 'vscodeData', env: envVars, theme: colors }, iframeOrigin); }
		catch (error) { console.error('[Parent] Error sending data to iframe:', error); }
	}

	window.addEventListener('message', (event) => {
		if (event.source === iframe.contentWindow) {
			if (event.data.type === 'ready' || event.data.type === 'view:ready') sendDataToIframe();
			if (event.data.type === 'requestPaste') vscode.postMessage({ type: 'requestPaste' });
			if (event.data.type === 'copyText' && event.data.text) vscode.postMessage({ type: 'copyText', text: event.data.text });
			if (event.data.type === 'requestFileDialog') vscode.postMessage({ type: 'requestFileDialog' });
		}
		const msg = event.data;
		if (msg.type === 'themeChanged') setTimeout(() => sendDataToIframe(), 50);
		if (msg.type === 'pasteContent' && msg.text && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'paste', text: msg.text }, iframeOrigin);
		if (msg.type === 'nativeFilesSelected' && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'nativeFilesSelected', files: msg.files }, iframeOrigin);
	});
})();
</script>
</body></html>`;

		// Bridge clipboard requests from the embedded iframe.  The chat-ui
		// (and any future embedded web app) cannot read the OS clipboard from
		// inside a VSCode webview iframe — VSCode intercepts native paste at
		// the Electron layer.  The iframe posts {type:'requestPaste'} up to
		// the bridge script, which forwards it here via vscode.postMessage;
		// we read the clipboard via the extension-host API and post the text
		// back to the webview, where the bridge relays it into the iframe.
		panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg?.type === 'requestPaste') {
				const text = await vscode.env.clipboard.readText();
				panel.webview.postMessage({ type: 'pasteContent', text });
			} else if (msg?.type === 'copyText' && typeof msg.text === 'string') {
				await vscode.env.clipboard.writeText(msg.text);
			}
		});
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-project.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			this.logger.error(`Error loading project editor HTML: ${error}`);
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading Project Editor</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
                <p>Expected: <code>${htmlPath.fsPath}</code></p>
            </body></html>`;
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
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
