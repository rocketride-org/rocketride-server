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
//   - the project-id STAMPING INVARIANT: every .pipe carries a
//     unique project_id — created/changed files get one stamped on watch,
//     duplicates (file copies) are reported, never rewritten unasked
//     (issue #2466),
//   - RESTART-ON-SAVE: a saved file with running sources prompts or
//     auto-restarts them per the pipelineRestartBehavior setting,
//   - the sidebar's file ACTIONS: open (custom editor), run, stop.
//
// Every write decision goes through the pure decidePipeFile(); this module
// keeps the side effects: reading, waiting, prompting and writing. The
// duplicate check judges against a parsed-file cache (a ReloadingCache) that
// an initial workspace scan fills first on the created-file queue, so no
// created file is judged against a cache still being filled.
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
import { decidePipeFile, emptyPipelineSkeleton, readPipeProjectId, withProjectId, withStoreBlock, EMPTY_FILE_SETTLE_MS } from '../../shared/util/pipeFileDecision';
import type { PipeFileEvent } from '../../shared/util/pipeFileDecision';
import { SerialQueue } from '../../shared/util/serialQueue';
import { ReloadingCache, isUnderNodeModules } from '../../shared/util/reloadingCache';
import { getPipelineProvider } from '../../extension';

/** Resolves after `ms`: the watcher's "give the other writer a moment" wait. */
function settle(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PipelineFiles {
	/**
	 * The parsed .pipe files, keyed by path — the duplicate check behind
	 * project-id stamping. Handlers write through cacheParsedFile;
	 * loadPipelineFiles rebuilds the map and installs it in one assignment,
	 * with the writes made meanwhile re-applied, and of two overlapping
	 * reloads only the newer installs (see ReloadingCache).
	 */
	private cache = new ReloadingCache<ParsedPipelineFile>();
	/**
	 * Created files are handled one at a time, behind the initial load. Each
	 * handler judges its file against parsedFiles and adds its file to
	 * parsedFiles afterwards, so two running side by side would each see a
	 * cache without the other's file, and a project_id the two share would go
	 * unreported.
	 */
	private createdFileQueue = new SerialQueue();
	/** Set by the owner disposing the watchers: a settle wait that outlives them must not write. */
	private disposed = false;

	private logger = getLogger();

	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly configManager: ConfigManager
	) {}

	/** The installed parsed-file cache, read only; writes go through cacheParsedFile. */
	private get parsedFiles(): ReadonlyMap<string, ParsedPipelineFile> {
		return this.cache.entries;
	}

	// =========================================================================
	// FILE WATCHING
	// =========================================================================

	/**
	 * Watches .pipe create/delete/change events in the workspace
	 * and returns the watcher disposables (the owner pushes them into its
	 * list). Also enqueues the initial workspace scan as the created-file
	 * queue's FIRST job: no created file is judged against a cache the
	 * initial load is still filling.
	 *
	 * findFiles excludes node_modules; the watcher does not, and the default
	 * files.watcherExclude leaves a top-level node_modules/x.pipe through.
	 * Every event is filtered here, once, by whole path segment, before any
	 * handler runs: a .pipe file inside an installed package is never written
	 * to (the created and changed reconciles write) and never cached (a
	 * reload would not list it, so it would appear and vanish).
	 */
	setupFileWatching(): vscode.Disposable[] {
		// First on the created-file queue: the initial load.
		void this.createdFileQueue
			.enqueue(() => this.loadPipelineFiles())
			.catch((error) => {
				this.logger.error(`Initial pipeline file load failed (${error instanceof Error ? error.message : String(error)}).`);
			});

		// Re-parse the cache when service definitions arrive (parse results
		// carry service-resolved source info). Logged, never an unhandled
		// rejection.
		const servicesUpdatedHandler = (): void => {
			void this.loadPipelineFiles().catch((error) => {
				this.logger.error(`Pipeline file reload after a services update failed (${error instanceof Error ? error.message : String(error)}).`);
			});
		};
		this.connectionManager.on('shell:servicesUpdated', servicesUpdatedHandler);

		const watcherPipe = vscode.workspace.createFileSystemWatcher('**/*.pipe');
		const outsideNodeModules =
			(handle: (uri: vscode.Uri) => void) =>
			(uri: vscode.Uri): void => {
				// Relative to the workspace folder, the way findFiles applies its exclude.
				if (isUnderNodeModules(vscode.workspace.asRelativePath(uri, false))) return;
				handle(uri);
			};
		return [
			watcherPipe,
			watcherPipe.onDidCreate(outsideNodeModules((uri) => this.enqueueCreatedFile(uri))),
			watcherPipe.onDidDelete(outsideNodeModules((uri) => this.handleFileDeleted(uri))),
			watcherPipe.onDidChange(outsideNodeModules((uri) => this.handleFileChanged(uri))),
			{
				dispose: () => {
					this.disposed = true;
					this.connectionManager.off('shell:servicesUpdated', servicesUpdatedHandler);
				},
			},
		];
	}

	/**
	 * Queues a created .pipe file for handleFileCreated. Files created together
	 * (a checkout, a copied folder) arrive as a burst of events; handled side by
	 * side, each would be judged against a cache that holds none of the others.
	 * A handler that fails is logged and does not hold up the next one.
	 */
	private enqueueCreatedFile(uri: vscode.Uri): void {
		void this.createdFileQueue
			.enqueue(() => this.handleFileCreated(uri))
			.catch((error) => {
				this.logger.error(`Pipeline ${vscode.workspace.asRelativePath(uri)}: create handling failed (${error instanceof Error ? error.message : String(error)}).`);
			});
	}

	/**
	 * Handles a newly created .pipe file. A genuinely new, empty file gets the
	 * starter skeleton and a pipeline without a project_id gets one; see
	 * reconcileProjectId for what the watcher may and may not write. Runs on
	 * createdFileQueue, one file at a time and after the initial load. Only
	 * the created file is parsed into the cache, as handleFileChanged does: a
	 * checkout that adds a hundred files must not run a hundred workspace
	 * scans, and the next queued file needs no more than this one's entry.
	 */
	private async handleFileCreated(uri: vscode.Uri): Promise<void> {
		// The queue can hold a file past dispose, and dispose can land during
		// the settle wait inside reconcileProjectId; a disposed module has
		// nothing to refresh.
		if (this.disposed) return;
		// node_modules events never get here: setupFileWatching filters them.
		await this.reconcileProjectId(uri, 'created');
		if (this.disposed) return;
		const text = await this.readFileText(uri);
		// Gone again already (a checkout, a temporary file): nothing to cache.
		if (text === null) return;
		this.cacheParsedFile(uri.fsPath, parsePipelineContent(text, uri.fsPath, this.getServiceClassInfoMap()));
	}

	/** Removes the deleted file from the parsed-files cache. */
	private handleFileDeleted(uri: vscode.Uri): void {
		if (this.disposed) return;
		this.cacheParsedFile(uri.fsPath, null);
	}

	/** Re-parses a changed .pipe file, ensures project_id, and optionally restarts. */
	private async handleFileChanged(uri: vscode.Uri): Promise<void> {
		if (this.disposed) return;
		await this.reconcileProjectId(uri, 'changed');
		// dispose can land during the settle wait inside reconcileProjectId.
		if (this.disposed) return;

		// Re-parse the changed file. Deleted meanwhile (a checkout, a temporary
		// file): the delete handler already dropped it, and a parse of a missing
		// path must not put it back as a ghost entry.
		const text = await this.readFileText(uri);
		if (this.disposed) return;
		if (text === null) {
			this.cacheParsedFile(uri.fsPath, null);
			return;
		}
		const parsedFile = parsePipelineContent(text, uri.fsPath, this.getServiceClassInfoMap());
		this.cacheParsedFile(uri.fsPath, parsedFile);

		await this.handlePipelineRestart(uri, parsedFile);
	}

	/**
	 * The one way a watcher handler writes to the parsed-file cache. A reload
	 * in progress builds its own map and would drop the write on its swap, so
	 * the cache also records the write for the reload to re-apply. `null`
	 * deletes.
	 */
	private cacheParsedFile(fsPath: string, parsed: ParsedPipelineFile | null): void {
		this.cache.write(fsPath, parsed);
	}

	/**
	 * Scans the workspace for .pipe files and parses them into
	 * the cache. The cache is replaced in one assignment once every file is
	 * parsed: a services update reloads outside the created-file queue, and a
	 * handler deciding during such a reload must see the previous cache
	 * whole, not one being refilled.
	 *
	 * The delete and change handlers write to that previous cache meanwhile,
	 * and the swap would drop their writes: a file deleted during the reload
	 * would come back, a changed one would keep its old parse. The cache
	 * records their writes and re-applies them after the swap. Of two
	 * overlapping reloads only the newer installs its map; the older waits
	 * for the newer to finish before it returns, whether it was superseded
	 * while parsing or failed, so the created-file queue, which runs the
	 * initial load first, continues against the newer reload's map, or, when
	 * that reload failed, against the current one (ReloadingCache holds this
	 * logic, with its tests).
	 *
	 * Invariant that keeps the queue deadlock-free: only the initial load runs
	 * on createdFileQueue. A services update reloads outside it on purpose; a
	 * queued load awaiting settled() on a load queued behind it would wait on
	 * itself (see serialQueue.ts).
	 */
	private async loadPipelineFiles(): Promise<void> {
		const seq = this.cache.beginReload();
		let parsed: Map<string, ParsedPipelineFile>;
		try {
			const files = await vscode.workspace.findFiles('**/*.pipe', '**/node_modules/**');
			parsed = new Map<string, ParsedPipelineFile>();
			for (const uri of files) {
				const text = await this.readFileText(uri);
				if (text === null) continue;
				parsed.set(uri.fsPath, parsePipelineContent(text, uri.fsPath, this.getServiceClassInfoMap()));
			}
		} catch (error) {
			// Nothing to install. When this was the newest reload, whoever waits on
			// it goes on with the current cache; when a newer one is in flight, wait
			// for it like a superseded load does, so the created-file queue does
			// not run against an empty map because a scan failed.
			this.cache.finishReload(seq, undefined);
			await this.cache.settled();
			throw error;
		}

		if (!this.cache.finishReload(seq, parsed)) {
			// A newer reload has started since: it saw everything this one saw.
			// Wait for it, so whatever is queued behind this load finds its map.
			await this.cache.settled();
		}
	}

	// =========================================================================
	// PROJECT ID RECONCILIATION (issue #2466)
	// =========================================================================

	/**
	 * The only path through which the watcher writes to a user's file. What
	 * happens is decided by the pure decidePipeFile(); this method reads,
	 * waits, prompts and writes.
	 */
	private async reconcileProjectId(uri: vscode.Uri, event: PipeFileEvent, settled = false): Promise<void> {
		if (this.disposed) return;
		const text = await this.readFileText(uri);
		// Not readable (not there yet, or already gone): nothing to decide.
		if (text === null) return;

		const decision = decidePipeFile({ event, filePath: uri.fsPath, text, settled });
		switch (decision.kind) {
			case 'leave':
				return;
			case 'confirm-empty':
				// A file another program is still saving reads as empty for a
				// moment. Look again once it has had time to land.
				await settle(EMPTY_FILE_SETTLE_MS);
				await this.reconcileProjectId(uri, event, true);
				return;
			case 'seed-empty': {
				// Only reachable through the settled re-entry above. Look once more
				// right before writing: a save that landed since the settled read
				// must not be replaced by the skeleton. writePipeText re-checks the
				// disposed flag.
				const latest = await this.readFileText(uri);
				if (latest === null || latest.trim() !== '') return;
				// The id lives INSIDE the file and is never derived from its name
				// (the file may be called anything): a fresh one is minted here and
				// the author picks the short id on PACKAGE › Identity.
				await this.writePipeText(uri, emptyPipelineSkeleton(crypto.randomUUID()), 'new empty file, wrote the starter pipeline');
				return;
			}
			case 'assign-id':
				// Only a pipeline without a usable id gets here; assignProjectId
				// re-reads the file and writes only while that is still so.
				await this.assignProjectId(uri, null, 'had no project_id, assigned one');
				return;
			case 'assign-store':
				// A saved pipe without a store block (plan §9): the default block is
				// written the way a missing id is, re-read first.
				await this.assignStoreBlock(uri);
				return;
			case 'refuse-dotted':
				// Never rewritten: the user typed an address where a short id goes
				// (B5); the namespace is derived from the publisher, not typed.
				vscode.window.showErrorMessage(`Pipeline ${vscode.workspace.asRelativePath(uri)}: project_id "${decision.projectId}" is not a short id. Use one dot-free segment (letters, digits, _ or -); the developer id is added when the pipeline is published.`);
				return;
		}
	}

	/**
	 * Writes a fresh project_id into the file, keeping its formatting. The file
	 * is read again first and left alone if its id is no longer `expectedId`:
	 * the user may have edited it since the decision was made (the duplicate
	 * warning can sit open for a long time).
	 */
	private async assignProjectId(uri: vscode.Uri, expectedId: string | null, why: string): Promise<void> {
		const text = await this.readFileText(uri);
		if (text === null || readPipeProjectId(text) !== expectedId) return;
		// The id lives INSIDE the file and is never derived from its name: a
		// fresh one is minted; the author picks the short id on PACKAGE › Identity.
		const next = withProjectId(text, crypto.randomUUID());
		if (next === undefined) return;
		await this.writePipeText(uri, next, why);
	}



	/**
	 * Writes the default store block into a pipeline that has none. The file is
	 * read again first and left alone if a block arrived meanwhile.
	 */
	private async assignStoreBlock(uri: vscode.Uri): Promise<void> {
		const text = await this.readFileText(uri);
		if (text === null) return;
		const next = withStoreBlock(text);
		if (next === undefined || next === text) return;
		await this.writePipeText(uri, next, 'had no store block, wrote the default one');
	}

	/** Reads a file as UTF-8, or null when unreadable (not there yet, or gone). */
	private async readFileText(uri: vscode.Uri): Promise<string | null> {
		try {
			return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			return null;
		}
	}

	/** Writes `text` to the file and records why in the output channel. */
	private async writePipeText(uri: vscode.Uri, text: string, why: string): Promise<void> {
		// Every write path awaits a read or a prompt first, and the watchers
		// may be disposed meanwhile. Checked here so no path can forget it.
		if (this.disposed) return;
		const file = vscode.workspace.asRelativePath(uri);
		try {
			await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
			this.logger.info(`Pipeline ${file}: ${why}.`);
		} catch (error) {
			this.logger.error(`Pipeline ${file}: write failed (${error instanceof Error ? error.message : String(error)}).`);
		}
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

			const pipeName = path.basename(fsPath).replace(/\.pipe$/, '');
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
			this.logger.error(`[SidebarProvider] stopPipeline failed: ${String(err)}`);
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
			this.logger.error(`[SidebarProvider] restartPipeline failed: ${error}`);
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
