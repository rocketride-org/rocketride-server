// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * service-manager.ts - Service Manager Abstraction
 *
 * Pure service lifecycle management — register, start, stop, remove, status.
 * No downloading, no versioning, no engine installation. The caller
 * (PageDeployProvider) handles engine installation via EngineInstaller
 * and then passes the executable path here.
 *
 * Each platform has its own implementation:
 *   - Windows: NSSM (Non-Sucking Service Manager)
 *   - Linux: systemd unit files
 *   - macOS: launchd plist files
 */

import * as net from 'net';
import { getLogger } from '../shared/util/output';

export const SERVICE_NAME = 'RocketRide';
export const SERVICE_DISPLAY_NAME = 'RocketRide Engine';
export const SERVICE_PORT = 5565;

export type ServiceState = 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface ServiceStatus {
	state: ServiceState;
	version: string | null;
	publishedAt: string | null;
	installPath: string | null;
}

export abstract class ServiceManager {
	protected readonly logger = getLogger();

	/**
	 * Register and start the engine as an OS service.
	 * @param executablePath - Full path to engine.exe
	 * @param engineDir - Working directory for the engine
	 */
	abstract install(executablePath: string, engineDir: string): Promise<void>;

	/**
	 * Stop and unregister the service, delete SYSTEM-owned dirs (engines, logs).
	 */
	abstract remove(): Promise<void>;

	/**
	 * Update the service to point to a new executable and restart.
	 */
	abstract update(executablePath: string, engineDir: string): Promise<void>;

	/** Start the service. */
	abstract start(): Promise<void>;

	/** Stop the service. */
	abstract stop(): Promise<void>;

	/** Get current service status. */
	abstract getStatus(): Promise<ServiceStatus>;

	/** Returns the platform-specific install root directory. */
	abstract getInstallPath(): string;

	/**
	 * Checks if the service port is accepting connections.
	 */
	protected isPortOpen(port: number = SERVICE_PORT): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = new net.Socket();
			socket.setTimeout(1000);
			socket.on('connect', () => { socket.destroy(); resolve(true); });
			socket.on('timeout', () => { socket.destroy(); resolve(false); });
			socket.on('error', () => { socket.destroy(); resolve(false); });
			socket.connect(port, 'localhost');
		});
	}
}

/**
 * Creates the appropriate ServiceManager for the current platform.
 */
export function createServiceManager(): ServiceManager {
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
