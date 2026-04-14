/**
 * Docker container lifecycle manager for the RocketRide runtime.
 *
 * Manages pulling images, creating containers, starting, stopping,
 * and removing Docker containers. Shells out to the `docker` CLI.
 */

import { execSync } from 'child_process';
import { DockerNotAvailableError } from '../exceptions/index.js';

const CONTAINER_NAME_PREFIX = 'rocketride-runtime';
const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';
const CONTAINER_PORT = 5565;

function containerName(instanceId: string): string {
	return `${CONTAINER_NAME_PREFIX}-${instanceId}`;
}

function exec(cmd: string): string {
	return execSync(cmd, {
		encoding: 'utf-8',
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	}).trim();
}

function execSilent(cmd: string): { ok: boolean; stdout: string } {
	try {
		const stdout = exec(cmd);
		return { ok: true, stdout };
	} catch {
		return { ok: false, stdout: '' };
	}
}

export interface DockerStatus {
	state: 'running' | 'starting' | 'stopping' | 'stopped' | 'not-installed';
	imageTag: string | null;
}

export class DockerRuntime {
	/**
	 * ARM64 Macs need --platform linux/amd64 since GHCR may not have arm64 builds.
	 */
	private static needsPlatformOverride(): boolean {
		return process.platform === 'darwin' && process.arch === 'arm64';
	}

	isDockerAvailable(): boolean {
		return execSilent('docker info').ok;
	}

	/**
	 * Return null if Docker is ready, or an error message explaining why not.
	 */
	checkDockerStatus(): string | null {
		try {
			exec('docker info');
			return null;
		} catch {
			return 'Docker daemon is not running or not reachable.';
		}
	}

	/**
	 * Pull image, create container, and start it. Returns the container ID.
	 */
	install(imageTag: string, instanceId: string, port: number, onProgress?: (msg: string) => void): string {
		const fullImage = `${IMAGE_BASE}:${imageTag}`;
		const name = containerName(instanceId);
		const platformFlag = DockerRuntime.needsPlatformOverride() ? ' --platform linux/amd64' : '';

		// Pull image
		if (onProgress) onProgress('Pulling image...');
		exec(`docker pull${platformFlag} ${fullImage}`);

		// Create container
		if (onProgress) onProgress('Creating container...');
		const containerId = exec(`docker create --name ${name}` + ` -p 127.0.0.1:${port}:${CONTAINER_PORT}` + ` --restart unless-stopped` + `${platformFlag} ${fullImage}`);

		// Start container
		if (onProgress) onProgress('Starting container...');
		exec(`docker start ${name}`);

		return containerId;
	}

	/**
	 * Start an existing stopped container.
	 */
	start(instanceId: string): void {
		const name = containerName(instanceId);
		exec(`docker start ${name}`);
	}

	/**
	 * Stop a running container. Ignores "already stopped" errors.
	 */
	stop(instanceId: string): void {
		const name = containerName(instanceId);
		const result = execSilent(`docker stop ${name}`);
		if (!result.ok) {
			// Only throw if it's not an "already stopped" / "not found" scenario
			// Re-check — if container doesn't exist, that's fine
			const status = this.getStatus(instanceId);
			if (status.state !== 'stopped' && status.state !== 'not-installed') {
				throw new DockerNotAvailableError(`Failed to stop container ${name}`);
			}
		}
	}

	/**
	 * Force-remove the container, optionally remove the image.
	 */
	remove(instanceId: string, removeImage: boolean = false): void {
		const name = containerName(instanceId);

		let imageTag: string | null = null;
		if (removeImage) {
			const inspect = execSilent(`docker inspect --format "{{.Config.Image}}" ${name}`);
			if (inspect.ok) imageTag = inspect.stdout;
		}

		execSilent(`docker rm -f ${name}`);

		if (removeImage && imageTag) {
			execSilent(`docker rmi ${imageTag}`);
		}
	}

	/**
	 * Return the container state and image tag.
	 */
	getStatus(instanceId: string): DockerStatus {
		const name = containerName(instanceId);

		const result = execSilent(`docker inspect --format "{{.State.Status}}|{{.Config.Image}}" ${name}`);

		if (!result.ok) {
			return { state: 'not-installed', imageTag: null };
		}

		const parts = result.stdout.split('|');
		const dockerState = parts[0];
		let imageTag: string | null = null;
		if (parts[1]) {
			const img = parts[1];
			if (img.includes(':')) {
				imageTag = img.split(':').pop() || null;
			}
		}

		const stateMap: Record<string, DockerStatus['state']> = {
			running: 'running',
			restarting: 'starting',
			removing: 'stopping',
			dead: 'stopping',
		};

		const state = stateMap[dockerState] ?? 'stopped';
		return { state, imageTag };
	}
}
