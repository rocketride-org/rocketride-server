/**
 * High-level runtime lifecycle service.
 *
 * Exposes install / start / stop / delete / list as a programmatic API.
 * All console output is replaced by typed callbacks; errors are thrown
 * as RuntimeManagementError (or subclasses).
 *
 * The CLI layer delegates here and maps callbacks to terminal output.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { satisfies, valid as semverValid, rcompare } from 'semver';

import { downloadRuntime } from './downloader.js';
import { rocketrideHome, runtimeBinary, runtimesDir, logsDir } from './paths.js';
import { normalizeVersion } from './platform.js';
import { findAvailablePort } from './ports.js';
import { spawnRuntime, stopRuntime, waitReady } from './process.js';
import { getCompatRange, resolveCompatibleVersion, resolveDockerTag, listCompatibleVersions } from './resolver.js';
import { StateDB, InstanceRecord, isPidAlive, isRuntimeProcess } from './state.js';
import { DockerRuntime } from './docker.js';
import { RuntimeManagementError, RuntimeNotFoundError } from '../exceptions/index.js';

// ── Public interfaces ──────────────────────────────────────────────

export interface VersionStatus {
	version: string;
	prerelease: boolean;
	publishedAt: string;
	installed: boolean;
	instances: Array<{ id: string; port: number; running: boolean }>;
}

export interface InstallOptions {
	version?: string;
	type?: 'Local' | 'Service' | 'Docker';
	force?: boolean;
	port?: number;
	allowDuplicate?: boolean;
	onProgress?: (msg: string, pct?: number) => void;
}

export interface StartOptions {
	port?: number;
	onProgress?: (msg: string) => void;
}

export interface DeleteOptions {
	purge?: boolean;
	onProgress?: (msg: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function retryRmSync(dir: string, maxAttempts: number = 5): Promise<boolean> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return true;
		} catch {
			if (attempt < maxAttempts - 1) await sleep(1000);
		}
	}
	return false;
}

// ── Service ────────────────────────────────────────────────────────

export class RuntimeService {
	/**
	 * Install a runtime binary (or Docker image) and register an instance.
	 */
	async install(opts?: InstallOptions): Promise<InstanceRecord> {
		const { version: versionArg, type: instType = 'Service', force = false, port: explicitPort, allowDuplicate = false, onProgress } = opts ?? {};

		let version = versionArg ? normalizeVersion(versionArg) : null;

		// ── Docker install ──────────────────────────────────────────
		if (instType === 'Docker') {
			return this.installDocker(version, explicitPort ?? null, allowDuplicate, onProgress);
		}

		// ── Local / Service install ─────────────────────────────────

		// Resolve keyword specs
		if (version === 'latest' || version === 'prerelease') {
			onProgress?.(`Resolving ${version} version...`);
			version = await resolveDockerTag(version);
		}

		if (version) {
			// Check if already installed (unless allowDuplicate)
			if (!allowDuplicate) {
				const db = new StateDB();
				db.open();
				try {
					const existing = db.findByVersionAndType(version, instType);
					if (existsSync(runtimeBinary(version)) && existing) {
						return existing;
					}
				} finally {
					db.close();
				}
			}

			// Validate compat range (unless --force)
			if (!force) {
				const compat = getCompatRange();
				const baseV = version
					.replace(/-prerelease$/, '')
					.replace(/-beta$/, '')
					.replace(/-alpha$/, '')
					.replace(/-rc.*$/, '');
				if (semverValid(baseV) && !satisfies(baseV, compat)) {
					throw new RuntimeManagementError(`Runtime v${version} is not compatible with this SDK (requires ${compat}). Use force option to install anyway.`);
				}
			}
		} else {
			onProgress?.('Resolving latest compatible version...');
			const compat = getCompatRange();
			version = await resolveCompatibleVersion(compat);
		}

		// Download binary if not present
		const binary = runtimeBinary(version);
		if (!existsSync(binary)) {
			await downloadRuntime(version, {
				onProgress: (downloaded, total) => {
					const dlStr = formatSize(downloaded);
					if (total) {
						const pct = Math.floor((downloaded * 100) / total);
						onProgress?.(`Downloading runtime v${version}... ${pct}% (${dlStr}/${formatSize(total)})`, pct);
					} else {
						onProgress?.(`Downloading runtime v${version}... ${dlStr}`);
					}
				},
				onPhase: (phase) => {
					if (phase === 'extracting') {
						onProgress?.(`Extracting runtime v${version}...`);
					}
				},
			});
		}

		// Register in state DB
		const db = new StateDB();
		db.open();
		let instanceId: string;
		try {
			if (allowDuplicate) {
				instanceId = db.nextId();
			} else {
				const existing = db.findByVersionAndType(version, instType);
				instanceId = existing ? existing.id : db.nextId();
			}
			db.register(instanceId, 0, 0, version, 'cli', 0, 'stopped', instType);
		} finally {
			db.close();
		}

		onProgress?.(`Installed runtime v${version} (id: ${instanceId})`);

		// Service type auto-starts
		if (instType === 'Service') {
			const port = explicitPort ?? (await findAvailablePort());
			onProgress?.(`Starting service on port ${port}...`);
			const pid = spawnRuntime(binary, port, instanceId);
			try {
				const stderrLog = join(logsDir(instanceId), 'stderr.log');
				await waitReady(pid, stderrLog, undefined, (line) => onProgress?.(`  ${line}`));
				onProgress?.(`Runtime v${version} is online (port ${port}, PID ${pid})`);

				const db2 = new StateDB();
				db2.open();
				try {
					db2.register(instanceId, pid, port, version!, 'cli', 0, 'running', 'Service');
				} finally {
					db2.close();
				}
			} catch (e) {
				await stopRuntime(pid);
				const db2 = new StateDB();
				db2.open();
				try {
					db2.register(instanceId, 0, 0, version!, 'cli', 0, 'stopped', 'Service');
				} finally {
					db2.close();
				}
				throw new RuntimeManagementError(`Auto-start failed: ${e}`);
			}
		}

		// Return final state
		const db3 = new StateDB();
		db3.open();
		try {
			return db3.get(instanceId)!;
		} finally {
			db3.close();
		}
	}

	/**
	 * Start a stopped runtime instance.
	 */
	async start(instanceId?: string | null, opts?: StartOptions & { version?: string }): Promise<InstanceRecord> {
		const { port: explicitPort, version: versionArg, onProgress } = opts ?? {};
		let version = versionArg ? normalizeVersion(versionArg) : null;

		const db = new StateDB();
		db.open();

		try {
			// Resolve instance ID
			if (!instanceId && version) {
				const existing = db.findByVersion(version);
				if (existing) {
					instanceId = existing.id;
				} else {
					throw new RuntimeNotFoundError(`No instance found for version ${version}. Install one first.`);
				}
			} else if (!instanceId) {
				const all = db.getAll();
				if (all.length > 0) {
					instanceId = all[0].id;
				} else {
					throw new RuntimeNotFoundError('No runtime instances found. Install one first.');
				}
			}

			const existing = db.get(instanceId);
			if (!existing) {
				throw new RuntimeNotFoundError(`No instance found with id: ${instanceId}`);
			}

			// Refuse to start if already running
			if (existing.pid && isPidAlive(existing.pid)) {
				throw new RuntimeManagementError(`Instance ${instanceId} is already running (PID ${existing.pid}, port ${existing.port})`);
			}

			const instType = existing.type || 'Local';

			// Docker start
			if (instType === 'Docker') {
				return this.startDocker(instanceId, existing, db, onProgress);
			}

			if (!version) version = existing.version;

			// Resolve version if still unknown
			if (!version) {
				version = await this.resolveInstalledVersion(onProgress);
			}

			const binary = runtimeBinary(version);
			if (!existsSync(binary)) {
				throw new RuntimeNotFoundError(`Runtime binary not found for v${version}. Install it first.`);
			}

			const port = explicitPort ?? (await findAvailablePort());

			// Track restarts
			let restartCount = 0;
			const prevCount = existing.restart_count ?? 0;
			const logFile = join(logsDir(instanceId), 'stdout.log');
			const hasRunBefore = prevCount > 0 || existsSync(logFile);
			restartCount = hasRunBefore ? prevCount + 1 : 0;

			onProgress?.(`Starting runtime v${version} on port ${port} (id: ${instanceId})...`);
			const pid = spawnRuntime(binary, port, instanceId);

			// Release DB lock before waiting
			db.close();

			try {
				const stderrLog = join(logsDir(instanceId), 'stderr.log');
				await waitReady(pid, stderrLog, undefined, (line) => onProgress?.(`  ${line}`));
				onProgress?.(`Runtime v${version} is online (port ${port}, PID ${pid})`);

				const db2 = new StateDB();
				db2.open();
				try {
					db2.register(instanceId!, pid, port, version, 'cli', restartCount, 'running');
					return db2.get(instanceId!)!;
				} finally {
					db2.close();
				}
			} catch (e) {
				await stopRuntime(pid);
				const db2 = new StateDB();
				db2.open();
				try {
					db2.register(instanceId!, 0, 0, version, 'cli', restartCount, 'stopped');
				} finally {
					db2.close();
				}
				throw new RuntimeManagementError(`Runtime started but health check failed: ${e}`);
			}
		} finally {
			try {
				db.close();
			} catch {
				/* already closed */
			}
		}
	}

	/**
	 * Stop a running runtime instance.
	 */
	async stop(instanceId: string): Promise<void> {
		const db = new StateDB();
		db.open();
		try {
			const inst = db.get(instanceId);
			if (!inst) {
				throw new RuntimeNotFoundError(`No instance found with id: ${instanceId}`);
			}

			const instType = inst.type || 'Local';

			if (instType === 'Docker') {
				const docker = new DockerRuntime();
				docker.stop(instanceId);
				db.register(instanceId, 0, inst.port, inst.version, inst.owner, inst.restart_count ?? 0, 'stopped', 'Docker');
			} else {
				await stopRuntime(inst.pid);
				db.register(instanceId, 0, 0, inst.version, inst.owner, inst.restart_count ?? 0, 'stopped', instType);
			}
		} finally {
			db.close();
		}
	}

	/**
	 * Delete (and optionally purge) a runtime instance.
	 */
	async delete(instanceId: string, opts?: DeleteOptions): Promise<void> {
		const { purge = false, onProgress } = opts ?? {};

		const db = new StateDB();
		db.open();
		try {
			let inst = db.get(instanceId);
			// Try as version string
			if (!inst) {
				inst = db.findByVersion(instanceId, true);
				if (inst) instanceId = inst.id;
			}
			if (!inst) {
				throw new RuntimeNotFoundError(`No instance found with id or version: ${instanceId}`);
			}

			const pid = inst.pid;
			const version = inst.version;
			const instType = inst.type || 'Local';
			const alreadyDeleted = !!inst.deleted;

			const removeLogDir = async () => {
				const logDir = logsDir(instanceId);
				if (!existsSync(logDir)) return;
				const ok = await retryRmSync(logDir);
				if (!ok) {
					onProgress?.(`Warning: could not remove ${logDir} — files may still be locked.`);
				}
			};

			// ── Docker delete ───────────────────────────────────────
			if (instType === 'Docker') {
				const docker = new DockerRuntime();
				if (purge) {
					onProgress?.(`Purging Docker runtime ${instanceId}...`);
					docker.remove(instanceId, true);
					await removeLogDir();
					db.unregister(instanceId);
					onProgress?.(`Purged Docker instance ${instanceId} (container and image removed).`);
				} else {
					if (alreadyDeleted) return;
					onProgress?.(`Removing Docker runtime ${instanceId}...`);
					docker.remove(instanceId, false);
					await removeLogDir();
					db.softDelete(instanceId);
					onProgress?.(`Deleted Docker instance ${instanceId} (container removed, image kept).`);
				}
				return;
			}

			// ── Local / Service delete ──────────────────────────────
			if (purge) {
				// Stop if running
				if (pid && isPidAlive(pid)) {
					onProgress?.(`Stopping running runtime ${instanceId}...`);
					await stopRuntime(pid);
				}

				// Check if other non-deleted instances use same binary
				const allInstances = db.getAll();
				let versionInUse = false;
				for (const other of allInstances) {
					if (other.id === instanceId) continue;
					if (other.version === version) {
						versionInUse = true;
						break;
					}
				}

				// Remove binary directory
				const versionDir = runtimesDir(version);
				if (versionInUse) {
					onProgress?.(`Keeping runtime v${version} binary (still in use by another instance).`);
				} else if (existsSync(versionDir)) {
					const ok = await retryRmSync(versionDir);
					if (ok) {
						onProgress?.(`Removed runtime v${version} from ${versionDir}`);
					} else {
						throw new RuntimeManagementError(`Could not remove ${versionDir} — files may still be locked. Try again shortly.`);
					}
				}

				await removeLogDir();
				db.unregister(instanceId);
				onProgress?.(`Purged instance ${instanceId}.`);
			} else {
				// Soft delete
				if (alreadyDeleted) return;

				if (pid && isPidAlive(pid)) {
					onProgress?.(`Stopping running runtime ${instanceId}...`);
					await stopRuntime(pid);
				}

				await removeLogDir();
				db.softDelete(instanceId);
				onProgress?.(`Deleted instance ${instanceId}.`);
			}
		} finally {
			db.close();
		}
	}

	/**
	 * List all non-deleted instances.
	 */
	list(): InstanceRecord[] {
		const db = new StateDB();
		db.open();
		try {
			return db.getAll();
		} finally {
			db.close();
		}
	}

	/**
	 * Get a single instance by ID.
	 */
	get(instanceId: string): InstanceRecord | null {
		const db = new StateDB();
		db.open();
		try {
			return db.get(instanceId);
		} finally {
			db.close();
		}
	}

	/**
	 * Get all currently running instances (verified alive).
	 */
	getRunning(): InstanceRecord[] {
		const db = new StateDB();
		db.open();
		try {
			const all = db.getAll();
			const running: InstanceRecord[] = [];
			for (const inst of all) {
				if (inst.pid === 0) continue;
				if (inst.type === 'Docker') {
					try {
						const docker = new DockerRuntime();
						const ds = docker.getStatus(inst.id);
						if (ds.state === 'running') running.push(inst);
					} catch {
						// skip
					}
				} else if (isRuntimeProcess(inst.pid)) {
					running.push(inst);
				}
			}
			return running;
		} finally {
			db.close();
		}
	}

	/**
	 * List available runtime versions (from GitHub) cross-referenced with
	 * locally installed instances.
	 */
	async listVersions(opts?: { includePrerelease?: boolean }): Promise<VersionStatus[]> {
		const includePrerelease = opts?.includePrerelease ?? false;
		const compatRange = getCompatRange();
		const versions = await listCompatibleVersions(compatRange, includePrerelease);

		// Get all local instances for cross-reference
		const db = new StateDB();
		db.open();
		let allInstances: InstanceRecord[];
		try {
			allInstances = db.getAll();
		} finally {
			db.close();
		}

		const results: VersionStatus[] = [];
		for (const vi of versions) {
			const binary = runtimeBinary(vi.version);
			const installed = existsSync(binary);

			const instances: VersionStatus['instances'] = [];
			for (const inst of allInstances) {
				if (inst.version !== vi.version) continue;
				let running = false;
				if (inst.pid && inst.pid !== 0) {
					if (inst.type === 'Docker') {
						try {
							const docker = new DockerRuntime();
							running = docker.getStatus(inst.id).state === 'running';
						} catch {
							/* skip */
						}
					} else {
						running = isPidAlive(inst.pid);
					}
				}
				instances.push({ id: inst.id, port: inst.port, running });
			}

			results.push({
				version: vi.version,
				prerelease: vi.prerelease,
				publishedAt: vi.publishedAt,
				installed,
				instances,
			});
		}

		return results;
	}

	// ── Private helpers ─────────────────────────────────────────────

	private async installDocker(version: string | null, explicitPort: number | null, allowDuplicate: boolean, onProgress?: (msg: string, pct?: number) => void): Promise<InstanceRecord> {
		const docker = new DockerRuntime();
		const dockerErr = docker.checkDockerStatus();
		if (dockerErr) {
			throw new RuntimeManagementError(dockerErr);
		}

		const versionSpec = version || 'latest';
		onProgress?.(`Resolving Docker image tag for "${versionSpec}"...`);
		const imageTag = await resolveDockerTag(versionSpec);

		const port = explicitPort ?? (await findAvailablePort());

		const db = new StateDB();
		db.open();
		try {
			if (!allowDuplicate) {
				const existingDocker = db.findByVersionAndType(imageTag, 'Docker');
				if (existingDocker) {
					return existingDocker;
				}
			}
			const instanceId = db.nextId();

			onProgress?.(`Installing Docker runtime (tag: ${imageTag}, port: ${port}, id: ${instanceId})`);
			docker.install(imageTag, instanceId, port, (msg) => onProgress?.(msg));

			db.register(instanceId, 0, port, imageTag, 'cli', 0, 'running', 'Docker');
			onProgress?.(`Installed Docker runtime (id: ${instanceId})`);
			return db.get(instanceId)!;
		} finally {
			db.close();
		}
	}

	private startDocker(instanceId: string, existing: InstanceRecord, db: StateDB, onProgress?: (msg: string) => void): InstanceRecord {
		onProgress?.(`Starting Docker runtime ${instanceId}...`);
		const docker = new DockerRuntime();
		let dockerPort = existing.port;
		try {
			docker.start(instanceId);
		} catch (e: unknown) {
			const msg = String(e);
			if (msg.includes('404') || msg.includes('No such container')) {
				onProgress?.('Container was removed outside the CLI. Re-installing...');
				// Can't use await here since this is called in sync context from start()
				// but port was already available. Keep existing port.
				dockerPort = existing.port;
				docker.install(existing.version, instanceId, dockerPort);
			} else {
				throw new RuntimeManagementError(`Failed to start Docker container: ${e}`);
			}
		}
		db.register(instanceId, 0, dockerPort, existing.version, existing.owner, existing.restart_count ?? 0, 'running', 'Docker');
		return db.get(instanceId)!;
	}

	private async resolveInstalledVersion(onProgress?: (msg: string) => void): Promise<string> {
		const compat = getCompatRange();
		const runtimesRoot = join(rocketrideHome(), 'runtimes');
		const installed: Array<[string, string]> = [];
		if (existsSync(runtimesRoot)) {
			for (const entry of readdirSync(runtimesRoot)) {
				const entryPath = join(runtimesRoot, entry);
				try {
					if (!statSync(entryPath).isDirectory()) continue;
				} catch {
					continue;
				}
				if (!semverValid(entry)) continue;
				if (!satisfies(entry, compat)) continue;
				if (!existsSync(runtimeBinary(entry))) continue;
				installed.push([entry, entry]);
			}
		}
		if (installed.length > 0) {
			installed.sort((a, b) => rcompare(a[0], b[0]));
			const version = installed[0][1];
			onProgress?.(`Using installed runtime v${version}`);
			return version;
		}
		onProgress?.('No compatible runtime installed. Downloading...');
		const version = await resolveCompatibleVersion(compat);
		await downloadRuntime(version);
		onProgress?.(`Downloaded runtime v${version}`);
		return version;
	}
}
