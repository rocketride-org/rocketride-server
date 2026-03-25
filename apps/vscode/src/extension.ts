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
let extensionContext: vscode.ExtensionContext | undefined;

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
}

/**
 * Extension activation entry point
 *
 * @param context VS Code extension context
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = getLogger();
	logger.output(`${icons.begin} Activating RocketRide extension...`);

	extensionContext = context;

	// Initialize config manager with context for secure storage
	configManager = ConfigManager.getInstance();
	await configManager.initialize(context);

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
				connectionManager = ConnectionManager.getInstance();
				connectionManager.setEnginesRoot(context.globalStorageUri.fsPath);

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

				sidebarFiles = new SidebarFilesProvider(context);
				const pipelineFilesTreeDataProvider = vscode.window.registerTreeDataProvider('rocketride.provider.files', sidebarFiles);

				// Register connection webview provider
				pageConnection = new PageConnectionProvider(context.extensionUri);
				const connectionWebviewProvider = vscode.window.registerWebviewViewProvider(PageConnectionProvider.viewType, pageConnection);

				sidebarConnection = new SidebarConnectionProvider(context);

				context.subscriptions.push(pipelineFilesTreeDataProvider, connectionWebviewProvider, sidebarConnection);

				//-------------------------------------
				// Create webview providers
				//-------------------------------------
				logger.output(`${icons.info} Creating webview providers...`);
				progress.report({ increment: 60, message: 'Creating webview providers...' });

				pageSettings = new PageSettingsProvider(context.extensionUri);
				pageStatus = new PageStatusProvider(context);
				pageDeploy = new PageDeployProvider(context);
				pageWelcome = new PageWelcomeProvider(context, context.extensionUri);

				// Register custom editor provider
				pageEditor = new PageEditorProvider(context);
				const pageEditorRegistration = vscode.window.registerCustomEditorProvider('rocketride.PageEditor', pageEditor, {
					webviewOptions: {
						retainContextWhenHidden: true, // Better performance for complex editors
					},
					supportsMultipleEditorsPerDocument: false, // One editor per file
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
				context.subscriptions.push(pageEditorRegistration, pageSettings, pageEditor, pageConnection, sidebarFiles, pageStatus, pageWelcome!);

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

				const welcomeDismissed = pageWelcome?.isDismissed() ?? true;
				if (!welcomeDismissed) {
					// First run: show welcome page, don't auto-connect
					logger.output(`${icons.info} First run detected — showing welcome page`);
					progress.report({ increment: 110, message: 'Showing welcome...' });
					barStatus.setNeedsSetup();
					pageWelcome!.show();
				} else {
					// Normal flow: auto-connect
					logger.output(`${icons.info} Initializing connections...`);
					progress.report({ increment: 110, message: 'Starting connections...' });
					barStatus.setReady();
					connectionManager.initialize().catch((error) => {
						console.error('[ROCKETRIDE] Connection initialization failed:', error);
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
	const commands = [
		vscode.commands.registerCommand('rocketride.refresh', async () => {
			await refreshAllProviders();
			vscode.window.showInformationMessage('RocketRide views refreshed');
		}),
	];

	commands.forEach((command) => context.subscriptions.push(command));
}

/**
 * Sets up event handlers for cross-provider communication
 */
function setupConnectionEventHandlers(): void {
	// Update pipeline data when connected
	connectionManager?.on('pipelineDataChanged', () => {
		sidebarFiles?.refresh();
	});

	// Scaffold .rocketride/ agent docs when engine connects and services load
	connectionManager?.on('connected', () => {
		scaffoldAgentDocs().catch((err) => {
			getLogger().error(`Failed to scaffold .rocketride/ agent docs: ${err}`);
		});
	});

	connectionManager?.on('servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
		if (payload.servicesError || !payload.services || Object.keys(payload.services).length === 0) {
			return;
		}
		writeServicesCatalog(payload.services).catch((err) => {
			getLogger().error(`Failed to write services catalog: ${err}`);
		});
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

/**
 * Builds the agent instruction content pointing to the extension's skill docs.
 * The services catalog lives in globalStorageUri (writable), everything else in extensionPath (readonly).
 */
function buildAgentDocsContent(skillDir: string, servicesPath: string): string {
	return ['When the user asks you to build, edit, or debug a RocketRide pipeline (.pipe file),', 'read the following documentation before generating any pipeline JSON.', '', `1. \`${path.join(skillDir, 'SKILL.md')}\` — How to think about pipelines, lane system, DAG rules, config patterns`, `2. \`${servicesPath}\` — Live catalog of every available node (lanes, profiles, config fields)`, `3. \`${path.join(skillDir, 'assets')}\` — Example .pipe files you can use as templates`].join('\n');
}

/**
 * Creates rocketride.md in the workspace root and scaffolds agent-specific
 * integration files based on the user's enabled integration settings.
 * Runs on every successful engine connection so paths stay current
 * across extension updates.
 */
async function scaffoldAgentDocs(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const logger = getLogger();

	// Resolve path to the skill docs inside the installed extension
	const extensionPath = vscode.extensions.getExtension('rocketride.rocketride')?.extensionPath;
	if (!extensionPath) {
		return;
	}

	const skillDir = path.join(extensionPath, 'skills', 'rocketride-pipelines');
	const storageDir = extensionContext?.globalStorageUri?.fsPath;
	const servicesPath = storageDir ? path.join(storageDir, 'services.md') : path.join(skillDir, 'references', 'services.md');
	const docsContent = buildAgentDocsContent(skillDir, servicesPath);

	// Always write rocketride.md as the universal fallback
	const docsFile = path.join(workspaceRoot, 'rocketride.md');
	const rocketrideMd = ['# RocketRide', '', '> This file is auto-generated by the RocketRide VS Code extension.', '> It is safe to add `rocketride.md` to your `.gitignore`.', '', '## For Coding Agents', '', docsContent, ''].join('\n');
	await fs.promises.writeFile(docsFile, rocketrideMd, 'utf-8');
	logger.output(`${icons.info} Agent docs written to ${docsFile}`);

	// Read integration settings
	const config = vscode.workspace.getConfiguration('rocketride');

	// Helper: write or remove an owned file
	const writeOrRemoveFile = async (enabled: boolean, filePath: string, content: string, label: string) => {
		if (enabled) {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await fs.promises.writeFile(filePath, content, 'utf-8');
			logger.output(`${icons.info} ${label} written to ${filePath}`);
		} else {
			try {
				await fs.promises.unlink(filePath);
				logger.output(`${icons.info} ${label} removed from ${filePath}`);
			} catch {
				// File doesn't exist — nothing to remove
			}
		}
	};

	// Helper: upsert or remove a managed section in a shared file
	const upsertOrRemoveSection = async (enabled: boolean, filePath: string, sectionContent: string, label: string) => {
		const marker = '## RocketRide';
		const markerEnd = '\n## ';
		const section = ['', marker, '', docsContent, ''].join('\n');

		if (enabled) {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			try {
				const existing = await fs.promises.readFile(filePath, 'utf-8');
				const markerIdx = existing.indexOf(marker);
				if (markerIdx !== -1) {
					// Replace existing section
					const afterMarker = existing.indexOf(markerEnd, markerIdx + marker.length);
					const before = existing.substring(0, markerIdx);
					const after = afterMarker !== -1 ? existing.substring(afterMarker) : '';
					await fs.promises.writeFile(filePath, before + section.trimStart() + after, 'utf-8');
					logger.output(`${icons.info} ${label} updated in ${filePath}`);
				} else {
					await fs.promises.writeFile(filePath, existing + section, 'utf-8');
					logger.output(`${icons.info} ${label} appended to ${filePath}`);
				}
			} catch {
				await fs.promises.writeFile(filePath, section.trimStart(), 'utf-8');
				logger.output(`${icons.info} ${label} written to ${filePath}`);
			}
		} else {
			// Remove our section if it exists
			try {
				const existing = await fs.promises.readFile(filePath, 'utf-8');
				const markerIdx = existing.indexOf(marker);
				if (markerIdx !== -1) {
					const afterMarker = existing.indexOf(markerEnd, markerIdx + marker.length);
					const before = existing.substring(0, markerIdx);
					const after = afterMarker !== -1 ? existing.substring(afterMarker) : '';
					const cleaned = (before + after).trim();
					if (cleaned.length > 0) {
						await fs.promises.writeFile(filePath, cleaned + '\n', 'utf-8');
					} else {
						await fs.promises.unlink(filePath);
					}
					logger.output(`${icons.info} ${label} removed from ${filePath}`);
				}
			} catch {
				// File doesn't exist — nothing to clean
			}
		}
	};

	// Claude Code — .claude/rules/rocketride.md
	await writeOrRemoveFile(config.get<boolean>('integrations.claudeCode', false), path.join(workspaceRoot, '.claude', 'rules', 'rocketride.md'), docsContent + '\n', 'Claude Code integration');

	// Cursor — .cursor/rules/rocketride.mdc
	const mdcContent = ['---', 'description: Build, edit, or debug RocketRide data processing pipelines (.pipe files). Use when the user asks about RocketRide pipelines, nodes, lanes, or agent workflows.', 'alwaysApply: false', '---', '', docsContent, ''].join('\n');
	await writeOrRemoveFile(config.get<boolean>('integrations.cursor', false), path.join(workspaceRoot, '.cursor', 'rules', 'rocketride.mdc'), mdcContent, 'Cursor integration');

	// Copilot — .github/copilot-instructions.md (managed section)
	await upsertOrRemoveSection(config.get<boolean>('integrations.copilot', false), path.join(workspaceRoot, '.github', 'copilot-instructions.md'), docsContent, 'Copilot integration');

	// Windsurf — .windsurf/rules/rocketride.md
	await writeOrRemoveFile(config.get<boolean>('integrations.windsurf', false), path.join(workspaceRoot, '.windsurf', 'rules', 'rocketride.md'), docsContent + '\n', 'Windsurf integration');

	// Codex — AGENTS.md (managed section)
	await upsertOrRemoveSection(config.get<boolean>('integrations.codex', false), path.join(workspaceRoot, 'AGENTS.md'), docsContent, 'Codex integration');
}

/**
 * Writes a formatted catalog of running services to globalStorageUri
 * so it's writable regardless of extension install location (marketplace,
 * remote, etc.). Falls back to the extension's skills directory if
 * globalStorageUri is unavailable.
 */
async function writeServicesCatalog(services: Record<string, unknown>): Promise<void> {
	const storageDir = extensionContext?.globalStorageUri?.fsPath;
	let servicesFile: string;

	if (storageDir) {
		await fs.promises.mkdir(storageDir, { recursive: true });
		servicesFile = path.join(storageDir, 'services.md');
	} else {
		const extensionPath = vscode.extensions.getExtension('rocketride.rocketride')?.extensionPath;
		if (!extensionPath) {
			return;
		}
		const skillDir = path.join(extensionPath, 'skills', 'rocketride-pipelines', 'references');
		await fs.promises.mkdir(skillDir, { recursive: true });
		servicesFile = path.join(skillDir, 'services.md');
	}

	const lines: string[] = ['# Available RocketRide Services', '', '> Auto-generated from the running RocketRide engine.', '> This file refreshes on every engine connection.', '', 'Use this catalog to select the right nodes when building `.pipe` pipelines.', 'Each service below is a node you can add to a pipeline as a `provider`.', ''];

	for (const [key, value] of Object.entries(services)) {
		const svc = value as Record<string, unknown>;

		const title = (svc.title as string) || key;
		const desc = Array.isArray(svc.description) ? (svc.description as string[]).join('') : (svc.description as string) || '';
		const classType = Array.isArray(svc.classType) ? (svc.classType as string[]).join(', ') : '';
		const lanes = svc.lanes as Record<string, string[]> | undefined;
		const input = svc.input as Array<{ lane: string; output?: Array<{ lane: string; description?: string }> }> | undefined;
		const preconfig = svc.preconfig as { default?: string; profiles?: Record<string, Record<string, unknown>> } | undefined;
		const fields = svc.fields as Record<string, unknown> | undefined;

		lines.push(`## \`${key}\` — ${title}`);
		lines.push('');
		if (classType) {
			lines.push(`**Category:** ${classType}`);
		}
		if (desc) {
			lines.push(`**Description:** ${desc.replace(/<[^>]*>/g, '').trim()}`);
		}
		lines.push('');

		// Lanes
		if (lanes && Object.keys(lanes).length > 0) {
			lines.push('**Lanes:**');
			for (const [inputLane, outputLanes] of Object.entries(lanes)) {
				const outputs = Array.isArray(outputLanes) && outputLanes.length > 0 ? outputLanes.join(', ') : '(none — terminal)';
				lines.push(`- \`${inputLane}\` → ${outputs}`);
			}
			lines.push('');
		}

		// Input/output with descriptions
		if (input && input.length > 0) {
			lines.push('**Input/Output:**');
			for (const inp of input) {
				const outputs =
					inp.output && inp.output.length > 0
						? inp.output
								.map((o) => {
									const d = o.description ? ` — ${o.description}` : '';
									return `\`${o.lane}\`${d}`;
								})
								.join(', ')
						: '(terminal)';
				lines.push(`- Accepts \`${inp.lane}\` → produces ${outputs}`);
			}
			lines.push('');
		}

		// Profiles (model selection)
		if (preconfig?.profiles && Object.keys(preconfig.profiles).length > 0) {
			const profileNames = Object.entries(preconfig.profiles).map(([k, v]) => {
				const t = (v as Record<string, unknown>).title as string | undefined;
				return t ? `\`${k}\` (${t})` : `\`${k}\``;
			});
			const defaultProfile = preconfig.default || '';
			lines.push(`**Profiles:** ${profileNames.join(', ')}`);
			if (defaultProfile) {
				lines.push(`**Default:** \`${defaultProfile}\``);
			}
			lines.push('');
		}

		// Config fields (key ones only — skip internal/UI fields)
		if (fields && Object.keys(fields).length > 0) {
			const configFields = Object.entries(fields).filter(([k]) => !k.startsWith('Pipe.') && !k.startsWith('DTC.') && k !== 'hideForm' && k !== 'type' && !k.startsWith('source.') && !k.startsWith('target.'));
			if (configFields.length > 0) {
				lines.push('**Config Fields:**');
				for (const [fieldKey, fieldDef] of configFields) {
					const fd = fieldDef as Record<string, unknown>;
					const type = (fd.type as string) || '';
					const fieldTitle = (fd.title as string) || fieldKey;
					const def = fd.default !== undefined ? ` (default: \`${JSON.stringify(fd.default)}\`)` : '';
					const secure = fd.secure ? ' [secure]' : '';
					lines.push(`- \`${fieldKey}\`: ${fieldTitle}${type ? ` (${type})` : ''}${def}${secure}`);
				}
				lines.push('');
			}
		}

		lines.push('---');
		lines.push('');
	}

	await fs.promises.writeFile(servicesFile, lines.join('\n'), 'utf-8');

	const logger = getLogger();
	logger.output(`${icons.info} Services catalog written to ${servicesFile} (${Object.keys(services).length} services)`);
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
