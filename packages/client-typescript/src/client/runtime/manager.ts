/**
 * Runtime lifecycle orchestrator.
 *
 * Implements the auto-spawn decision tree:
 * 1. Check state.db for a running instance -> reuse it
 * 2. Compatible binary installed -> spawn it
 * 3. No binary -> download latest compatible -> spawn
 *
 * Teardown only happens if we started the runtime ourselves.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { satisfies, valid as semverValid, rcompare } from 'semver';
import Database from 'better-sqlite3';
import { downloadRuntime } from './downloader.js';
import { rocketrideHome, runtimeBinary, stateDbPath } from './paths.js';
import { findAvailablePort } from './ports.js';
import { spawnRuntime, stopRuntime, waitHealthy } from './process.js';
import { getCompatRange, resolveCompatibleVersion } from './resolver.js';
import { StateDB } from './state.js';

export class RuntimeManager {
	private instanceId: string | null = null;
	private _port: number | null = null;
	private _weStarted: boolean = false;
	private _version: string = '';
	private originalSigint: NodeJS.SignalsListener | null = null;
	private originalSigterm: NodeJS.SignalsListener | null = null;

	get weStarted(): boolean {
		return this._weStarted;
	}

	get uri(): string | null {
		if (this._port === null) return null;
		return `http://127.0.0.1:${this._port}`;
	}

	/**
	 * Ensure a runtime instance is running.
	 *
	 * Returns [uri, weStarted] where weStarted indicates whether this
	 * manager spawned the instance.
	 */
	async ensureRunning(): Promise<[string, boolean]> {
		const db = new StateDB();
		db.open();

		try {
			// 1. Check for an existing live instance
			const existing = db.findRunning();
			if (existing) {
				if (await RuntimeManager.isRuntimeHealthy(existing.port)) {
					this._port = existing.port;
					this.instanceId = existing.id;
					this._weStarted = false;
					return [this.uri!, false];
				}
				// Stale — stop and mark
				await stopRuntime(existing.pid);
				db.markStopped(existing.id);
			}

			// 2. Find or download a compatible binary
			const binary = await this.resolveBinary();

			// 3. Spawn
			const port = await findAvailablePort();
			const existingRow = db.findByVersion(this._version);
			const instanceId = existingRow ? existingRow.id : db.nextId();

			const pid = spawnRuntime(binary, port, instanceId);

			// 4. Wait for healthy
			try {
				await waitHealthy(port, pid);
			} catch (e) {
				await stopRuntime(pid);
				db.register(instanceId, 0, 0, this._version, 'sdk', 0, 'stopped');
				throw e;
			}

			db.register(instanceId, pid, port, this._version, 'sdk');

			this._port = port;
			this.instanceId = instanceId;
			this._weStarted = true;

			this.registerSignalHandlers();

			return [this.uri!, true];
		} finally {
			db.close();
		}
	}

	/**
	 * Stop the runtime if we started it, and unregister from state.
	 */
	async teardown(): Promise<void> {
		if (!this._weStarted || !this.instanceId) return;

		const db = new StateDB();
		db.open();
		try {
			const inst = db.get(this.instanceId);
			if (inst) {
				await stopRuntime(inst.pid);
				db.markStopped(this.instanceId);
			}
		} finally {
			db.close();
		}

		this.restoreSignalHandlers();
		this._weStarted = false;
		this.instanceId = null;
		this._port = null;
	}

	private static async isRuntimeHealthy(port: number): Promise<boolean> {
		try {
			const resp = await fetch(`http://127.0.0.1:${port}`, {
				signal: AbortSignal.timeout(2000),
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Find an installed compatible binary or download one.
	 */
	private async resolveBinary(): Promise<string> {
		const compat = getCompatRange();
		const runtimesRoot = join(rocketrideHome(), 'runtimes');

		if (existsSync(runtimesRoot)) {
			const installed: Array<[string, string]> = [];
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

			if (installed.length > 0) {
				installed.sort((a, b) => rcompare(a[0], b[0]));
				const bestVersion = installed[0][1];
				this._version = bestVersion;
				return runtimeBinary(bestVersion);
			}
		}

		// Nothing installed — download
		const version = await resolveCompatibleVersion(compat);
		this._version = version;
		return await downloadRuntime(version);
	}

	private registerSignalHandlers(): void {
		const handler = () => this.signalHandler();

		this.originalSigint = (process.listeners('SIGINT')[0] as NodeJS.SignalsListener) ?? null;
		process.on('SIGINT', handler);

		if (process.platform !== 'win32') {
			this.originalSigterm = (process.listeners('SIGTERM')[0] as NodeJS.SignalsListener) ?? null;
			process.on('SIGTERM', handler);
		}
	}

	private restoreSignalHandlers(): void {
		// Remove our handlers — originals are still attached
		process.removeAllListeners('SIGINT');
		if (this.originalSigint) {
			process.on('SIGINT', this.originalSigint);
		}

		if (process.platform !== 'win32') {
			process.removeAllListeners('SIGTERM');
			if (this.originalSigterm) {
				process.on('SIGTERM', this.originalSigterm);
			}
		}

		this.originalSigint = null;
		this.originalSigterm = null;
	}

	/**
	 * Emergency synchronous cleanup on signal.
	 */
	private signalHandler(): void {
		if (!this._weStarted || !this.instanceId) return;

		try {
			const dbPath = stateDbPath();
			if (existsSync(dbPath)) {
				const conn = new Database(dbPath);
				const row = conn.prepare('SELECT pid FROM instances WHERE id = ?').get(this.instanceId) as { pid: number } | undefined;
				if (row && row.pid) {
					try {
						process.kill(row.pid, 'SIGTERM');
					} catch {
						// Already gone
					}
				}
				conn.prepare('UPDATE instances SET pid = 0, port = 0 WHERE id = ?').run(this.instanceId);
				conn.close();
			}
		} catch {
			// Best-effort
		}

		// Re-raise
		process.exit(1);
	}
}
