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
 * Pipeline Files Tree Provider for Pipeline File Management
 *
 * Displays .pipeline files with parsed content including:
 * - Pipeline file hierarchy and structure
 * - Source component breakdown
 * - File validation status and warnings
 * - Interactive file and component selection
 *
 * Monitors file system changes and provides pipeline-specific
 * operations through tree view interface.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { getStatusPageProvider, getPageEditorProvider } from '../extension';
import { getLogger } from '../shared/util/output';
import { PipelineFileParser, ParsedPipelineFile, ParsedSourceComponent } from '../shared/util/pipelineParser';
import { ConfigManager } from '../config';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent, GenericResponse } from '../shared/types';

/** Parsed location from structured error format (ErrorType*`message`*filepath:linenumber) */
export interface ParsedErrWarnLine {
	filePath: string;
	lineNumber?: number;
	label: string;
}

export interface PipelineFileItem {
	label: string;
	description?: string;
	resourceUri: vscode.Uri;
	contextValue: string;
	iconPath?: vscode.ThemeIcon;
	collapsibleState: vscode.TreeItemCollapsibleState;
	parsedFile?: ParsedPipelineFile;
	sourceComponent?: ParsedSourceComponent;
	unknownTask?: UnknownTask;
	/** Task execution errors (for pipelineSource and errorsFolder) */
	taskErrors?: string[];
	/** Task execution warnings (for pipelineSource and warningsFolder) */
	taskWarnings?: string[];
	/** Folder type for Errors (n) / Warnings (n) nodes */
	folderType?: 'errors' | 'warnings';
	/** Raw error/warning strings for folder children */
	taskItems?: string[];
	/** Parsed file path and line for errorLine/warningLine click-to-open */
	errorLine?: ParsedErrWarnLine;
}

export interface UnknownTask {
	projectId: string;
	sourceId: string;
	displayName?: string;
}

export class SidebarFilesProvider implements vscode.TreeDataProvider<PipelineFileItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<PipelineFileItem | undefined | null | void> = new vscode.EventEmitter<PipelineFileItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<PipelineFileItem | undefined | null | void> = this._onDidChangeTreeData.event;

	private pipelineFiles: PipelineFileItem[] = [];
	private parsedFiles = new Map<string, ParsedPipelineFile>();
	private disposables: vscode.Disposable[] = [];

	private configManager = ConfigManager.getInstance();
	private connectionManager = ConnectionManager.getInstance();

	private activePipelines = new Set<string>();
	private unknownTasks = new Map<string, UnknownTask>(); // Tracks tasks without local .pipe files
	private logger = getLogger(); // Handles output logging to VS Code channels

	/**
	 * Creates a new SidebarFilesProvider
	 *
	 * @param context VS Code extension context for command registration
	 */
	constructor(private context: vscode.ExtensionContext) {
		this.setupFileWatching();
		this.registerCommands();
		this.setupEventListeners();
		this.loadPipelineFiles();
	}

	/**
	 * Initialize file system watching for .pipe and .pipe.json files
	 */
	private setupFileWatching(): void {
		// Watch both .pipe (new default) and .pipe.json (backward compat)
		const watcherPipe = vscode.workspace.createFileSystemWatcher('**/*.pipe');
		const watcherPipeJson = vscode.workspace.createFileSystemWatcher('**/*.pipe.json');

		// Store disposables for cleanup
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
	 * Registers all commands handled by this provider
	 */
	private registerCommands(): void {
		const commands = [
			// Pipeline file operations
			vscode.commands.registerCommand('rocketride.sidebar.files.openFile', async (item?: PipelineFileItem) => {
				const resourceUri = this.resolveCommandResourceUri(item);
				if (!resourceUri) {
					vscode.window.showErrorMessage('No pipeline file selected');
					return;
				}

				try {
					// Open with a specific custom editor
					await vscode.commands.executeCommand('vscode.openWith', resourceUri, 'rocketride.PageEditor');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to open status page: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.openStatus', async (item?: PipelineFileItem) => {
				const resourceUri = this.resolveCommandResourceUri(item);
				if (!resourceUri) {
					vscode.window.showErrorMessage('No pipeline file selected');
					return;
				}

				const knownContext = this.resolveKnownPipelineCommandContext(item, resourceUri);
				const unknownTask = item?.unknownTask as UnknownTask;

				try {
					let projectId: string;
					let source: string;
					let displayName: string;

					// Check if this is an unknown task
					if (unknownTask) {
						projectId = unknownTask.projectId;
						source = unknownTask.sourceId;
						displayName = unknownTask.displayName || source;
					} else {
						if (knownContext?.parsedPipeline?.isValid && knownContext.parsedPipeline.projectId && knownContext.componentId) {
							projectId = knownContext.parsedPipeline.projectId;
							source = knownContext.componentId;
							displayName = knownContext.displayName;
						} else {
							vscode.window.showErrorMessage(`Invalid pipeline file or missing project_id: ${path.basename(resourceUri.fsPath)}`);
							return;
						}
					}

					// Show the status page for this project with the specific component as source
					const statusPageProvider = getStatusPageProvider();
					if (statusPageProvider) {
						// Pass title and tooltip to the status page provider
						statusPageProvider.show(displayName, resourceUri, projectId, source);
					} else {
						vscode.window.showErrorMessage('Status page provider not available');
					}
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to open status page for component: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.refresh', async () => {
				await this.forceRefresh();
				this.updateContextBasedOnData();
				vscode.window.showInformationMessage('Pipeline views refreshed');
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.createFile', async () => {
				await this.createNewPipelineFile();
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.runPipeline', async (item?: PipelineFileItem) => {
				const resourceUri = this.resolveCommandResourceUri(item);
				if (!resourceUri) {
					vscode.window.showErrorMessage('No pipeline selected');
					return;
				}

				try {
					// Read the pipeline file
					const fileContent = await vscode.workspace.fs.readFile(resourceUri);
					const pipelineText = Buffer.from(fileContent).toString('utf8');
					const pipelineJson = JSON.parse(pipelineText);

					// Substitute .env settings
					const pipelineTransformed = ConfigManager.getInstance().substituteEnvVariables(pipelineJson);

					// Get project and source identifiers
					const context = this.resolveKnownPipelineCommandContext(item, resourceUri);
					const projectId = context?.parsedPipeline?.projectId;
					const sourceId = context?.componentId ?? '';

					// Use DAP command to execute pipeline without debugging
					await this.connectionManager.request('execute', {
						projectId: projectId,
						source: sourceId,
						pipeline: pipelineTransformed,
						args: ConfigManager.getInstance().getEffectiveEngineArgs(),
					});
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to run pipeline: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.stopPipeline', async (item?: PipelineFileItem) => {
				if (!item) {
					vscode.window.showErrorMessage('No pipeline selected');
					return;
				}

				let projectId: string | undefined;
				let sourceId: string | undefined;

				if (item.contextValue?.startsWith('pipelineSource')) {
					const parsedFile = item.parsedFile || this.getParsedPipeline(item.resourceUri);
					projectId = parsedFile?.projectId;
					sourceId = item.sourceComponent?.id;
				} else if (item.contextValue === 'unknownTask' && item.unknownTask) {
					projectId = item.unknownTask.projectId;
					sourceId = item.unknownTask.sourceId;
				}

				if (!projectId || !sourceId) {
					vscode.window.showErrorMessage('Could not determine pipeline to stop');
					return;
				}

				try {
					const response = (await this.connectionManager.request('rrext_get_token', {
						projectId: projectId,
						source: sourceId,
					})) as GenericResponse | undefined;

					const token = response?.body?.token as string | undefined;

					await this.connectionManager.request('terminate', {}, token);
				} catch (error: unknown) {
					this.logger.error(`Unable to stop pipeline: ${error}`);
					vscode.window.showErrorMessage(`Failed to stop pipeline: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.openFileAtLine', async (filePath: string, lineNumber?: number) => {
				if (!filePath || typeof filePath !== 'string') return;
				const line = typeof lineNumber === 'number' && lineNumber > 0 ? lineNumber : 1;
				let uri: vscode.Uri;
				if (path.isAbsolute(filePath)) {
					uri = vscode.Uri.file(filePath);
				} else {
					const folders = vscode.workspace.workspaceFolders;
					uri = folders?.length ? vscode.Uri.joinPath(folders[0].uri, filePath) : vscode.Uri.file(filePath);
				}
				try {
					const doc = await vscode.workspace.openTextDocument(uri);
					const range = new vscode.Range(line - 1, 0, line - 1, 0);
					await vscode.window.showTextDocument(doc, { selection: range, preview: false });
				} catch (e) {
					this.logger.error(`Open file at line failed: ${e}`);
					vscode.window.showErrorMessage(`Could not open ${path.basename(filePath)}: ${e}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.revealErrorsSection', async (item?: PipelineFileItem) => {
				if (!item || !item.resourceUri || !item.sourceComponent || !item.folderType) return;
				const resourceUri = item.resourceUri as vscode.Uri;
				const sourceComponent = item.sourceComponent as ParsedSourceComponent;
				const parsedPipeline = this.getParsedPipeline(resourceUri);
				if (!parsedPipeline?.isValid || !parsedPipeline.projectId) {
					vscode.window.showErrorMessage(`Invalid pipeline file or missing project_id`);
					return;
				}
				const projectId = parsedPipeline.projectId;
				const sourceId = sourceComponent.id;
				const services = this.connectionManager.getCachedServices()?.services ?? {};
				const providerDef = sourceComponent.provider ? (services[sourceComponent.provider] as { title?: string } | undefined) : undefined;
				const displayName = sourceComponent.name || providerDef?.title || sourceId;
				const statusPageProvider = getStatusPageProvider();
				if (!statusPageProvider) {
					vscode.window.showErrorMessage('Status page provider not available');
					return;
				}
				await statusPageProvider.show(displayName, resourceUri, projectId, sourceId);
				statusPageProvider.revealErrorsSection(projectId, sourceId, item.folderType);
			}),
		];

		// Store disposables and add to context subscriptions
		this.disposables.push(...commands);
		commands.forEach((command) => this.context.subscriptions.push(command));
	}

	private resolveCommandResourceUri(item?: PipelineFileItem): vscode.Uri | undefined {
		if (item?.resourceUri) {
			return item.resourceUri;
		}

		const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
		if (activeEditorUri && this.isPipelineUri(activeEditorUri)) {
			return activeEditorUri;
		}

		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (activeTab instanceof vscode.TabInputText || activeTab instanceof vscode.TabInputCustom) {
			if (this.isPipelineUri(activeTab.uri)) {
				return activeTab.uri;
			}
		}

		return undefined;
	}

	private isPipelineUri(uri: vscode.Uri): boolean {
		return uri.fsPath.endsWith('.pipe') || uri.fsPath.endsWith('.pipe.json');
	}

	private resolveKnownPipelineCommandContext(
		item: PipelineFileItem | undefined,
		resourceUri: vscode.Uri
	):
		| {
				componentId?: string;
				displayName: string;
				parsedPipeline?: ParsedPipelineFile;
				sourceComponent?: ParsedSourceComponent;
		  }
		| undefined {
		const parsedPipeline = item?.parsedFile || this.getParsedPipeline(resourceUri);
		if (!parsedPipeline?.isValid) {
			return undefined;
		}

		const componentId = item?.sourceComponent?.id ?? parsedPipeline.pipeline?.source ?? parsedPipeline.sourceComponents?.[0]?.id;
		const sourceComponent = componentId ? item?.sourceComponent || this.getSourceComponentById(resourceUri, componentId) : undefined;
		const services = this.connectionManager.getCachedServices()?.services ?? {};
		const providerDef = sourceComponent?.provider ? (services[sourceComponent.provider] as { title?: string } | undefined) : undefined;

		return {
			componentId,
			displayName: sourceComponent?.name || providerDef?.title || componentId || path.basename(resourceUri.fsPath),
			parsedPipeline,
			sourceComponent,
		};
	}

	/**
	 * Sets up event listeners for connection and DAP events
	 */
	private setupEventListeners(): void {
		// Listen for events from any session
		const eventListener = this.connectionManager.addListener('event', (e) => {
			this.handleEvent(e);
		});

		// Listen for connected events
		const connectedEventListener = this.connectionManager.addListener('connected', (_e) => {
			// Global task/output monitors are now registered in ConnectionManager.onConnectionEstablished
		});

		// Listen for disconnected events
		const disconnectedEventListener = this.connectionManager.addListener('disconnected', (_e) => {
			// Clear them all and refresh
			this.activePipelines.clear();
			this.unknownTasks.clear();
			this.refresh();
		});

		// Refresh tree when service definitions arrive so component names resolve
		const servicesUpdatedListener = this.connectionManager.addListener('servicesUpdated', () => {
			this.refresh();
		});

		// Keep track of disposables
		this.disposables.push(eventListener, connectedEventListener, disconnectedEventListener, servicesUpdatedListener);
	}

	/**
	 * Handles events and routes them to the appropriate webviews
	 *
	 * @param event The DAP event received from the connection manager
	 */
	private handleEvent(event: GenericEvent): void {
		switch (event.event) {
			case 'apaevt_task': {
				// Parse the event to extract project_id and source_id
				const projectId = event.body?.projectId || 'default';
				const sourceId = event.body?.source || 'default';
				const action = event.body?.action;
				const key = this.getActiveKey(projectId, sourceId);

				// Add or remove it
				switch (action) {
					case 'begin':
						// Single pipeline started
						this.activePipelines.add(key);
						// Check if this is an unknown task (no local .pipe.json)
						if (!this.isKnownTask(projectId, sourceId)) {
							this.unknownTasks.set(key, { projectId, sourceId });
						}
						break;

					case 'running':
						// Resync
						this.activePipelines.clear();
						this.unknownTasks.clear();
						for (const task of event.body?.tasks ?? []) {
							const key = this.getActiveKey(task.projectId, task.source);
							this.activePipelines.add(key);
							// Check if this is an unknown task
							if (!this.isKnownTask(task.projectId, task.source)) {
								this.unknownTasks.set(key, {
									projectId: task.projectId,
									sourceId: task.source,
								});
							}
						}
						break;

					case 'end':
						// Single pipeline ended
						this.activePipelines.delete(key);
						this.unknownTasks.delete(key);
						break;
				}

				// Refresh the tree view to update icons
				this.refresh();
				break;
			}
		}
	}

	/**
	 * Generates the active pipeline key for tracking running pipelines
	 */
	private getActiveKey(projectId: string, sourceId: string): string {
		return `${projectId}.${sourceId}`;
	}

	/**
	 * Checks if a task corresponds to a known pipeline file in the workspace
	 */
	private isKnownTask(projectId: string, sourceId: string): boolean {
		// Check if any parsed pipeline file matches this projectId and has this sourceId
		for (const parsedFile of this.parsedFiles.values()) {
			if (parsedFile.isValid && parsedFile.projectId === projectId) {
				// Check if this pipeline has the source component
				const hasSource = parsedFile.sourceComponents.some((c) => c.id === sourceId);
				if (hasSource) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Handles file creation events
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const text = Buffer.from(raw).toString('utf8').trim();
			let parsed: Record<string, unknown>;
			let needsWrite = false;

			if (!text) {
				// Empty file — initialize with valid pipeline template
				parsed = { project_id: crypto.randomUUID(), components: [] };
				needsWrite = true;
			} else {
				try {
					const result = JSON.parse(text);
					if (result === null || typeof result !== 'object' || Array.isArray(result)) {
						parsed = { project_id: crypto.randomUUID(), components: [] };
						needsWrite = true;
					} else {
						parsed = result as Record<string, unknown>;
					}
				} catch {
					// Invalid JSON — overwrite with valid pipeline template
					parsed = { project_id: crypto.randomUUID(), components: [] };
					needsWrite = true;
				}
			}

			if (!Array.isArray(parsed.components)) {
				parsed.components = [];
				needsWrite = true;
			}

			const existingIds = new Set([...this.parsedFiles.values()].map((f) => f.projectId).filter((id): id is string => typeof id === 'string' && id.trim() !== ''));
			const projectId = typeof parsed.project_id === 'string' && parsed.project_id.trim() !== '' ? parsed.project_id : null;
			const isDuplicate = projectId !== null && existingIds.has(projectId);
			if (!projectId || isDuplicate) {
				parsed.project_id = crypto.randomUUID();
				needsWrite = true;
			}

			if (needsWrite) {
				await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
			}
		} catch {
			// If the file can't be read yet, just proceed with reload
		}
		await this.loadPipelineFiles();
	}

	/**
	 * Handles file deletion events
	 */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		// Remove from parsed files map
		this.parsedFiles.delete(uri.fsPath);

		// Remove from pipeline files array
		this.pipelineFiles = this.pipelineFiles.filter((item) => item.resourceUri.fsPath !== uri.fsPath);

		// Fire the tree change event - use no parameters to refresh entire tree
		this.refresh();
	}

	/**
	 * Handles file modification events
	 */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		// Ensure a valid project_id exists before re-parsing
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const result = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
			if (result && typeof result === 'object' && !Array.isArray(result)) {
				const root = result as Record<string, unknown>;
				const target = root.pipeline && typeof root.pipeline === 'object' && !Array.isArray(root.pipeline) ? (root.pipeline as Record<string, unknown>) : root;
				const hasComponents = Array.isArray(target.components);
				const hasValidProjectId = typeof target.project_id === 'string' && target.project_id.trim().length > 0;
				if (hasComponents && !hasValidProjectId) {
					target.project_id = crypto.randomUUID();
					await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(result, null, 2), 'utf8'));
				}
			}
		} catch {
			// Not valid JSON yet — skip project_id assignment
		}

		// Re-parse the changed file
		const parsedFile = await PipelineFileParser.parseFile(uri.fsPath);
		this.parsedFiles.set(uri.fsPath, parsedFile);

		// If this file is valid and has sources, remove any matching unknown tasks
		if (parsedFile.isValid && parsedFile.projectId) {
			for (const sourceComponent of parsedFile.sourceComponents) {
				const key = this.getActiveKey(parsedFile.projectId, sourceComponent.id);
				this.unknownTasks.delete(key);
			}
		}

		// Update the corresponding tree item
		const existingItem = this.pipelineFiles.find((item) => item.resourceUri.fsPath === uri.fsPath);

		if (existingItem) {
			existingItem.parsedFile = parsedFile;
			existingItem.collapsibleState = parsedFile.isValid && parsedFile.sourceComponents.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
		}

		this.refresh();

		// Handle pipeline restart based on configuration
		await this.handlePipelineRestart(uri, parsedFile);
	}

	/**
	 * Handles pipeline restart logic based on configuration settings
	 */
	private async handlePipelineRestart(uri: vscode.Uri, parsedFile: ParsedPipelineFile): Promise<void> {
		// Only proceed if the pipeline file is valid and has a project_id
		if (!parsedFile.isValid || !parsedFile.projectId) {
			return;
		}

		// Check if this file save is part of a Run operation
		// If so, skip restart check (the save is from clicking Run, not a manual edit)
		const pageEditorProvider = getPageEditorProvider();
		if (pageEditorProvider?.isSaveForRun(uri)) {
			return;
		}

		// Check if any source components from this pipeline are currently running
		const runningComponents = parsedFile.sourceComponents.filter((component) => {
			const key = this.getActiveKey(parsedFile.projectId!, component.id);
			return this.activePipelines.has(key);
		});

		// If no components are running, nothing to restart
		if (runningComponents.length === 0) {
			return;
		}

		// Get the restart behavior from configuration
		const config = this.configManager.getConfig();
		const restartBehavior = config?.pipelineRestartBehavior || 'prompt';

		const fileName = path.basename(uri.fsPath);

		switch (restartBehavior) {
			case 'manual':
				// Do nothing - user will manually restart
				break;

			case 'auto':
				// Automatically restart all running components
				for (const component of runningComponents) {
					await this.restartPipe(parsedFile.projectId!, component.id, uri);
				}
				break;

			case 'prompt': {
				// Show a prompt asking if user wants to restart
				const componentNames = runningComponents.map((c) => c.name || c.id).join(', ');

				const message = runningComponents.length === 1 ? `Pipeline component "${componentNames}" in ${fileName} is running. Restart it?` : `${runningComponents.length} components (${componentNames}) in ${fileName} are running. Restart them?`;

				const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Yes', 'No');

				if (choice === 'Yes') {
					for (const component of runningComponents) {
						await this.restartPipe(parsedFile.projectId!, component.id, uri);
					}
				}
				break;
			}
		}
	}

	/**
	 * Restarts a specific pipeline component
	 *
	 * @param projectId The project ID of the pipeline
	 * @param sourceId The source component ID to restart
	 * @param fileName The pipeline file name (for logging/notifications)
	 */
	private async restartPipe(projectId: string, sourceId: string, uri: vscode.Uri): Promise<void> {
		// Read the pipeline file
		// Read the pipeline file
		const fileContent = await vscode.workspace.fs.readFile(uri);

		// Get it into a a string
		const pipelineText = Buffer.from(fileContent).toString('utf8');

		// Convert to json
		const pipelineJson = JSON.parse(pipelineText);

		// Substitute and .env settings
		const pipelineTransformed = ConfigManager.getInstance().substituteEnvVariables(pipelineJson);

		// Use DAP command to execute pipeline without debugging
		try {
			// We need the token to attach...
			const response = (await this.connectionManager.request('rrext_get_token', {
				projectId: projectId,
				source: sourceId,
			})) as GenericResponse | undefined;

			// Get the token of the task
			const token = response?.body?.token as string | undefined;

			await this.connectionManager.request(
				'restart',
				{
					token: token,
					projectId: projectId,
					source: sourceId,
					pipeline: pipelineTransformed,
				},
				'*'
			);
		} catch (error: unknown) {
			this.logger.error(`Unable to execute pipeline: ${error}`);
			vscode.window.showErrorMessage(String(error));
		}
	}

	/**
	 * Creates a new pipeline file with template content
	 */
	private async createNewPipelineFile(): Promise<void> {
		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage('No workspace folder open');
			return;
		}

		const workspaceFolder = vscode.workspace.workspaceFolders[0];

		// Resolve the default directory for new pipelines, expanding ${workspaceFolder} if present
		const config = this.configManager.getConfig();
		const rawPath = config?.defaultPipelinePath || 'pipelines';
		const relativePath = rawPath.replace(/^\$\{workspaceFolder\}[/\\]?/, '');
		const defaultDir = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

		const fileUri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(defaultDir, 'new-pipeline'),
			filters: { 'RocketRide Pipeline': ['pipe'] },
			title: 'Create New Pipeline',
		});

		if (!fileUri) {
			return;
		}

		// Ensure the parent directory exists
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));

		// Create basic pipeline template
		const template = {
			components: [],
		};

		try {
			const content = JSON.stringify(template, null, 2);
			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));

			await vscode.commands.executeCommand('vscode.openWith', fileUri, 'rocketride.PageEditor');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to create pipeline: ${error}`);
		}
	}

	/**
	 * Parses structured error/warning string (ErrorType*`message`*filepath:linenumber) for file path, line, and label.
	 */
	private parseErrWarnLine(raw: string, _type: 'error' | 'warning'): ParsedErrWarnLine {
		const parts = raw.split('*');
		if (parts.length >= 3) {
			const message = parts[1].replace(/^`|`$/g, '').trim();
			const fileInfo = parts[2].trim();
			const colonIndex = fileInfo.lastIndexOf(':');
			let filePath = fileInfo;
			let lineNumber: number | undefined;
			if (colonIndex > 0) {
				const lineStr = fileInfo.substring(colonIndex + 1);
				const parsed = parseInt(lineStr, 10);
				if (!isNaN(parsed)) {
					filePath = fileInfo.substring(0, colonIndex);
					lineNumber = parsed;
				}
			}
			const fileName = filePath.split(/[/\\]/).pop() || filePath;
			const label = lineNumber !== undefined ? `${fileName}:${lineNumber} — ${message}` : `${fileName} — ${message}`;
			return { filePath, lineNumber, label };
		}
		return { filePath: '', label: raw };
	}

	/**
	 * Updates VS Code context based on current data state
	 */
	private updateContextBasedOnData(): void {
		const hasPipelineFiles = this.pipelineFiles.length > 0;
		vscode.commands.executeCommand('setContext', 'rocketride.noPipelineFiles', !hasPipelineFiles);
	}

	/**
	 * Returns tree item representation with dynamic icons based on pipeline state
	 */
	getTreeItem(element: PipelineFileItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, element.collapsibleState);
		item.description = element.description;
		item.resourceUri = element.resourceUri;

		// Start with base context value, we'll append state if applicable
		let contextValue = element.contextValue;

		// Set icon based on context and active state
		if (element.contextValue === 'pipelineFile') {
			// Pipeline files get a standard file icon, or error icon if invalid
			if (element.parsedFile?.isValid) {
				item.iconPath = new vscode.ThemeIcon('file-code');

				// Check if any source component in this pipeline is running
				const parsedFile = element.parsedFile;
				if (parsedFile.projectId) {
					const hasRunningComponents = parsedFile.sourceComponents.some((comp) => {
						const key = this.getActiveKey(parsedFile.projectId!, comp.id);
						return this.activePipelines.has(key);
					});
					contextValue = hasRunningComponents ? 'pipelineFile:running' : 'pipelineFile:stopped';
					// Aggregate task errors/warnings across all sources for pipeline file description
					const statusProvider = getStatusPageProvider();
					let totalErrors = 0;
					let totalWarnings = 0;
					for (const comp of parsedFile.sourceComponents) {
						const ts = statusProvider?.getTaskStatus(parsedFile.projectId!, comp.id);
						totalErrors += ts?.errors?.length ?? 0;
						totalWarnings += ts?.warnings?.length ?? 0;
					}
					if (totalErrors > 0 || totalWarnings > 0) {
						const parts = [];
						if (totalErrors > 0) parts.push(`${totalErrors} error${totalErrors !== 1 ? 's' : ''}`);
						if (totalWarnings > 0) parts.push(`${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}`);
						item.description = (item.description ? `${item.description} · ` : '') + parts.join(', ');
					}
				}
			} else {
				item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				item.description = '(Parse Error)';
			}
		} else if (element.contextValue === 'otherTasksRoot') {
			// "Other" root item gets a server process icon
			item.iconPath = new vscode.ThemeIcon('server-process');
		} else if (element.contextValue === 'unknownTask') {
			// Unknown tasks always show as running (pulse icon for viewing status)
			item.iconPath = new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.red'));

			// Set tooltip for unknown tasks
			if (element.unknownTask) {
				const tooltip = new vscode.MarkdownString();
				tooltip.supportHtml = true;
				let html = `<div>`;
				html += `<strong>Project ID:</strong> ${element.unknownTask.projectId}<br/>`;
				html += `<strong>Source ID:</strong> ${element.unknownTask.sourceId}<br/>`;
				html += `<strong>Status:</strong> 🟢 Running<br/>`;
				html += `<br/><em>This task is running on the server but has no local .pipe file.</em>`;
				html += `</div>`;
				tooltip.appendMarkdown(html);
				item.tooltip = tooltip;
			}
		} else if (element.contextValue === 'pipelineSource') {
			const comp = element.sourceComponent!;
			const parsedFile = this.getParsedPipeline(element.resourceUri);

			// Label: component name, or services[provider].title, or component id
			const services = this.connectionManager.getCachedServices()?.services ?? {};
			const providerDef = comp.provider ? (services[comp.provider] as { title?: string } | undefined) : undefined;
			const providerTitle = providerDef?.title;
			item.label = comp.name || providerTitle || comp.id;

			// Require both project_id and source component id - no fallbacks
			if (parsedFile?.isValid && parsedFile.projectId && comp.id) {
				const componentKey = this.getActiveKey(parsedFile.projectId, comp.id);
				const isActive = this.activePipelines.has(componentKey);

				// Set icon based on active state - light gray circle when stopped, pulse when running
				item.iconPath = new vscode.ThemeIcon(isActive ? 'pulse' : 'circle-filled', new vscode.ThemeColor(isActive ? 'charts.red' : 'descriptionForeground'));

				// Description: parse-time warnings + task execution errors/warnings
				const parts: string[] = [];
				if (comp.warnings.length > 0) parts.push(`${comp.warnings.length} warning(s)`);
				const errCount = element.taskErrors?.length ?? 0;
				const warnCount = element.taskWarnings?.length ?? 0;
				if (errCount > 0) parts.push(`${errCount} error${errCount !== 1 ? 's' : ''}`);
				if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
				item.description = parts.length > 0 ? parts.join(', ') : '';

				// Update context value to include running state
				contextValue = isActive ? 'pipelineSource:running' : 'pipelineSource:stopped';
			} else {
				// Show error state - invalid pipeline or missing IDs
				item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				item.description = '';
			}
		} else if (element.contextValue === 'errorsSection' || element.contextValue === 'warningsSection') {
			item.iconPath = element.iconPath;
			item.command = {
				command: 'rocketride.sidebar.files.revealErrorsSection',
				title: 'Go to section',
				arguments: [element],
			};
		} else {
			// Default icon for other items
			item.iconPath = element.iconPath || new vscode.ThemeIcon('file-code');
		}

		// Set tooltip for source components: Title, blank line, Component ID, Status, Warnings
		if (element.sourceComponent) {
			const comp = element.sourceComponent;
			const services = this.connectionManager.getCachedServices()?.services ?? {};
			const providerDef = comp.provider ? (services[comp.provider] as { title?: string } | undefined) : undefined;
			const providerTitle = providerDef?.title;
			const title = comp.name || providerTitle || comp.id;

			const parsedFile = this.getParsedPipeline(element.resourceUri);
			const isValid = parsedFile?.isValid && parsedFile.projectId && comp.id;
			const componentKey = isValid ? this.getActiveKey(parsedFile!.projectId!, comp.id) : '';
			const isActive = isValid && this.activePipelines.has(componentKey);
			const status = !isValid ? 'Invalid Configuration' : isActive ? 'Running' : 'Stopped';

			const tooltip = new vscode.MarkdownString();
			tooltip.supportHtml = true;
			let html = `<div>`;
			html += `<strong>${title}</strong><br/>`;
			if (providerTitle) {
				html += `<strong>Node:</strong> ${providerTitle}<br/>`;
			}
			html += `<strong>Component ID:</strong> ${comp.id}<br/>`;
			html += `<strong>Status:</strong> ${status}<br/>`;
			if (comp.warnings.length > 0) {
				html += `<br/><strong style="color: orange;">Warnings:</strong><br/>`;
				html += `<ul style="margin: 0; padding-left: 20px;">`;
				comp.warnings.forEach((w) => {
					html += `<li style="color: orange;">${w}</li>`;
				});
				html += `</ul>`;
			}
			html += `</div>`;
			tooltip.appendMarkdown(html);

			item.tooltip = tooltip;
		}

		// Set the final context value (may have been modified to include running state)
		item.contextValue = contextValue;

		// Add command to open pipeline editor for pipeline files
		if (element.contextValue === 'pipelineFile') {
			item.command = {
				command: 'rocketride.sidebar.files.openFile',
				title: 'Open Pipeline Editor',
				arguments: [element],
			};
		} else if (element.contextValue === 'pipelineSource') {
			// For source components, add a command that includes the component ID
			item.command = {
				command: 'rocketride.sidebar.files.openStatus',
				title: 'Select Component',
				arguments: [element],
			};
		} else if (element.contextValue === 'unknownTask') {
			// For unknown tasks, add a command to open status page
			item.command = {
				command: 'rocketride.sidebar.files.openStatus',
				title: 'View Task Status',
				arguments: [element],
			};
		}

		return item;
	}

	/**
	 * Returns child items for tree structure
	 */
	getChildren(element?: PipelineFileItem): Thenable<PipelineFileItem[]> {
		if (!element) {
			// Return top-level items: pipeline files + "Other" if there are unknown tasks
			const items = [...this.pipelineFiles];

			if (this.unknownTasks.size > 0) {
				items.push({
					label: 'Other',
					description: `${this.unknownTasks.size} running`,
					resourceUri: vscode.Uri.parse('rocketride:other'),
					contextValue: 'otherTasksRoot',
					iconPath: new vscode.ThemeIcon('server-process'),
					collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				});
			}

			return Promise.resolve(items);
		}

		// Return source components for expanded pipeline files (sorted by display name)
		if (element.contextValue === 'pipelineFile' && element.parsedFile?.isValid) {
			const parsedFile = element.parsedFile;
			const projectId = parsedFile.projectId!;
			const statusProvider = getStatusPageProvider();
			const sortedSources = [...parsedFile.sourceComponents].sort((a, b) => {
				const nameA = (a.name || a.id || '').toLowerCase();
				const nameB = (b.name || b.id || '').toLowerCase();
				return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
			});
			const children = sortedSources.map((sourceComponent) => {
				const displayName = sourceComponent.name || sourceComponent.id;
				const taskStatus = statusProvider?.getTaskStatus(projectId, sourceComponent.id);
				const taskErrors = taskStatus?.errors?.length ? taskStatus.errors : undefined;
				const taskWarnings = taskStatus?.warnings?.length ? taskStatus.warnings : undefined;
				const hasErrWarn = (taskErrors?.length ?? 0) + (taskWarnings?.length ?? 0) > 0;
				return {
					label: displayName,
					description: undefined,
					resourceUri: element.resourceUri,
					contextValue: 'pipelineSource',
					iconPath: new vscode.ThemeIcon('circle'),
					collapsibleState: hasErrWarn ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
					sourceComponent: sourceComponent,
					taskErrors,
					taskWarnings,
				} as PipelineFileItem;
			});
			return Promise.resolve(children);
		}

		// Return exactly two lines under a pipelineSource when there are errors/warnings: "Warnings" and/or "Errors"
		if (element.contextValue === 'pipelineSource' && (element.taskErrors?.length || element.taskWarnings?.length)) {
			const items: PipelineFileItem[] = [];
			if (element.taskWarnings?.length) {
				items.push({
					label: 'Warnings',
					description: `${element.taskWarnings.length}`,
					resourceUri: element.resourceUri,
					contextValue: 'warningsSection',
					iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground')),
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					sourceComponent: element.sourceComponent,
					folderType: 'warnings',
				} as PipelineFileItem);
			}
			if (element.taskErrors?.length) {
				items.push({
					label: 'Errors',
					description: `${element.taskErrors.length}`,
					resourceUri: element.resourceUri,
					contextValue: 'errorsSection',
					iconPath: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					sourceComponent: element.sourceComponent,
					folderType: 'errors',
				} as PipelineFileItem);
			}
			return Promise.resolve(items);
		}

		// Return unknown tasks for expanded "Other" item
		if (element.contextValue === 'otherTasksRoot') {
			const children = Array.from(this.unknownTasks.values()).map((task) => {
				const displayName = task.displayName || task.sourceId;

				return {
					label: displayName,
					description: `${task.projectId.substring(0, 8)}… (Running)`,
					resourceUri: vscode.Uri.parse(`rocketride:unknown:${task.projectId}:${task.sourceId}`),
					contextValue: 'unknownTask',
					iconPath: new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.red')),
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					unknownTask: task,
				} as PipelineFileItem;
			});

			return Promise.resolve(children);
		}

		return Promise.resolve([]);
	}

	/**
	 * Loads all .pipeline files from workspace
	 */
	private async loadPipelineFiles(): Promise<void> {
		const [pipeFiles, pipeJsonFiles] = await Promise.all([vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**'), vscode.workspace.findFiles('**/*.pipe.json', '**/node_modules/**')]);
		const files = [...pipeFiles, ...pipeJsonFiles];

		this.pipelineFiles = [];
		this.parsedFiles.clear();

		for (const uri of files) {
			const fileName = path.basename(uri.fsPath);
			const relativePath = vscode.workspace.asRelativePath(uri);

			// Parse the pipeline file
			const parsedFile = await PipelineFileParser.parseFile(uri.fsPath);
			this.parsedFiles.set(uri.fsPath, parsedFile);

			// If this file is valid and has sources, remove any matching unknown tasks
			if (parsedFile.isValid && parsedFile.projectId) {
				for (const sourceComponent of parsedFile.sourceComponents) {
					const key = this.getActiveKey(parsedFile.projectId, sourceComponent.id);
					this.unknownTasks.delete(key);
				}
			}

			// Simple file icon
			const iconPath = new vscode.ThemeIcon('file-code');
			const description = path.dirname(relativePath) !== '.' ? path.dirname(relativePath) : undefined;

			const item: PipelineFileItem = {
				label: fileName,
				description,
				resourceUri: uri,
				contextValue: 'pipelineFile',
				iconPath,
				collapsibleState: parsedFile.isValid && parsedFile.sourceComponents.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
				parsedFile,
			};

			this.pipelineFiles.push(item);
		}

		// Sort files by label (file name) for consistent display
		this.pipelineFiles.sort((a, b) => (a.label || '').localeCompare(b.label || '', undefined, { sensitivity: 'base' }));

		this.refresh();
		this.updateContextBasedOnData();
	}

	/**
	 * Checks if there are any pipeline files to display
	 */
	async hasData(): Promise<boolean> {
		return this.pipelineFiles.length > 0;
	}

	/**
	 * Refreshes the tree view
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Forces a complete reload of pipeline files
	 */
	async forceRefresh(): Promise<void> {
		await this.loadPipelineFiles();
	}

	/**
	 * Gets parsed pipeline data for a specific file
	 */
	getParsedPipeline(fileUri: vscode.Uri): ParsedPipelineFile | undefined {
		return this.parsedFiles.get(fileUri.fsPath);
	}

	/**
	 * Gets source component by ID from a specific pipeline file
	 */
	getSourceComponentById(fileUri: vscode.Uri, componentId: string): ParsedSourceComponent | undefined {
		const parsedFile = this.parsedFiles.get(fileUri.fsPath);
		if (parsedFile?.isValid) {
			return parsedFile.sourceComponents.find((c) => c.id === componentId);
		}
		return undefined;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
