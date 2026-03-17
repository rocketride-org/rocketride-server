// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * docker-manager.ts - Docker Container Lifecycle Manager
 *
 * Manages the RocketRide engine as a Docker container using the dockerode SDK.
 * Provides install (pull + create + start), start, stop, remove, update, and
 * status operations — the same lifecycle as the OS service manager but backed
 * by Docker instead of NSSM / systemd / launchd.
 */

import Docker from 'dockerode';
import * as net from 'net';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export const CONTAINER_NAME = 'rocketride-engine';
export const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';
export const CONTAINER_PORT = 5565;

export type DockerState = 'not-installed' | 'no-docker' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface DockerStatus {
	state: DockerState;
	version: string | null;
	publishedAt: string | null;
	imageTag: string | null;
}

export type ProgressCallback = (message: string) => void;

// Windows named pipes — Docker Desktop uses 'dockerDesktopLinuxEngine',
// older/standalone installs use 'docker_engine'.
const WINDOWS_PIPES = [
	'//./pipe/dockerDesktopLinuxEngine',
	'//./pipe/docker_engine',
];

export class DockerManager {
	private docker: Docker;
	private readonly logger = getLogger();

	constructor() {
		this.docker = this.createClient();
	}

	/**
	 * Creates a Docker client, auto-detecting the connection.
	 * On Linux/macOS dockerode's defaults work. On Windows we may need
	 * to try multiple named pipe paths.
	 */
	private createClient(socketPath?: string): Docker {
		if (socketPath) {
			return new Docker({ socketPath });
		}
		// Non-Windows: let dockerode auto-detect (/var/run/docker.sock or DOCKER_HOST)
		if (process.platform !== 'win32') {
			return new Docker();
		}
		// Windows with DOCKER_HOST set: let dockerode use it
		if (process.env.DOCKER_HOST) {
			return new Docker();
		}
		// Windows default: try Docker Desktop pipe first
		return new Docker({ socketPath: WINDOWS_PIPES[0] });
	}

	// =========================================================================
	// Docker daemon availability
	// =========================================================================

	async isDockerAvailable(): Promise<boolean> {
		// Try current client first
		try {
			await this.docker.ping();
			return true;
		} catch {
			// On Windows, try alternate pipe paths
			if (process.platform === 'win32' && !process.env.DOCKER_HOST) {
				for (const pipe of WINDOWS_PIPES) {
					try {
						const candidate = new Docker({ socketPath: pipe });
						await candidate.ping();
						// Found a working pipe — switch to it
						this.docker = candidate;
						this.logger.output(`${icons.info} Docker: connected via ${pipe}`);
						return true;
					} catch {
						continue;
					}
				}
			}
			return false;
		}
	}

	// =========================================================================
	// Lifecycle operations
	// =========================================================================

	/**
	 * Pull the image, create a container, and start it.
	 */
	async install(imageTag: string, onProgress?: ProgressCallback): Promise<void> {
		const fullImage = `${IMAGE_BASE}:${imageTag}`;
		this.logger.output(`${icons.info} Docker install: pulling ${fullImage}`);

		// Pull image with progress streaming
		onProgress?.('Pulling image...');
		await this.pullImage(fullImage, onProgress);

		// Create container
		onProgress?.('Creating container...');
		this.logger.output(`${icons.info} Docker install: creating container ${CONTAINER_NAME}`);
		const container = await this.docker.createContainer({
			name: CONTAINER_NAME,
			Image: fullImage,
			ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
			HostConfig: {
				PortBindings: {
					[`${CONTAINER_PORT}/tcp`]: [{ HostPort: String(CONTAINER_PORT) }]
				},
				RestartPolicy: { Name: 'unless-stopped' }
			}
		});

		// Start container
		onProgress?.('Starting container...');
		this.logger.output(`${icons.info} Docker install: starting container`);
		await container.start();
	}

	/**
	 * Start an existing stopped container.
	 */
	async start(): Promise<void> {
		this.logger.output(`${icons.info} Docker: starting container ${CONTAINER_NAME}`);
		const container = this.docker.getContainer(CONTAINER_NAME);
		await container.start();
	}

	/**
	 * Stop a running container.
	 */
	async stop(): Promise<void> {
		this.logger.output(`${icons.info} Docker: stopping container ${CONTAINER_NAME}`);
		const container = this.docker.getContainer(CONTAINER_NAME);
		try {
			await container.stop();
		} catch (err: unknown) {
			// Ignore "container already stopped" errors
			if (!this.isNotModifiedError(err)) throw err;
		}
	}

	/**
	 * Stop and remove the container, optionally remove the image.
	 */
	async remove(removeImage: boolean = false): Promise<void> {
		this.logger.output(`${icons.info} Docker: removing container ${CONTAINER_NAME}`);
		const container = this.docker.getContainer(CONTAINER_NAME);

		// Get image name before removing the container
		let imageName: string | undefined;
		if (removeImage) {
			try {
				const info = await container.inspect();
				imageName = info.Config.Image;
			} catch { /* container may not exist */ }
		}

		// Force-remove the container (stops it if running)
		try {
			await container.remove({ force: true });
		} catch (err: unknown) {
			if (!this.isNotFoundError(err)) throw err;
		}

		// Optionally remove the image
		if (removeImage && imageName) {
			try {
				this.logger.output(`${icons.info} Docker: removing image ${imageName}`);
				await this.docker.getImage(imageName).remove();
			} catch (err) {
				this.logger.output(`${icons.warning} Docker: failed to remove image: ${err}`);
			}
		}
	}

	/**
	 * Update: stop old container, remove it, pull new image, create + start new container.
	 */
	async update(imageTag: string, onProgress?: ProgressCallback): Promise<void> {
		const fullImage = `${IMAGE_BASE}:${imageTag}`;
		this.logger.output(`${icons.info} Docker update: updating to ${fullImage}`);

		// Remove existing container and its image
		onProgress?.('Removing old container and image...');
		await this.remove(true);

		// Pull new image
		onProgress?.('Pulling new image...');
		await this.pullImage(fullImage, onProgress);

		// Create and start new container
		onProgress?.('Creating container...');
		const container = await this.docker.createContainer({
			name: CONTAINER_NAME,
			Image: fullImage,
			ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
			HostConfig: {
				PortBindings: {
					[`${CONTAINER_PORT}/tcp`]: [{ HostPort: String(CONTAINER_PORT) }]
				},
				RestartPolicy: { Name: 'unless-stopped' }
			}
		});

		onProgress?.('Starting container...');
		await container.start();
	}

	// =========================================================================
	// Status
	// =========================================================================

	async getStatus(): Promise<DockerStatus> {
		const empty: DockerStatus = { state: 'not-installed', version: null, publishedAt: null, imageTag: null };

		if (!await this.isDockerAvailable()) {
			return { ...empty, state: 'no-docker' };
		}

		try {
			const container = this.docker.getContainer(CONTAINER_NAME);
			const info = await container.inspect();
			const dockerState = info.State.Status; // running, created, restarting, removing, paused, exited, dead
			const imageTag = this.extractTag(info.Config.Image);

			let state: DockerState;
			switch (dockerState) {
				case 'running':
					// Verify the port is actually responding
					state = await this.isPortOpen() ? 'running' : 'starting';
					break;
				case 'restarting':
					state = 'starting';
					break;
				case 'removing':
				case 'dead':
					state = 'stopping';
					break;
				default: // created, exited, paused
					state = 'stopped';
					break;
			}

			return { state, version: null, publishedAt: null, imageTag };
		} catch (err: unknown) {
			if (this.isNotFoundError(err)) {
				return empty;
			}
			this.logger.output(`${icons.warning} Docker getStatus error: ${err}`);
			return empty;
		}
	}

	// =========================================================================
	// Image pull with progress
	// =========================================================================

	private pullImage(fullImage: string, onProgress?: ProgressCallback): Promise<void> {
		return new Promise((resolve, reject) => {
			this.docker.pull(fullImage, (err: Error | null, stream: NodeJS.ReadableStream) => {
				if (err) {
					reject(this.mapError(err));
					return;
				}
				this.docker.modem.followProgress(
					stream,
					(err: Error | null) => {
						if (err) reject(this.mapError(err));
						else resolve();
					},
					(event: { status?: string; progress?: string }) => {
						if (onProgress && event.status) {
							const msg = event.progress
								? `${event.status}: ${event.progress}`
								: event.status;
							onProgress(msg);
						}
					}
				);
			});
		});
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private extractTag(image: string): string | null {
		// "ghcr.io/rocketride-org/rocketride-engine:3.1.1" -> "3.1.1"
		const colonIndex = image.lastIndexOf(':');
		return colonIndex >= 0 ? image.substring(colonIndex + 1) : null;
	}

	private isPortOpen(port: number = CONTAINER_PORT): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = new net.Socket();
			socket.setTimeout(1000);
			socket.on('connect', () => { socket.destroy(); resolve(true); });
			socket.on('timeout', () => { socket.destroy(); resolve(false); });
			socket.on('error', () => { socket.destroy(); resolve(false); });
			socket.connect(port, 'localhost');
		});
	}

	private isNotFoundError(err: unknown): boolean {
		return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404;
	}

	private isNotModifiedError(err: unknown): boolean {
		return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 304;
	}

	private mapError(err: Error): Error {
		const msg = err.message || '';
		const statusCode = (err as { statusCode?: number }).statusCode;

		if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT') || msg.includes('EPIPE')) {
			return new Error('Docker is not installed or the Docker daemon is not running.');
		}
		if (statusCode === 409) {
			return new Error(`A container named '${CONTAINER_NAME}' already exists. Remove it first.`);
		}
		if (statusCode === 404) {
			return new Error(`Docker image not found. Check that the image tag exists on GHCR.`);
		}
		if (msg.includes('port is already allocated') || msg.includes('address already in use')) {
			return new Error(`Port ${CONTAINER_PORT} is already in use. Stop any existing service on that port.`);
		}
		return err;
	}
}
