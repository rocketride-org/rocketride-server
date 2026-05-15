// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionMessageHandler — shared message routing for connection-related
 * webview messages (cloud auth, engine versions, test connection, docker/service
 * lifecycle).
 *
 * Used by both SettingsProvider and WelcomeProvider so connection
 * management code is never duplicated.
 */

import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { EngineInstaller } from '../../connection/engine-installer';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
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
	private readonly engineInstaller: EngineInstaller;
	readonly engineOps: EngineOperations;
	private pendingSudoPassword: ((pw: string) => void) | null = null;
	private cloudAuthCleanups: Array<() => void> = [];
	private cachedServerInfo: { version: string; capabilities: string[]; platform?: string } | null = null;

	constructor(private readonly opts: ConnectionMessageHandlerOptions) {
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
				await this.fetchCloudTeams(webview, message.hostUrl as string);
				return true;

			case 'fetchEngineVersions':
				await this.fetchEngineVersions(webview);
				return true;

			case 'testConnection':
				await this.testConnection(message.hostUrl as string, message.apiKey as string, webview);
				return true;

			case 'probeServerInfo':
				this.cachedServerInfo = null; // force re-probe
				await this.probeServerInfo(webview, message.hostUrl as string);
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
	 * Probe the server for capabilities.
	 * Uses the dev connection manager's URL when connected (actual running
	 * server, which may be on a dynamic port). Falls back to the build-time
	 * ROCKETRIDE_URI for pre-connection probing.
	 * Caches the result so subsequent calls are instant.
	 */
	public async probeServerInfo(webview: vscode.Webview, hostUrl: string): Promise<void> {
		if (this.cachedServerInfo) {
			webview.postMessage({ type: 'serverInfo', ...this.cachedServerInfo });
			return;
		}

		const uri = hostUrl;
		if (!uri) return;

		console.log(`[ConnectionMessageHandler] probeServerInfo: uri=${uri}`);

		try {
			const info = await RocketRideClient.getServerInfo(uri, 5000);
			console.log(`[ConnectionMessageHandler] probeServerInfo result: capabilities=${JSON.stringify(info.capabilities)}, version=${info.version}`);
			this.cachedServerInfo = info;
			webview.postMessage({ type: 'serverInfo', ...info });
		} catch (error) {
			console.log(`[ConnectionMessageHandler] probeServerInfo FAILED: ${error}`);
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
	}

	/**
	 * Fetch cloud teams by connecting to the given cloud URL with the
	 * stored cloud auth token. The URL comes from the webview (build-time
	 * ROCKETRIDE_URI injected into the CloudPanel).
	 */
	public async fetchCloudTeams(webview: vscode.Webview, hostUrl: string): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		const token = await cloudAuth.getToken();
		if (!token) return;

		const uri = hostUrl;
		if (!uri) return;

		console.log(`[ConnectionMessageHandler] fetchCloudTeams: uri=${uri}`);

		let client: RocketRideClient | undefined;
		try {
			client = new RocketRideClient({ module: 'CONN-CFG', requestTimeout: 8000 });
			await client.connect(token, { uri, timeout: 10000 });

			const teams = this.extractTeams(client.getAccountInfo());
			console.log(`[ConnectionMessageHandler] fetchCloudTeams: ${teams.length} teams found`);
			webview.postMessage({ type: 'teamsLoaded', teams });
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

	public async testConnection(hostUrl: string, apiKey: string, webview: vscode.Webview, messageContext?: 'development'): Promise<void> {
		let testClient: RocketRideClient | undefined;

		try {
			this.showMessage(webview, 'info', 'Testing connection...', messageContext);

			hostUrl = (hostUrl || '').trim();
			if (!hostUrl) {
				this.showMessage(webview, 'error', 'Host URL is required.', messageContext);
				return;
			}

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

			apiKey = (apiKey || '').trim();
			if (!apiKey) {
				this.showMessage(webview, 'error', 'API key is required.', messageContext);
				return;
			}

			testClient = new RocketRideClient({ uri: hostUrl, module: 'CONN-TST', requestTimeout: 5000 });

			try {
				await testClient.connect(apiKey as string, { timeout: 8000 });
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
