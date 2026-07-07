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
 * Main Extension Entry Point
 *
 * Coordinates all extension providers and manages the overall extension lifecycle.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './shared/util/output';
import { icons } from './shared/util/icons';

// import { registerDebugger } from './debugger/adapter'; // Disabled: debugger removed from package.json
import { ConnectionManager } from './connection/connection';
import { DeployManager } from './connection/deploy-manager';
import { ConfigManager } from './config';
import { EngineRegistry } from './engine';
import { getUserConfigDir, getSystemInstallDir, migrateLocalEngine, migrateServiceConfig } from './engine/config/config-migration';

import { SidebarProvider } from './providers/SidebarProvider';
import { ProjectProvider } from './providers/ProjectProvider';
import { SettingsProvider } from './providers/SettingsProvider';
import { MonitorProvider } from './providers/MonitorProvider';
// DeployProvider removed — Docker/Service operations now live in Settings panels
import { StatusProvider } from './providers/StatusProvider';
import { BarStatus } from './providers/BarStatusProvider';
import { WelcomeProvider } from './providers/WelcomeProvider';
import { AccountProvider } from './providers/AccountProvider';
import { EnvironmentProvider } from './providers/EnvironmentProvider';
// BillingProvider removed — billing is now a tab in AccountProvider
// AuthProvider removed — auth failures now open the Settings page directly
import { AgentManager } from './agents/agent-manager';
import { syncServiceCatalog } from './agents/services';
import { CloudAuthProvider } from './auth/CloudAuthProvider';

// Extension context — set once in activate(), available via getExtensionContext()
let extensionContext: vscode.ExtensionContext;

// Core managers
let connectionManager: ConnectionManager | undefined;
let engineRegistry: EngineRegistry | undefined;
let configManager: ConfigManager | undefined;

// Provider references
let sidebar: SidebarProvider | undefined;
let project: ProjectProvider | undefined;
let settings: SettingsProvider | undefined;
let _monitor: MonitorProvider | undefined;
// deploy removed — functionality moved to Settings panels
let status: StatusProvider | undefined;
let barStatus: BarStatus | undefined;
let welcome: WelcomeProvider | undefined;

/**
 * One-time migrations for settings/files that changed between extension versions.
 * Safe to run on every startup — each migration is idempotent.
 */
async function runMigrations(context: vscode.ExtensionContext): Promise<void> {
	const logger = getLogger();
	const config = vscode.workspace.getConfiguration('rocketride');

	// Migration 1: engineArgs array → string (v1.0.0 → v1.0.2)
	const engineArgs = config.inspect<unknown>('engineArgs');
	const migrateArgs = async (scope: vscode.ConfigurationTarget, value: unknown) => {
		if (Array.isArray(value)) {
			const joined = (value as string[]).join(' ');
			await config.update('engineArgs', joined, scope);
			logger.output(`${icons.info} Migrated rocketride.engineArgs from array to string (${scope === vscode.ConfigurationTarget.Global ? 'global' : 'workspace'})`);
		}
	};
	if (engineArgs?.globalValue !== undefined) await migrateArgs(vscode.ConfigurationTarget.Global, engineArgs.globalValue);
	if (engineArgs?.workspaceValue !== undefined) await migrateArgs(vscode.ConfigurationTarget.Workspace, engineArgs.workspaceValue);

	// Migration 2: Remove old engine directory from extensionPath (v1.0.0 stored engine inside the extension folder)
	const oldEngineDir = path.join(context.extensionPath, 'engine');
	try {
		await fs.promises.access(oldEngineDir);
		await fs.promises.rm(oldEngineDir, { recursive: true });
		logger.output(`${icons.info} Removed legacy engine directory: ${oldEngineDir}`);
	} catch {
		// Directory doesn't exist or couldn't be removed — nothing to do
	}

	// Migration 3: Flat settings keys → grouped development.* / deployment.* keys
	if (!context.globalState.get('settingsMigrationV2Done')) {
		const keyMap: Array<[string, string]> = [
			// Development
			['connectionMode', 'development.connectionMode'],
			['hostUrl', 'development.hostUrl'],
			['developmentTeamId', 'development.teamId'],
			['local.engineVersion', 'development.local.engineVersion'],
			['local.debugOutput', 'development.local.debugOutput'],
			['engineArgs', 'development.local.engineArgs'],
			// Deployment
			['deployTargetMode', 'deployment.connectionMode'],
			['deployHostUrl', 'deployment.hostUrl'],
			['deployTargetTeamId', 'deployment.teamId'],
			['deploy.local.engineVersion', 'deployment.local.engineVersion'],
			['deploy.local.debugOutput', 'deployment.local.debugOutput'],
			['deployEngineArgs', 'deployment.local.engineArgs'],
		];

		for (const [oldKey, newKey] of keyMap) {
			const inspected = config.inspect<unknown>(oldKey);
			const migrated = config.inspect<unknown>(newKey);
			if (inspected?.globalValue !== undefined) {
				if (migrated?.globalValue === undefined) {
					await config.update(newKey, inspected.globalValue, vscode.ConfigurationTarget.Global);
				}
				await config.update(oldKey, undefined, vscode.ConfigurationTarget.Global);
			}
			if (inspected?.workspaceValue !== undefined) {
				if (migrated?.workspaceValue === undefined) {
					await config.update(newKey, inspected.workspaceValue, vscode.ConfigurationTarget.Workspace);
				}
				await config.update(oldKey, undefined, vscode.ConfigurationTarget.Workspace);
			}
		}

		// Migrate secret storage keys
		const secretMap: Array<[string, string]> = [
			['rocketride.apiKey', 'rocketride.development.apiKey'],
			['rocketride.deployApiKey', 'rocketride.deployment.apiKey'],
		];
		for (const [oldSecret, newSecret] of secretMap) {
			try {
				const value = await context.secrets.get(oldSecret);
				if (value) {
					const existing = await context.secrets.get(newSecret);
					if (!existing) {
						await context.secrets.store(newSecret, value);
					}
					await context.secrets.delete(oldSecret);
				}
			} catch {
				// Ignore — secret may not exist
			}
		}

		await context.globalState.update('settingsMigrationV2Done', true);
		logger.output(`${icons.success} Migrated settings to development/deployment groups`);
	}

	// Migration 4: Move local engine from globalStorage to per-user dir
	// Old: globalStorage/engines/server-3.2.0--abc/engine.exe + pointer files
	// New: %LOCALAPPDATA%/RocketRide/engine/engine.exe + version.json
	const oldEnginesDir = path.join(context.globalStorageUri.fsPath, 'engines');
	migrateLocalEngine(oldEnginesDir);

	// Migration 5: Convert service config.json → engine/version.json
	// Old: %PROGRAMDATA%/RocketRide/config.json + engines/server-3.2.0--abc/
	// New: %PROGRAMDATA%/RocketRide/engine/engine.exe + engine/version.json
	migrateServiceConfig();
}

/**
 * Extension activation entry point
 *
 * @param context VS Code extension context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionContext = context;
	const logger = getLogger();
	logger.output(`${icons.begin} Activating RocketRide extension...`);

	// Initialize config manager with context for secure storage
	configManager = ConfigManager.getInstance();
	await configManager.initialize(context);

	// Initialize cloud auth provider (registers vscode:// URI handler)
	const cloudAuth = CloudAuthProvider.getInstance();
	cloudAuth.initialize(context);
	context.subscriptions.push(cloudAuth);

	// Run one-time migrations (idempotent — safe on every startup)
	await runMigrations(context);

	// Set initial context
	vscode.commands.executeCommand('setContext', 'rocketride.connected', false);

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Initializing RocketRide Extension',
				cancellable: false,
			},
			async (progress) => {
				//-------------------------------------
				// Load configuration
				//-------------------------------------
				logger.output(`${icons.info} Loading configuration...`);
				progress.report({ increment: 10, message: 'Loading configuration...' });
				await sleep(200);

				//-------------------------------------
				// Load status bar
				//-------------------------------------
				logger.output(`${icons.info} Loading status bar...`);
				progress.report({ increment: 20, message: 'Loading status bar...' });
				barStatus = new BarStatus(context);
				barStatus.setInitializing();

				//-------------------------------------
				// Create connection manager
				//-------------------------------------
				logger.output(`${icons.info} Creating connection manager...`);
				progress.report({ increment: 30, message: 'Creating connection manager...' });

				// --- Engine Registry + Connection Managers ---
				// One EngineManager per mode, shared across dev and deploy.
				engineRegistry = EngineRegistry.getInstance({
					localParentDir: getUserConfigDir(),
					serviceInstallDir: getSystemInstallDir(),
				});

				connectionManager = ConnectionManager.getInstance();
				connectionManager.setEngineRegistry(engineRegistry);

				const deployManager = DeployManager.getDeployInstance();
				deployManager.setEngineRegistry(engineRegistry);

				//-------------------------------------
				// Create status bar
				//-------------------------------------
				logger.output(`${icons.info} Creating status bar...`);
				progress.report({ increment: 40, message: 'Creating status providers...' });

				//-------------------------------------
				// Register tree data providers
				//-------------------------------------
				logger.output(`${icons.info} Creating tree providers...`);
				progress.report({ increment: 50, message: 'Creating tree providers...' });

				// Register unified sidebar webview
				sidebar = new SidebarProvider(context.extensionUri);
				const sidebarWebviewProvider = vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar);

				context.subscriptions.push(sidebarWebviewProvider);

				//-------------------------------------
				// Create webview providers
				//-------------------------------------
				logger.output(`${icons.info} Creating webview providers...`);
				progress.report({ increment: 60, message: 'Creating webview providers...' });

				settings = new SettingsProvider(context.extensionUri);
				_monitor = new MonitorProvider(context);
				// deploy removed — register redirect command so sidebar "Deploy" opens Settings
				context.subscriptions.push(vscode.commands.registerCommand('rocketride.page.deploy.open', () => vscode.commands.executeCommand('rocketride.page.settings.open', 'deployment')));
				status = new StatusProvider(context);
				welcome = new WelcomeProvider(context, context.extensionUri);
				const account = new AccountProvider(context);
				const environment = new EnvironmentProvider(context);
				context.subscriptions.push(account, environment);

				// Register unified project editor (canvas + status + trace)
				project = new ProjectProvider(context);
				const pageProjectRegistration = vscode.window.registerCustomEditorProvider('rocketride.PageProject', project, {
					webviewOptions: {
						retainContextWhenHidden: true,
					},
					supportsMultipleEditorsPerDocument: false,
				});

				//-------------------------------------
				// Register utility commands
				//-------------------------------------
				logger.output(`${icons.info} Registering utility commands...`);
				progress.report({ increment: 70, message: 'Registering commands and components...' });
				registerUtilityCommands(context);

				//-------------------------------------
				// Register debugger (disabled — see debugger/adapter.ts to re-enable)
				//-------------------------------------
				// registerDebugger(context);

				//-------------------------------------
				// Set up event handlers
				//-------------------------------------
				logger.output(`${icons.info} Setting up event handlers...`);
				progress.report({ increment: 90, message: 'Setting up event handlers...' });
				setupConnectionEventHandlers();

				// Add all providers to context subscriptions for proper cleanup
				context.subscriptions.push(pageProjectRegistration, settings, project, welcome!);

				//-------------------------------------
				// Update tree providers with initial data
				//-------------------------------------
				logger.output(`${icons.info} Refreshing providers...`);
				progress.report({ increment: 100, message: 'Refreshing providers...' });
				await refreshAllProviders();

				//-------------------------------------
				// Initialize connection / welcome flow
				//-------------------------------------
				vscode.commands.executeCommand('setContext', 'rocketride.loaded', true);
				vscode.commands.executeCommand('setContext', 'rocketride.connected', false);

				logger.output(`${icons.info} Initializing status bar...`);
				progress.report({ increment: 120, message: 'Setup status bar' });
				barStatus.initializeConnectionManager();
				context.subscriptions.push(barStatus);

				const welcomeDismissed = welcome?.isDismissed() ?? true;
				if (!welcomeDismissed) {
					// First run: show welcome page, don't auto-connect
					logger.output(`${icons.info} First run detected — showing welcome page`);
					progress.report({ increment: 110, message: 'Showing welcome...' });
					barStatus.setNeedsSetup();
					welcome!.show();
				} else {
					// Normal flow: initialize CMs first so they validate credentials
					// and set their connection mode. This must happen BEFORE reconcile
					// because the reconciler reads CM config checksums to decide which
					// engines need (re)starting. CMs don't connect here — they wait
					// for the engine's 'ready' event emitted during reconcile.
					logger.output(`${icons.info} Initializing connections and reconciling engines...`);
					progress.report({ increment: 110, message: 'Starting engines...' });
					barStatus.setReady();
					await connectionManager.initialize();
					await deployManager.initialize();
					// Reconcile kicks off engine downloads/starts. Engines emit 'ready'
					// events which handleEngineStatus() picks up to connect the WebSocket.
					engineRegistry.reconcile().catch((err) => {
						console.error('[ROCKETRIDE] Initial engine reconcile failed:', err);
					});
				}

				//-------------------------------------
				// Auto-install agent documentation (non-blocking)
				//-------------------------------------
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
				if (workspaceFolder) {
					const agentMgr = new AgentManager();
					agentMgr.autoInstall(context.extensionPath, workspaceFolder.uri).catch((error) => {
						logger.output(`${icons.warning} Auto agent integration failed: ${error}`);
					});
				}

				//-------------------------------------
				// And done...
				//-------------------------------------
				logger.output(`${icons.info} Completed initializing`);
				progress.report({ increment: 130, message: 'Complete' });
			}
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
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Registers utility commands that coordinate between providers
 */
function registerUtilityCommands(context: vscode.ExtensionContext): void {
	const agentManager = new AgentManager();

	const commands = [
		vscode.commands.registerCommand('rocketride.sidebar.documentation.open', () => {
			vscode.env.openExternal(vscode.Uri.parse('https://docs.rocketride.org/'));
		}),
		vscode.commands.registerCommand('rocketride.sidebar.connection.connect', async () => {
			await connectionManager?.connect();
		}),
		vscode.commands.registerCommand('rocketride.sidebar.connection.disconnect', async () => {
			await connectionManager?.disconnect();
		}),
		vscode.commands.registerCommand('rocketride.sidebar.connection.reconnect', async () => {
			await connectionManager?.disconnect();
			await connectionManager?.connect();
		}),
		vscode.commands.registerCommand('rocketride.page.status.open', (projectId: string, sourceId: string, displayName: string) => {
			status?.show(projectId, sourceId, displayName);
		}),
		vscode.commands.registerCommand('rocketride.refresh', async () => {
			await refreshAllProviders();
			vscode.window.showInformationMessage('RocketRide views refreshed');
		}),
		vscode.commands.registerCommand('rocketride.agents.install', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('No workspace folder open. Open a folder first.');
				return;
			}
			try {
				await agentManager.installAll(context.extensionPath, workspaceFolder.uri);
				vscode.window.showInformationMessage('RocketRide agent documentation installed successfully.');
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to install agent documentation: ${err}`);
			}
		}),
		vscode.commands.registerCommand('rocketride.agents.uninstall', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('No workspace folder open. Open a folder first.');
				return;
			}
			try {
				await agentManager.uninstallAll(workspaceFolder.uri);
				vscode.window.showInformationMessage('RocketRide agent documentation removed.');
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to remove agent documentation: ${err}`);
			}
		}),

		// ── Pipeline file commands (previously in SidebarFilesProvider) ──────────
		vscode.commands.registerCommand('rocketride.sidebar.files.createFile', async () => {
			if (!vscode.workspace.workspaceFolders) {
				vscode.window.showErrorMessage('No workspace folder open');
				return;
			}
			const workspaceFolder = vscode.workspace.workspaceFolders[0];
			const config = ConfigManager.getInstance().getConfig();
			const rawPath = config?.defaultPipelinePath || 'pipelines';
			const relativePath = rawPath.replace(/^\$\{workspaceFolder\}[/\\]?/, '');
			const defaultDir = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

			const fileUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.joinPath(defaultDir, 'new-pipeline'),
				filters: { 'RocketRide Pipeline': ['pipe'] },
				title: 'Create New Pipeline',
			});
			if (!fileUri) return;

			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
			const template = { components: [] };
			try {
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(template, null, 2), 'utf8'));
				await vscode.commands.executeCommand('vscode.openWith', fileUri, 'rocketride.PageProject');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to create pipeline: ${error}`);
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
				vscode.window.showErrorMessage(`Could not open ${path.basename(filePath)}: ${e}`);
			}
		}),

		vscode.commands.registerCommand('rocketride.sidebar.files.refresh', async () => {
			vscode.window.showInformationMessage('Pipeline views refreshed');
		}),

		vscode.commands.registerCommand('rocketride.cloud.logout', async () => {
			const cloudAuth = CloudAuthProvider.getInstance();
			await cloudAuth.signOut();
		}),

		// Stub commands — run/stop/open are handled via webview messages now,
		// but package.json still declares them so they must be registered.
		vscode.commands.registerCommand('rocketride.sidebar.files.openFile', () => {}),
		vscode.commands.registerCommand('rocketride.sidebar.files.openStatus', () => {}),
		vscode.commands.registerCommand('rocketride.sidebar.files.runPipeline', () => {}),
		vscode.commands.registerCommand('rocketride.sidebar.files.stopPipeline', () => {}),
		vscode.commands.registerCommand('rocketride.sidebar.files.revealErrorsSection', () => {}),
	];

	commands.forEach((command) => context.subscriptions.push(command));
}

/**
 * Sets up event handlers for cross-provider communication
 */
function setupConnectionEventHandlers(): void {
	// Pipeline data changes are now handled by SidebarProvider's event listeners

	// Sync service catalog + schemas to .rocketride/ when services are fetched
	connectionManager?.on('shell:servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
		if (payload.servicesError || !payload.services || Object.keys(payload.services).length === 0) {
			return;
		}
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) return;

		syncServiceCatalog(workspaceFolder.uri, payload.services).catch((err) => {
			const logger = getLogger();
			logger.output(`${icons.warning} Failed to sync service catalog: ${err}`);
		});
	});
}

/**
 * Refreshes all data providers
 */
async function refreshAllProviders(): Promise<void> {
	// SidebarProvider handles its own refresh via event listeners
}

/**
 * Extension deactivation cleanup
 */
export async function deactivate(): Promise<void> {
	if (_monitor) {
		try {
			_monitor.dispose();
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error disposing monitor page:', error);
			}
		}
	}

	// Dispose engine registry (stops all engines)
	if (engineRegistry) {
		try {
			await engineRegistry.disposeAll();
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				console.error('[ROCKETRIDE] Error disposing engine registry:', error);
			}
		}
	}

	// Dispose connection manager (disconnects WebSocket)
	if (connectionManager) {
		try {
			await connectionManager.stop();
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

// =========================================================================
// GLOBAL VERSION CACHES — populated by ConnectionMessageHandler, read by backends
// =========================================================================
//
// These module-level caches are the single source of truth for available
// engine versions and Docker image tags. ConnectionMessageHandler fetches
// them from GitHub/GHCR and writes via the setters. Engine backends read
// from the exported arrays when resolving "latest" or "prerelease" tags
// during install/pull operations. This avoids redundant API calls and
// ensures all consumers see the same data regardless of which webview
// triggered the fetch.
// =========================================================================

/** Cached GitHub releases (engine binaries). Populated by ConnectionMessageHandler.fetchAndBroadcastVersions(). */
export let cachedEngineVersions: Array<{ tag_name: string; prerelease: boolean }> = [];
/** Replaces the cached engine version list. Called by ConnectionMessageHandler after a successful GitHub API fetch. */
export const setCachedEngineVersions = (v: typeof cachedEngineVersions) => { cachedEngineVersions = v; };

/** Cached GHCR container tags (Docker images). Populated by ConnectionMessageHandler.fetchAndBroadcastDockerTags(). */
export let cachedDockerTags: string[] = [];
/** Replaces the cached Docker tag list. Called by ConnectionMessageHandler after a successful GHCR API fetch. */
export const setCachedDockerTags = (t: string[]) => { cachedDockerTags = t; };

// Export getters for provider access
export const getExtensionContext = () => extensionContext;
export const getConnectionManager = () => connectionManager;
export const getEngineRegistry = () => engineRegistry;
export const getSettingsProvider = () => settings;
export const getConfigManager = () => configManager;
export const getPipelineFilesTreeProvider = () => undefined;
export const getConnectionTreeProvider = () => undefined;
export const getProjectProvider = () => project;
export const getBarStatus = () => barStatus;
export const getWelcomeProvider = () => welcome;
