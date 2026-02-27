// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
	/** Set on synthetic 'Errors' / 'Warnings' child items for scroll-to-section commands */
	scrollToSection?: 'errors' | 'warnings';
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
	private unknownTasks = new Map<string, UnknownTask>();  // Tracks tasks without local .pipe files
	private logger = getLogger();               // Handles output logging to VS Code channels

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
				if (!item || !item.resourceUri) {
					vscode.window.showErrorMessage('No pipeline file selected');
					return;
				}

				try {
					// Open with a specific custom editor
					await vscode.commands.executeCommand('vscode.openWith', item.resourceUri, 'rocketride.PageEditor');
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to open status page: ${error}`);
				}
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.openStatus', async (item?: PipelineFileItem) => {
				const resourceUri = item?.resourceUri as vscode.Uri;
				const componentId = item?.sourceComponent?.id as string;
				const sourceComponent = item?.sourceComponent as ParsedSourceComponent;
				const unknownTask = item?.unknownTask as UnknownTask;

				try {
					let projectId: string;
					let source: string;
					let displayName: string;

					// Check if this is an unknown task
					if (unknownTask) {
						projectId = unknownTask.projectId;
						source = unknownTask.sourceId;
						displayName = unknownTask.displayName || `${projectId.substring(0, 8)}.../${source}`;
					} else {
						// Parse the pipeline file to get the project_id (for known tasks)
						const parsedPipeline = this.getParsedPipeline(resourceUri);

						if (parsedPipeline?.isValid && parsedPipeline.projectId) {
							// Use project_id as the pipeline ID and componentId as the source
							projectId = parsedPipeline.projectId;
							source = componentId;

							// Create a meaningful title: component name, provider title, or component id
						const services = this.connectionManager.getCachedServices()?.services ?? {};
						const providerDef = sourceComponent?.provider ? (services[sourceComponent.provider] as { title?: string } | undefined) : undefined;
						displayName = sourceComponent?.name || providerDef?.title || componentId;
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

			vscode.commands.registerCommand('rocketride.sidebar.files.openStatusAndScrollToErrors', async (item?: PipelineFileItem) => {
				await this.openStatusAndScroll(item, 'errors');
			}),

			vscode.commands.registerCommand('rocketride.sidebar.files.openStatusAndScrollToWarnings', async (item?: PipelineFileItem) => {
				await this.openStatusAndScroll(item, 'warnings');
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
			if (!item || !item.resourceUri) {
				vscode.window.showErrorMessage('No pipeline selected');
				return;
			}
			const parsedFile = item.parsedFile ?? this.getParsedPipeline(item.resourceUri);
			if (!parsedFile?.isValid || !parsedFile.projectId) {
				vscode.window.showErrorMessage('Invalid pipeline file or missing project_id');
				return;
			}
			let sourceId = item.sourceComponent?.id;
			if (!sourceId) {
				if (parsedFile.sourceComponents.length === 0) {
					vscode.window.showErrorMessage('Pipeline file has no sources');
					return;
				}
				if (parsedFile.sourceComponents.length === 1) {
					sourceId = parsedFile.sourceComponents[0].id;
				} else {
					const selected = await vscode.window.showQuickPick(
						parsedFile.sourceComponents.map(s => ({ label: s.name || s.id, sourceId: s.id })),
						{ placeHolder: 'Select a source to run' }
					);
					if (!selected) return;
					sourceId = selected.sourceId;
				}
			}
			try {
				getStatusPageProvider()?.clearErrorsWarningsForTask(parsedFile.projectId, sourceId);
				const fileContent = await vscode.workspace.fs.readFile(item.resourceUri);
				const pipelineText = Buffer.from(fileContent).toString('utf8');
				const pipelineJson = JSON.parse(pipelineText);
				const pipelineTransformed = this.configManager.substituteEnvVariables(pipelineJson);
				await this.connectionManager.request('execute', {
					projectId: parsedFile.projectId,
					source: sourceId,
					pipeline: pipelineTransformed,
					args: ['--trace=servicePython,debugOut,debugProtocol']
				}, '*');
				this.refresh();
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to run pipeline: ${error}`);
			}
		}),

		vscode.commands.registerCommand('rocketride.sidebar.files.launchPipeline', async (item?: PipelineFileItem) => {
			if (!item || !item.resourceUri) {
				vscode.window.showErrorMessage('No pipeline selected');
				return;
			}

			// Get the parsed file to extract source component if applicable
			const _parsedFile = item.parsedFile || this.getParsedPipeline(item.resourceUri);
			const sourceId = item.sourceComponent?.id || '';

			// Create debug configuration
			const config: vscode.DebugConfiguration = {
				type: 'rocketride',
				request: 'launch',
				name: `Debug ${item.label}`,
				file: item.resourceUri.fsPath,
				source: sourceId
			};

			try {
				const parsedFile = item.parsedFile ?? this.getParsedPipeline(item.resourceUri);
				if (parsedFile?.projectId && sourceId) {
					getStatusPageProvider()?.clearErrorsWarningsForTask(parsedFile.projectId, sourceId);
				}
				await vscode.debug.startDebugging(undefined, config);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to start debugging: ${error}`);
			}
		}),

		vscode.commands.registerCommand('rocketride.sidebar.files.attachPipeline', async (item?: PipelineFileItem) => {
			if (!item) {
				vscode.window.showErrorMessage('No pipeline selected');
				return;
			}

			let token: string | undefined;
			let sourceId: string | undefined;

			// For known pipelines with files, determine the token from active pipelines
			if (item.contextValue?.startsWith('pipelineFile') || item.contextValue?.startsWith('pipelineSource')) {
				const parsedFile = item.parsedFile || this.getParsedPipeline(item.resourceUri);
				
				if (!parsedFile?.isValid || !parsedFile.projectId) {
					vscode.window.showErrorMessage('Invalid pipeline file');
					return;
				}

				// If it's a source component, use that specific source
				if (item.sourceComponent?.id) {
					sourceId = item.sourceComponent.id;
					token = this.getActiveKey(parsedFile.projectId, sourceId);
				} else {
					// For pipeline files, we could prompt which source to attach to if multiple
					const runningSources = parsedFile.sourceComponents.filter(comp => {
						const key = this.getActiveKey(parsedFile.projectId!, comp.id);
						return this.activePipelines.has(key);
					});

					if (runningSources.length === 0) {
						vscode.window.showErrorMessage('No running sources found in this pipeline');
						return;
					} else if (runningSources.length === 1) {
						sourceId = runningSources[0].id;
						token = this.getActiveKey(parsedFile.projectId, sourceId);
					} else {
						// Multiple running sources - let user pick
						const selected = await vscode.window.showQuickPick(
							runningSources.map(s => ({ label: s.name || s.id, sourceId: s.id })),
							{ placeHolder: 'Select a source to attach to' }
						);
						if (!selected) {
							return;
						}
						sourceId = selected.sourceId;
						token = this.getActiveKey(parsedFile.projectId, sourceId);
					}
				}
			} else if (item.contextValue === 'unknownTask' && item.unknownTask) {
				// For unknown tasks, use the task's projectId and sourceId
				sourceId = item.unknownTask.sourceId;
				token = this.getActiveKey(item.unknownTask.projectId, item.unknownTask.sourceId);
			}

			if (!token) {
				vscode.window.showErrorMessage('Could not determine pipeline token');
				return;
			}

			// Create attach configuration
			const config: vscode.DebugConfiguration = {
				type: 'rocketride',
				request: 'attach',
				name: `Attach to ${item.label}`,
				token: token,
				auth: token
			};

			try {
				await vscode.debug.startDebugging(undefined, config);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to attach to pipeline: ${error}`);
			}
		})
	];

	// Store disposables and add to context subscriptions
	this.disposables.push(...commands);
	commands.forEach(command => this.context.subscriptions.push(command));
}

	/**
	 * Opens the status page for the given item and scrolls to the Errors or Warnings section.
	 */
	private async openStatusAndScroll(item: PipelineFileItem | undefined, section: 'errors' | 'warnings'): Promise<void> {
		if (!item?.resourceUri) {
			return;
		}
		const resourceUri = item.resourceUri as vscode.Uri;
		const componentId = item.sourceComponent?.id as string;
		const sourceComponent = item.sourceComponent as ParsedSourceComponent | undefined;
		const unknownTask = item.unknownTask as UnknownTask | undefined;

		let projectId: string;
		let source: string;
		let displayName: string;

		if (unknownTask) {
			projectId = unknownTask.projectId;
			source = unknownTask.sourceId;
			displayName = unknownTask.displayName || `${projectId.substring(0, 8)}.../${source}`;
		} else {
			const parsedPipeline = this.getParsedPipeline(resourceUri);
			if (!parsedPipeline?.isValid || !parsedPipeline.projectId) {
				vscode.window.showErrorMessage(`Invalid pipeline file or missing project_id: ${path.basename(resourceUri.fsPath)}`);
				return;
			}
			projectId = parsedPipeline.projectId;
			source = componentId;
			const services = this.connectionManager.getCachedServices()?.services ?? {};
			const providerDef = sourceComponent?.provider ? (services[sourceComponent.provider] as { title?: string } | undefined) : undefined;
			displayName = sourceComponent?.name || providerDef?.title || componentId;
		}

		const statusPageProvider = getStatusPageProvider();
		if (!statusPageProvider) {
			vscode.window.showErrorMessage('Status page provider not available');
			return;
		}
		await statusPageProvider.show(displayName, resourceUri, projectId, source);
		// Brief delay so webview can render before we post scroll
		setTimeout(() => {
			statusPageProvider.postScrollToSection(projectId, source, section);
		}, 150);
	}

	/**
	 * Sets up event listeners for connection and DAP events
	 */
	private setupEventListeners(): void {
		// Listen for events from any session
		const eventListener = this.connectionManager.addListener('event', e => {
			this.handleEvent(e);
		});

		// Listen for connected events
		const connectedEventListener = this.connectionManager.addListener('connected', _e => {
			// Turn on the task monitors
			this.connectionManager.request('rrext_monitor', {
				"types": ["task"]
			}, '*');
		});

		// Listen for disconnected events
		const disconnectedEventListener = this.connectionManager.addListener('disconnected', _e => {
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
									sourceId: task.source 
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
				const hasSource = parsedFile.sourceComponents.some(c => c.id === sourceId);
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
	private async handleFileCreated(_uri: vscode.Uri): Promise<void> {
		await this.loadPipelineFiles();
	}

	/**
	 * Handles file deletion events
	 */
	private async handleFileDeleted(uri: vscode.Uri): Promise<void> {
		// Remove from parsed files map
		this.parsedFiles.delete(uri.fsPath);

		// Remove from pipeline files array
		this.pipelineFiles = this.pipelineFiles.filter(item =>
			item.resourceUri.fsPath !== uri.fsPath
		);

		// Fire the tree change event - use no parameters to refresh entire tree
		this.refresh();
	}

	/**
	 * Handles file modification events
	 */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
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
	const existingItem = this.pipelineFiles.find(item =>
		item.resourceUri.fsPath === uri.fsPath
	);

	if (existingItem) {
		existingItem.parsedFile = parsedFile;
		existingItem.collapsibleState = parsedFile.isValid && parsedFile.sourceComponents.length > 0 ?
			vscode.TreeItemCollapsibleState.Collapsed :
			vscode.TreeItemCollapsibleState.None;
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
		const runningComponents = parsedFile.sourceComponents.filter(component => {
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
				const componentNames = runningComponents
					.map(c => c.name || c.id)
					.join(', ');

				const message = runningComponents.length === 1
					? `Pipeline component "${componentNames}" in ${fileName} is running. Restart it?`
					: `${runningComponents.length} components (${componentNames}) in ${fileName} are running. Restart them?`;

				const choice = await vscode.window.showInformationMessage(
					message,
					{ modal: true },
					'Restart'
				);

				if (choice === 'Restart') {
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
			const response = await this.connectionManager.request('rrext_get_token', {
				projectId: projectId,
				source: sourceId
			}) as GenericResponse | undefined;

			// Get the token of the task
			const token = response?.body?.token as string | undefined;

			await this.connectionManager.request('restart', {
				token: token,
				projectId: projectId,
				source: sourceId,
				pipeline: pipelineTransformed
			}, '*');
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
			title: 'Create New Pipeline'
		});

		if (!fileUri) {
			return;
		}

		// Ensure the parent directory exists
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));

		// Create basic pipeline template
		const template = {
			pipeline: {
				components: [],
				project_id: crypto.randomUUID()
			}
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
			if (!element.parsedFile?.isValid || (element.parsedFile.errors && element.parsedFile.errors.length > 0)) {
				item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				item.description = '(Parse Error)';
			} else {
				const parsedFile = element.parsedFile;
				const statusProvider = getStatusPageProvider();
				let hasUnreadErrors = false;
				let hasUnreadWarnings = false;
				if (parsedFile.projectId && statusProvider) {
					for (const comp of parsedFile.sourceComponents) {
						const taskStatus = statusProvider.getTaskStatus(parsedFile.projectId!, comp.id);
						if (taskStatus?.errors?.length && !statusProvider.areErrorsRead(parsedFile.projectId!, comp.id)) {
							hasUnreadErrors = true;
						}
						if ((taskStatus?.warnings?.length || comp.warnings?.length) && !statusProvider.areWarningsRead(parsedFile.projectId!, comp.id)) {
							hasUnreadWarnings = true;
						}
					}
				}
				if (hasUnreadErrors) {
					item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
					item.description = item.description ? `${item.description} • 1+ error(s)` : '1+ error(s)';
				} else if (hasUnreadWarnings) {
					item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
					item.description = item.description ? `${item.description} • 1+ warning(s)` : '1+ warning(s)';
				} else {
					item.iconPath = new vscode.ThemeIcon('file-code');
				}
				if (parsedFile.projectId) {
					const hasRunningComponents = parsedFile.sourceComponents.some(comp => {
						const key = this.getActiveKey(parsedFile.projectId!, comp.id);
						return this.activePipelines.has(key);
					});
					contextValue = hasRunningComponents ? 'pipelineFile:running' : 'pipelineFile:stopped';
				}
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
		} else if (element.contextValue === 'scrollToErrors') {
			item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
			item.command = {
				command: 'rocketride.sidebar.files.openStatusAndScrollToErrors',
				title: 'Scroll to Errors',
				arguments: [element]
			};
		} else if (element.contextValue === 'scrollToWarnings') {
			item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
			item.command = {
				command: 'rocketride.sidebar.files.openStatusAndScrollToWarnings',
				title: 'Scroll to Warnings',
				arguments: [element]
			};
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
				const statusProvider = getStatusPageProvider();
				const taskStatus = statusProvider?.getTaskStatus(parsedFile.projectId, comp.id);
				const errorsRead = statusProvider?.areErrorsRead(parsedFile.projectId, comp.id) ?? false;
				const warningsRead = statusProvider?.areWarningsRead(parsedFile.projectId, comp.id) ?? false;
				const hasUnreadErrors = (taskStatus?.errors?.length ?? 0) > 0 && !errorsRead;
				const hasUnreadWarnings = ((taskStatus?.warnings?.length ?? 0) > 0 || (comp.warnings?.length ?? 0) > 0) && !warningsRead;

				const hasErrors = (taskStatus?.errors?.length ?? 0) > 0;
				const hasWarnings = (taskStatus?.warnings?.length ?? 0) > 0 || (comp.warnings?.length ?? 0) > 0;

				// Icon priority: error (unread) > warning (unread) > run state
				if (hasUnreadErrors) {
					item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
					item.description = hasErrors ? `${taskStatus!.errors!.length} error(s)` : '';
				} else if (hasUnreadWarnings) {
					item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
					item.description = hasWarnings ? (comp.warnings.length > 0 ? `${comp.warnings.length} warning(s)` : `${taskStatus!.warnings!.length} warning(s)`) : '';
				} else {
					item.iconPath = new vscode.ThemeIcon(
						isActive ? 'pulse' : 'circle-filled',
						new vscode.ThemeColor(isActive ? 'charts.red' : 'descriptionForeground')
					);
					item.description = hasWarnings ? (comp.warnings.length > 0 ? `${comp.warnings.length} warning(s)` : '') : '';
				}

				// Show Errors/Warnings as expandable children when present
				if (hasErrors || hasWarnings) {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
				}

				// Context value: running state + hasErrors/hasWarnings for inline scroll actions
				contextValue = isActive ? 'pipelineSource:running' : 'pipelineSource:stopped';
				if (hasUnreadErrors) {
					contextValue += ':hasErrors';
				}
				if (hasUnreadWarnings) {
					contextValue += ':hasWarnings';
				}
			} else {
				// Show error state - invalid pipeline or missing IDs
				item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				item.description = '';
			}
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
			const status = !isValid ? 'Invalid Configuration' : (isActive ? 'Running' : 'Stopped');

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
				comp.warnings.forEach(w => {
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
				arguments: [element]
			};
		} else if (element.contextValue === 'pipelineSource') {
			// For source components, add a command that includes the component ID
			item.command = {
				command: 'rocketride.sidebar.files.openStatus',
				title: 'Select Component',
				arguments: [element]
			};
		} else if (element.contextValue === 'unknownTask') {
			// For unknown tasks, add a command to open status page
			item.command = {
				command: 'rocketride.sidebar.files.openStatus',
				title: 'View Task Status',
				arguments: [element]
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
					collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
				});
			}
			
			return Promise.resolve(items);
		}

		// Return source components for expanded pipeline files (sorted by display name)
		if (element.contextValue === 'pipelineFile' && element.parsedFile?.isValid) {
			const sortedSources = [...element.parsedFile.sourceComponents].sort((a, b) => {
				const nameA = (a.name || a.id || '').toLowerCase();
				const nameB = (b.name || b.id || '').toLowerCase();
				return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
			});
			const children = sortedSources.map(sourceComponent => {
				// Use component name if available, otherwise use id for display
				const displayName = sourceComponent.name || sourceComponent.id;

				return {
					label: displayName,
					description: undefined, // Keep it clean
					resourceUri: element.resourceUri,
					contextValue: 'pipelineSource',
					iconPath: new vscode.ThemeIcon('circle'), // Default icon for now
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					sourceComponent: sourceComponent
				} as PipelineFileItem;
			});

			return Promise.resolve(children);
		}

		// Return Errors / Warnings link rows under a source when it has errors and/or warnings
		if (element.contextValue === 'pipelineSource' && element.resourceUri && element.sourceComponent) {
			const parsedFile = this.getParsedPipeline(element.resourceUri);
			const statusProvider = getStatusPageProvider();
			const taskStatus = parsedFile?.projectId && statusProvider
				? statusProvider.getTaskStatus(parsedFile.projectId, element.sourceComponent.id)
				: undefined;
			const comp = element.sourceComponent;
			const hasErrors = (taskStatus?.errors?.length ?? 0) > 0;
			const hasWarnings = (taskStatus?.warnings?.length ?? 0) > 0 || (comp.warnings?.length ?? 0) > 0;

			const childItems: PipelineFileItem[] = [];
			if (hasErrors) {
				childItems.push({
					label: 'Errors',
					resourceUri: element.resourceUri,
					contextValue: 'scrollToErrors',
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					sourceComponent: element.sourceComponent,
					scrollToSection: 'errors'
				} as PipelineFileItem);
			}
			if (hasWarnings) {
				childItems.push({
					label: 'Warnings',
					resourceUri: element.resourceUri,
					contextValue: 'scrollToWarnings',
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					sourceComponent: element.sourceComponent,
					scrollToSection: 'warnings'
				} as PipelineFileItem);
			}
			return Promise.resolve(childItems);
		}

		// Return unknown tasks for expanded "Other" item
		if (element.contextValue === 'otherTasksRoot') {
			const children = Array.from(this.unknownTasks.values()).map(task => {
				const displayName = task.displayName || `${task.projectId.substring(0, 8)}.../${task.sourceId}`;
				
				return {
					label: displayName,
					description: '(Running)',
					resourceUri: vscode.Uri.parse(`rocketride:unknown:${task.projectId}:${task.sourceId}`),
					contextValue: 'unknownTask',
					iconPath: new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.red')),
					collapsibleState: vscode.TreeItemCollapsibleState.None,
					unknownTask: task
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
		const [pipeFiles, pipeJsonFiles] = await Promise.all([
			vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**'),
			vscode.workspace.findFiles('**/*.pipe.json', '**/node_modules/**')
		]);
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
			collapsibleState: parsedFile.isValid && parsedFile.sourceComponents.length > 0 ?
				vscode.TreeItemCollapsibleState.Collapsed :
				vscode.TreeItemCollapsibleState.None,
			parsedFile
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
			return parsedFile.sourceComponents.find(c => c.id === componentId);
		}
		return undefined;
	}

	/**
	 * Cleans up event listeners and resources
	 */
	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
		this.disposables = [];
	}
}
