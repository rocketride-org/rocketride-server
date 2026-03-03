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
 * Main Extension Entry Point
 * 
 * Coordinates all extension providers and manages the overall extension lifecycle.
 */
import * as vscode from 'vscode';
import { getLogger } from './shared/util/output';
import { icons } from './shared/util/icons';

import { registerDebugger } from './debugger/adapter';
import { syncIntegrations } from './integrations';

import { ConnectionManager } from './connection/connection';
import { ConfigManager } from './config';

import { PageConnectionProvider } from './providers/PageConnectionProvider';
import { SidebarFilesProvider } from './providers/SidebarFilesProvider';
import { PageEditorProvider } from './providers/PageEditorProvider';
import { PageSettingsProvider } from './providers/PageSettingsProvider';
import { PageStatusProvider } from './providers/PageStatusProvider';
import { PageDeployProvider } from './providers/PageDeployProvider';
import { BarStatus } from './providers/BarStatusProvider';
import { PageWelcomeProvider } from './providers/PageWelcomeProvider';
import { SidebarConnectionProvider } from './providers/SidebarConnectionProvider';


// Core managers
let connectionManager: ConnectionManager | undefined;
let configManager: ConfigManager | undefined;

// Provider references
let pageConnection: PageConnectionProvider | undefined;
let sidebarFiles: SidebarFilesProvider | undefined;
let pageEditor: PageEditorProvider | undefined;
let pageSettings: PageSettingsProvider | undefined;
let pageStatus: PageStatusProvider | undefined;
let pageDeploy: PageDeployProvider | undefined;
let barStatus: BarStatus | undefined;
let pageWelcome: PageWelcomeProvider | undefined;
let sidebarConnection: SidebarConnectionProvider | undefined;

/**
 * Extension activation entry point
 * 
 * @param context VS Code extension context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = getLogger();
	logger.output(`${icons.begin} Activating RocketRide extension...`);

	// Initialize config manager with context for secure storage
	configManager = ConfigManager.getInstance();
	await configManager.initialize(context);

	// Set initial context
	vscode.commands.executeCommand('setContext', 'rocketride.connected', false);

	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Initializing RocketRide Extension",
			cancellable: false
		}, async (progress) => {
			//-------------------------------------
			// Load configuration
			//-------------------------------------
			logger.output(`${icons.info} Loading configuration...`);
			progress.report({ increment: 10, message: "Loading configuration..." });
			await sleep(200);

			//-------------------------------------
			// Load status bar
			//-------------------------------------
			logger.output(`${icons.info} Loading status bar...`);
			progress.report({ increment: 20, message: "Loading status bar..." });
			barStatus = new BarStatus(context);
			barStatus.setInitializing();

			//-------------------------------------
			// Create connection manager
			//-------------------------------------
			logger.output(`${icons.info} Creating connection manager...`);
			progress.report({ increment: 30, message: "Creating connection manager..." });
			connectionManager = ConnectionManager.getInstance();
			connectionManager.setExtensionPath(context.extensionPath);

			//-------------------------------------
			// Create status bar
			//-------------------------------------
			logger.output(`${icons.info} Creating status bar...`);
			progress.report({ increment: 40, message: "Creating status providers..." });

			//-------------------------------------
			// Register tree data providers
			//-------------------------------------
			logger.output(`${icons.info} Creating tree providers...`);
			progress.report({ increment: 50, message: "Creating tree providers..." });

			sidebarFiles = new SidebarFilesProvider(context);
			const pipelineFilesTreeDataProvider = vscode.window.registerTreeDataProvider('rocketride.provider.files', sidebarFiles);

			// Register connection webview provider
			pageConnection = new PageConnectionProvider(context.extensionUri);
			const connectionWebviewProvider = vscode.window.registerWebviewViewProvider(
				PageConnectionProvider.viewType,
				pageConnection
			);

			sidebarConnection = new SidebarConnectionProvider(context);

			context.subscriptions.push(
				pipelineFilesTreeDataProvider,
				connectionWebviewProvider,
				sidebarConnection
			);

			//-------------------------------------
			// Create webview providers
			//-------------------------------------
			logger.output(`${icons.info} Creating webview providers...`);
			progress.report({ increment: 60, message: "Creating webview providers..." });

		pageSettings = new PageSettingsProvider(context.extensionUri);
		pageStatus = new PageStatusProvider(context);
		pageDeploy = new PageDeployProvider(context);
		pageWelcome = new PageWelcomeProvider(context, context.extensionUri);

			// Register custom editor provider
			pageEditor = new PageEditorProvider(context);
			const pageEditorRegistration = vscode.window.registerCustomEditorProvider(
				'rocketride.PageEditor',
				pageEditor,
				{
					webviewOptions: {
						retainContextWhenHidden: true // Better performance for complex editors
					},
					supportsMultipleEditorsPerDocument: false // One editor per file
				}
			);

			//-------------------------------------
			// Register utility commands
			//-------------------------------------
			logger.output(`${icons.info} Registering utility commands...`);
			progress.report({ increment: 70, message: "Registering commands and components..." });
			registerUtilityCommands(context);

			//-------------------------------------
			// Register debugger
			//-------------------------------------
			logger.output(`${icons.info} Registering debugger...`);
			progress.report({ increment: 80, message: "Registering debugger..." });
			registerDebugger(context);

			//-------------------------------------
			// Set up event handlers
			//-------------------------------------
			logger.output(`${icons.info} Setting up event handlers...`);
			progress.report({ increment: 90, message: "Setting up event handlers..." });
			setupConnectionEventHandlers();

		// Add all providers to context subscriptions for proper cleanup
		context.subscriptions.push(
			pageEditorRegistration,
			pageSettings,
			pageEditor,
			pageConnection,
			sidebarFiles,
			pageStatus,
			pageWelcome!
		);

			//-------------------------------------
			// Update tree providers with initial data
			//-------------------------------------
			logger.output(`${icons.info} Refreshing providers...`);
			progress.report({ increment: 100, message: "Refreshing providers..." });
			await refreshAllProviders();

			//-------------------------------------
			// Initialize connection / welcome flow
			//-------------------------------------
			vscode.commands.executeCommand('setContext', 'rocketride.loaded', true);
			vscode.commands.executeCommand('setContext', 'rocketride.connected', false);

			logger.output(`${icons.info} Initializing status bar...`);
			progress.report({ increment: 120, message: "Setup status bar" });
			barStatus.initializeConnectionManager();
			context.subscriptions.push(barStatus);

			const welcomeDismissed = pageWelcome?.isDismissed() ?? true;
			if (!welcomeDismissed) {
				// First run: show welcome page, don't auto-connect
				logger.output(`${icons.info} First run detected — showing welcome page`);
				progress.report({ increment: 110, message: "Showing welcome..." });
				barStatus.setNeedsSetup();
				pageWelcome!.show();
			} else {
				// Normal flow: auto-connect
				logger.output(`${icons.info} Initializing connections...`);
				progress.report({ increment: 110, message: "Starting connections..." });
				barStatus.setReady();
				connectionManager.initialize().catch(error => {
					console.error('[ROCKETRIDE] Connection initialization failed:', error);
				});
			}

		//-------------------------------------
		// Sync integrations based on settings
		//-------------------------------------
		logger.output(`${icons.info} Syncing integrations...`);
		await syncIntegrationsFromSettings();

		//-------------------------------------
		// And done...
		//-------------------------------------
		logger.output(`${icons.info} Completed initializing`);
		progress.report({ increment: 130, message: "Complete" });
	});

	// Listen for workspace folder changes to re-sync integrations
	// Note: ConfigManager handles .env file sync automatically
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			await syncIntegrationsFromSettings();
		})
	);

	// Listen for integration settings changes to re-sync automatically
	// This handles changes from both the Settings page and VSCode settings panel
	// Note: ConfigManager handles .env file sync automatically when settings change
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('rocketride.copilotIntegration') ||
				event.affectsConfiguration('rocketride.cursorIntegration')) {
				await syncIntegrationsFromSettings();
			}
		})
	);

		logger.output(`${icons.success} RocketRide extension activated successfully`);
	} catch (error) {
		console.error('[ROCKETRIDE] Extension activation failed with error:', error);
		barStatus?.setError(String(error));
		logger.output(`${icons.warning} Extension activation failed: ${error}`);

		vscode.commands.executeCommand('setContext', 'rocketride.connected', false);
		throw error;
	}
}

/**
 * Simple sleep utility for activation delays
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Syncs integrations based on current settings
 */
async function syncIntegrationsFromSettings(): Promise<void> {
	const logger = getLogger();

	try {
		const config = vscode.workspace.getConfiguration('rocketride');
		const copilotEnabled = config.get<boolean>('copilotIntegration', false);
		const cursorEnabled = config.get<boolean>('cursorIntegration', false);


		// Sync based on settings
		await syncIntegrations(copilotEnabled, cursorEnabled);
	} catch (error) {
		logger.output(`${icons.warning} Failed to sync integrations: ${error}`);
		// Don't throw - this shouldn't block extension activation
	}
}

/**
 * Registers utility commands that coordinate between providers
 */
function registerUtilityCommands(context: vscode.ExtensionContext): void {
	const commands = [
		vscode.commands.registerCommand('rocketride.refresh', async () => {
			await refreshAllProviders();
			vscode.window.showInformationMessage('RocketRide views refreshed');
		})
	];

	commands.forEach(command => context.subscriptions.push(command));
}

/**
 * Sets up event handlers for cross-provider communication
 */
function setupConnectionEventHandlers(): void {
	// Update pipeline data when connected
	connectionManager?.on('pipelineDataChanged', () => {
		sidebarFiles?.refresh();
	});
}

/**
 * Refreshes all data providers
 */
async function refreshAllProviders(): Promise<void> {
	sidebarFiles?.refresh();
	pageConnection?.refresh();
}

/**
 * Extension deactivation cleanup
 */
export async function deactivate(): Promise<void> {
	// Close all status pages first
	if (pageStatus) {
		try {
			pageStatus.closeAll();
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error closing status pages:', error);
			}
		}
	}

	if (pageDeploy) {
		try {
			pageDeploy.dispose();
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error disposing deploy page:', error);
			}
		}
	}

	// Dispose connection manager (async — awaits engine process shutdown)
	if (connectionManager) {
		try {
			await connectionManager.dispose();
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error disposing connection manager:', error);
			}
		}
	}

	// Dispose config manager
	if (configManager) {
		try {
			configManager.dispose();
		} catch (error: unknown) {
			// Silently ignore cancellation errors during shutdown
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error disposing config manager:', error);
			}
		}
	}
}

// Export getters for provider access
export const getConnectionManager = () => connectionManager;
export const getSettingsProvider = () => pageSettings;
export const getStatusPageProvider = () => pageStatus;
export const getConfigManager = () => configManager;
export const getPipelineFilesTreeProvider = () => sidebarFiles;
export const getConnectionTreeProvider = () => pageConnection;
export const getPageEditorProvider = () => pageEditor;
export const getBarStatus = () => barStatus;
export const getPageWelcomeProvider = () => pageWelcome;
