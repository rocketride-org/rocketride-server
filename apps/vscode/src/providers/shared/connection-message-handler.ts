// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionMessageHandler — shared message routing for connection-related
 * webview messages (cloud auth, engine versions, test connection, docker/service
 * lifecycle).
 *
 * Used by both PageSettingsProvider and PageWelcomeProvider so connection
 * management code is never duplicated.
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { ConfigManager } from '../../config';
import { getConnectionManager } from '../../extension';
import { EngineInstaller } from '../../connection/engine-installer';
import { connectionModeRequiresApiKey } from '../../shared/util/connectionModeAuth';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
import { DeployManager } from '../../connection/deploy-manager';
import { EngineOperations, EngineOperationsCallbacks } from '../../deploy/engine-operations';

// =============================================================================
// TYPES
// =============================================================================

export interface ConnectionMessageHandlerOptions {
	extensionFsPath: string;
	getActiveWebviews: () => Iterable<vscode.Webview>;
}

// =============================================================================
// HANDLER
// =============================================================================

export class ConnectionMessageHandler {
	private readonly configManager: ConfigManager;
	private readonly engineInstaller: EngineInstaller;
	readonly engineOps: EngineOperations;
	private pendingSudoPassword: ((pw: string) => void) | null = null;
	private cloudAuthCleanups: Array<() => void> = [];
	private cachedServerInfo: { version: string; capabilities: string[]; platform?: string } | null = null;

	constructor(private readonly opts: ConnectionMessageHandlerOptions) {
		this.configManager = ConfigManager.getInstance();
		this.engineInstaller = new EngineInstaller(opts.extensionFsPath);

		const callbacks: EngineOperationsCallbacks = {
			postMessage: (msg) => {
				for (const w of opts.getActiveWebviews()) {
					w.postMessage(msg);
				}
			},
			requestSudoPassword: () =>
				new Promise((resolve) => {
					this.pendingSudoPassword = resolve;
					for (const w of opts.getActiveWebviews()) {
						w.postMessage({ type: 'serviceNeedsSudo' });
					}
				}),
		};

		this.engineOps = new EngineOperations(callbacks);
	}

	/**
	 * Handle a message from the webview. Returns true if handled.
	 */
	public async handleMessage(message: { type: string; [key: string]: unknown }, webview: vscode.Webview): Promise<boolean> {
		switch (message.type) {
			case 'cloud:signIn': {
				const cloudAuth = CloudAuthProvider.getInstance();
				await cloudAuth.signIn(process.env.RR_ZITADEL_URL || '', process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '');
				return true;
			}

			case 'cloud:signOut': {
				const cloudAuth = CloudAuthProvider.getInstance();
				await cloudAuth.signOut();
				await this.sendCloudStatus(webview);
				return true;
			}

			case 'cloud:getStatus':
				await this.sendCloudStatus(webview);
				return true;

			case 'fetchTeams':
				await this.fetchCloudTeams(webview);
				return true;

			case 'fetchEngineVersions':
				await this.fetchEngineVersions(webview);
				return true;

			case 'testConnection':
				await this.testConnection(message.settings as Record<string, unknown>, webview);
				return true;

			case 'sudoPassword':
				if (this.pendingSudoPassword) {
					this.pendingSudoPassword(message.password as string);
					this.pendingSudoPassword = null;
				}
				return true;

			default: {
				// Route Docker/Service operation messages to EngineOperations
				const msgType = message.type as string;
				if (msgType.startsWith('docker') || msgType.startsWith('service')) {
					return this.engineOps.handleMessage(message);
				}
				return false;
			}
		}
	}

	/**
	 * Register a cloud auth change listener for a webview.
	 * Returns a cleanup function to call on dispose.
	 */
	public registerCloudAuthListener(webview: vscode.Webview): () => void {
		const cloudAuth = CloudAuthProvider.getInstance();
		const handler = () => this.sendCloudStatus(webview);
		cloudAuth.onDidChange.on('changed', handler);
		const cleanup = () => cloudAuth.onDidChange.removeListener('changed', handler);
		this.cloudAuthCleanups.push(cleanup);
		return cleanup;
	}

	/**
	 * Start Docker/Service status polling and send initial status.
	 */
	public async startStatusPolling(): Promise<void> {
		await this.engineOps.sendDockerStatus();
		await this.engineOps.sendServiceStatus();
		this.engineOps.startStatusPolling();
	}

	/**
	 * Stop Docker/Service status polling.
	 */
	public stopStatusPolling(): void {
		this.engineOps.stopStatusPolling();
	}

	// =========================================================================
	// SERVER INFO PROBE
	// =========================================================================

	/**
	 * Probe the server at ROCKETRIDE_URI for capabilities.
	 * Caches the result so subsequent calls are instant.
	 * Sends the result to the webview as `{ type: 'serverInfo', ... }`.
	 */
	public async probeServerInfo(webview: vscode.Webview): Promise<void> {
		if (this.cachedServerInfo) {
			webview.postMessage({ type: 'serverInfo', ...this.cachedServerInfo });
			return;
		}

		const uri = process.env.ROCKETRIDE_URI || '';
		if (!uri) return;

		try {
			const info = await RocketRideClient.getServerInfo(uri, 5000);
			this.cachedServerInfo = info;
			webview.postMessage({ type: 'serverInfo', ...info });
		} catch (error) {
			console.error('[ConnectionMessageHandler] Server info probe failed:', error);
			// Fall back to showing all modes if probe fails
			webview.postMessage({ type: 'serverInfo', capabilities: [], version: '' });
		}
	}

	// =========================================================================
	// CLOUD AUTH
	// =========================================================================

	public async sendCloudStatus(webview: vscode.Webview): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		const signedIn = await cloudAuth.isSignedIn();
		const userName = await cloudAuth.getUserName();
		webview.postMessage({ type: 'cloud:status', signedIn, userName });
		await this.fetchCloudTeams(webview);
	}

	public async fetchCloudTeams(webview: vscode.Webview): Promise<void> {
		const devAccount = getConnectionManager()?.getClient()?.getAccountInfo();
		const devTeams = this.extractTeams(devAccount);
		if (devTeams.length) {
			webview.postMessage({ type: 'teamsLoaded', teams: devTeams });
			return;
		}

		const deployAccount = DeployManager.getDeployInstance().getClient()?.getAccountInfo();
		const deployTeams = this.extractTeams(deployAccount);
		if (deployTeams.length) {
			webview.postMessage({ type: 'teamsLoaded', teams: deployTeams });
			return;
		}

		await this.fetchTeamsViaTempConnection(webview);
	}

	private async fetchTeamsViaTempConnection(webview: vscode.Webview): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		const signedIn = await cloudAuth.isSignedIn();
		if (!signedIn) return;

		let client: RocketRideClient | undefined;
		try {
			const token = await cloudAuth.getToken();
			if (!token) return;

			const cloudUri = process.env.ROCKETRIDE_URI || '';
			client = new RocketRideClient({ module: 'CONN-CFG', requestTimeout: 8000 });
			await client.connect(token, { uri: cloudUri, timeout: 10000 });

			const teams = this.extractTeams(client.getAccountInfo());
			if (teams.length) {
				webview.postMessage({ type: 'teamsLoaded', teams });
			}
		} catch (error) {
			console.log('[ConnectionMessageHandler] Could not fetch cloud teams:', error);
		} finally {
			if (client) client.disconnect().catch(() => {});
		}
	}

	private extractTeams(account: ReturnType<RocketRideClient['getAccountInfo']>): Array<{ id: string; name: string }> {
		if (!account?.organizations?.length) return [];
		return account.organizations.flatMap((org) => (org.teams ?? []).map((t) => ({ id: t.id, name: t.name })));
	}

	// =========================================================================
	// ENGINE VERSIONS
	// =========================================================================

	public async fetchEngineVersions(webview: vscode.Webview): Promise<void> {
		try {
			let githubToken: string | undefined;
			try {
				const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
				githubToken = session?.accessToken;
			} catch {
				/* proceed without token */
			}

			const versions = await this.engineInstaller.getReleases(undefined, githubToken);
			webview.postMessage({ type: 'engineVersionsLoaded', versions });
		} catch (error) {
			console.error('[ConnectionMessageHandler] Failed to fetch engine versions:', error);
			webview.postMessage({ type: 'engineVersionsLoaded', versions: [] });
		}
	}

	// =========================================================================
	// TEST CONNECTION
	// =========================================================================

	public async testConnection(formSettings: Record<string, unknown>, webview: vscode.Webview, messageContext?: 'development'): Promise<void> {
		let testClient: RocketRideClient | undefined;

		try {
			this.showMessage(webview, 'info', 'Testing connection...', messageContext);

			const connectionMode = (formSettings.connectionMode as string) || 'cloud';
			let hostUrl = (formSettings.hostUrl as string)?.trim() || '';
			if (connectionMode === 'cloud' && !hostUrl) hostUrl = process.env.ROCKETRIDE_URI || '';
			if (connectionMode === 'local' && !hostUrl) hostUrl = 'http://localhost:5565';

			hostUrl = RocketRideClient.normalizeUri(hostUrl);

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(hostUrl);
			} catch {
				this.showMessage(webview, 'error', 'Invalid URL format. Please enter a valid URL or port.', messageContext);
				return;
			}

			const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : parsedUrl.protocol === 'https:' ? 443 : 80;
			if (port < 1 || port > 65535) {
				this.showMessage(webview, 'error', `Invalid port number: ${port}. Port must be between 1 and 65535.`, messageContext);
				return;
			}

			const needsApiKey = connectionModeRequiresApiKey(connectionMode);
			let apiKey = 'MYAPIKEY';
			if (needsApiKey) {
				apiKey = typeof formSettings.apiKey === 'string' ? formSettings.apiKey.trim() : '';
				if (!apiKey) {
					const config = this.configManager.getConfig();
					apiKey = config.apiKey;
				}
				if (!apiKey) {
					this.showMessage(webview, 'error', 'API key is required. Please enter your API key first.', messageContext);
					return;
				}
			}

			testClient = new RocketRideClient({ auth: apiKey, uri: hostUrl, module: 'CONN-TST', requestTimeout: 5000 });

			try {
				await testClient.connect(undefined, { timeout: 8000 });
			} catch (connectError) {
				if (testClient) await testClient.disconnect();
				const errorMessage = connectError instanceof Error ? connectError.message : String(connectError);
				if (errorMessage.includes('ECONNREFUSED')) {
					this.showMessage(webview, 'error', `Connection refused. Server is not running at ${parsedUrl.host}.`, messageContext);
				} else if (errorMessage.includes('ENOTFOUND')) {
					this.showMessage(webview, 'error', `Server not found at ${parsedUrl.hostname}. Please check the URL.`, messageContext);
				} else if (errorMessage.includes('timeout')) {
					this.showMessage(webview, 'error', `Connection timed out. Server at ${parsedUrl.host} is not responding.`, messageContext);
				} else {
					this.showMessage(webview, 'error', `Failed to connect: ${errorMessage}`, messageContext);
				}
				return;
			}

			try {
				await testClient.ping();
			} catch (pingError) {
				await testClient.disconnect();
				const errorMessage = pingError instanceof Error ? pingError.message : String(pingError);
				this.showMessage(webview, 'error', `Server connected but failed to respond: ${errorMessage}`, messageContext);
				return;
			}

			await testClient.disconnect();
			this.showMessage(webview, 'success', `Connection successful! ${parsedUrl.host} is responding correctly.`, messageContext);
		} catch (error) {
			if (testClient) testClient.disconnect().catch(() => {});
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.showMessage(webview, 'error', `Connection test failed: ${errorMessage}`, messageContext);
		}
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	private showMessage(webview: vscode.Webview, level: string, message: string, context?: 'development'): void {
		webview.postMessage({
			type: 'showMessage',
			level,
			message,
			...(context && { context }),
		});
	}

	public dispose(): void {
		this.engineOps.dispose();
		for (const cleanup of this.cloudAuthCleanups) {
			cleanup();
		}
		this.cloudAuthCleanups = [];
	}
}
