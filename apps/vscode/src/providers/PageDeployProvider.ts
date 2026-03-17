// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy Page Provider
 *
 * Provides a webview panel for the Deploy page: deploy to RocketRide.ai cloud,
 * pull Docker images, or install as a local OS service.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createServiceManager, ServiceManager } from '../deploy/service-manager';
import { DockerManager } from '../deploy/docker-manager';
import { EngineInstaller } from '../connection/engine-installer';
import { ConfigManager } from '../config';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export class PageDeployProvider {
	private webviewPanel?: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private serviceManager: ServiceManager;
	private dockerManager: DockerManager;
	private logger = getLogger();
	private statusPollInterval?: NodeJS.Timeout;
	private ghcrTags: string[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.serviceManager = createServiceManager();
		this.dockerManager = new DockerManager();
		this.registerCommands();
	}

	private registerCommands(): void {
		const commands = [
			vscode.commands.registerCommand('rocketride.page.deploy.open', async () => {
				await this.show();
			}),
			vscode.commands.registerCommand('rocketride.page.deploy.close', () => {
				this.close();
			})
		];
		commands.forEach(c => this.context.subscriptions.push(c));
	}

	public async show(): Promise<void> {
		if (this.webviewPanel) {
			this.webviewPanel.reveal(vscode.ViewColumn.One);
			return;
		}

		this.webviewPanel = vscode.window.createWebviewPanel(
			'rocketrideDeploy',
			'Deploy',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
					vscode.Uri.file(path.join(this.context.extensionPath, 'webview')),
					this.context.extensionUri
				]
			}
		);

		this.webviewPanel.webview.html = this.getHtmlForWebview(this.webviewPanel.webview);

		this.webviewPanel.webview.onDidReceiveMessage(
			async (message: { type: string; [key: string]: unknown }) => {
				try {
					switch (message.type) {
						case 'ready':
							await this.sendInit();
							await this.sendServiceStatus();
							await this.sendDockerStatus();
							this.startStatusPolling();
							break;
						case 'copyToClipboard':
							if (typeof message.text === 'string') {
								await vscode.env.clipboard.writeText(message.text);
								vscode.window.showInformationMessage('Copied to clipboard.');
							}
							break;
						case 'fetchVersions':
							await this.fetchVersions();
							break;
						// Service operations
						case 'serviceInstall':
							await this.serviceInstall(message.version as string);
							break;
						case 'serviceRemove':
							await this.serviceRemove();
							break;
						case 'serviceUpdate':
							await this.serviceUpdate(message.version as string);
							break;
						case 'serviceStart':
							await this.serviceStart();
							break;
						case 'serviceStop':
							await this.serviceStop();
							break;
						// Docker operations
						case 'dockerInstall':
							await this.dockerInstall(message.version as string);
							break;
						case 'dockerRemove':
							await this.dockerRemove();
							break;
						case 'dockerUpdate':
							await this.dockerUpdate(message.version as string);
							break;
						case 'dockerStart':
							await this.dockerStart();
							break;
						case 'dockerStop':
							await this.dockerStop();
							break;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.output(`${icons.error} Deploy action failed: ${msg}`);
					// Route error to the correct panel based on message type
					const errorType = (message.type as string).startsWith('docker') ? 'dockerError' : 'serviceError';
					this.postMessage({ type: errorType, message: msg });
				}
			},
			undefined,
			this.disposables
		);

		this.webviewPanel.onDidDispose(
			() => {
				this.stopStatusPolling();
				this.webviewPanel = undefined;
			},
			null,
			this.disposables
		);
	}

	// =========================================================================
	// Service operations
	// =========================================================================

	private getInstaller(): EngineInstaller {
		return new EngineInstaller(this.serviceManager.getInstallPath());
	}

	private async serviceInstall(versionSpec: string): Promise<void> {
		const githubToken = await this.getGithubToken();
		const installer = this.getInstaller();

		// Step 1: Download engine
		const progress = {
			report: (value: { message?: string }) => {
				if (value.message) this.postMessage({ type: 'serviceProgress', message: value.message });
			}
		};
		const executablePath = await installer.install(versionSpec, progress, undefined, githubToken);
		const engineDir = path.dirname(executablePath);

		// Step 2: Register and start the service
		this.postMessage({ type: 'serviceProgress', message: 'Registering service...' });
		await this.serviceManager.install(executablePath, engineDir);

		// Step 3: Write config with version info
		const channel = versionSpec === 'prerelease' ? 'pre' as const : 'stable' as const;
		this.writeServiceConfig({
			versionSpec,
			version: installer.getInstalledVersion(channel) ?? versionSpec,
			publishedAt: installer.getInstalledPublishedAt(channel) ?? '',
		});

		// Step 4: Wait for service to be fully running
		await this.waitForServiceRunning();
		this.postMessage({ type: 'serviceComplete' });
	}

	private async serviceRemove(): Promise<void> {
		this.postMessage({ type: 'serviceProgress', message: 'Removing service...' });
		await this.serviceManager.remove();
		await this.sendServiceStatus();
		this.postMessage({ type: 'serviceComplete' });
	}

	private async serviceUpdate(versionSpec: string): Promise<void> {
		const githubToken = await this.getGithubToken();
		const installer = this.getInstaller();

		// Step 1: Check if there's actually a new version to install
		this.postMessage({ type: 'serviceProgress', message: 'Checking for updates...' });
		const progress = {
			report: (value: { message?: string }) => {
				if (value.message) this.postMessage({ type: 'serviceProgress', message: value.message });
			}
		};
		const executablePath = await installer.install(versionSpec, progress, undefined, githubToken);
		const engineDir = path.dirname(executablePath);

		// Step 2: Check if the installed version changed
		const channel = versionSpec === 'prerelease' ? 'pre' as const : 'stable' as const;
		const newVersion = installer.getInstalledVersion(channel) ?? versionSpec;
		const currentConfig = this.readServiceConfig();

		if (currentConfig && currentConfig.version === newVersion) {
			this.postMessage({ type: 'serviceProgress', message: 'Already up to date' });
			await this.sendServiceStatus();
			this.postMessage({ type: 'serviceComplete' });
			return;
		}

		// Step 3: Stop the service, update, restart
		this.postMessage({ type: 'serviceProgress', message: 'Stopping service...' });
		await this.serviceManager.update(executablePath, engineDir);

		// Step 4: Update config
		this.writeServiceConfig({
			versionSpec,
			version: newVersion,
			publishedAt: installer.getInstalledPublishedAt(channel) ?? '',
		});

		// Step 5: Clean up old versions (non-elevated — may skip SYSTEM-owned dirs)
		try { await installer.cleanupOldVersions(engineDir); } catch { /* best effort */ }

		// Step 6: Wait for service to be fully running
		await this.waitForServiceRunning();
		this.postMessage({ type: 'serviceComplete' });
	}

	private async serviceStart(): Promise<void> {
		this.postMessage({ type: 'serviceProgress', message: 'Starting service...' });
		await this.serviceManager.start();
		await this.waitForServiceRunning();
		this.postMessage({ type: 'serviceComplete' });
	}

	private async serviceStop(): Promise<void> {
		this.postMessage({ type: 'serviceProgress', message: 'Stopping service...' });
		await this.serviceManager.stop();
		await this.sendServiceStatus();
		this.postMessage({ type: 'serviceComplete' });
	}

	// =========================================================================
	// Status — merges service state with version info from config
	// =========================================================================

	/**
	 * Polls service status until it reaches 'running' state, sending
	 * live progress updates to the UI. Times out after 60 seconds.
	 */
	private async waitForServiceRunning(timeoutMs: number = 60000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			this.postMessage({ type: 'serviceProgress', message: 'Starting service...' });
			const status = await this.serviceManager.getStatus();
			const config = this.readServiceConfig();
			if (config) {
				status.version = config.version;
				status.publishedAt = config.publishedAt;
			}
			this.postMessage({ type: 'serviceStatus', status });

			if (status.state === 'running') return;
			await new Promise(r => setTimeout(r, 1000));
		}
		this.logger.output(`${icons.warning} Service did not reach running state within ${timeoutMs / 1000}s`);
	}

	private async sendServiceStatus(): Promise<void> {
		try {
			const status = await this.serviceManager.getStatus();
			const config = this.readServiceConfig();

			// Overlay version info from our config onto the service state
			if (config) {
				status.version = config.version;
				status.publishedAt = config.publishedAt;
			}

			this.postMessage({ type: 'serviceStatus', status });
		} catch {
			this.postMessage({
				type: 'serviceStatus',
				status: { state: 'not-installed', version: null, publishedAt: null, installPath: null }
			});
		}
	}

	private startStatusPolling(): void {
		this.stopStatusPolling();
		this.statusPollInterval = setInterval(() => {
			this.sendServiceStatus();
			this.sendDockerStatus();
		}, 3000);
	}

	private stopStatusPolling(): void {
		if (this.statusPollInterval) {
			clearInterval(this.statusPollInterval);
			this.statusPollInterval = undefined;
		}
	}

	private async fetchVersions(): Promise<void> {
		// Fetch service versions from GitHub Releases
		try {
			const githubToken = await this.getGithubToken();
			const installer = this.getInstaller();
			const versions = await installer.getReleases(undefined, githubToken);
			this.postMessage({ type: 'versionsLoaded', versions });
		} catch {
			this.postMessage({ type: 'versionsLoaded', versions: [] });
		}

		// Fetch Docker image tags from GHCR
		try {
			const { stable, all } = await this.fetchGhcrTags();
			this.ghcrTags = all;
			this.postMessage({ type: 'dockerVersionsLoaded', tags: stable });
		} catch {
			this.postMessage({ type: 'dockerVersionsLoaded', tags: [] });
		}
	}

	/**
	 * Lists available image tags from GHCR using the Docker Registry V2 API.
	 * For public images, we can get an anonymous token.
	 */
	private async fetchGhcrTags(): Promise<{ stable: string[]; all: string[] }> {
		// Step 1: Get anonymous pull token for the public image
		const tokenUrl = 'https://ghcr.io/token?scope=repository:rocketride-org/rocketride-engine:pull';
		const tokenData = await this.httpsGetJson(tokenUrl) as { token: string };

		// Step 2: List tags
		const tagsUrl = 'https://ghcr.io/v2/rocketride-org/rocketride-engine/tags/list';
		const tagsData = await this.httpsGetJson(tagsUrl, tokenData.token) as { tags: string[] };

		const all = (tagsData.tags || [])
			.filter((t: string) => /^\d+/.test(t)) // version tags only (exclude 'latest', digests)
			.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));

		// Stable: only pure version tags (e.g. '3.1.0'), no '-prerelease' suffix
		const stable = all.filter((t: string) => /^\d+\.\d+\.\d+$/.test(t));

		return { stable, all };
	}

	private httpsGetJson(url: string, bearerToken?: string): Promise<unknown> {
		const https = require('https');
		return new Promise((resolve, reject) => {
			const options: Record<string, unknown> = {
				headers: {
					'Accept': 'application/json',
					...(bearerToken ? { 'Authorization': `Bearer ${bearerToken}` } : {}),
				}
			};
			https.get(url, options, (res: { statusCode?: number; on: Function; setEncoding: Function }) => {
				if (res.statusCode !== 200) {
					reject(new Error(`GHCR API returned ${res.statusCode}`));
					return;
				}
				let data = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => { data += chunk; });
				res.on('end', () => {
					try { resolve(JSON.parse(data)); }
					catch (e) { reject(e); }
				});
			}).on('error', reject);
		});
	}

	// =========================================================================
	// Service config — version tracking (separate from ServiceManager)
	// =========================================================================

	private static readonly CONFIG_PATH = path.join(
		process.env.PROGRAMDATA || 'C:\\ProgramData', 'RocketRide', 'config.json'
	);

	private writeServiceConfig(info: { versionSpec: string; version: string; publishedAt: string }): void {
		const configDir = path.dirname(PageDeployProvider.CONFIG_PATH);
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(PageDeployProvider.CONFIG_PATH, JSON.stringify({
			...info,
			installedAt: new Date().toISOString()
		}, null, 2), 'utf8');
	}

	private readServiceConfig(): { versionSpec: string; version: string; publishedAt: string } | null {
		try {
			if (fs.existsSync(PageDeployProvider.CONFIG_PATH)) {
				return JSON.parse(fs.readFileSync(PageDeployProvider.CONFIG_PATH, 'utf8'));
			}
		} catch { /* corrupt */ }
		return null;
	}

	// =========================================================================
	// Docker operations
	// =========================================================================

	/**
	 * Maps a versionSpec to the actual GHCR image tag.
	 *   'latest'      → 'latest' (GHCR alias for newest stable)
	 *   'prerelease'  → newest '*-prerelease' tag from GHCR (e.g. '3.1.0-prerelease')
	 *   '3.1.0'       → '3.1.0' (pass through)
	 */
	private getDockerImageTag(versionSpec: string): string {
		if (versionSpec === 'latest') return 'latest';
		if (versionSpec === 'prerelease') {
			const pre = this.ghcrTags.find(t => t.endsWith('-prerelease'));
			if (!pre) throw new Error('No prerelease image found on GHCR');
			return pre;
		}
		return versionSpec;
	}

	private async dockerInstall(versionSpec: string): Promise<void> {
		const { imageTag } = { imageTag: this.getDockerImageTag(versionSpec) };
		const onProgress = (message: string) => this.postMessage({ type: 'dockerProgress', message });

		await this.dockerManager.install(imageTag, onProgress);

		this.writeDockerConfig({ versionSpec, imageTag });

		await this.waitForDockerRunning();
		this.postMessage({ type: 'dockerComplete' });
	}

	private async dockerRemove(): Promise<void> {
		this.postMessage({ type: 'dockerProgress', message: 'Removing container and image...' });
		await this.dockerManager.remove(true);
		this.deleteDockerConfig();
		await this.sendDockerStatus();
		this.postMessage({ type: 'dockerComplete' });
	}

	private async dockerUpdate(versionSpec: string): Promise<void> {
		const { imageTag } = { imageTag: this.getDockerImageTag(versionSpec) };
		const onProgress = (message: string) => this.postMessage({ type: 'dockerProgress', message });

		// Check if already on this version
		const currentConfig = this.readDockerConfig();
		if (currentConfig && currentConfig.imageTag === imageTag) {
			this.postMessage({ type: 'dockerProgress', message: 'Already up to date' });
			await this.sendDockerStatus();
			this.postMessage({ type: 'dockerComplete' });
			return;
		}

		await this.dockerManager.update(imageTag, onProgress);

		this.writeDockerConfig({ versionSpec, imageTag });

		await this.waitForDockerRunning();
		this.postMessage({ type: 'dockerComplete' });
	}

	private async dockerStart(): Promise<void> {
		this.postMessage({ type: 'dockerProgress', message: 'Starting container...' });
		await this.dockerManager.start();
		await this.waitForDockerRunning();
		this.postMessage({ type: 'dockerComplete' });
	}

	private async dockerStop(): Promise<void> {
		this.postMessage({ type: 'dockerProgress', message: 'Stopping container...' });
		await this.dockerManager.stop();
		await this.sendDockerStatus();
		this.postMessage({ type: 'dockerComplete' });
	}

	// =========================================================================
	// Docker status
	// =========================================================================

	private async sendDockerStatus(): Promise<void> {
		try {
			const status = await this.dockerManager.getStatus();
			const config = this.readDockerConfig();
			if (config) {
				status.version = config.versionSpec;
			}
			this.postMessage({ type: 'dockerStatus', status });
		} catch {
			this.postMessage({
				type: 'dockerStatus',
				status: { state: 'not-installed', version: null, publishedAt: null, imageTag: null }
			});
		}
	}

	private async waitForDockerRunning(timeoutMs: number = 60000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			this.postMessage({ type: 'dockerProgress', message: 'Starting container...' });
			const status = await this.dockerManager.getStatus();
			const config = this.readDockerConfig();
			if (config) {
				status.version = config.versionSpec;
			}
			this.postMessage({ type: 'dockerStatus', status });

			if (status.state === 'running') return;
			await new Promise(r => setTimeout(r, 1000));
		}
		this.logger.output(`${icons.warning} Docker container did not reach running state within ${timeoutMs / 1000}s`);
	}

	// =========================================================================
	// Docker config — version tracking
	// =========================================================================

	private static readonly DOCKER_CONFIG_PATH = path.join(
		process.env.PROGRAMDATA || (process.platform === 'darwin' ? '/Library/Application Support' : '/etc'),
		'RocketRide', 'docker-config.json'
	);

	private writeDockerConfig(info: { versionSpec: string; imageTag: string }): void {
		const configDir = path.dirname(PageDeployProvider.DOCKER_CONFIG_PATH);
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(PageDeployProvider.DOCKER_CONFIG_PATH, JSON.stringify({
			...info,
			installedAt: new Date().toISOString()
		}, null, 2), 'utf8');
	}

	private readDockerConfig(): { versionSpec: string; imageTag: string } | null {
		try {
			if (fs.existsSync(PageDeployProvider.DOCKER_CONFIG_PATH)) {
				return JSON.parse(fs.readFileSync(PageDeployProvider.DOCKER_CONFIG_PATH, 'utf8'));
			}
		} catch { /* corrupt */ }
		return null;
	}

	private deleteDockerConfig(): void {
		try {
			if (fs.existsSync(PageDeployProvider.DOCKER_CONFIG_PATH)) {
				fs.unlinkSync(PageDeployProvider.DOCKER_CONFIG_PATH);
			}
		} catch { /* best effort */ }
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private async getApiKey(): Promise<string> {
		const config = ConfigManager.getInstance().getConfig();
		return config.apiKey || '';
	}

	private async getGithubToken(): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	private postMessage(message: Record<string, unknown>): void {
		this.webviewPanel?.webview.postMessage(message);
	}

	// =========================================================================
	// Webview HTML
	// =========================================================================

	private async sendInit(): Promise<void> {
		if (!this.webviewPanel) return;

		const webview = this.webviewPanel.webview;
		const logoDarkUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'rocketride-dark-icon.png')
		);
		const logoLightUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'rocketride-light-icon.png')
		);
		const dockerUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'docker.svg')
		);
		const onpremUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'onprem.svg')
		);

		webview.postMessage({
			type: 'init',
			rocketrideLogoDarkUri: logoDarkUri.toString(),
			rocketrideLogoLightUri: logoLightUri.toString(),
			dockerIconUri: dockerUri.toString(),
			onpremIconUri: onpremUri.toString(),
		});
	}

	public close(): void {
		if (this.webviewPanel) {
			this.webviewPanel.dispose();
		}
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-deploy.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent
				.replace(/\{\{nonce\}\}/g, nonce)
				.replace(/\{\{cspSource\}\}/g, webview.cspSource);

			return htmlContent.replace(
				/(?:src|href)="(\/static\/[^"]+)"/g,
				(match: string, relativePath: string): string => {
					const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
					const resourceUri = webview.asWebviewUri(
						vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath)
					);
					return match.replace(relativePath, resourceUri.toString());
				}
			);
		} catch (error) {
			return `<!DOCTYPE html><html><body><h1>Deploy page failed to load</h1><p>${String(error)}</p><p>Expected: ${htmlPath.fsPath}</p></body></html>`;
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

	public dispose(): void {
		this.close();
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}
}
