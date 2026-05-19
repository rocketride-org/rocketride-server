// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-docker.ts — Docker container engine backend.
 *
 * Manages the engine as a Docker container. Delegates container lifecycle
 * (pull, create, start, stop, remove) to DockerManager.
 *
 * Lifecycle:
 *   install()  → pull image + create + start container
 *   start()    → start existing container
 *   stop()     → stop running container
 *   update()   → pull new image + recreate container
 *   remove()   → stop + remove container + optionally remove image
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EngineBackend, type StatusEmitter, type EngineInfo, type EngineBackendStatus, type IoControlResult, type IoProgressCallback } from '../engine-backend';
import type { ConnectionMode } from '../../config';
import { DockerManager, CONTAINER_PORT } from './docker-manager';
import type { ConnectionGroupConfig } from '../../config';
import { cachedDockerTags } from '../../extension';
import { getSystemInstallDir } from '../config/config-migration';

// =============================================================================
// DOCKER ENGINE BACKEND
// =============================================================================

export class EngineDocker extends EngineBackend {
	/** Manages container lifecycle (pull, create, start, stop, remove). */
	private readonly dockerManager: DockerManager;

	/**
	 * @param emitStatus - Callback to emit status events to EngineManager.
	 */
	constructor(emitStatus: StatusEmitter) {
		super(emitStatus);
		this.dockerManager = new DockerManager();
	}

	/** The underlying DockerManager (for advanced status queries). */
	getDockerManager(): DockerManager {
		return this.dockerManager;
	}

	/** Path to docker-version.json in the system install dir. */
	private static readonly VERSION_PATH = path.join(getSystemInstallDir(), 'version.docker.json');

	/** Reads the tracked Docker version, or null if not installed. */
	getInfo(): EngineInfo | null {
		return EngineDocker.readVersionFile();
	}

	/** Writes docker-version.json after a successful pull/install. */
	private static writeVersionFile(imageTag: string): void {
		try {
			const dir = path.dirname(EngineDocker.VERSION_PATH);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(EngineDocker.VERSION_PATH, JSON.stringify({
				imageTag,
				installedAt: new Date().toISOString(),
			}, null, 2), 'utf8');
		} catch { /* best effort */ }
	}

	/** Reads docker-version.json, or null if missing/corrupt. */
	private static readVersionFile(): EngineInfo | null {
		try {
			if (fs.existsSync(EngineDocker.VERSION_PATH)) {
				const data = JSON.parse(fs.readFileSync(EngineDocker.VERSION_PATH, 'utf8'));
				if (data?.imageTag) {
					return { version: data.imageTag, publishedAt: data.installedAt || '' };
				}
			}
		} catch { /* corrupt */ }
		return null;
	}

	/** Removes docker-version.json (e.g., after container removal). */
	private static deleteVersionFile(): void {
		try {
			if (fs.existsSync(EngineDocker.VERSION_PATH)) {
				fs.unlinkSync(EngineDocker.VERSION_PATH);
			}
		} catch { /* best effort */ }
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	/**
	 * Pulls the Docker image and starts a container.
	 *
	 * @param versionSpec - Image tag to pull (e.g., '3.2.0', 'latest', 'prerelease').
	 */
	async install(versionSpec: string, _config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		const imageTag = this.resolveImageTag(versionSpec);
		const onProgress = (message: string) => this.emitStatus({ phase: 'working', message });

		await this.dockerManager.install(imageTag, onProgress);
		EngineDocker.writeVersionFile(imageTag);

		this.emitStatus({
			phase: 'ready',
			message: 'Docker container running',
			uri: `http://localhost:${CONTAINER_PORT}`,
			version: imageTag,
		});
	}

	/**
	 * Starts an existing container if it's not already running.
	 * Checks the actual Docker daemon state first.
	 */
	async start(_config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		// Check if already running — skip start if so
		const currentStatus = await this.dockerManager.getStatus();
		if (currentStatus.state === 'running') {
			this.emitStatus({
				phase: 'ready',
				message: 'Docker container running',
				uri: `http://localhost:${CONTAINER_PORT}`,
			});
			return;
		}

		if (currentStatus.state === 'not-installed' || currentStatus.state === 'no-docker') {
			this.emitStatus({ phase: 'idle', message: currentStatus.state === 'no-docker' ? 'Docker not available' : 'Container not installed' });
			return;
		}

		this.emitStatus({ phase: 'working', message: 'Starting container...' });
		await this.dockerManager.start();

		this.emitStatus({
			phase: 'ready',
			message: 'Docker container running',
			uri: `http://localhost:${CONTAINER_PORT}`,
		});
	}

	/**
	 * Called by the reconciler when this engine is no longer needed.
	 * Does NOT stop the Docker container — it's persistent and runs independently.
	 * Just emits idle so ConnectionManagers disconnect from this engine.
	 */
	async stop(): Promise<void> {
		this.emitStatus({ phase: 'idle', message: 'Docker engine detached' });
	}

	/**
	 * Pulls a new image and recreates the container.
	 */
	async update(versionSpec: string, _config: ConnectionGroupConfig, _token?: vscode.CancellationToken): Promise<void> {
		const imageTag = this.resolveImageTag(versionSpec);
		const onProgress = (message: string) => this.emitStatus({ phase: 'working', message });

		await this.dockerManager.update(imageTag, onProgress);
		EngineDocker.writeVersionFile(imageTag);

		this.emitStatus({
			phase: 'ready',
			message: 'Docker container updated and running',
			uri: `http://localhost:${CONTAINER_PORT}`,
			version: imageTag,
		});
	}

	/**
	 * Stops and removes the container and image.
	 */
	async remove(): Promise<void> {
		this.emitStatus({ phase: 'working', message: 'Removing container and image...' });
		await this.dockerManager.remove(true);
		EngineDocker.deleteVersionFile();
		this.emitStatus({ phase: 'idle', message: 'Container removed' });
	}

	/** Re-emits the current status (ready with URI, or idle). */
	emitCurrentStatus(): void {
		this.dockerManager.getStatus().then((status) => {
			if (status.state === 'running') {
				this.emitStatus({
					phase: 'ready',
					message: 'Docker container running',
					uri: `http://localhost:${CONTAINER_PORT}`,
					version: status.imageTag ?? undefined,
				});
			} else {
				this.emitStatus({ phase: 'idle', message: `Container ${status.state}` });
			}
		}).catch(() => {
			this.emitStatus({ phase: 'idle', message: 'Docker status unknown' });
		});
	}

	/** Nothing to dispose — Docker daemon manages the container independently. */
	async dispose(): Promise<void> {}

	// =========================================================================
	// STATIC STATUS — queries Docker daemon without needing an instance
	// =========================================================================

	/**
	 * Queries the Docker daemon for the container's actual state.
	 * No instance needed — creates a temporary DockerManager to check.
	 */
	static async getStatus(): Promise<EngineBackendStatus> {
		const dm = new DockerManager();
		const status = await dm.getStatus();
		return {
			state: status.state === 'no-docker' ? 'not-installed' : status.state,
			version: status.version,
			publishedAt: status.publishedAt,
			installPath: null, // Docker images don't have a local install path
		};
	}

	// =========================================================================
	// HELPERS
	// =========================================================================

	/**
	 * Resolves a version spec to a Docker image tag.
	 * 'prerelease' is looked up from the cached GHCR tag list.
	 *
	 * @param versionSpec - 'latest', 'prerelease', or a specific semver tag.
	 * @returns The resolved Docker image tag.
	 */
	private resolveImageTag(versionSpec: string): string {
		if (versionSpec === 'latest') return 'latest';
		if (versionSpec === 'prerelease') {
			const tag = cachedDockerTags.find((t) => t.includes('prerelease') || t.includes('-pre'));
			if (!tag) throw new Error('No prerelease tags available. Try refreshing versions.');
			return tag;
		}
		return versionSpec;
	}

	// =========================================================================
	// STATIC ioControl — panel commands
	// =========================================================================

	/**
	 * Resolves 'prerelease' to an actual GHCR tag from the global cache.
	 * Static variant of resolveImageTag for use in ioControl (no instance).
	 *
	 * @param versionSpec - 'latest', 'prerelease', or a specific semver tag.
	 * @returns The resolved Docker image tag.
	 */
	private static resolveTag(versionSpec: string): string {
		if (versionSpec === 'latest') return 'latest';
		if (versionSpec === 'prerelease') {
			const tag = cachedDockerTags.find((t) => t.includes('prerelease') || t.includes('-pre'));
			if (!tag) throw new Error('No prerelease tags available. Try refreshing versions.');
			return tag;
		}
		return versionSpec;
	}

	/**
	 * Handles Docker panel commands (install, remove, start, stop, update, test).
	 * Creates a temporary DockerManager for each call — no persistent state needed.
	 *
	 * @param _mode - Connection mode (unused, always 'docker').
	 * @param command - The command: 'install' | 'remove' | 'start' | 'stop' | 'update' | 'test'.
	 * @param params - Optional params; install/update accept `version`.
	 * @param onProgress - Optional callback for progress messages.
	 * @returns Result with success flag and optional data/error.
	 */
	static async ioControl(_mode: ConnectionMode, command: string, params?: Record<string, unknown>, onProgress?: IoProgressCallback): Promise<IoControlResult> {
		const dm = new DockerManager();
		const progress = onProgress ?? (() => {});
		try {
			switch (command) {
				case 'install': {
					const version = EngineDocker.resolveTag((params?.version as string) || 'latest');
					onProgress?.('Pulling image...');
					await dm.install(version, progress);
					EngineDocker.writeVersionFile(version);
					return { success: true, data: { imageTag: version } };
				}
				case 'remove':
					onProgress?.('Removing container and image...');
					await dm.remove(true);
					EngineDocker.deleteVersionFile();
					return { success: true };
				case 'start':
					onProgress?.('Starting container...');
					await dm.start();
					return { success: true };
				case 'stop':
					onProgress?.('Stopping container...');
					await dm.stop();
					return { success: true };
				case 'update': {
					const version = EngineDocker.resolveTag((params?.version as string) || 'latest');
					onProgress?.('Pulling updated image...');
					await dm.update(version, progress);
					EngineDocker.writeVersionFile(version);
					return { success: true, data: { imageTag: version } };
				}
				case 'test': {
					// Dynamic require — avoids bundling the SDK into the webview; only used at runtime
					const { RocketRideClient } = require('rocketride');
					const client = new RocketRideClient({ persist: false });
					// Local Docker doesn't need a real API key — any non-empty string works
					await client.connect('MYAPIKEY', { uri: `http://localhost:${CONTAINER_PORT}`, timeout: 10000 });
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
