// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProjectProvider — Unified custom editor for .pipeline files.
 *
 * Combines the former PageEditorProvider (canvas editing, file I/O, undo/redo)
 * and StatusProvider (status, trace, flow monitoring) into a single provider
 * that renders the shared-ui ProjectView component.
 *
 * Uses the ProjectViewIncoming / ProjectViewOutgoing message protocol to
 * communicate with the Project webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { TaskStatus, GenericEvent, ConnectionState, PIPE_BUILDER_APP_ID } from '../shared/types';
import { ConnectionManager } from '../connection/connection';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConfigManager } from '../config';
import type { PipelineConfig } from 'rocketride';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { PipelineFileParser } from '../shared/util/pipelineParser';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { handleMissingEnvVars } from '../shared/util/envVarCheck';
import { resolveDeployTeams, mapVersionCards, mapHistoryRows, mapTeamDeploymentRows } from '../shared/util/deployMapping';

// =============================================================================
// CONSTANTS
// =============================================================================

const PREFS_KEY = 'rocketride.prefs';
const LAYOUTS_KEY = 'rocketride.layouts';

// How long undelivered OAuth tokens are kept for redelivery after a webview
// reload. Long enough to cover a slow consent flow, short enough that stale
// tokens don't linger.
const OAUTH_REDELIVERY_TTL_MS = 5 * 60 * 1000;

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
	/** One-shot: save the document after the next contentChanged, so OAuth tokens reach disk without a manual save. */
	saveAfterOAuthApply?: boolean;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class ProjectProvider implements vscode.CustomTextEditorProvider {
	private disposables: vscode.Disposable[] = [];
	private editorStates: Map<vscode.WebviewPanel, EditorState> = new Map();
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();
	private savesForRun: Set<string> = new Set();
	// OAuth tokens that arrived while no live webview existed for their
	// document (e.g. the editor was recycled during the browser round-trip),
	// keyed by document URI. Redelivered after the next view:ready.
	private undeliveredOAuthTokens: Map<string, { tokens: string; state: string; expiresAt: number }> = new Map();

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
		const eventListener = this.connectionManager.on('shell:event', (event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.logger.error(`Handling event: ${error}`);
			}
		});

		// Account updates (subscription changes, env changes) are emitted as
		// a dedicated shell:accountUpdate — no longer buried in shell:event
		const accountUpdateListener = this.connectionManager.on('shell:accountUpdate', () => {
			this.broadcastSubscriptionStatus();
		});

		const envKeysChangedListener = this.connectionManager.on('shell:envKeysChanged', () => {
			this.broadcastEnvKeys();
		});

		const connectionStateListener = this.connectionManager.on('shell:statusChange', async (connectionStatus) => {
			try {
				if (connectionStatus.state === ConnectionState.CONNECTED) {
					this.onConnectedClearStaleData();
					// Start monitoring for all open editors that missed initial subscription
					for (const [panel] of this.editorStates) {
						this.startMonitoring(panel).catch((err) => {
							this.logger.error(`Starting monitoring on reconnect: ${err}`);
						});
					}
				}
				this.broadcastConnectionState(this.connectionManager.isConnected());
			} catch (error) {
				this.logger.error(`Handling connection state change: ${error}`);
			}
		});

		const servicesUpdatedListener = this.connectionManager.on('shell:servicesUpdated', (payload: { services: Record<string, unknown>; servicesError?: string }) => {
			this.broadcastServicesToAllEditors(payload);
		});

		this.disposables.push(eventListener, accountUpdateListener, envKeysChangedListener, connectionStateListener, servicesUpdatedListener);
	}

	// =========================================================================
	// EVENT ROUTING
	// =========================================================================

	private handleEvent(event: GenericEvent): void {
		const projectId = event.body?.project_id;
		if (!projectId) return;

		if (event.event === 'apaevt_status_update') {
			const source = event.body?.source;
			if (source) {
				for (const editorState of this.editorStates.values()) {
					if (!editorState.isDisposed && editorState.projectId === projectId) {
						editorState.cachedStatuses[source] = event.body as TaskStatus;
					}
				}
			}
		}

		// Forward EVERY stamped task event for this project — the server stamps
		// project_id + source into all task-scoped bodies at its forward choke
		// point, so identity is a pure body test. The webview's live log,
		// trace, and run-active timeline consume output/lifecycle events too;
		// a status/flow-only whitelist left them permanently incomplete.
		for (const editorState of this.editorStates.values()) {
			if (editorState.isDisposed || !editorState.isReady) continue;
			if (editorState.projectId !== projectId) continue;
			editorState.webviewPanel.webview.postMessage({ type: 'shell:event', event });
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
						type: 'project:services',
						services: payload.services,
					})
					.then(undefined, (err: unknown) => {
						this.logger.error(`Failed to post services to webview: ${err}`);
					});
			}
		}
	}

	private broadcastConnectionState(isConnected: boolean): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'shell:connectionChange', isConnected, isSubscribed: subscribed, serverHost: this.connectionManager.getHttpUrl() }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post connectionState to webview: ${err}`);
				});
			}
		}
	}

	/**
	 * Re-fetches env key names from the server and broadcasts them to all
	 * open editor webviews so the autocomplete list stays in sync after
	 * variables are added or removed on the Environment page.
	 */
	private async broadcastEnvKeys(): Promise<void> {
		const client = this.connectionManager.getClient();
		if (!client) return;

		let envKeys: string[];
		try {
			envKeys = await client.account.getEnvironmentKeys();
		} catch {
			return;
		}

		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'project:envKeysUpdate', envKeys }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post envKeysUpdate to webview: ${err}`);
				});
			}
		}
	}

	/**
	 * Broadcasts updated subscription status to all open editor webviews.
	 * Called when an apaext_account event arrives (subscription change).
	 */
	private broadcastSubscriptionStatus(): void {
		const client = this.connectionManager.getClient();
		const subscribed = isSubscribed(client, PIPE_BUILDER_APP_ID);
		for (const editorState of this.editorStates.values()) {
			if (editorState.isReady && !editorState.isDisposed && editorState.webviewPanel.webview) {
				editorState.webviewPanel.webview.postMessage({ type: 'checkout:subscriptionUpdate', isSubscribed: subscribed }).then(undefined, (err: unknown) => {
					this.logger.error(`Failed to post subscriptionUpdate to webview: ${err}`);
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
			// summary/flow feed the canvas + status map; output/task feed the
			// webview's live log and run-active timeline. The webview has no
			// session of its own (the host bridges all events), so the host
			// must subscribe to every class the panes consume.
			await client.addMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow', 'output', 'task']);
		} catch (error) {
			this.logger.error(`Starting monitoring for project ${editorState.projectId}: ${error}`);
		}
	}

	private async stopMonitoring(panel: vscode.WebviewPanel): Promise<void> {
		const editorState = this.editorStates.get(panel);
		if (!editorState || !editorState.projectId) return;

		try {
			const client = this.connectionManager.getClient();
			if (client) await client.removeMonitor({ projectId: editorState.projectId, source: '*' }, ['summary', 'flow', 'output', 'task']);
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
	// OAUTH TOKEN DELIVERY
	// =========================================================================

	/**
	 * The live editor state for a document, if any. The custom editor is
	 * registered with supportsMultipleEditorsPerDocument: false, so at most
	 * one live webview exists per document.
	 */
	private findLiveEditorState(docKey: string): EditorState | undefined {
		for (const editorState of this.editorStates.values()) {
			if (!editorState.isDisposed && editorState.isReady && editorState.document.uri.toString() === docKey) {
				return editorState;
			}
		}
		return undefined;
	}

	/**
	 * Deliver broker OAuth tokens to the live webview for the document that
	 * started the login. The webview instance that armed the waiter may have
	 * been disposed during the browser round-trip, so the target is resolved
	 * at delivery time; with no live target the tokens are stashed and
	 * redelivered after the next view:ready.
	 */
	private deliverOAuthTokens(docKey: string, tokens: string, state: string): void {
		const stash = () => {
			this.undeliveredOAuthTokens.set(docKey, { tokens, state, expiresAt: Date.now() + OAUTH_REDELIVERY_TTL_MS });
		};

		const editorState = this.findLiveEditorState(docKey);
		if (!editorState) {
			this.logger.info('[ProjectProvider] OAuth tokens arrived with no live editor; holding for redelivery');
			stash();
			return;
		}

		// Arm the one-shot save before posting: the token apply surfaces as the
		// next project:contentChanged, which must reach disk without Ctrl+S.
		editorState.saveAfterOAuthApply = true;
		editorState.webviewPanel.webview.postMessage({ type: 'project:oauthTokens', tokens, state }).then(
			(posted) => {
				if (!posted) {
					editorState.saveAfterOAuthApply = false;
					stash();
				}
			},
			(err: unknown) => {
				editorState.saveAfterOAuthApply = false;
				stash();
				this.logger.error(`[ProjectProvider] Failed to deliver OAuth tokens: ${err}`);
			}
		);
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
				case 'view:ready': {
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
					const client = this.connectionManager.getClient();
					let envKeys: string[] | undefined;
					try {
						envKeys = await client?.account?.getEnvironmentKeys();
					} catch {
						envKeys = undefined;
					}

					// Send everything in one message
					webview.postMessage({
						type: 'project:load',
						project,
						viewState: { mode: 'design', ...layout },
						prefs: storedPrefs,
						services: cached.services,
						isConnected: this.connectionManager.isConnected(),
						isSubscribed: isSubscribed(client, PIPE_BUILDER_APP_ID),
						statuses: editorState.cachedStatuses,
						serverHost: this.connectionManager.getHttpUrl(),
						// The OAuth broker only allows https://*.rocketride.ai redirect URLs,
						// so tokens bounce off this hosted page, which forwards them to the
						// `<uriScheme>://rocketride.rocketride/auth/google` deep link.
						oauthReturnUrl: `https://api.rocketride.ai/auth/vscode/google?scheme=${vscode.env.uriScheme}`,
						envKeys,
					});
					webview.postMessage({ type: 'project:dirtyState', isDirty: document.isDirty, isNew: document.isUntitled });

					// Redeliver OAuth tokens that arrived while this document had no
					// live webview. Safe ordering: the webview clears its pending
					// tokens in the project:load handler above, so this arrives after.
					const oauthKey = document.uri.toString();
					const undelivered = this.undeliveredOAuthTokens.get(oauthKey);
					if (undelivered) {
						this.undeliveredOAuthTokens.delete(oauthKey);
						if (undelivered.expiresAt > Date.now()) {
							this.deliverOAuthTokens(oauthKey, undelivered.tokens, undelivered.state);
						}
					}

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
				case 'project:contentChanged': {
					if (data.project) {
						const content = typeof data.project === 'string' ? data.project : JSON.stringify(data.project);
						const { applied } = await this.applyDocumentEdit(document, content);
						// One-shot save after an OAuth token apply: tokens must reach
						// the .pipe on disk without requiring a manual save.
						if (editorState.saveAfterOAuthApply) {
							editorState.saveAfterOAuthApply = false;
							if (applied || document.isDirty) {
								await document.save();
							}
						}
					}
					break;
				}

				case 'project:validate': {
					this.logger.output(`${icons.pipeline} Validating pipeline...`);
					try {
						const client = this.connectionManager.getClient();
						if (!client) throw new Error('Not connected to server');
						const result = await client.validate({ pipeline: data.pipeline });
						this.logger.output(`${icons.success} Pipeline validation passed`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result });
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.output(`${icons.error} Pipeline validation failed: ${msg}`);
						webview.postMessage({ type: 'project:validateResponse', requestId: data.requestId, result: { errors: [], warnings: [] }, error: msg });
					}
					break;
				}

				case 'project:requestSave': {
					await document.save();
					break;
				}

				// Status messages
				case 'status:pipelineAction': {
					const action = data.action as 'run' | 'stop' | 'restart';
					const source = data.source as string | undefined;
					if (action === 'run' || action === 'restart') {
						// Gate: check connection before running
						const runClient = this.connectionManager.getClient();
						if (!runClient) {
							vscode.window.showErrorMessage('Not connected to server');
							break;
						}
						// Gate: check subscription before running
						const sub = isSubscribed(runClient, PIPE_BUILDER_APP_ID);
						if (!sub) {
							webview.postMessage({ type: 'checkout:required' });
							break;
						}
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

				// Missing env vars — webview detected ROCKETRIDE_* refs not in envKeys
				case 'status:missingEnvVars': {
					const keys = data.keys as string[];
					if (keys?.length) {
						await handleMissingEnvVars(keys);
					}
					break;
				}

				// Link opening
				case 'project:openLink': {
					if (data.url) {
						this.openLink(data.url as string, data.displayName as string | undefined, data.browser as boolean | undefined);
					}
					break;
				}

				// OAuth login: open the broker URL in the system browser (Google's
				// consent screen refuses to render in a webview iframe) and arm a
				// one-shot callback so the deep-link return delivers tokens back to
				// this panel via project:oauthTokens.
				case 'project:openExternal': {
					if (data.url) {
						// Webview-supplied URL: require a parseable https target
						// before arming any OAuth state (same spirit as openLink's
						// scheme allowlist; OAuth brokers are https-only).
						let parsedUrl: URL;
						try {
							parsedUrl = new URL(data.url as string);
						} catch {
							this.logger.error('[ProjectProvider] Blocked unparseable OAuth URL');
							break;
						}
						if (parsedUrl.protocol !== 'https:') {
							this.logger.error(`[ProjectProvider] Blocked OAuth URL scheme: ${parsedUrl.protocol}`);
							break;
						}
						// Key the waiter by the node that started the login so the
						// deep-link return routes to the right editor. The callback
						// resolves the live webview at delivery time — this webview
						// instance may be disposed during the browser round-trip.
						const nodeId = parsedUrl.searchParams.get('node_id') || (data.url as string);
						const docKey = document.uri.toString();
						const unregister = CloudAuthProvider.getInstance().setPendingGoogleOAuth(nodeId, (tokens, state) => {
							this.deliverOAuthTokens(docKey, tokens, state);
						});
						// Pass the raw string: Uri.parse re-encodes the query and un-escapes
						// %3B/%3A, and Zitadel's Go parser rejects raw semicolons in queries
						// (microsoft/vscode#85930). openExternal accepts a string at runtime.
						try {
							const opened = await vscode.env.openExternal(data.url as unknown as vscode.Uri);
							if (!opened) throw new Error('the system browser refused to open');
						} catch (error) {
							// A dead waiter would swallow a later unrelated deep link.
							unregister();
							this.logger.error(`[ProjectProvider] Failed to open OAuth URL: ${error}`);
							vscode.window.showErrorMessage('Could not open the browser for Google sign-in. Check your default browser and try again.');
						}
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

				// Checkout flow — bridge billing SDK calls for the CheckoutModal
				case 'checkout:fetchPlans': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						const plans = await billingClient.billing.getProductPrices(PIPE_BUILDER_APP_ID);
						webview.postMessage({ type: 'checkout:plansResult', plans, error: null });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						webview.postMessage({ type: 'checkout:plansResult', plans: [], error: msg });
					}
					break;
				}

				case 'checkout:createSession': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						const orgId = billingClient.getAccountInfo()?.organization?.id;
						if (!orgId) throw new Error('No organisation found');
						const result = await billingClient.billing.createCheckoutSession(orgId, PIPE_BUILDER_APP_ID, data.priceId as string);
						webview.postMessage({ type: 'checkout:sessionResult', ...result, error: null });
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						webview.postMessage({ type: 'checkout:sessionResult', clientSecret: '', subscriptionId: '', error: msg });
					}
					break;
				}

				case 'checkout:confirmPending': {
					try {
						const billingClient = this.connectionManager.getClient();
						if (!billingClient) throw new Error('Not connected');
						await (billingClient as any).dapRequest('rrext_account_billing', {
							subcommand: 'confirm_pending',
							appId: PIPE_BUILDER_APP_ID,
							subscriptionId: data.subscriptionId,
							priceId: data.priceId,
						});
						webview.postMessage({ type: 'checkout:confirmResult', error: null });
					} catch (err: unknown) {
						// Non-fatal — the webhook will still update the DB
						webview.postMessage({ type: 'checkout:confirmResult', error: null });
					}
					break;
				}

				// Deploy lifecycle — snapshot request from the DEPLOY page
				case 'deploy:fetch': {
					await this.sendDeployData(webview, editorState);
					break;
				}

				// Deploy lifecycle — publish the SAVED document as the next version
				case 'deploy:publish': {
					try {
						const deployClient = this.connectionManager.getClient();
						if (!deployClient) throw new Error('Not connected to server');
						// Publish snapshots the DOCUMENT, never webview state: the
						// immutable registry must hold exactly what is on disk, so a
						// dirty or never-saved document blocks the publish outright.
						if (document.isUntitled) throw new Error('Save the pipeline first');
						// Save-first: a dirty document is saved before the snapshot,
						// so the registry still holds exactly what is on disk.
						if (document.isDirty) {
							const saved = await document.save();
							if (!saved) throw new Error('Save failed — publish cancelled');
						}
						const pipeline = JSON.parse(document.getText()) as PipelineConfig;
						// The registry renders pipelineName on every deploy surface;
						// .pipe JSON rarely carries one (names live in FILENAMES), so
						// the snapshot takes the file's basename when the JSON has none.
						if (!pipeline.name) {
							pipeline.name =
								document.uri.path
									.split('/')
									.pop()
									?.replace(/\.pipe(?:\.json)?$/, '') || document.uri.path;
						}
						await deployClient.deploy.publish(pipeline, { ...(data.comment ? { comment: data.comment as string } : {}), ...(data.deployTo ? { deployTo: data.deployTo as string } : {}) });
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId });
						// Re-push the lifecycle so the strip/history show the new truth.
						await this.sendDeployData(webview, editorState);
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`[ProjectProvider] Publish failed: ${msg}`);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId, error: msg });
					}
					break;
				}

				// Deploy lifecycle — point a team at a version (promotion/rollback)
				case 'deploy:deploy': {
					try {
						const deployClient = this.connectionManager.getClient();
						if (!deployClient) throw new Error('Not connected to server');
						await deployClient.deploy.deploy((data.projectId as string) || editorState.projectId || '', data.version as number, data.teamId as string);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId });
						// Re-push the lifecycle so badges/where-live show the new truth.
						await this.sendDeployData(webview, editorState);
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						this.logger.error(`[ProjectProvider] Deploy failed: ${msg}`);
						webview.postMessage({ type: 'deploy:actionResult', requestId: data.requestId, error: msg });
					}
					break;
				}

				// Deploy lifecycle — open the file-less deployment tab for a team
				case 'deploy:openDeployment': {
					vscode.commands.executeCommand('rocketride.page.deployment.open', data.teamId as string, data.projectId as string, data.title as string);
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
				if (editorState.isReady) {
					webview.postMessage({ type: 'project:dirtyState', isDirty: e.document.isDirty, isNew: e.document.isUntitled });
				}
			}
		});

		// Listen for saves to clear dirty state in canvas
		const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument((savedDoc) => {
			if (savedDoc.uri.toString() === document.uri.toString() && editorState.isReady) {
				webview.postMessage({ type: 'project:dirtyState', isDirty: false, isNew: savedDoc.isUntitled });
			}
		});

		// Clean up when panel is disposed
		webviewPanel.onDidDispose(async () => {
			await this.stopMonitoring(webviewPanel);
			editorState.cachedStatuses = {};
			editorState.isDisposed = true;
			this.editorStates.delete(webviewPanel);
			changeDocumentSubscription.dispose();
			saveDocumentSubscription.dispose();
		});

		// Start monitoring immediately if connected
		if (this.connectionManager.isConnected()) {
			this.startMonitoring(webviewPanel).catch((error) => {
				this.logger.error(`Starting initial monitoring: ${error}`);
			});
		}
	}

	// =========================================================================
	// DEPLOY LIFECYCLE DATA
	// =========================================================================

	/**
	 * Fetches this project's deploy lifecycle (registry versions, team
	 * deployments, merged history, team roster) through the deploy API, maps
	 * everything into serialisable view models HOST-side (mirroring
	 * rocket-ui's ProjectProvider deploy closures + useDeployments), and pushes one
	 * deploy:data snapshot to the webview.
	 *
	 * A project that was never published has no registry — the snapshot
	 * degrades to empty arrays rather than an error state, so the DEPLOY
	 * page renders its empty strip.
	 *
	 * @param webview - The editor webview to push the snapshot to.
	 * @param editorState - The editor whose projectId scopes the fetch.
	 */
	private async sendDeployData(webview: vscode.Webview, editorState: EditorState): Promise<void> {
		const projectId = editorState.projectId;
		const client = this.connectionManager.getClient();

		// No identity or connection yet — the empty snapshot ends the webview's
		// loading state instead of leaving a spinner forever.
		if (!projectId || !client || !this.connectionManager.isConnected()) {
			webview.postMessage({ type: 'deploy:data', versions: [], deployments: [], history: [], teams: [] });
			return;
		}

		try {
			// Step 1: fetch the registry + deployments in parallel — versions and
			// history are project-scoped, list() carries every visible deployment
			// (also the team-roster fallback for rosterless identities).
			const [versions, history, list] = await Promise.all([client.deploy.versions(projectId), client.deploy.history(projectId), client.deploy.list()]);
			const deploymentRows = list.rows ?? [];

			// Step 2: resolve the caller's teams (names + control rights).
			const teams = resolveDeployTeams(client, deploymentRows);

			// Step 3: map everything into view models and push the snapshot.
			webview.postMessage({
				type: 'deploy:data',
				versions: mapVersionCards(versions.rows ?? []),
				deployments: mapTeamDeploymentRows(deploymentRows, projectId, teams),
				history: mapHistoryRows(history.rows ?? [], teams),
				teams,
			});
		} catch (error) {
			// A project that was never published has no registry — empty strip,
			// but keep the identity-derived team roster so Publish still offers
			// its one-step deploy targets.
			this.logger.error(`[ProjectProvider] Deploy lifecycle fetch failed: ${error}`);
			webview.postMessage({ type: 'deploy:data', versions: [], deployments: [], history: [], teams: resolveDeployTeams(client, []) });
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
			webview.postMessage({ type: 'project:update', project });
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
			this.logger.error('[ProjectProvider] Failed to apply document edit');
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
				this.logger.error(`[ProjectProvider] Missing projectId or componentId`);
				vscode.window.showErrorMessage('Invalid pipeline: missing project ID or component ID');
				return;
			}

			const token = await client.getTaskToken({ projectId, source: componentId });

			if (!token) {
				this.logger.error('[ProjectProvider] No token found for running task');
				vscode.window.showErrorMessage('No running task found to stop');
				return;
			}

			await client.terminate(token);
		} catch (error: unknown) {
			this.logger.error(`[ProjectProvider] Unable to stop pipeline: ${error}`);
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to stop pipeline: ${message}`);
		}
	}

	// =========================================================================
	// OPEN LINK
	// =========================================================================

	/**
	 * Opens a URL. With `browser`, opens it in the system browser via the VS Code
	 * shell (used by sandboxed CTAs like the Free/Enterprise plan links). Otherwise
	 * opens it in an embedded WebviewPanel with an iframe, bridging theme colors,
	 * env vars, clipboard, and drag-and-drop to the iframe.
	 */
	private openLink(url: string, displayName?: string, browser = false): void {
		if (browser) {
			// URL comes from a webview message; allowlist schemes before opening.
			const uri = vscode.Uri.parse(url);
			const scheme = uri.scheme.toLowerCase();
			if (!['https', 'http', 'mailto'].includes(scheme)) {
				this.logger.error(`[ProjectProvider] Blocked external URL scheme: ${scheme}`);
				return;
			}
			void vscode.env.openExternal(uri);
			return;
		}
		const panel = vscode.window.createWebviewPanel('externalContent', displayName || 'Pipeline', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

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
	const envVars = { devMode: true };
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
			if (event.data.type === 'view:ready') sendDataToIframe();
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
			} else if (msg?.type === 'requestFileDialog') {
				// The embedded app's "Browse" button can't open an OS file picker from
				// inside the sandboxed iframe, so it posts {type:'requestFileDialog'} up to
				// the bridge, which forwards it here. Open the native dialog on the host,
				// read the chosen files, and post them back as {type:'nativeFilesSelected'};
				// the bridge relays that into the iframe. Buffers go as number[] so they
				// survive webview message serialization.
				try {
					const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Select' });
					if (!uris || uris.length === 0) return;
					const files = await Promise.all(
						uris.map(async (uri) => ({
							name: uri.path.split('/').pop() || 'file',
							type: '',
							lastModified: Date.now(),
							buffer: Array.from(await vscode.workspace.fs.readFile(uri)),
						}))
					);
					panel.webview.postMessage({ type: 'nativeFilesSelected', files });
				} catch (error) {
					this.logger.error(`[ProjectProvider] Native file dialog failed: ${error}`);
				}
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

			// Inject CSP meta tag allowing Stripe Elements (js.stripe.com for scripts/frames,
			// api.stripe.com for network calls). Required for the in-editor checkout flow.
			const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://js.stripe.com; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} data:; frame-src https://js.stripe.com; connect-src ${webview.cspSource} https://api.stripe.com; img-src ${webview.cspSource} data:;">`;
			htmlContent = htmlContent.replace('<head>', `<head>\n\t${cspMeta}`);

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
