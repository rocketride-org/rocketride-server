// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PipelineProvider — the .pipe custom editor (canvas, file I/O, run/stop,
 * publish) plus the readonly live-task viewer (task: docs).
 *
 * The editor webview is a BUS REALM: boot state rides host.pipeline.load,
 * per-document state rides the pipeline:doc:<doc> topics, engine access is
 * request('client.*'). NOTHING rides postMessage any more: publish is an
 * op, the subscribe overlay is a per-doc signal, and subscription state is
 * derived realm-side from the mirrored account.
 *
 * NOTE: the viewType stays 'rocketride.page.project' on purpose — it is
 * VS Code's tab-restore identity; renaming it orphans every user's open
 * .pipe tabs (decision: keep, 2026-10-18).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GenericEvent, ConnectionState, PIPE_BUILDER_APP_ID } from '../shared/types';
import { PIPELINE_PARTITION } from 'shared/tools/pipelines/types';
import type { TaskStatus } from 'shared/tools/pipelines/types';
import { ConnectionManager } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConfigManager } from '../config';
import type { PipelineConfig } from 'rocketride';
import { getLogger } from '../shared/util/output';
// Deep import on purpose — see SidebarProvider: the barrel drags view types
// into the extension-host compile; parse.ts is pure.
import { parsePipelineContent } from 'shared/tools/pipelines/utils/parse';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { isDeployRunBody } from 'shared/tools/pipelines/runKind';
import { handleMissingEnvVars } from '../shared/util/envVarCheck';
import { isCloudConnectionConfigured as hasCloudConnectionConfigured } from '../shared/util/connectionModeAuth';
import { savePipelineDocument } from '../shared/util/pipelineSave';
import { openExternalLink } from './pipeline/externalLink';
import type { BusHost } from './toolhost/busHost';
import { renderWebviewHtml } from './toolhost/frameworkProvider';
// Deep import on purpose — ext-host-safe .ts leaf (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { OpImplTable } from 'shell/src/ops/busOps';
import type { PipelineHostOpMap, PipelineLoadPayload } from 'shared/ops/pipelineOps';

// =============================================================================
// CONSTANTS
// =============================================================================

// Per-document VIEW STATE (which page, flow view, viewport, toolbar
// position, navigation mode, canvas layout) lives in the pipeline tool's
// partition in the WORKSPACE file, keyed by document URI — so it roams with
// the workspace like every other piece of persisted state, instead of
// sitting in a VS Code Memento. It is NOT prefs: moving the toolbar in one
// pipeline must not move it in all of them.
// workspaceState key prefix for the auto-backup of an untitled pipeline's
// content. VS Code does not hot-exit-back-up a custom-editor untitled document,
// so we persist it ourselves (keyed by the untitled URI) and restore it when
// the editor re-resolves empty after a restart. Cleared when the editor closes.
const UNTITLED_BACKUP_PREFIX = 'rocketride.untitledBackup:';

/** Parses a readonly live-task doc (`task:<projectId>.<sourceId>`), else null. */
function parseTaskDoc(doc: string): { projectId: string; sourceId: string } | null {
	if (!doc.startsWith('task:')) return null;
	const rest = doc.slice('task:'.length);
	const dot = rest.indexOf('.');
	if (dot <= 0) return null;
	return { projectId: rest.slice(0, dot), sourceId: rest.slice(dot + 1) };
}

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

export class PipelineProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<vscode.WebviewPanel, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	private savesForRun: Set<string> = new Set();
	/** Readonly live-task viewer panels (doc = task:<projectId>.<sourceId>). */
	private taskPanels: Map<string, vscode.WebviewPanel> = new Map();

	constructor(
		private readonly context: vscode.ExtensionContext,
		/** The shell bus router — every project editor webview attaches as a
		 *  realm so shell components (checkout, stripe key) ride the bus. The
		 *  project:* postMessage protocol itself migrates in a later pass. */
		private readonly busHost: BusHost
	) {
		this.registerCommands();
		this.setupEventListeners();
		this.registerPipelineOps();
		// Drop an untitled pipeline's auto-backup once its editor closes: an
		// explicit save reverts-and-closes it, and a discard just closes it, so
		// only a full VS Code exit leaves the backup behind — which is exactly
		// the case we want to restore on the next launch.
		this.context.subscriptions.push(
			vscode.workspace.onDidCloseTextDocument((closed) => {
				if (closed.isUntitled) {
					void this.context.workspaceState.update(`${UNTITLED_BACKUP_PREFIX}${closed.uri.toString()}`, undefined);
				}
			})
		);
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
		const eventListener = this.connectionManager.on('shell:event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Subscription state is NOT pushed: every realm mirrors shell:account
		// and derives it with isAppSubscribed. The host only GATES run.

		const envKeysChangedListener = this.connectionManager.on('shell:envKeysChanged', () => {
			void this.broadcastEnvKeys();
		});

		// Connection + services state ride the framework's retained topics
		// ('shell:status' / 'shell:services' — busHost.startMirrors) and the
		// realm-local shell events; no typed pushes. The reconnect hook below
		// only restarts monitoring (realm-side in a later step).
		const connectionStateListener = this.connectionManager.on('shell:statusChange', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					// Monitoring is realm-owned now (brokered client.addMonitor
					// with cross-realm refcounts; the broker resubscribes on
					// reconnect) — the host only clears its stale status fold.
					this.onConnectedClearStaleData();
				}
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('rocketride.development.connectionMode') || event.affectsConfiguration('rocketride.deployment.connectionMode')) {
				this.publishCloudSetup();
			}
		});
		// Seed the topic so a panel opening before any config change replays it.
		this.publishCloudSetup();

		this.disposables.push(eventListener, envKeysChangedListener, connectionStateListener, configChangeListener);
	}

	// =========================================================================
	// EVENT ROUTING
	// =========================================================================

	private handleEvent(event: GenericEvent): void {
		// The realms receive the event firehose THEMSELVES (mirror.event →
		// realm-local shell:event; the webview's own filters are complete),
		// so nothing is relayed here. The host keeps exactly one fold: the
		// status cache that seeds project:load's canvas and answers the
		// sidebar's getTaskStatus.
		const projectId = event.body?.project_id;
		if (!projectId || event.event !== 'apaevt_status_update') return;
		// Deploy-run statuses (delivered whenever a team-scoped subscription
		// is open) must not enter the DEV canvas cache.
		const source = event.body?.source;
		if (source && !isDeployRunBody(event.body)) {
			for (const editorState of this.editorStates.values()) {
				if (!editorState.isDisposed && editorState.projectId === projectId) {
					editorState.cachedStatuses[source] = event.body as TaskStatus;
				}
			}
		}
	}

	// =========================================================================
	// BROADCASTING
	// =========================================================================

	private isCloudConnectionConfigured(): boolean {
		return hasCloudConnectionConfigured({
			development: { connectionMode: vscode.workspace.getConfiguration('rocketride.development').get('connectionMode', 'local') },
			deployment: { connectionMode: vscode.workspace.getConfiguration('rocketride.deployment').get('connectionMode', null) },
		});
	}

	/** Cloud-setup facts are a retained topic — config-derived and global. */
	private publishCloudSetup(): void {
		this.busHost.retained.publish('pipeline:cloudSetup', { cloudConnectionConfigured: this.isCloudConnectionConfigured() });
	}

	/**
	 * Re-fetches env key names from the server and broadcasts them to all
	 * open editor webviews so the autocomplete list stays in sync after
	 * variables are added or removed on the Environment page.
	 */
	private async broadcastEnvKeys(): Promise<void> {
		const client = this.connectionManager.getClient();
		if (!client) return;
		try {
			this.busHost.retained.publish('pipeline:env', { envKeys: await client.account.getEnvironmentKeys() });
		} catch {
			/* transient — the next envKeysChanged republishes */
		}
	}


	// =========================================================================
	// MONITORING
	// =========================================================================

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
	// OAUTH TOKEN DELIVERY
	// =========================================================================

	/**
	 * The live editor state for a document, if any. The custom editor is
	 * registered with supportsMultipleEditorsPerDocument: false, so at most
	 * one live webview exists per document.
	 */
	/**
	 * The pipeline page's host verbs (shared/ops/pipelineOps.ts), registered
	 * at the root — `doc` (the document URI) addresses the panel.
	 */
	private registerPipelineOps(): void {
		const stateFor = (doc: string): EditorState => {
			const editorState = this.findLiveEditorState(doc);
			if (!editorState) throw new Error(`No open pipeline editor for ${doc}`);
			return editorState;
		};
		const impls: OpImplTable<PipelineHostOpMap> = {
			'host.pipeline.load': (p) => this.loadForRealm(p.doc),
			// Publish snapshots the DOCUMENT, never webview state: the immutable
			// registry must hold exactly what is on disk, so a never-saved doc
			// rejects outright and a dirty one is saved first. A throw here IS
			// the realm's rejection — the bus does the correlation.
			'host.pipeline.publish': async (p) => {
				const document = stateFor(p.doc).document;
				const deployClient = this.connectionManager.getClient();
				if (!deployClient) throw new Error('Not connected to server');
				if (document.isUntitled) throw new Error('Save the pipeline first');
				if (document.isDirty) {
					const saved = await document.save();
					if (!saved) throw new Error('Save failed; publish cancelled');
				}
				const parsed = JSON.parse(document.getText()) as PipelineConfig;
				// The registry renders pipelineName on every deploy surface;
				// .pipe JSON rarely carries one (names live in FILENAMES), so the
				// snapshot takes the file's basename when the JSON has none.
				const pipeline = {
					...parsed,
					name: parsed.name || document.uri.path.split('/').pop()?.replace(/\.pipe(?:\.json)?$/, '') || document.uri.path,
				};
				await deployClient.deploy.add({ pipeline, ...(p.comment ? { comment: p.comment } : {}), ...(p.deployTo ? { deployTo: p.deployTo } : {}) });
			},
			'host.pipeline.contentSet': async (p) => {
				const editorState = stateFor(p.doc);
				const document = editorState.document;
				if (p.project === undefined || p.project === null) return;
				const content = typeof p.project === 'string' ? p.project : JSON.stringify(p.project);
				const { applied } = await this.applyDocumentEdit(document, content);
				// Auto-backup untitled pipelines so in-progress work survives a
				// VS Code restart (hot exit does not preserve custom-editor
				// untitled documents). Cleared when the editor closes.
				if (document.isUntitled) {
					void this.context.workspaceState.update(`${UNTITLED_BACKUP_PREFIX}${document.uri.toString()}`, document.getText());
				}
				// One-shot save after an OAuth token apply: the realm stamps the
				// exact change that applied the tokens (no host-side arming, no
				// next-change race).
				if (p.saveAfter && (applied || document.isDirty)) {
					await document.save();
				}
			},
			'host.pipeline.viewState': (p) => {
				if (!p.viewState) return;
				this.busHost.prefs.setAppStateKey(PIPELINE_PARTITION, p.doc, p.viewState);
			},
			'host.pipeline.oauthStart': (p) => this.startOAuth(stateFor(p.doc).document, p.url),
			'host.pipeline.run': (p) => this.runFromRealm(stateFor(p.doc), p.action, p.source),
			'host.pipeline.stop': async (p) => {
				// The readonly live-task viewer stops through the task registry
				// (it has no document).
				const task = parseTaskDoc(p.doc);
				if (task) {
					const client = this.connectionManager.getClient();
					if (!client) throw new Error('Not connected to server');
					const token = await client.getTaskToken({ projectId: task.projectId, source: p.source });
					if (token) await client.terminate(token);
					return;
				}
				const editorState = stateFor(p.doc);
				await this.stopPipeline(p.source, editorState.document);
			},
			'host.pipeline.save': async (p) => {
				// Same save flow as the Ctrl+S keybinding: in place for titled
				// files, the native OS Save dialog for untitled ones. Reveal
				// first so the revert-and-close inside the untitled branch
				// targets this editor.
				const editorState = stateFor(p.doc);
				editorState.webviewPanel.reveal(undefined, false);
				await savePipelineDocument(editorState.document);
			},
			'host.pipeline.missingEnv': async (p) => {
				if (p.keys?.length) await handleMissingEnvVars(p.keys);
			},
			'host.pipeline.openLink': (p) => {
				if (p.url) openExternalLink(p.url, p.displayName, p.browser);
			},
		};
		registerOpHandlers<PipelineHostOpMap>(this.busHost.rootBus, impls);
	}

	/**
	 * Run/restart with the host's policy: subscription gate (pushes
	 * checkout:required to the panel), save-first (untitled documents drive
	 * the OS Save dialog; cancelling cancels the run), and the save-for-run
	 * suppression window pipelineFiles.isSaveForRun reads.
	 */
	private async runFromRealm(editorState: EditorState, _action: 'run' | 'restart', source?: string): Promise<void> {
		const { document, webviewPanel } = editorState;
		const runClient = this.connectionManager.getClient();
		if (!runClient) {
			vscode.window.showErrorMessage('Not connected to server');
			return;
		}
		const sub = isSubscribed(runClient, PIPE_BUILDER_APP_ID);
		if (!sub) {
			// A one-shot "open the Subscribe overlay" — a SIGNAL, not state:
			// replaying it after a later subscribe would reopen the overlay.
			this.busHost.retained.signal(`pipeline:doc:${document.uri.toString()}:checkout`, { required: true });
			return;
		}
		const uriKey = document.uri.toString();
		let savedKey: string | undefined;
		this.savesForRun.add(uriKey);
		try {
			// Capture the text up front: the untitled save flow below closes
			// the buffer, after which the document is disposed.
			const text = document.getText();
			let runTarget: vscode.Uri | undefined = document.uri;
			if (document.isUntitled) {
				webviewPanel.reveal(undefined, false);
				runTarget = await savePipelineDocument(document);
			} else {
				await this.saveDocument(document, text);
			}
			if (runTarget) {
				// The untitled save reopens the file under a NEW URI — the
				// save-for-run suppression must follow it.
				savedKey = runTarget.toString();
				this.savesForRun.add(savedKey);
				const parsed = JSON.parse(text);
				const pipeName = path.basename(runTarget.fsPath, '.pipe');
				await this.runPipeline({ pipeline: { ...parsed, source: source ?? parsed.source } }, pipeName);
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to run pipeline: ${message}`);
		}
		setTimeout(() => {
			this.savesForRun.delete(uriKey);
			if (savedKey) this.savesForRun.delete(savedKey);
		}, 2000);
	}

	/**
	 * The document's full boot state (host.pipeline.load). Task docs
	 * (`task:<projectId>.<sourceId>`) answer the READONLY live-task viewer:
	 * the pipeline comes off the running task, falling back to a synthesized
	 * single-node project so the page always renders something.
	 */
	private async loadForRealm(doc: string): Promise<PipelineLoadPayload> {
		const task = parseTaskDoc(doc);
		if (task) {
			const client = this.connectionManager.getClient();
			let project: unknown;
			try {
				const token = client ? await client.getTaskToken({ projectId: task.projectId, source: task.sourceId }) : undefined;
				project = token ? await client!.getTaskPipeline(token) : undefined;
			} catch {
				project = undefined;
			}
			if (!project) {
				project = { project_id: task.projectId, components: [{ id: task.sourceId, provider: 'unknown', name: task.sourceId, config: {} }] };
			}
			return {
				project,
				viewState: { mode: 'design' },
				statuses: {},
				isSubscribed: true,
				isReadonly: true,
				isDirty: false,
				isNew: false,
			};
		}

		const editorState = this.findLiveEditorState(doc);
		if (!editorState) throw new Error(`No open pipeline editor for ${doc}`);
		const document = editorState.document;

		const text = document.getText();
		const parsed = parsePipelineContent(text, document.uri.fsPath);
		let project: Record<string, unknown> | undefined;
		if (parsed.isValid) {
			try {
				project = JSON.parse(this.enrichComponentNames(text));
			} catch {
				/* invalid JSON */
			}
		}

		// The tool's partition may never have been activated — load it before
		// reading, or a fresh window restores every editor to defaults.
		await this.busHost.prefs.ensurePartition(PIPELINE_PARTITION);
		const layout = (this.busHost.prefs.appStateFor(PIPELINE_PARTITION)[doc] as Record<string, unknown> | undefined) ?? {};
		const client = this.connectionManager.getClient();
		let envKeys: string[] | undefined;
		try {
			envKeys = await client?.account?.getEnvironmentKeys();
		} catch {
			envKeys = undefined;
		}

		// Seed the doc's dirty topic alongside the load so late subscribers
		// replay a current value.
		this.busHost.retained.publish(`pipeline:doc:${doc}`, { isDirty: document.isDirty, isNew: document.isUntitled });

		// Kick off background services refresh (the realm reads the mirrored
		// services topic as it lands).
		this.connectionManager.refreshServices().catch((err) => {
			this.logger.error(`Background services refresh failed: ${err}`);
		});

		return {
			project,
			viewState: { mode: 'design', ...layout },
			statuses: editorState.cachedStatuses,
			isSubscribed: isSubscribed(client, PIPE_BUILDER_APP_ID),
			isDirty: document.isDirty,
			isNew: document.isUntitled,
			// The OAuth broker only allows https://*.rocketride.ai redirect URLs,
			// so tokens bounce off the CLOUD SERVER's hosted page, which forwards
			// them to the `<uriScheme>://rocketride.rocketride/auth/google` deep
			// link. The bounce host is the effective cloud target (a setting,
			// never a bake) — a custom server hosts its own bounce endpoint.
			oauthReturnUrl: `${ConfigManager.getInstance().getEffectiveCloudUrl()}/auth/vscode/google?scheme=${vscode.env.uriScheme}`,
			...(envKeys ? { envKeys } : {}),
		};
	}

	/**
	 * OAuth login: open the broker URL in the system browser (Google's
	 * consent screen refuses to render in a webview iframe) and arm a
	 * one-shot callback — the deep-link return publishes the tokens on the
	 * doc's retained oauth topic.
	 */
	private async startOAuth(document: vscode.TextDocument, url: string): Promise<void> {
		if (!url) return;
		// Realm-supplied URL: require a parseable https target before arming
		// any OAuth state (OAuth brokers are https-only).
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			this.logger.error('[PipelineProvider] Blocked unparseable OAuth URL');
			return;
		}
		if (parsedUrl.protocol !== 'https:') {
			this.logger.error(`[PipelineProvider] Blocked OAuth URL scheme: ${parsedUrl.protocol}`);
			vscode.window.showErrorMessage(`Sign-in blocked: the OAuth broker URL must use https (got "${parsedUrl.protocol}//"). Rebuild the extension without a non-https REACT_APP_OAUTH_ROOT_URL override.`);
			return;
		}
		// Key the waiter by the node that started the login so the deep-link
		// return routes to the right document's topic.
		const nodeId = parsedUrl.searchParams.get('node_id') || url;
		const docKey = document.uri.toString();
		const unregister = CloudAuthProvider.getInstance().setPendingGoogleOAuth(nodeId, (tokens, state) => {
			this.deliverOAuthTokens(docKey, tokens, state);
		});
		// Pass the raw string: Uri.parse re-encodes the query and un-escapes
		// %3B/%3A, and Zitadel's Go parser rejects raw semicolons in queries
		// (microsoft/vscode#85930). openExternal accepts a string at runtime.
		try {
			const opened = await vscode.env.openExternal(url as unknown as vscode.Uri);
			if (!opened) throw new Error('the system browser refused to open');
		} catch (error) {
			// A dead waiter would swallow a later unrelated deep link.
			unregister();
			this.logger.error(`[PipelineProvider] Failed to open OAuth URL: ${error}`);
			vscode.window.showErrorMessage('Could not open the browser for sign-in. Check your default browser and try again.');
		}
	}

	/**
	 * Opens (or reveals) the READONLY live-task viewer for a running task
	 * with no local .pipe file — the same pipeline page served with a
	 * `task:` doc (the StatusProvider replacement: one panel per task,
	 * stop-only, no persistence).
	 */
	public openTaskStatus(projectId: string, sourceId: string): void {
		const doc = `task:${projectId}.${sourceId}`;
		const existing = this.taskPanels.get(doc);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}
		const panel = vscode.window.createWebviewPanel('rocketride.page.status', `Task: ${sourceId}`, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		this.taskPanels.set(doc, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview, doc);
		const detachRealm = this.busHost.attachWebview(panel.webview, `page:pipeline/${doc}`);
		panel.onDidDispose(() => {
			detachRealm();
			this.taskPanels.delete(doc);
		});
	}

	private findLiveEditorState(docKey: string): EditorState | undefined {
		for (const editorState of this.editorStates.values()) {
			if (!editorState.isDisposed && editorState.isReady && editorState.document.uri.toString() === docKey) {
				return editorState;
			}
		}
		return undefined;
	}

	/**
	 * Deliver broker OAuth tokens as the document's retained oauth topic —
	 * retention IS the redelivery stash (the editor that started the login
	 * may be recycled during the browser round-trip; its replacement replays
	 * the topic on subscribe). The consuming page RETRACTS after applying.
	 */
	private deliverOAuthTokens(docKey: string, tokens: string, state: string): void {
		this.busHost.retained.publish(`pipeline:doc:${docKey}:oauth`, { tokens, state });
	}

	// =========================================================================
	// RESOLVE CUSTOM TEXT EDITOR
	// =========================================================================

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
		const webview = webviewPanel.webview;

		// A hot-exit restored untitled pipeline comes back with empty content
		// (VS Code does not preserve the programmatically-seeded text), which
		// would parse to no project and render a blank canvas. Restore our own
		// auto-backup of the in-progress pipeline if there is one; otherwise
		// seed the empty-pipeline template so the starting-point wizard shows.
		if (document.isUntitled && document.getText().trim() === '') {
			const backup = this.context.workspaceState.get<string>(`${UNTITLED_BACKUP_PREFIX}${document.uri.toString()}`);
			const seedText = backup && backup.trim() !== '' ? backup : JSON.stringify({ components: [] }, null, 2);
			const seed = new vscode.WorkspaceEdit();
			seed.insert(document.uri, new vscode.Position(0, 0), seedText);
			await vscode.workspace.applyEdit(seed);
		}

		const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.fsPath;
		webviewPanel.title = fileName.replace(/\.pipe(\.json)?$/i, '');

		const { projectId } = this.extractPipelineIds(document);

		const editorState: EditorState = {
			document,
			webviewPanel,
			projectId,
			isDisposed: false,
			// No handshake: the realm pulls host.pipeline.load when it boots.
			isReady: true,
			cachedStatuses: {},
		};

		this.editorStates.set(webviewPanel, editorState);

		webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		webview.html = this.getHtmlForWebview(webview, document.uri.toString());

		// The editor is also a bus realm: shell components inside it (checkout,
		// stripe key) use request('client.*')/host.* ops over the `__rrbus`
		// envelope, which never collides with the typed project:* messages.
		const detachRealm = this.busHost.attachWebview(webview, `page:pipeline/${document.uri.toString()}`);

		// --- Handle messages from the webview (ProjectViewOutgoing) -----------

		webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				// Checkout rides the bus (client.billing.* ops + host.stripeKey)
				// — no checkout:* request handling here. checkout:required and
				// checkout:subscriptionUpdate remain host-originated pushes.

			}
		});

		// Document changes (undo/redo, external edits) ride the doc topics:
		// the canvas echo is a SIGNAL (transient by nature — a retained
		// snapshot would fight the document), dirty state is RETAINED.
		const docKey = document.uri.toString();
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === docKey) {
				const { projectId: newProjectId } = this.extractPipelineIds(e.document);
				editorState.projectId = newProjectId;
				this.sendCanvasUpdate(e.document);
				this.busHost.retained.publish(`pipeline:doc:${docKey}`, { isDirty: e.document.isDirty, isNew: e.document.isUntitled });
			}
		});

		// Saves clear dirty state in the canvas.
		const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
			if (savedDoc.uri.toString() === docKey) {
				this.busHost.retained.publish(`pipeline:doc:${docKey}`, { isDirty: false, isNew: savedDoc.isUntitled });
			}
		});

		// Clean up when panel is disposed — the doc's retained topics RETRACT
		// (one snapshot per ever-opened URI would otherwise leak at the root).
		webviewPanel.onDidDispose(async () => {
			detachRealm();
			this.busHost.retained.publish(`pipeline:doc:${docKey}`, undefined);
			this.busHost.retained.publish(`pipeline:doc:${docKey}:oauth`, undefined);
			editorState.cachedStatuses = {};
			editorState.isDisposed = true;
			this.editorStates.delete(webviewPanel);
			changeDocumentSubscription.dispose();
			saveDocumentSubscription.dispose();
		});

	}

	// =========================================================================
	// DOCUMENT I/O
	// =========================================================================

	private sendCanvasUpdate(document: vscode.TextDocument): void {
		const text = document.getText();
		const parsed = parsePipelineContent(text, document.uri.fsPath);
		if (!parsed.isValid) {
			return;
		}

		const enriched = this.enrichComponentNames(text);
		try {
			const project = JSON.parse(enriched);
			this.busHost.retained.signal(`pipeline:doc:${document.uri.toString()}:canvas`, { project });
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
			this.logger.error('[PipelineProvider] Failed to apply document edit');
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

			// TTL, trace level, task arguments, and debug output are workspace
			// settings; the host reads them here and passes them per task to the
			// engine. There is no per-pipeline override.
			const cfg = ConfigManager.getInstance().getConfig();

			await client.use({
				pipeline: project,
				source: project.source,
				pipelineTraceLevel: cfg.pipelineTraceLevel,
				args: ConfigManager.getInstance().getTaskArgs(),
				name,
				// ttl comes straight from settings (0 = no timeout).
				...(cfg.pipelineTtl !== undefined ? { ttl: cfg.pipelineTtl } : {}),
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
				this.logger.error(`[PipelineProvider] Missing projectId or componentId`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			const token = await client.getTaskToken({ projectId, source: componentId });

			if (!token) {
				this.logger.error('[PipelineProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			await client.terminate(token);
		} catch (error: unknown) {
			this.logger.error(`[PipelineProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	// =========================================================================
	// HTML GENERATION
	// =========================================================================

	private getHtmlForWebview(webview: vscode.Webview, doc: string): string {
		return renderWebviewHtml(this.context, webview, {
			htmlFile: 'page-pipeline.html',
			stamps: { doc },
			// This page hosts Stripe Elements for the in-editor checkout, so it
			// replaces the template's CSP with one admitting js.stripe.com
			// (scripts/frames) and api.stripe.com (network).
			transform: (html) =>
				html.replace(
					'<head>',
					`<head>\n\t<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://js.stripe.com; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} data:; frame-src https://js.stripe.com; connect-src ${webview.cspSource} https://api.stripe.com; img-src ${webview.cspSource} data:;">`
				),
		});
	}


	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables = [];
	}
}
