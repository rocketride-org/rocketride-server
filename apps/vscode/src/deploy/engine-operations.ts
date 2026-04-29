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
 * EngineOperations — shared Docker and Service engine lifecycle manager.
 *
 * Extracted from PageDeployProvider so the same operations can be used by
 * both the Settings page (development and deployment panels) and any other
 * consumer that needs to install, start, stop, remove, or update Docker
 * containers and OS services.
 *
 * Connection-agnostic: callers decide whether the engine backs a dev or
 * deploy connection.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServiceManager, ServiceManager, SERVICE_PORT } from './service-manager';
import { DockerManager } from './docker-manager';
import { EngineInstaller } from '../connection/engine-installer';
import { getLogger } from '../shared/util/output';
import { getConnectionManager, getConfigManager } from '../extension';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Callback interface that the consumer (provider) implements to receive
 * progress/status/error messages from engine operations.
 */
export interface EngineOperationsCallbacks {
	/** Post a message to the webview (status, progress, error, complete). */
	postMessage(msg: Record<string, unknown>): void;
	/** Request a sudo password from the user (Linux/Mac service operations). */
	requestSudoPassword(): Promise<string>;
}

/** Version item from GitHub releases. */
export interface VersionItem {
	tag_name: string;
	prerelease: boolean;
}

// =============================================================================
// ENGINE OPERATIONS
// =============================================================================

export class EngineOperations {
	private readonly serviceManager: ServiceManager;
	private readonly dockerManager: DockerManager;
	private readonly logger = getLogger();
	private statusPollInterval?: NodeJS.Timeout;
	private ghcrTags: string[] = [];

	constructor(private readonly callbacks: EngineOperationsCallbacks) {
		this.serviceManager = createServiceManager();
		this.dockerManager = new DockerManager();
	}

	// =========================================================================
	// SERVICE OPERATIONS
	// =========================================================================

	public async serviceInstall(versionSpec: string): Promise<void> {
		const githubToken = await this.getGithubToken();
		const installer = this.getInstaller();

		await this.ensureSudoCredentials();
		await this.stopLocalEngine();

		this.postProgress('service', 'Preparing install directory...');
		await this.serviceManager.prepareInstallRoot();

		const progress = this.makeProgressReporter('service');
		const executablePath = await installer.install(versionSpec, progress, undefined, githubToken);
		const engineDir = path.dirname(executablePath);

		this.postProgress('service', 'Registering service...');
		await this.serviceManager.install(executablePath, engineDir);

		const channel = versionSpec === 'prerelease' ? ('pre' as const) : ('stable' as const);
		this.writeServiceConfig({
			versionSpec,
			version: installer.getInstalledVersion(channel) ?? versionSpec,
			publishedAt: installer.getInstalledPublishedAt(channel) ?? '',
		});

		await this.waitForServiceRunning();
		await this.connectToService();
		this.callbacks.postMessage({ type: 'serviceComplete' });
	}

	public async serviceRemove(): Promise<void> {
		await this.ensureSudoCredentials();
		this.postProgress('service', 'Removing service...');
		await this.serviceManager.remove();
		await this.sendServiceStatus();
		this.callbacks.postMessage({ type: 'serviceComplete' });
	}

	public async serviceUpdate(versionSpec: string): Promise<void> {
		await this.ensureSudoCredentials();
		const githubToken = await this.getGithubToken();
		const installer = this.getInstaller();

		this.postProgress('service', 'Checking for updates...');
		const progress = this.makeProgressReporter('service');
		const executablePath = await installer.install(versionSpec, progress, undefined, githubToken);
		const engineDir = path.dirname(executablePath);

		const channel = versionSpec === 'prerelease' ? ('pre' as const) : ('stable' as const);
		const newVersion = installer.getInstalledVersion(channel) ?? versionSpec;
		const currentConfig = this.readServiceConfig();

		if (currentConfig && currentConfig.version === newVersion) {
			this.postProgress('service', 'Already up to date');
			await this.sendServiceStatus();
			this.callbacks.postMessage({ type: 'serviceComplete' });
			return;
		}

		this.postProgress('service', 'Stopping service...');
		await this.serviceManager.update(executablePath, engineDir);

		this.writeServiceConfig({
			versionSpec,
			version: newVersion,
			publishedAt: installer.getInstalledPublishedAt(channel) ?? '',
		});

		try {
			await installer.cleanupOldVersions(engineDir);
		} catch {
			/* best effort */
		}

		await this.waitForServiceRunning();
		await this.connectToService();
		this.callbacks.postMessage({ type: 'serviceComplete' });
	}

	public async serviceStart(): Promise<void> {
		await this.ensureSudoCredentials();
		await this.stopLocalEngine();
		this.postProgress('service', 'Starting service...');
		await this.serviceManager.start();
		await this.waitForServiceRunning();
		await this.connectToService();
		this.callbacks.postMessage({ type: 'serviceComplete' });
	}

	public async serviceStop(): Promise<void> {
		await this.ensureSudoCredentials();
		this.postProgress('service', 'Stopping service...');
		await this.serviceManager.stop();
		await this.sendServiceStatus();
		this.callbacks.postMessage({ type: 'serviceComplete' });
	}

	// =========================================================================
	// DOCKER OPERATIONS
	// =========================================================================

	public async dockerInstall(versionSpec: string): Promise<void> {
		const imageTag = this.getDockerImageTag(versionSpec);
		const onProgress = (message: string) => this.postProgress('docker', message);

		await this.dockerManager.install(imageTag, onProgress);
		this.writeDockerConfig({ versionSpec, imageTag });
		await this.waitForDockerRunning();
		this.callbacks.postMessage({ type: 'dockerComplete' });
	}

	public async dockerRemove(): Promise<void> {
		this.postProgress('docker', 'Removing container and image...');
		await this.dockerManager.remove(true);
		this.deleteDockerConfig();
		await this.sendDockerStatus();
		this.callbacks.postMessage({ type: 'dockerComplete' });
	}

	public async dockerUpdate(versionSpec: string): Promise<void> {
		const imageTag = this.getDockerImageTag(versionSpec);
		const onProgress = (message: string) => this.postProgress('docker', message);

		const currentConfig = this.readDockerConfig();
		if (currentConfig && currentConfig.imageTag === imageTag && imageTag !== 'latest') {
			this.postProgress('docker', 'Already up to date');
			await this.sendDockerStatus();
			this.callbacks.postMessage({ type: 'dockerComplete' });
			return;
		}

		await this.dockerManager.update(imageTag, onProgress);
		this.writeDockerConfig({ versionSpec, imageTag });
		await this.waitForDockerRunning();
		this.callbacks.postMessage({ type: 'dockerComplete' });
	}

	public async dockerStart(): Promise<void> {
		this.postProgress('docker', 'Starting container...');
		await this.dockerManager.start();
		await this.waitForDockerRunning();
		this.callbacks.postMessage({ type: 'dockerComplete' });
	}

	public async dockerStop(): Promise<void> {
		this.postProgress('docker', 'Stopping container...');
		await this.dockerManager.stop();
		await this.sendDockerStatus();
		this.callbacks.postMessage({ type: 'dockerComplete' });
	}

	// =========================================================================
	// STATUS
	// =========================================================================

	public async sendServiceStatus(): Promise<void> {
		try {
			const status = await this.serviceManager.getStatus();
			const config = this.readServiceConfig();
			if (config) {
				status.version = config.version;
				status.publishedAt = config.publishedAt;
			}
			this.callbacks.postMessage({ type: 'serviceStatus', status });
		} catch {
			this.callbacks.postMessage({
				type: 'serviceStatus',
				status: { state: 'not-installed', version: null, publishedAt: null, installPath: null },
			});
		}
	}

	public async sendDockerStatus(): Promise<void> {
		try {
			const status = await this.dockerManager.getStatus();
			const config = this.readDockerConfig();
			if (config) {
				status.version = config.versionSpec;
			}
			this.callbacks.postMessage({ type: 'dockerStatus', status });
		} catch {
			this.callbacks.postMessage({
				type: 'dockerStatus',
				status: { state: 'not-installed', version: null, publishedAt: null, imageTag: null },
			});
		}
	}

	// =========================================================================
	// STATUS POLLING
	// =========================================================================

	public startStatusPolling(): void {
		this.stopStatusPolling();
		this.statusPollInterval = setInterval(() => {
			this.sendServiceStatus();
			this.sendDockerStatus();
		}, 3000);
	}

	public stopStatusPolling(): void {
		if (this.statusPollInterval) {
			clearInterval(this.statusPollInterval);
			this.statusPollInterval = undefined;
		}
	}

	// =========================================================================
	// VERSION FETCHING
	// =========================================================================

	public async fetchVersions(): Promise<void> {
		// GitHub releases (service / local engine versions)
		try {
			const githubToken = await this.getGithubToken();
			const installer = this.getInstaller();
			const versions = await installer.getReleases(undefined, githubToken);
			this.callbacks.postMessage({ type: 'versionsLoaded', versions });
		} catch {
			this.callbacks.postMessage({ type: 'versionsLoaded', versions: [] });
		}

		// GHCR image tags (Docker versions)
		try {
			const { stable, all } = await this.fetchGhcrTags();
			this.ghcrTags = all;
			this.callbacks.postMessage({ type: 'dockerVersionsLoaded', tags: stable });
		} catch {
			this.callbacks.postMessage({ type: 'dockerVersionsLoaded', tags: [] });
		}
	}

	// =========================================================================
	// MESSAGE ROUTING — convenience for providers
	// =========================================================================

	/**
	 * Routes an incoming webview message to the appropriate operation.
	 * Returns true if the message was handled, false otherwise.
	 */
	public async handleMessage(message: { type: string; [key: string]: unknown }): Promise<boolean> {
		switch (message.type) {
			case 'fetchVersions':
				await this.fetchVersions();
				return true;
			case 'sudoPassword':
				// Handled by the pending promise in requestSudoPassword — caller resolves it
				return false;
			case 'serviceInstall':
				await this.serviceInstall(message.version as string);
				return true;
			case 'serviceRemove':
				await this.serviceRemove();
				return true;
			case 'serviceUpdate':
				await this.serviceUpdate(message.version as string);
				return true;
			case 'serviceStart':
				await this.serviceStart();
				return true;
			case 'serviceStop':
				await this.serviceStop();
				return true;
			case 'dockerInstall':
				await this.dockerInstall(message.version as string);
				return true;
			case 'dockerRemove':
				await this.dockerRemove();
				return true;
			case 'dockerUpdate':
				await this.dockerUpdate(message.version as string);
				return true;
			case 'dockerStart':
				await this.dockerStart();
				return true;
			case 'dockerStop':
				await this.dockerStop();
				return true;
			default:
				return false;
		}
	}

	// =========================================================================
	// PRIVATE HELPERS
	// =========================================================================

	private postProgress(target: 'service' | 'docker', message: string): void {
		this.callbacks.postMessage({
			type: target === 'service' ? 'serviceProgress' : 'dockerProgress',
			message,
		});
	}

	private makeProgressReporter(target: 'service' | 'docker'): vscode.Progress<{ message?: string }> {
		return {
			report: (value) => {
				if (value.message) this.postProgress(target, value.message);
			},
		};
	}

	private getInstaller(): EngineInstaller {
		return new EngineInstaller(this.serviceManager.getInstallPath());
	}

	private async ensureSudoCredentials(): Promise<void> {
		if (!(await this.serviceManager.needsElevation())) return;
		const password = await this.callbacks.requestSudoPassword();
		this.serviceManager.setElevationPassword(password);
	}

	private async stopLocalEngine(): Promise<void> {
		const cm = getConnectionManager();
		if (cm) {
			this.postProgress('service', 'Stopping local engine...');
			await cm.disconnect();
		}
	}

	private async connectToService(): Promise<void> {
		const configMgr = getConfigManager();
		if (!configMgr) return;
		this.postProgress('service', 'Connecting to service...');
		await configMgr.updateHostUrl(`http://localhost:${SERVICE_PORT}`);
		await configMgr.updateConnectionMode('onprem');
	}

	private async waitForServiceRunning(): Promise<void> {
		while (true) {
			this.postProgress('service', 'Starting service...');
			const status = await this.serviceManager.getStatus();
			const config = this.readServiceConfig();
			if (config) {
				status.version = config.version;
				status.publishedAt = config.publishedAt;
			}
			this.callbacks.postMessage({ type: 'serviceStatus', status });

			if (status.state === 'running') return;
			if (status.state === 'stopped' || status.state === 'not-installed') {
				throw new Error(`Service failed to start (state: ${status.state})`);
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}

	private async waitForDockerRunning(): Promise<void> {
		while (true) {
			this.postProgress('docker', 'Starting container...');
			const status = await this.dockerManager.getStatus();
			const config = this.readDockerConfig();
			if (config) {
				status.version = config.versionSpec;
			}
			this.callbacks.postMessage({ type: 'dockerStatus', status });

			if (status.state === 'running') return;
			if (status.state === 'stopped' || status.state === 'not-installed') {
				throw new Error(`Docker container failed to start (state: ${status.state})`);
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}

	private getDockerImageTag(versionSpec: string): string {
		if (versionSpec === 'latest') return 'latest';
		if (versionSpec === 'prerelease') {
			const pre = this.ghcrTags.find((t) => t.endsWith('-prerelease'));
			if (!pre) throw new Error('No prerelease image found on GHCR');
			return pre;
		}
		return versionSpec;
	}

	private async getGithubToken(): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	// =========================================================================
	// GHCR TAG FETCHING
	// =========================================================================

	private async fetchGhcrTags(): Promise<{ stable: string[]; all: string[] }> {
		const tokenUrl = 'https://ghcr.io/token?scope=repository:rocketride-org/rocketride-engine:pull';
		const tokenData = (await this.httpsGetJson(tokenUrl)) as { token: string };

		const tagsUrl = 'https://ghcr.io/v2/rocketride-org/rocketride-engine/tags/list';
		const tagsData = (await this.httpsGetJson(tagsUrl, tokenData.token)) as { tags: string[] };

		const all = (tagsData.tags || []).filter((t: string) => /^\d+/.test(t)).sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));

		const stable = all.filter((t: string) => /^\d+\.\d+\.\d+$/.test(t));

		return { stable, all };
	}

	private httpsGetJson(url: string, bearerToken?: string): Promise<unknown> {
		const https = require('https');
		return new Promise((resolve, reject) => {
			const options: Record<string, unknown> = {
				headers: {
					Accept: 'application/json',
					...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
				},
			};
			https
				.get(url, options, (res: import('http').IncomingMessage) => {
					if (res.statusCode !== 200) {
						reject(new Error(`GHCR API returned ${res.statusCode}`));
						return;
					}
					let data = '';
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => {
						data += chunk;
					});
					res.on('end', () => {
						try {
							resolve(JSON.parse(data));
						} catch (e) {
							reject(e);
						}
					});
				})
				.on('error', reject);
		});
	}

	// =========================================================================
	// CONFIG READ/WRITE — version tracking files
	// =========================================================================

	private static readonly CONFIG_DIR = path.join(process.env.PROGRAMDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')), 'RocketRide');
	private static readonly SERVICE_CONFIG_PATH = path.join(EngineOperations.CONFIG_DIR, 'config.json');
	private static readonly DOCKER_CONFIG_PATH = path.join(EngineOperations.CONFIG_DIR, 'docker-config.json');

	private writeServiceConfig(info: { versionSpec: string; version: string; publishedAt: string }): void {
		fs.mkdirSync(EngineOperations.CONFIG_DIR, { recursive: true });
		fs.writeFileSync(EngineOperations.SERVICE_CONFIG_PATH, JSON.stringify({ ...info, installedAt: new Date().toISOString() }, null, 2), 'utf8');
	}

	private readServiceConfig(): { versionSpec: string; version: string; publishedAt: string } | null {
		try {
			if (fs.existsSync(EngineOperations.SERVICE_CONFIG_PATH)) {
				return JSON.parse(fs.readFileSync(EngineOperations.SERVICE_CONFIG_PATH, 'utf8'));
			}
		} catch {
			/* corrupt */
		}
		return null;
	}

	private writeDockerConfig(info: { versionSpec: string; imageTag: string }): void {
		fs.mkdirSync(EngineOperations.CONFIG_DIR, { recursive: true });
		fs.writeFileSync(EngineOperations.DOCKER_CONFIG_PATH, JSON.stringify({ ...info, installedAt: new Date().toISOString() }, null, 2), 'utf8');
	}

	private readDockerConfig(): { versionSpec: string; imageTag: string } | null {
		try {
			if (fs.existsSync(EngineOperations.DOCKER_CONFIG_PATH)) {
				return JSON.parse(fs.readFileSync(EngineOperations.DOCKER_CONFIG_PATH, 'utf8'));
			}
		} catch {
			/* corrupt */
		}
		return null;
	}

	private deleteDockerConfig(): void {
		try {
			if (fs.existsSync(EngineOperations.DOCKER_CONFIG_PATH)) {
				fs.unlinkSync(EngineOperations.DOCKER_CONFIG_PATH);
			}
		} catch {
			/* best effort */
		}
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		this.stopStatusPolling();
	}
}
