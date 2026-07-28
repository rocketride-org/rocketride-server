// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploymentProvider — Webview panel for one team's deployment of a project.
 *
 * The file-less deployment tab (teams-as-environments, mockup v5 screen A):
 * everything is fetched from the registry through the deploy API — the
 * deployment record, the immutable artifact (readonly DESIGN render), the
 * team's history, and the registry versions — mapped host-side into view
 * models, and pushed to the page-deployment webview which renders shared-ui's
 * DeploymentView. One panel per `${teamId}:${projectId}`, modeled on
 * StatusProvider.
 *
 * Polls every 10 seconds while the panel is visible (schedule dispatches,
 * state flips, and history growth appear without a reopen — poll-based until
 * push events land) and re-fetches after every mutation so the header/state
 * chips always reflect the server's truth.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { getLogger } from '../shared/util/output';
import { resolveDeployTeams, teamNameOf, mapVersionCards, mapHistoryRows, mapDeploymentInfo, mapScheduleRows } from '../shared/util/deployMapping';
import type { RocketRideClient } from 'rocketride';
import type { DeploymentLoadPayload, DeploymentWebviewToHost } from './views/deployTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Refresh cadence for a visible deployment panel (ms). */
const POLL_INTERVAL_MS = 10_000;

// =============================================================================
// TYPES
// =============================================================================

/** Per-panel bookkeeping for one open deployment tab. */
interface DeploymentPanelState {
	panel: vscode.WebviewPanel;
	teamId: string;
	projectId: string;
	/** True after the webview posted view:ready (safe to push data). */
	isReady: boolean;
	/** The visible-only refresh timer. */
	timer: ReturnType<typeof setInterval>;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class DeploymentProvider {
	/** Open panels keyed by `${teamId}:${projectId}`. */
	private panels = new Map<string, DeploymentPanelState>();
	private disposables: vscode.Disposable[] = [];
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();

	/**
	 * Creates the provider and subscribes to connection state changes so
	 * every open panel tracks connect/disconnect live.
	 *
	 * @param context - The VS Code extension context (URIs, subscriptions).
	 */
	constructor(private readonly context: vscode.ExtensionContext) {
		this.setupEventListeners();
	}

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/**
	 * Shows (or creates) the deployment tab for one team + project.
	 *
	 * @param teamId - The owning team (the environment).
	 * @param projectId - The deployed project.
	 * @param title - Optional initial tab title; refined to
	 *   `${teamName} / ${pipelineName}` after the first fetch.
	 */
	public async show(teamId: string, projectId: string, title?: string): Promise<void> {
		const key = `${teamId}:${projectId}`;

		// Step 1: reveal the existing panel if this deployment is already open.
		const existing = this.panels.get(key);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Step 2: create the panel backed by the page-deployment webview bundle.
		const panel = vscode.window.createWebviewPanel('rocketride.pageDeployment', title || projectId, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Step 3: register the panel state with its visible-only poll timer.
		const state: DeploymentPanelState = {
			panel,
			teamId,
			projectId,
			isReady: false,
			timer: setInterval(() => {
				// Poll only while visible — a background tab refreshes on reveal.
				if (state.isReady && panel.visible) {
					this.fetchAndPush(state).catch((err) => {
						this.logger.error(`[DeploymentProvider] Poll refresh failed: ${err}`);
					});
				}
			}, POLL_INTERVAL_MS),
		};
		this.panels.set(key, state);

		// Step 4: bridge webview messages to the deploy API.
		panel.webview.onDidReceiveMessage(async (message: DeploymentWebviewToHost) => {
			try {
				await this.handleWebviewMessage(state, message);
			} catch (error) {
				this.logger.error(`[DeploymentProvider] Message handling error: ${error}`);
			}
		});

		// Step 5: an off-screen panel skipped its polls — refresh on reveal.
		const viewStateSub = panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.visible && state.isReady) {
				this.fetchAndPush(state).catch((err) => {
					this.logger.error(`[DeploymentProvider] Reveal refresh failed: ${err}`);
				});
			}
		});

		// Step 6: clean up on dispose.
		panel.onDidDispose(() => {
			clearInterval(state.timer);
			viewStateSub.dispose();
			this.panels.delete(key);
		});
	}

	// =========================================================================
	// MESSAGE HANDLING
	// =========================================================================

	/**
	 * Dispatches one incoming webview message. Mutations run through the
	 * deploy API, ack with deployment:actionResult (the webview's pending
	 * promise), then re-fetch so the panel reflects the server's truth.
	 *
	 * @param state - The panel's bookkeeping entry.
	 * @param message - The incoming typed message.
	 */
	private async handleWebviewMessage(state: DeploymentPanelState, message: DeploymentWebviewToHost): Promise<void> {
		const { teamId, projectId } = state;

		switch (message.type) {
			// -- Lifecycle --------------------------------------------------------
			case 'view:ready': {
				state.isReady = true;
				await this.fetchAndPush(state);
				break;
			}

			// -- Pause / resume ---------------------------------------------------
			case 'deployment:setPaused': {
				await this.runAction(state, message.requestId, async (client) => {
					if (message.paused) await client.deploy.pause(projectId, teamId);
					else await client.deploy.resume(projectId, teamId);
				});
				break;
			}

			// -- Pointer move (Deploy version… / Rollback alike) ------------------
			case 'deployment:deployVersion': {
				await this.runAction(state, message.requestId, async (client) => {
					await client.deploy.deploy(projectId, message.version, teamId);
				});
				break;
			}

			// -- Soft remove (closes the panel on success) ------------------------
			case 'deployment:remove': {
				const removed = await this.runAction(state, message.requestId, async (client) => {
					await client.deploy.remove(projectId, teamId);
				});
				// The deployment left every listing — close its tab rather than
				// leaving a view of something that no longer exists.
				if (removed) state.panel.dispose();
				break;
			}

			// -- Manual source dispatch (the smoke-test path) ---------------------
			case 'deployment:runSource': {
				await this.runAction(state, message.requestId, async (client) => {
					await client.deploy.run(projectId, message.sourceId, teamId);
				});
				break;
			}

			// -- Stop one source's live run ---------------------------------------
			case 'deployment:stopSource': {
				await this.runAction(state, message.requestId, async (client) => {
					// Existing task machinery: resolve the live task, terminate it —
					// permissions resolve against the task's TEAM server-side.
					const token = await client.getTaskToken({ projectId, source: message.sourceId });
					if (token) await client.terminate(token);
				});
				break;
			}

			// -- Set / clear a source schedule ------------------------------------
			case 'deployment:setSchedule': {
				await this.runAction(state, message.requestId, async (client) => {
					await client.deploy.setSchedule(projectId, message.sourceId, message.cron, teamId, { enabled: message.enabled, ...(message.ttl !== null && message.ttl !== undefined ? { ttl: message.ttl } : {}) });
				});
				break;
			}

			// -- Cron preview (THE single evaluator; no re-fetch needed) ----------
			case 'deployment:preview': {
				try {
					const client = this.requireClient();
					const result = await client.deploy.preview(message.cron, message.count);
					await state.panel.webview.postMessage({ type: 'deployment:previewResult', requestId: message.requestId, result });
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					await state.panel.webview.postMessage({ type: 'deployment:previewResult', requestId: message.requestId, result: {}, error: msg });
				}
				break;
			}

			// -- Validation passthrough (readonly canvas still validates) ---------
			case 'deployment:validate': {
				let result: { errors: unknown[]; warnings: unknown[] } = { errors: [], warnings: [] };
				try {
					const client = this.requireClient();
					result = await client.validate({ pipeline: message.pipeline as Record<string, unknown> });
				} catch {
					// A validation transport failure renders as a clean canvas —
					// same fallback the rocket-ui host uses.
				}
				await state.panel.webview.postMessage({ type: 'deployment:validateResult', requestId: message.requestId, result });
				break;
			}
		}
	}

	/**
	 * Runs one mutation with shared ack + re-fetch handling.
	 *
	 * @param state - The panel's bookkeeping entry.
	 * @param requestId - Correlation id for the deployment:actionResult ack.
	 * @param action - The deploy API call to run.
	 * @returns True when the action succeeded.
	 */
	private async runAction(state: DeploymentPanelState, requestId: number, action: (client: RocketRideClient) => Promise<void>): Promise<boolean> {
		try {
			// Step 1: run the mutation against the dev connection's client.
			const client = this.requireClient();
			await action(client);

			// Step 2: ack the webview's pending promise, then re-push fresh state.
			await state.panel.webview.postMessage({ type: 'deployment:actionResult', requestId });
			await this.fetchAndPush(state);
			return true;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			await state.panel.webview.postMessage({ type: 'deployment:actionResult', requestId, error: msg });
			return false;
		}
	}

	/**
	 * The connected SDK client, or throws the standard not-connected error.
	 *
	 * @returns The dev connection's client.
	 */
	private requireClient(): RocketRideClient {
		const client = this.connectionManager.getClient();
		if (!client || !this.connectionManager.isConnected()) throw new Error('Not connected to server');
		return client;
	}

	// =========================================================================
	// DATA FETCH
	// =========================================================================

	/**
	 * Fetches the full deployment state and pushes deployment:load, mirroring
	 * rocket-ui's DeploymentPage.fetchAll: get → artifact → history(teamId) →
	 * versions → preview of the first armed schedule → running-source scan.
	 *
	 * @param state - The panel to fetch for and push to.
	 */
	private async fetchAndPush(state: DeploymentPanelState): Promise<void> {
		const { teamId, projectId, panel } = state;
		try {
			const client = this.requireClient();

			// Step 1: the deployment record (version pointer, state, schedules).
			const dep = await client.deploy.get(projectId, teamId);

			// Step 2: the immutable artifact this team runs (readonly DESIGN).
			const pipeline = typeof dep.version === 'number' ? ((await client.deploy.artifact(projectId, dep.version)) as unknown as Record<string, unknown>) : {};

			// Step 3: this team's audit trail + the registry version pickers.
			const [history, versions] = await Promise.all([client.deploy.history(projectId, { teamId }), client.deploy.versions(projectId)]);

			// Step 4: next occurrence — preview the first ENABLED schedule through
			// THE single evaluator (never parse cron client-side).
			let nextRun: DeploymentLoadPayload['nextRun'];
			const armed = Object.entries(dep.schedules ?? {}).find(([, sched]) => sched.cron && sched.enabled !== false);
			if (armed && dep.state === 'active') {
				const preview = await client.deploy.preview(armed[1].cron as string, 1);
				const firstAt = preview.valid ? preview.next?.[0] : undefined;
				if (typeof firstAt === 'number') nextRun = { at: firstAt, sourceId: armed[0], cron: armed[1].cron as string };
			}

			// Step 5: which sources have a LIVE run right now — server task
			// registry, attributed to THIS team via the descriptor's teamId.
			const tasks = (await client.call('rrext_get_tasks')) as { tasks?: Array<{ source?: string; teamId?: string; pipeline?: { project_id?: string } }> };
			const runningSources: Record<string, boolean> = {};
			for (const t of tasks.tasks ?? []) {
				if (t.teamId === teamId && t.pipeline?.project_id === projectId && t.source) runningSources[t.source] = true;
			}

			// Step 6: resolve teams (names + control) from the identity and map
			// everything into the serialisable view models.
			const teams = resolveDeployTeams(client, [dep]);
			const teamName = teamNameOf(teams, teamId);
			const info = mapDeploymentInfo(dep, projectId);
			const payload: DeploymentLoadPayload = {
				teamName,
				deployment: info,
				pipeline,
				servicesJson: (this.connectionManager.getCachedServices()?.services ?? {}) as Record<string, unknown>,
				schedules: mapScheduleRows(pipeline, dep),
				history: mapHistoryRows(history.rows ?? [], teams),
				versions: mapVersionCards(versions.rows ?? []),
				...(nextRun ? { nextRun } : {}),
				runningSources,
				canControl: teams.find((t) => t.id === teamId)?.canControl ?? false,
				isConnected: this.connectionManager.isConnected(),
			};

			// Step 7: title the tab from the resolved names and push the state.
			panel.title = `${teamName} / ${info.pipelineName}`;
			await panel.webview.postMessage({ type: 'deployment:load', ...payload });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.error(`[DeploymentProvider] Failed to load deployment ${teamId}:${projectId}: ${msg}`);
			await panel.webview.postMessage({ type: 'deployment:error', error: msg });
		}
	}

	// =========================================================================
	// EVENT FORWARDING
	// =========================================================================

	/** Forwards connection state changes to every open panel (+ refresh on connect). */
	private setupEventListeners(): void {
		const connChange = this.connectionManager.on('shell:statusChange', () => {
			const isConnected = this.connectionManager.isConnected();
			for (const state of this.panels.values()) {
				state.panel.webview.postMessage({ type: 'shell:connectionChange', isConnected }).then(undefined, (err: unknown) => {
					this.logger.error(`[DeploymentProvider] Failed to post connection change: ${err}`);
				});
				// A reconnect invalidates everything shown — reload from the server.
				if (isConnected && state.isReady) {
					this.fetchAndPush(state).catch((err) => {
						this.logger.error(`[DeploymentProvider] Reconnect refresh failed: ${err}`);
					});
				}
			}
		});
		this.disposables.push(connChange);
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/**
	 * Loads the Rsbuild-generated page-deployment.html, injects the CSP nonce,
	 * and rewrites static resource URIs to webview-safe URIs.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @returns The HTML string to assign to `webview.html`.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-deployment.html');

		try {
			// Step 1: read the generated template and stamp nonce + CSP source.
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

			// Step 2: rewrite static asset paths into webview URIs.
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			this.logger.error(`[DeploymentProvider] Error loading deployment HTML: ${error}`);
			return `<html><body><p>Error loading deployment view: ${error}</p></body></html>`;
		}
	}

	/**
	 * Generates a 32-character random nonce for the Content Security Policy.
	 *
	 * @returns The nonce string.
	 */
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

	/** Disposes all panels (their onDidDispose handlers clear the timers). */
	public dispose(): void {
		for (const state of this.panels.values()) {
			state.panel.dispose();
		}
		this.panels.clear();
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
