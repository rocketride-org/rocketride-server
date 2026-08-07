// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-service.ts — OS service engine backend.
 *
 * Installs and manages the engine as a system service (Windows NSSM,
 * Linux systemd, macOS launchd). Delegates platform-specific operations
 * to the appropriate ServiceManager subclass.
 *
 * The engine binary is downloaded via EngineInstaller into a system-level
 * directory, then registered as a service pointing to a fixed path
 * (<installRoot>/engine/engine.exe). Updates replace the binary in-place
 * without re-registering the service.
 *
 * Lifecycle:
 *   install()  → download engine + register OS service + start
 *   start()    → start the registered service
 *   stop()     → stop the running service
 *   update()   → stop → download new version → start
 *   remove()   → stop + unregister service + delete files
 */

import * as vscode from 'vscode';
import { EngineBackend, type StatusEmitter, type EngineInfo, type EngineBackendStatus, type IoControlResult, type IoProgressCallback } from '../engine-backend';
import { getSystemInstallDir } from '../config/config-migration';
import { EngineInstaller } from '../shared/engine-installer';
import type { ConnectionMode, ConnectionGroupConfig } from '../../config';
import { SERVICE_PORT } from './service-manager';

// Re-export the service manager infrastructure so platform files can stay in this directory
export { ServiceManager, ServiceStatus, ServiceState, SERVICE_NAME, SERVICE_DISPLAY_NAME, SERVICE_PORT } from './service-manager';

// =============================================================================
// SERVICE ENGINE BACKEND
// =============================================================================

/**
 * EngineService — OS service backend for the engine.
 *
 * Wraps EngineInstaller (download/extract) and ServiceManager (OS service
 * lifecycle) into a single EngineBackend implementation. Used when the user
 * chooses "service" deployment mode.
 */
export class EngineService extends EngineBackend {
	/** Handles downloading and extracting engine binaries from GitHub. */
	private readonly installer: EngineInstaller;

	/** Platform-specific service manager (NSSM / systemd / launchd). */
	private readonly serviceManager: import('./service-manager').ServiceManager;

	/**
	 * @param installRoot - System-level directory (e.g., C:\ProgramData\RocketRide).
	 *   Engine binaries go in <installRoot>/engine/. Service points to this fixed path.
	 * @param emitStatus - Callback to emit status events to EngineManager.
	 */
	constructor(installRoot: string, emitStatus: StatusEmitter) {
		super(emitStatus);
		this.installer = new EngineInstaller(installRoot, 'version.service.json');
		this.serviceManager = createPlatformServiceManager();
	}

	// =========================================================================
	// PUBLIC API
	// =========================================================================

	/** The EngineInstaller (for version fetching in UI). */
	getInstaller(): EngineInstaller {
		return this.installer;
	}

	/** The platform-specific service manager (for advanced operations). */
	getServiceManager(): import('./service-manager').ServiceManager {
		return this.serviceManager;
	}

	/** Returns installed engine version info, or null. */
	getInfo(): EngineInfo | null {
		const installed = this.installer.getInstalledVersion();
		if (!installed) return null;
		return { version: installed.tag, publishedAt: installed.publishedAt };
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	/**
	 * Downloads the engine, registers the OS service, and starts it.
	 * Handles sudo/elevation prompts as needed.
	 */
	async install(versionSpec: string, config: ConnectionGroupConfig, token?: vscode.CancellationToken): Promise<void> {
		// Prepare install root (creates dirs, sets permissions on macOS/Linux)
		this.emitStatus({ phase: 'working', message: 'Preparing install directory...' });
		await this.serviceManager.prepareInstallRoot();

		// Download engine binary
		this.emitStatus({ phase: 'working', message: 'Downloading engine...' });
		const progress: vscode.Progress<{ message?: string }> = {
			report: (value) => {
				if (value.message) this.emitStatus({ phase: 'working', message: value.message });
			},
		};

		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch { /* proceed without token */ }

		const executablePath = await this.installer.install(versionSpec, progress, token, githubToken);
		const engineDir = this.installer.dir;

		// Register and start the OS service
		this.emitStatus({ phase: 'working', message: 'Registering service...' });
		await this.serviceManager.install(executablePath, engineDir);
		await this.waitForReady();

		this.emitStatus({
			phase: 'ready',
			message: 'Service installed and running',
			uri: `http://localhost:${SERVICE_PORT}`,
			version: this.installer.getInstalledVersion()?.tag,
		});
	}

	/**
	 * Starts the service if it's not already running.
	 * Checks the actual OS service state first to avoid unnecessary
	 * UAC prompts on VS Code restart.
	 */
	async start(_config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		// Check if already running — skip the start (and UAC prompt) if so
		const currentStatus = await this.serviceManager.getStatus();
		if (currentStatus.state === 'running') {
			this.emitStatus({
				phase: 'ready',
				message: 'Service running',
				uri: `http://localhost:${SERVICE_PORT}`,
				version: this.installer.getInstalledVersion()?.tag,
			});
			return;
		}

		// Not installed — can't start what isn't registered
		if (currentStatus.state === 'not-installed') {
			this.emitStatus({ phase: 'idle', message: 'Service not installed' });
			return;
		}

		// Stopped or other state — start it (triggers UAC on Windows)
		this.emitStatus({ phase: 'working', message: 'Starting service...' });
		await this.serviceManager.start();
		await this.waitForReady();

		this.emitStatus({
			phase: 'ready',
			message: 'Service running',
			uri: `http://localhost:${SERVICE_PORT}`,
			version: this.installer.getInstalledVersion()?.tag,
		});
	}

	/**
	 * Called by the reconciler when this engine is no longer needed.
	 * Does NOT stop the OS service — it's persistent and runs independently.
	 * Just emits idle so ConnectionManagers disconnect from this engine.
	 */
	async stop(): Promise<void> {
		this.emitStatus({ phase: 'idle', message: 'Service engine detached' });
	}

	/**
	 * Stops the service, downloads a new version, and restarts.
	 * The service still points to the same fixed engine/ path — no re-registration.
	 */
	async update(versionSpec: string, config: ConnectionGroupConfig, token?: vscode.CancellationToken): Promise<void> {
		this.emitStatus({ phase: 'working', message: 'Stopping service...' });
		await this.serviceManager.stop();

		// Download new version (replaces engine/ contents in-place)
		this.emitStatus({ phase: 'working', message: 'Downloading update...' });
		const progress: vscode.Progress<{ message?: string }> = {
			report: (value) => {
				if (value.message) this.emitStatus({ phase: 'working', message: value.message });
			},
		};

		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch { /* proceed without token */ }

		await this.installer.install(versionSpec, progress, token, githubToken);

		// Restart (same path, no NSSM reconfiguration needed)
		this.emitStatus({ phase: 'working', message: 'Starting service...' });
		await this.serviceManager.start();
		await this.waitForReady();

		this.emitStatus({
			phase: 'ready',
			message: 'Service updated and running',
			uri: `http://localhost:${SERVICE_PORT}`,
			version: this.installer.getInstalledVersion()?.tag,
		});
	}

	/**
	 * Stops, unregisters, and deletes the service and engine files.
	 */
	async remove(): Promise<void> {
		this.emitStatus({ phase: 'working', message: 'Removing service...' });
		await this.serviceManager.remove();
		this.emitStatus({ phase: 'idle', message: 'Service removed' });
	}

	/** Re-emits the current status (ready with URI, or idle). */
	emitCurrentStatus(): void {
		// Query actual OS service state
		this.serviceManager.getStatus().then((status) => {
			if (status.state === 'running') {
				this.emitStatus({
					phase: 'ready',
					message: 'Service running',
					uri: `http://localhost:${SERVICE_PORT}`,
					version: this.installer.getInstalledVersion()?.tag,
				});
			} else {
				this.emitStatus({ phase: 'idle', message: `Service ${status.state}` });
			}
		}).catch(() => {
			this.emitStatus({ phase: 'idle', message: 'Service status unknown' });
		});
	}

	/** Nothing to dispose — service runs independently. */
	async dispose(): Promise<void> {
		// Service continues running after VS Code closes — nothing to clean up
	}

	/**
	 * Waits for the service to become reachable on its port before returning.
	 * Polls every 500ms for up to 30 seconds.
	 */
	private async waitForReady(): Promise<void> {
		const maxAttempts = 60;
		for (let i = 0; i < maxAttempts; i++) {
			const status = await this.serviceManager.getStatus();
			if (status.state === 'running') return;
			this.emitStatus({ phase: 'working', message: 'Waiting for service to become ready...' });
			await new Promise(r => setTimeout(r, 500));
		}
		throw new Error('Service did not become reachable within 30 seconds');
	}

	// =========================================================================
	// ELEVATION HELPERS — forwarded to ServiceManager
	// =========================================================================

	/** Returns true if the current platform needs sudo/admin elevation. */
	async needsElevation(): Promise<boolean> {
		return this.serviceManager.needsElevation();
	}

	/** Provides the sudo password for elevated operations (macOS/Linux). */
	setElevationPassword(password: string): void {
		this.serviceManager.setElevationPassword(password);
	}

	// =========================================================================
	// STATIC STATUS — queries OS service state without needing an instance
	// =========================================================================

	/**
	 * Queries the actual service state directly from the OS.
	 * No instance needed — creates a temporary ServiceManager to check.
	 */
	static async getStatus(): Promise<EngineBackendStatus> {
		const sm = createPlatformServiceManager();
		const installRoot = getSystemInstallDir();
		const installer = new EngineInstaller(installRoot, 'version.service.json');
		const installed = installer.getInstalledVersion();
		const status = await sm.getStatus();
		return {
			state: status.state,
			version: installed?.tag?.replace(/^server-/, '') ?? status.version,
			publishedAt: installed?.publishedAt ?? status.publishedAt,
			installPath: status.installPath,
		};
	}

	// =========================================================================
	// STATIC ioControl — panel commands that don't need a running instance
	// =========================================================================

	/**
	 * Handles panel commands: install, remove, start, stop.
	 * Creates temporary ServiceManager + EngineInstaller as needed.
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, onProgress?: IoProgressCallback): Promise<IoControlResult> {
		const sm = createPlatformServiceManager();
		const installRoot = getSystemInstallDir();
		const installer = new EngineInstaller(installRoot, 'version.service.json');
		const progress = onProgress
			? { report: (v: { message?: string }) => { if (v.message) onProgress(v.message); } }
			: undefined;

		try {
			switch (command) {
				case 'install': {
					const version = (params?.version as string) || 'latest';
					const githubToken = params?.githubToken as string | undefined;
					onProgress?.('Preparing install directory...');
					await sm.prepareInstallRoot();
					onProgress?.('Downloading engine...');
					const executablePath = await installer.install(version, progress, undefined, githubToken);
					const engineDir = installer.dir;
					onProgress?.('Registering service...');
					await sm.install(executablePath, engineDir);
					return { success: true, data: { version: installer.getInstalledVersion()?.tag } };
				}
				case 'remove':
					onProgress?.('Removing service...');
					await sm.remove();
					return { success: true };
				case 'start':
					onProgress?.('Starting service...');
					await sm.start();
					return { success: true };
				case 'stop':
					onProgress?.('Stopping service...');
					await sm.stop();
					return { success: true };
				case 'update': {
					const version = (params?.version as string) || 'latest';
					const githubToken = params?.githubToken as string | undefined;
					onProgress?.('Stopping service...');
					await sm.stop();
					onProgress?.('Downloading update...');
					await installer.install(version, progress, undefined, githubToken);
					onProgress?.('Starting service...');
					await sm.start();
					return { success: true, data: { version: installer.getInstalledVersion()?.tag } };
				}
				case 'test': {
					const { RocketRideClient } = require('rocketride');
					const client = new RocketRideClient({ persist: false });
					await client.connect('MYAPIKEY', { uri: `http://localhost:${SERVICE_PORT}`, timeout: 10000 });
					const version = client.getServerVersion?.() ?? null;
					await client.disconnect();
					return { success: true, data: { version } };
				}
				default:
					return { success: false, error: `Unknown command: ${command}` };
			}
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
}

// =============================================================================
// PLATFORM FACTORY
// =============================================================================

/**
 * Creates the appropriate ServiceManager for the current platform.
 * This mirrors the old createServiceManager() but lives here with the backend.
 */
function createPlatformServiceManager(): import('./service-manager').ServiceManager {
	switch (process.platform) {
		case 'win32': {
			const { WindowsServiceManager } = require('./service-windows');
			return new WindowsServiceManager();
		}
		case 'linux': {
			const { LinuxServiceManager } = require('./service-linux');
			return new LinuxServiceManager();
		}
		case 'darwin': {
			const { MacServiceManager } = require('./service-mac');
			return new MacServiceManager();
		}
		default:
			throw new Error(`Unsupported platform for service deployment: ${process.platform}`);
	}
}
