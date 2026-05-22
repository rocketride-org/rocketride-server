// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * service-manager.ts - Service Manager Abstraction
 *
 * Pure service lifecycle management — register, start, stop, remove, status.
 * No downloading, no versioning, no engine installation. The caller
 * (DeployProvider) handles engine installation via EngineInstaller
 * and then passes the executable path here.
 *
 * Each platform has its own implementation:
 *   - Windows: NSSM (Non-Sucking Service Manager)
 *   - Linux: systemd unit files
 *   - macOS: launchd plist files
 */

import * as net from 'net';
import { getLogger } from '../../shared/util/output';

/** The service name as registered with the OS (NSSM / systemd / launchd). */
export const SERVICE_NAME = 'RocketRide';

/** Human-readable display name shown in OS service management UIs. */
export const SERVICE_DISPLAY_NAME = 'RocketRide Engine';

/** Fixed port the engine service listens on (localhost only). */
export const SERVICE_PORT = 5565;

/** Possible states of the OS-level service. */
export type ServiceState = 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';

/** Snapshot of the OS service state, returned by {@link ServiceManager.getStatus}. */
export interface ServiceStatus {
	/** Current lifecycle state of the service. */
	state: ServiceState;
	/** Engine version string, if known (null when not installed or unknown). */
	version: string | null;
	/** ISO date string of when this version was published on GitHub. */
	publishedAt: string | null;
	/** Filesystem path where the engine is installed, or null if not installed. */
	installPath: string | null;
}

/**
 * ServiceManager — abstract base for platform-specific OS service lifecycle.
 *
 * Subclasses implement the actual register/start/stop/remove commands for
 * Windows (NSSM), Linux (systemd), and macOS (launchd). This base class
 * provides shared helpers like port-checking and no-op defaults for optional
 * capabilities (elevation, install-root preparation).
 */
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
	 * Creates the install root and makes it writable by the current user.
	 * Must be called before EngineInstaller writes to the install path.
	 * Default is a no-op for platforms where the install path is already user-writable.
	 */
	prepareInstallRoot(): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Returns true if elevated credentials are required for service operations.
	 * Default returns false for platforms where no credential prompt is needed.
	 */
	needsElevation(): Promise<boolean> {
		return Promise.resolve(false);
	}

	/**
	 * Provides the password used for privilege elevation (e.g. sudo -S).
	 * Default is a no-op for platforms that don't need it.
	 */
	setElevationPassword(_password: string): void {
		// no-op
	}

	/**
	 * Checks if the service port is accepting connections.
	 */
	protected isPortOpen(port: number = SERVICE_PORT): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = new net.Socket();
			socket.setTimeout(1000);
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
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
