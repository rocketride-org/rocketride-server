// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE FILES — the host's .pipe concerns behind the sidebar
// =============================================================================
//
// The extension host's three remaining pipeline-file jobs (discovery and the
// entry list belong to the webview's PIPELINES CONTROLLER now):
//
//   - the project-id STAMPING INVARIANT: every .pipe/.pipe.json carries a
//     unique project_id — created/changed files get one stamped on watch,
//     duplicates (file copies) get a fresh one,
//   - RESTART-ON-SAVE: a saved file with running sources prompts or
//     auto-restarts them per the pipelineRestartBehavior setting,
//   - the sidebar's file ACTIONS: open (custom editor), run, stop.
// =============================================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfigManager } from '../../config';
import type { ConnectionManager } from '../../connection/connection';
// Deep import on purpose: the tools/pipelines BARREL exports the discovery
// controller, which carries sidebar view types the extension host's no-DOM
// compile must never see. parse.ts is the pure parsing contract.
import { parsePipelineContent } from 'shared/tools/pipelines/utils/parse';
import type { ParsedPipelineFile, ServiceClassInfo } from 'shared/tools/pipelines/utils/parse';
import { checkMissingEnvVars } from '../../shared/util/envVarCheck';
import { getLogger } from '../../shared/util/output';
import { getPipelineProvider } from '../../extension';

export class PipelineFiles {
	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly configManager: ConfigManager
	) {}

	/**
	 * Watches .pipe / .pipe.json create/change events in the workspace and
	 * returns the watcher disposables (the owner pushes them into its list).
	 */
	setupFileWatching(): vscode.Disposable[] {
		const watcherPipe = vscode.workspace.createFileSystemWatcher('**/*.pipe');
		const watcherPipeJson = vscode.workspace.createFileSystemWatcher('**/*.pipe.json');
		return [
			watcherPipe,
			watcherPipe.onDidCreate((uri) => this.handleFileCreated(uri)),
			watcherPipe.onDidChange((uri) => this.handleFileChanged(uri)),
			watcherPipeJson,
			watcherPipeJson.onDidCreate((uri) => this.handleFileCreated(uri)),
			watcherPipeJson.onDidChange((uri) => this.handleFileChanged(uri)),
		];
	}

	// =========================================================================
	// PROJECT-ID STAMPING
	// =========================================================================

	/** Handles a newly created .pipe file — assigns a project_id if missing. */
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
							const existingIds = await this.collectProjectIds(uri.fsPath);
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
	}

	/** Re-parses a changed .pipe file, ensures project_id, and optionally restarts. */
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
							const existingIds = await this.collectProjectIds(uri.fsPath);
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

		// Re-parse the changed file for the restart decision only — the
		// sidebar's entry list is the webview controller's business now.
		const text = await this.readFileText(uri);
		if (text === null) return;
		const parsedFile = parsePipelineContent(text, uri.fsPath, this.getServiceClassInfoMap());

		await this.handlePipelineRestart(uri, parsedFile);
	}

	/** Reads a file as UTF-8, or null when unreadable. */
	private async readFileText(uri: vscode.Uri): Promise<string | null> {
		try {
			return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			return null;
		}
	}

	/**
	 * The project_ids of every OTHER pipeline file in the workspace — the
	 * duplicate check behind project-id stamping. Collected on demand (no
	 * parse cache; stamping is the host's one remaining .pipe concern — the
	 * always-on invariant).
	 *
	 * @param excludeFsPath - The file being stamped (its own id is not a duplicate).
	 * @returns The set of ids in use.
	 */
	private async collectProjectIds(excludeFsPath: string): Promise<Set<string>> {
		const ids = new Set<string>();
		const files = await vscode.workspace.findFiles('{**/*.pipe,**/*.pipe.json}', '**/node_modules/**');
		await Promise.all(files.filter((f) => f.fsPath !== excludeFsPath).map(async (file) => {
			const text = await this.readFileText(file);
			if (text === null) return;
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const body = (parsed.pipeline && typeof parsed.pipeline === 'object' ? parsed.pipeline : parsed) as Record<string, unknown>;
				if (typeof body.project_id === 'string' && body.project_id.trim() !== '') ids.add(body.project_id);
			} catch {
				// Not valid JSON — carries no claimable id.
			}
		}));
		return ids;
	}

	/** Returns the cached service class definitions (restart-flow parsing). */
	private getServiceClassInfoMap(): Record<string, ServiceClassInfo> | undefined {
		const cached = this.connectionManager.getCachedServices();
		return cached?.services as Record<string, ServiceClassInfo> | undefined;
	}

	// =========================================================================
	// ACTIONS
	// =========================================================================

	/** Opens a .pipe file in the custom editor. */
	async openPipelineFile(fsPath: string): Promise<void> {
		try {
			// fsPath may be relative — resolve against workspace
			const uri = this.resolveFileUri(fsPath);
			await vscode.commands.executeCommand('vscode.openWith', uri, 'rocketride.page.project');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to open pipeline: ${error}`);
		}
	}

	/** Reads the pipeline JSON from disk and sends it to the engine via client.use(). */
	async runPipeline(fsPath: string, sourceId?: string): Promise<void> {
		try {
			const uri = this.resolveFileUri(fsPath);
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));

			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			// Gate: check for missing ROCKETRIDE_* env vars
			const missing = await checkMissingEnvVars(client, pipelineJson);
			if (missing.length > 0) return;

			const pipeName = path.basename(fsPath).replace(/\.pipe(?:\.json)?$/, '');
			// Same per-task settings as editor launches (PipelineProvider.runPipeline)
			// — a pipeline must run identically regardless of where it is started.
			const cfg = ConfigManager.getInstance().getConfig();
			await client.use({
				pipeline: pipelineJson,
				source: sourceId ?? '',
				pipelineTraceLevel: cfg.pipelineTraceLevel,
				args: ConfigManager.getInstance().getTaskArgs(),
				name: pipeName,
				...(cfg.pipelineTtl !== undefined ? { ttl: cfg.pipelineTtl } : {}),
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to run pipeline: ${error}`);
		}
	}

	/** Terminates a running pipeline task by project + source. */
	async stopPipeline(projectId: string, sourceId: string): Promise<void> {
		try {
			const client = this.connectionManager.getClient();
			if (!client) return;
			const token = await client.getTaskToken({ projectId, source: sourceId });
			if (token) await client.terminate(token);
		} catch (err) {
			getLogger().error(`[SidebarProvider] stopPipeline failed: ${String(err)}`);
		}
	}

	/** Restarts a running pipeline task with the latest file content. */
	private async restartPipeline(projectId: string, sourceId: string, uri: vscode.Uri): Promise<void> {
		try {
			const fileContent = await vscode.workspace.fs.readFile(uri);
			const pipelineJson = JSON.parse(Buffer.from(fileContent).toString('utf8'));
			const client = this.connectionManager.getClient();
			if (!client) throw new Error('Not connected to server');

			const token = await client.getTaskToken({ projectId, source: sourceId });
			await client.restart({ token, projectId, source: sourceId, pipeline: pipelineJson });
		} catch (error) {
			getLogger().error(`[SidebarProvider] restartPipeline failed: ${error}`);
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
	// RESTART ON SAVE
	// =========================================================================

	/** After a file save, optionally prompts or auto-restarts running pipeline tasks. */
	private async handlePipelineRestart(uri: vscode.Uri, parsedFile: ParsedPipelineFile): Promise<void> {
		if (!parsedFile.isValid || !parsedFile.projectId) return;

		const projectProvider = getPipelineProvider();
		if (projectProvider?.isSaveForRun(uri)) return;

		// Which sources are running — asked of the server directly (the host
		// keeps no task state).
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
}
