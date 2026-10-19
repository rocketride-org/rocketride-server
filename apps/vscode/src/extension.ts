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
import { createCatalogueReporter } from './shared/util/catalogueDiagnostic';

import { ConnectionManager, disconnectCloudConnections } from './connection/connection';
import { DeployManager } from './connection/deploy-manager';
import { ConfigManager } from './config';
import { savePipelineDocument } from './shared/util/pipelineSave';
import { EngineRegistry } from './engine';
import { getUserConfigDir, getSystemInstallDir, migrateLocalEngine, migrateServiceConfig } from './engine/config/config-migration';

import { SidebarProvider } from './providers/SidebarProvider';
import { PipelineProvider } from './providers/PipelineProvider';
import { HtmlPageProvider } from './providers/HtmlPageProvider';
// DeployProvider removed — Docker/Service operations now live in Settings panels
import { BarStatus } from './providers/BarStatusProvider';
import { FrameworkProvider } from './providers/toolhost/frameworkProvider';
import { DevToolStore } from './providers/DevToolStore';
import { BusHost } from './providers/toolhost/busHost';
import { registerVscodeOps } from './ops';
import { registerVscodeDevToolOps } from './ops/devtoolOps';
import { writePref } from './providers/PrefsBag';
import { DevToolPanelProvider } from './providers/DevToolPanelProvider';
// BillingProvider removed — billing is now a tab in AccountProvider
// AuthProvider removed — auth failures now open the Settings page directly
import { AgentManager } from './agents/agent-manager';
import { syncServiceCatalog } from './agents/services';
import { CloudAuthProvider } from './auth/CloudAuthProvider';
import { AppScreenProvider } from './providers/AppScreenProvider';
import { initDevSessionManager } from './appdev/devSessionManager';
import { ensureShell, refreshVendoredPlatform } from './appdev/appTypes';

// Extension context — set once in activate(), available via getExtensionContext()
let extensionContext: vscode.ExtensionContext;

// Core managers
let connectionManager: ConnectionManager | undefined;
let engineRegistry: EngineRegistry | undefined;
let configManager: ConfigManager | undefined;

// Provider references
let sidebar: SidebarProvider | undefined;
let pipeline: PipelineProvider | undefined;
let _htmlPages: HtmlPageProvider | undefined;
// deploy removed — functionality moved to Settings panels
let appScreen: AppScreenProvider | undefined;
let barStatus: BarStatus | undefined;

/**
 * One-time migrations for settings/files that changed between extension versions.
 * Safe to run on every startup — each migration is idempotent.
 */
async function runMigrations(context: vscode.ExtensionContext): Promise<void> {
	const logger = getLogger();
	const config = vscode.workspace.getConfiguration('rocketride');

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
			['local.engineVersion', 'development.local.engineVersion'],
			// Deployment
			['deployTargetMode', 'deployment.connectionMode'],
			['deployHostUrl', 'deployment.hostUrl'],
			['deploy.local.engineVersion', 'deployment.local.engineVersion'],
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

	// Migration 3b: legacy per-connection debug-output flags fold into the ONE
	// per-task setting — any scope that had debug output on keeps it on (OR of
	// the old keys; same intent, wider scope). Own marker: the V2 migration
	// shipped earlier, so users who already completed it must still get this
	// one. engineArgs is deliberately NOT migrated: engine PROCESS flags are
	// not per-task arguments, and silently injecting them into every .use call
	// could break runs.
	if (!context.globalState.get('debugOutputMigrationDone')) {
		const legacyDebugKeys = ['local.debugOutput', 'deploy.local.debugOutput', 'development.local.debugOutput', 'deployment.local.debugOutput'];
		for (const target of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace] as const) {
			const scope = target === vscode.ConfigurationTarget.Global ? 'globalValue' : 'workspaceValue';
			let anyOn = false;
			let anySet = false;
			for (const key of legacyDebugKeys) {
				const value = config.inspect<unknown>(key)?.[scope];
				if (value !== undefined) {
					anySet = true;
					if (value === true) anyOn = true;
				}
			}
			// Write the replacement BEFORE deleting anything: a failure mid-way
			// must never have destroyed the only copy of the old configuration
			// (the whole migration is retry-safe in that order).
			if (anySet && anyOn && config.inspect<unknown>('pipelineDebugOutput')?.[scope] === undefined) {
				await config.update('pipelineDebugOutput', true, target);
			}
			for (const key of legacyDebugKeys) {
				if (config.inspect<unknown>(key)?.[scope] !== undefined) {
					await config.update(key, undefined, target);
				}
			}
		}
		await context.globalState.update('debugOutputMigrationDone', true);
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

	// Migration 6: Sidebar state into the generic prefs bag ('rr.prefs')
	// under the ShellPrefsMap system keys — one spelling per concept across
	// hosts. Workspace-scoped (each workspace migrates on its first open).
	if (!context.workspaceState.get('sidebarPrefsMigrationDone')) {
		const moves: Array<[string, string]> = [
			['rr.devTools', 'devToolPins'],
			['rr.sidebarTabOrder', 'sidebarTabOrder'],
			['rr.disabledBuiltins', 'disabledBuiltins'],
			['rr.sidebarMode', 'sidebarMode'],
		];
		for (const [oldKey, newKey] of moves) {
			const value = context.workspaceState.get(oldKey);
			if (value !== undefined) {
				await writePref(context, newKey, value, 'workspace');
				await context.workspaceState.update(oldKey, undefined);
				logger.output(`${icons.info} Migrated ${oldKey} -> prefs.${newKey}`);
			}
		}
		await context.workspaceState.update('sidebarPrefsMigrationDone', true);
	}
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

				// Pinned dev-tools store — created before the sidebar (which
				// renders the tool tabs) and shared with the picker below —
				const devTools = new DevToolStore(context);
				const engineConnection = ConnectionManager.getInstance();

				// SHELL BUS ROOT: this process owns the engine connection, so
				// the bus router + client broker live here. Webview realms
				// attach as spokes (SidebarProvider wires its webview on
				// resolve) and reach the engine only through request() —
				// named client.* ops, broker-owned monitors, mirrored state.
				const busHost = new BusHost(engineConnection);
				// Everything this host serves over the bus — monitor broker,
				// client overrides, the shared client table, host.* ops, the
				// settings/cloud/engine family — registers in dependency order
				// in src/ops. The returned controller is the settings pages'
				// panel-lifecycle seam (open args, polling, close semantics).
				const settingsOps = registerVscodeOps(busHost, context);
				busHost.startMirrors();
				context.subscriptions.push({ dispose: () => busHost.dispose() });

				// The HOST owns the tools' reachability topic: every frame's
				// bus peer subscribes `host:connection` (retained — a late
				// panel replays it first) so enablement is right even before
				// any tool sidebar has mounted.
				const pushHostConnection = (): void => busHost.retained.publish('host:connection', { connected: engineConnection.isConnected() });
				pushHostConnection();
				engineConnection.on('shell:statusChange', pushHostConnection);
				context.subscriptions.push({ dispose: () => engineConnection.off('shell:statusChange', pushHostConnection) });

				// Register unified sidebar webview. retainContextWhenHidden: the
				// sidebar carries live state (dev-tool sidebar mounts, their SDK
				// connections, task indicators) that must survive switching to
				// another activity-bar container (Explorer, Git, ...).
				sidebar = new SidebarProvider(context.extensionUri, context, devTools, busHost);
				const sidebarWebviewProvider = vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
					webviewOptions: { retainContextWhenHidden: true },
				});

				context.subscriptions.push(sidebarWebviewProvider);

				//-------------------------------------
				// Create webview providers
				//-------------------------------------
				logger.output(`${icons.info} Creating webview providers...`);
				progress.report({ increment: 60, message: 'Creating webview providers...' });

				// Settings page: a framework page (page-frame + bus ops). The
				// open command's positional args (focus section, auth-error
				// banner) ride the settings controller's open-args seam.
				const settingsPage = new FrameworkProvider(context, busHost, {
					page: 'settings',
					command: 'rocketride.page.settings.open',
					viewType: 'rocketride.page.settings',
					title: 'RocketRide Settings',
					onOpen: (args) => {
						settingsOps.setOpenArgs({
							focus: typeof args[0] === 'string' ? args[0] : undefined,
							authError: typeof args[1] === 'string' ? args[1] : undefined,
						});
						settingsOps.pageOpened('settings');
					},
					onClose: (userClosed) => settingsOps.pageClosed('settings', userClosed),
				});
				// Credential commands kept as thin aliases (contributed in
				// package.json): setup/update open the page; clear is a
				// host-side confirm + delete + disconnect.
				context.subscriptions.push(
					vscode.commands.registerCommand('rocketride.page.settings.setupCredentials', () => vscode.commands.executeCommand('rocketride.page.settings.open')),
					vscode.commands.registerCommand('rocketride.page.settings.updateApiKey', () => vscode.commands.executeCommand('rocketride.page.settings.open')),
					vscode.commands.registerCommand('rocketride.page.settings.clearApiKey', async () => {
						const result = await vscode.window.showWarningMessage('Are you sure you want to clear the stored API key?', 'Yes', 'No');
						if (result === 'Yes') {
							await configManager?.deleteApiKey('development');
							// Disconnect since credentials are now invalid
							void connectionManager?.disconnect();
						}
					})
				);
				// Server Monitor is a DEV TOOL now — the old page command opens
				// the tool's frame panel (palette compatibility).
				context.subscriptions.push(vscode.commands.registerCommand('rocketride.page.monitor.open', () => {
					void vscode.commands.executeCommand('rocketride.devtool.open', 'rocketride.monitor');
				}));
				// Embedded "Introduction to ..." pages (sidebar Introduction rows).
				_htmlPages = new HtmlPageProvider(context);
				// deploy removed — register redirect command so sidebar "Deploy" opens Settings
				context.subscriptions.push(vscode.commands.registerCommand('rocketride.page.deploy.open', () => vscode.commands.executeCommand('rocketride.page.settings.open', 'deployment')));
				// App Builder — a first-class DOCUMENT, .pipe-style: a custom
				// editor over the app's real <name>.rrapp file (VSCode owns tab
				// identity, dedupe, and restore-on-reload; double-clicking the
				// file in the Explorer opens the App Builder), plus the
				// watch-session manager driving the inner loop.
				appScreen = new AppScreenProvider(context, busHost);
				// The guard wrapper ships beside the bundle (staged by
				// vscode:stage-files); every dev server spawns through it so
				// it dies with this extension host.
				const devSessions = initDevSessionManager(appScreen, context.asAbsolutePath('devServerGuard.cjs'));
				context.subscriptions.push(
					vscode.window.registerCustomEditorProvider('rocketride.appBuilder', appScreen, {
						webviewOptions: { retainContextWhenHidden: true },
						supportsMultipleEditorsPerDocument: false,
					}),
					appScreen,
					{ dispose: () => devSessions.dispose() },
				);
				// Tabs that predate this host ("Developer: Restart Extension
				// Host" keeps them open but never re-resolves them) still need
				// their dev servers — reconcile against the surviving tab list.
				void appScreen.reconcileOpenTabs();
				// Framework pages: shell components in a webview, engine access
				// over the bus — the host side is just command + panel + realm.
				// Welcome: first-run onboarding. Closing it by ANY user exit
				// counts as dismissal (the settings controller persists it);
				// Save & Connect runs the first initialize+reconcile inside
				// host.settings.save{connect} before the page retires itself.
				const welcomePage = new FrameworkProvider(context, busHost, {
					page: 'welcome',
					command: 'rocketride.page.welcome.open',
					viewType: 'rocketride.page.welcome',
					title: 'Welcome to RocketRide',
					onOpen: () => settingsOps.pageOpened('welcome'),
					onClose: (userClosed) => settingsOps.pageClosed('welcome', userClosed),
				});
				const account = new FrameworkProvider(context, busHost, {
					page: 'account',
					command: 'rocketride.page.account.open',
					viewType: 'rocketride.page.account',
					title: 'Account',
				});
				// The Environment page's missing-keys prefill (the pre-run env
				// gate): pull-based for open-with-args (the realm attaches
				// after the command fires), push for an already-open page.
				let envPrefillKeys: string[] = [];
				busHost.rootBus.handle('env.getPrefill', async () => ({ keys: envPrefillKeys }));
				const environment = new FrameworkProvider(context, busHost, {
					page: 'environment',
					command: 'rocketride.page.environment.open',
					viewType: 'rocketride.page.environment',
					title: 'Variables',
					onOpen: (args) => {
						const keys = Array.isArray(args[0]) ? (args[0] as string[]) : [];
						if (keys.length > 0) {
							envPrefillKeys = keys;
							busHost.broadcastEmitOp('env.prefill', { keys });
						}
					},
				});
				// New App wizard — a framework page (shared NewAppForm over the
				// host.appdev.* ops); the open command keeps its historic id.
				const newApp = new FrameworkProvider(context, busHost, {
					page: 'newapp',
					command: 'rocketride.app.create',
					viewType: 'rocketride.page.newApp',
					title: 'New App',
				});
				// Dev tools: the tool panels (MF host webviews) + the modules
				// flow's details page (README + Install/Remove — Remove also
				// closes the tool's open panel). Each registers its own command.
				const devToolPanels = new DevToolPanelProvider(context, busHost);
				// Focusing a tool's editor tab highlights its tab on the
				// sidebar strip (and shows its sidebar body).
				devToolPanels.onPanelFocused = (appId) => sidebar?.setModeExternal(`tool:${appId}`);
				// Tool sidebars follow the editor's fronted tab: the fronted
				// tool document's key, or null when a non-tool tab is active.
				devToolPanels.onActiveDocChange = (appId, docKey) => sidebar?.notifyToolActiveDoc(appId, docKey);
				// The details page is a MULTI-INSTANCE framework page: one panel
				// per tool, identity stamped as data-rr-args, title from the
				// current catalog (best effort — the page itself stays correct
				// off the mirror either way).
				const devToolReadme = new FrameworkProvider(context, busHost, {
					page: 'devtool-readme',
					command: 'rocketride.devtool.readme',
					viewType: 'rocketride.page.devToolReadme',
					title: 'Dev Tool',
					instanceKey: (args) => (typeof args[0] === 'string' ? args[0] : ''),
					instanceTitle: (args) => {
						const apps = (connectionManager?.getClient()?.getAccountInfo()?.apps ?? []) as Array<{ id: string; name?: string }>;
						const name = apps.find((a) => a?.id === args[0])?.name ?? String(args[0]);
						return `Dev Tool: ${name}`;
					},
					instanceArgs: (args) => ({ appId: String(args[0]) }),
				});
				// Install/Remove for the details pages — the pinned set is host
				// state; changes push to every open surface.
				registerVscodeDevToolOps(busHost.rootBus, {
					context,
					devTools,
					closeToolPanel: (appId) => devToolPanels.close(appId),
					// The RESET is owned by the sidebar provider (it reboots the
					// sidebar's own page last) — resolved lazily: the sidebar is
					// constructed after this registration.
					refreshTools: async () => sidebar?.refreshDevTools(),
					broadcast: (op, params) => busHost.broadcastEmitOp(op, params),
				});
				context.subscriptions.push(welcomePage, settingsPage, account, environment, newApp, devTools, devToolPanels, devToolReadme);

				// Register unified project editor (canvas + status + trace)
				pipeline = new PipelineProvider(context, busHost);
				const pipelineEditorRegistration = vscode.window.registerCustomEditorProvider('rocketride.page.project', pipeline, {
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
				//-------------------------------------

				//-------------------------------------
				// Set up event handlers
				//-------------------------------------
				logger.output(`${icons.info} Setting up event handlers...`);
				progress.report({ increment: 90, message: 'Setting up event handlers...' });
				setupConnectionEventHandlers();

				// Add all providers to context subscriptions for proper cleanup
				context.subscriptions.push(pipelineEditorRegistration, pipeline);

				//-------------------------------------
				// Initialize connection / welcome flow
				//-------------------------------------
				vscode.commands.executeCommand('setContext', 'rocketride.loaded', true);
				vscode.commands.executeCommand('setContext', 'rocketride.connected', false);

				logger.output(`${icons.info} Initializing status bar...`);
				progress.report({ increment: 120, message: 'Setup status bar' });
				barStatus.initializeConnectionManager();
				context.subscriptions.push(barStatus);

				const welcomeDismissed = vscode.workspace.getConfiguration('rocketride').get<boolean>('welcomeDismissed', false);
				if (!welcomeDismissed) {
					// First run: show welcome page, don't auto-connect — NO
					// engine/connection work happens until the user confirms
					// (host.settings.save{connect} runs initialize+reconcile).
					logger.output(`${icons.info} First run detected — showing welcome page`);
					progress.report({ increment: 110, message: 'Showing welcome...' });
					barStatus.setNeedsSetup();
					FrameworkProvider.openPage('welcome');
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
						getLogger().error(`[ROCKETRIDE] Initial engine reconcile failed: ${String(err)}`);
					});
				}

				//-------------------------------------
				// Auto-install agent documentation (non-blocking). Docs come
				// from the connected server (/client/docs); with no
				// connection yet, existing workspace docs are kept and the
				// sync re-runs on shell:connected.
				//-------------------------------------
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
				if (workspaceFolder) {
					const agentMgr = new AgentManager();
					agentMgr.autoInstall(workspaceFolder.uri).catch((error) => {
						logger.output(`${icons.warning} Auto agent integration failed: ${error}`);
					});

					// Vendor the platform packages (shell + client SDK tgzs)
					// into .rocketride/ at BOOT — offline fallbacks included —
					// so agents and scripts always find them at the well-known
					// locations without waiting for an App Builder open.
					void ensureShell(context);
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
		getLogger().error(`[ROCKETRIDE] Extension activation failed with error: ${String(error)}`);
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
 * Creates a brand-new, NAMELESS untitled pipeline document and opens it in the
 * pipeline grid editor — the standard VS Code new-file lifecycle, shared by the
 * sidebar "New pipeline" action and the File ▸ New File… picker.
 *
 * The document is deliberately path-less. A path-bearing untitled URI is
 * treated by VS Code as already destined for that file, so it silent-saves with
 * no dialog (and errors "file already exists" when the file is present). A
 * nameless untitled defers everything to first save, which is handled by the
 * scoped Ctrl+S keybinding / webview Save button → {@link savePipelineDocument}.
 */
async function createUntitledPipeline(): Promise<void> {
	// step: require an open workspace — pipelines are rooted in it.
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showErrorMessage('No workspace folder open');
		return;
	}

	try {
		// step: open a NAMELESS untitled document seeded with the empty-pipeline
		// template (born dirty), then show it in the pipeline grid editor.
		const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ components: [] }, null, 2) });
		await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'rocketride.page.project');
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to create pipeline: ${error}`);
	}
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
			try {
				await connectionManager?.connect();
			} catch (error) {
				// Surface the failure as a readable notification instead of the
				// raw command-error toast; connect() has already published the
				// DISCONNECTED/AUTH_FAILED state to the status surfaces.
				const msg = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`RocketRide: failed to connect: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('rocketride.sidebar.connection.disconnect', async () => {
			try {
				await connectionManager?.disconnect();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`RocketRide: failed to disconnect: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('rocketride.sidebar.connection.reconnect', async () => {
			try {
				await connectionManager?.disconnect();
				await connectionManager?.connect();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`RocketRide: failed to reconnect: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('rocketride.page.status.open', (projectId: string, sourceId: string) => {
			// Readonly live-task viewer — the pipeline page served with a
			// task: doc (the StatusProvider replacement).
			pipeline?.openTaskStatus(projectId, sourceId);
		}),
		vscode.commands.registerCommand('rocketride.app.open', (appId: string) => {
			// Fire-and-forget: a rejection has no other surface here — say it.
			appScreen?.show(appId).catch((err) => vscode.window.showErrorMessage(`Failed to open app: ${err instanceof Error ? err.message : String(err)}`));
		}),
		vscode.commands.registerCommand('rocketride.refresh', () => {
			vscode.window.showInformationMessage('RocketRide views refreshed');
		}),
		vscode.commands.registerCommand('rocketride.agents.install', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('No workspace folder open. Open a folder first.');
				return;
			}
			try {
				await agentManager.installAll(workspaceFolder.uri);
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
		// Both entry points — the sidebar "New pipeline" action and the
		// File ▸ New File… picker — mint a new untitled .pipe through the
		// standard VS Code document lifecycle (see createUntitledPipeline).
		vscode.commands.registerCommand('rocketride.sidebar.files.createFile', async () => {
			await createUntitledPipeline();
		}),

		vscode.commands.registerCommand('rocketride.pipeline.new', async () => {
			await createUntitledPipeline();
		}),

		// Ctrl+S inside the grid editor (contributes.keybindings, scoped to
		// activeCustomEditorId): resolve the active custom-editor tab to its
		// backing document and run the shared save flow — in place for titled
		// files, the native OS Save dialog (defaulted into the pipelines
		// directory) for untitled ones.
		vscode.commands.registerCommand('rocketride.pipeline.save', async () => {
			const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			if (!(input instanceof vscode.TabInputCustom) || input.viewType !== 'rocketride.page.project') return;
			const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === input.uri.toString());
			if (!document) return;
			try {
				await savePipelineDocument(document);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to save pipeline: ${error}`);
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
			try {
				await cloudAuth.signOut();
			} catch (error) {
				// Naming the step matters here: the credential may still be
				// stored, so the user has to know the session did NOT end.
				const msg = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`RocketRide: failed to sign out of the cloud: ${msg}`);
				return;
			}
			// A direct sign-out applies immediately — take the live cloud
			// connection down with the credential so no surface keeps showing
			// a connected session that storage no longer backs.
			try {
				await disconnectCloudConnections();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`RocketRide: signed out, but the cloud connection did not close: ${msg}`);
			}
		}),

	];

	commands.forEach((command) => context.subscriptions.push(command));
}

/**
 * Sets up event handlers for cross-provider communication
 */
function setupConnectionEventHandlers(): void {
	// Pipeline data changes are now handled by SidebarProvider's event listeners

	// Re-vendor the platform packages against the freshly connected server
	// — the boot pass may have used the offline fallbacks (or a previous
	// server's packages), and the session memo would otherwise keep them.
	connectionManager?.on('shell:connected', () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder || !extensionContext) return;
		void refreshVendoredPlatform(extensionContext);

		// Sync agent docs + stubs against the freshly connected server —
		// the boot pass may have run before any connection existed (docs
		// come from GET /client/docs, never from the vsix). Hash-stamped,
		// so an unchanged bundle is a no-op.
		const agentMgr = new AgentManager();
		agentMgr.autoInstall(workspaceFolder.uri).catch((error) => {
			const logger = getLogger();
			logger.output(`${icons.warning} Agent docs sync on connect failed: ${error}`);
		});
	});

	// Sync service catalog + schemas to .rocketride/ when services are fetched.
	//
	// The ONE place a catalogue problem is reported: this listener sees every
	// update exactly once, however many editors are open. See
	// catalogueDiagnostic for what is said and what is deliberately not.
	const reportCatalogue = createCatalogueReporter();
	connectionManager?.on('shell:servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
		const diagnostic = reportCatalogue(payload);
		if (diagnostic?.level === 'error') {
			getLogger().error(diagnostic.message);
		} else if (diagnostic) {
			getLogger().output(`${icons.warning} ${diagnostic.message}`);
		}

		// Not syncing is right — an empty catalogue must not overwrite a good
		// one on disk.
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
 * Extension deactivation cleanup
 */
export async function deactivate(): Promise<void> {
	if (_htmlPages) {
		try {
			_htmlPages.dispose();
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				getLogger().error(`[ROCKETRIDE] Error disposing html pages: ${String(error)}`);
			}
		}
	}

	// Dispose engine registry (stops all engines)
	if (engineRegistry) {
		try {
			await engineRegistry.disposeAll();
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.name !== 'Canceled') {
				getLogger().error(`[ROCKETRIDE] Error disposing engine registry: ${String(error)}`);
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
				getLogger().error(`[ROCKETRIDE] Error disposing connection manager: ${String(error)}`);
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
				getLogger().error(`[ROCKETRIDE] Error disposing config manager: ${String(error)}`);
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

/** Cached GitHub releases (engine binaries). Written via setCachedEngineVersions; currently no reader (kept so the ops-side setter contract stays stable). */
/** Replaces the cached engine version list. Called by settingsOps after a successful GitHub API fetch. */
export const setCachedEngineVersions = (v: Array<{ tag_name: string; prerelease: boolean }>) => {
};

/** Cached GHCR container tags (Docker images). Populated by ConnectionMessageHandler.fetchAndBroadcastDockerTags(). */
export let cachedDockerTags: string[] = [];
/** Replaces the cached Docker tag list. Called by ConnectionMessageHandler after a successful GHCR API fetch. */
export const setCachedDockerTags = (t: string[]) => {
	cachedDockerTags = t;
};

// Export getters for provider access
export const getExtensionContext = () => extensionContext;
export const getConnectionManager = () => connectionManager;
export const getEngineRegistry = () => engineRegistry;
export const getPipelineProvider = () => pipeline;
