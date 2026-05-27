// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-manager.ts — Central engine lifecycle state machine.
 *
 * Owns ONE engine backend at a time. When the user changes modes,
 * the manager tears down the current backend and creates a new one.
 * Emits structured EngineStatusEvent for all consumers:
 *   - ConnectionManager → connects WebSocket when phase='ready'
 *   - StatusBar → shows progress/status messages
 *   - Settings panels → enable/disable buttons
 *
 * Usage:
 *   const engine = new EngineManager({ localParentDir, serviceInstallDir });
 *   engine.on('status', (event: EngineStatusEvent) => { ... });
 *   engine.on('terminated', (details) => { ... });
 *   await engine.transitionTo('local', config);
 *   // → emits { phase: 'ready', uri: 'http://localhost:12345' }
 *   await engine.teardown();
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { EngineBackend, type EngineStatusEvent, type EnginePhase, type EngineInfo, type EngineBackendStatus } from './engine-backend';
import { EngineLocal } from './local/engine-local';
import { EngineService } from './service/engine-service';
import { EngineDocker } from './docker/engine-docker';
import { EngineCloud } from './cloud/engine-cloud';
import { EngineOnprem } from './onprem/engine-onprem';
import type { ConnectionMode, ConnectionGroupConfig } from '../config';

// =============================================================================
// TYPES
// =============================================================================

/** Configuration for EngineManager — directories for each mode. */
export interface EngineManagerConfig {
	/** Per-user directory for local engine (e.g., %LOCALAPPDATA%\RocketRide). */
	localParentDir: string;
	/** System-level directory for service engine (e.g., C:\ProgramData\RocketRide). */
	serviceInstallDir: string;
}

// Re-export types that consumers need
export type { EngineStatusEvent, EnginePhase, EngineInfo } from './engine-backend';

// =============================================================================
// ENGINE MANAGER
// =============================================================================

/**
 * EngineManager — drives ONE engine to a target connection mode.
 *
 * Events:
 *   'status'     → EngineStatusEvent (phase/message changes)
 *   'terminated' → { code, signal } (local process died unexpectedly)
 */
export class EngineManager extends EventEmitter {
	private readonly config: EngineManagerConfig;

	/** The active backend (null when idle). */
	private backend: EngineBackend | null = null;

	/** Current connection mode (null when idle). */
	private _mode: ConnectionMode | null = null;

	/** Current phase (mirrors the backend's last emitted phase). */
	private _phase: EnginePhase = 'idle';

	/** Cancellation token for the current in-flight operation. */
	private cts?: vscode.CancellationTokenSource;

	/** Checksum of the group config when this engine was last started. */
	private _configChecksum: number = 0;

	constructor(config: EngineManagerConfig) {
		super();
		this.config = config;
	}

	// =========================================================================
	// PUBLIC API — state
	// =========================================================================

	/** Current connection mode, or null if idle. */
	get mode(): ConnectionMode | null { return this._mode; }

	/** Current lifecycle phase. */
	get phase(): EnginePhase { return this._phase; }

	/** Config checksum from when this engine was last started. */
	get configChecksum(): number { return this._configChecksum; }


	/** The active backend (if any). Useful for mode-specific operations. */
	getBackend(): EngineBackend | null { return this.backend; }

	/** Returns info about the installed engine, or null. */
	getInfo(): EngineInfo | null {
		return this.backend?.getInfo() ?? null;
	}

	/** Asks the backend to re-emit its current status event. */
	emitCurrentStatus(): void {
		this.backend?.emitCurrentStatus();
	}

	// =========================================================================
	// PUBLIC API — lifecycle
	// =========================================================================

	/**
	 * Drives the engine to the target mode. Cancels any in-flight work and
	 * tears down the current backend if the mode is changing.
	 *
	 * @param mode - Target connection mode (local, service, docker, cloud, onprem).
	 * @param config - Connection group config with host URL, API key, engine version, etc.
	 */
	public async transitionTo(mode: ConnectionMode, config: ConnectionGroupConfig, checksum?: number): Promise<void> {
		if (checksum !== undefined) this._configChecksum = checksum;

		this.cancelCurrentOperation();

		if (this._mode !== mode && this.backend) {
			try {
				await this.backend.stop();
			} catch { /* best effort */ }
			await this.backend.dispose();
			this.backend = null;
		}

		this._mode = mode;
		this.cts = new vscode.CancellationTokenSource();

		if (!this.backend) {
			this.backend = this.createBackend(mode);
		}

		try {
			await this.backend.start(config, this.cts.token);
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				this.emitStatus({ phase: 'idle', message: 'Cancelled' });
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			this.emitStatus({ phase: 'error', message: msg, error: msg });
		}
	}

	// install/update/remove are handled by static EngineBackend.ioControl()
	// — they go directly to the backend class, not through EngineManager.

	/**
	 * Removes the current backend entirely (dispose without stop-first semantics).
	 * Used when the user explicitly uninstalls an engine.
	 */
	public async remove(): Promise<void> {
		if (!this.backend) return;
		this.cancelCurrentOperation();

		try {
			await this.backend.dispose();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emitStatus({ phase: 'error', message: msg, error: msg });
		}

		this.backend = null;
		this._mode = null;
	}

	/** Stops and disposes the current backend, resetting the manager to idle. */
	public async teardown(): Promise<void> {
		this.cancelCurrentOperation();

		if (this.backend) {
			try { await this.backend.stop(); } catch { /* best effort */ }
			await this.backend.dispose();
			this.backend = null;
		}

		this._mode = null;
	}

	/** Cancels any in-flight start/install operation via the CancellationToken. */
	public cancelCurrentOperation(): void {
		if (this.cts) {
			this.cts.cancel();
			this.cts.dispose();
			this.cts = undefined;
		}
	}

	/**
	 * Cleans up all resources. Call when the extension is deactivating.
	 */
	public async dispose(): Promise<void> {
		this.cancelCurrentOperation();
		if (this.backend) {
			await this.backend.dispose();
			this.backend = null;
		}
	}

	// =========================================================================
	// BACKEND FACTORY
	// =========================================================================

	/**
	 * Creates the appropriate backend for the given mode.
	 * The status emitter callback relays events from the backend to
	 * EngineManager's EventEmitter so external consumers can listen.
	 */
	private createBackend(mode: ConnectionMode): EngineBackend {
		const emitStatus = (event: EngineStatusEvent) => this.emitStatus(event);

		switch (mode) {
			case 'local':
				return new EngineLocal(this.config.localParentDir, emitStatus);
			case 'service':
				return new EngineService(this.config.serviceInstallDir, emitStatus);
			case 'docker':
				return new EngineDocker(emitStatus);
			case 'cloud':
				return new EngineCloud(emitStatus);
			case 'onprem':
				return new EngineOnprem(emitStatus);
			default:
				throw new Error(`Unknown engine mode: ${mode}`);
		}
	}

	// =========================================================================
	// STATUS RELAY
	// =========================================================================

	/**
	 * Relays a status event from the backend to all listeners.
	 * Also updates the internal phase tracker.
	 */
	private emitStatus(event: EngineStatusEvent): void {
		this._phase = event.phase;
		this.emit('status', event);
	}

	// =========================================================================
	// STATIC STATUS — queries engine state without needing a running instance
	// =========================================================================

	/**
	 * Queries the actual state of the specified engine mode.
	 * No active connection or backend instance required — directly checks
	 * the OS, Docker daemon, filesystem, or probes a remote server.
	 *
	 * @param mode - Which engine mode to query.
	 * @param config - Directories config (needed for local mode to find engine/).
	 * @param hostUrl - Host URL for cloud/onprem probe (optional).
	 */
	static async getEngineStatus(mode: ConnectionMode, config: EngineManagerConfig, hostUrl?: string): Promise<EngineBackendStatus> {
		switch (mode) {
			case 'local':
				return EngineLocal.getStatus(config.localParentDir);
			case 'service':
				return EngineService.getStatus();
			case 'docker':
				return EngineDocker.getStatus();
			case 'cloud':
				return EngineCloud.getStatus(hostUrl);
			case 'onprem':
				return EngineOnprem.getStatus(hostUrl);
			default:
				return { state: 'not-installed', version: null, publishedAt: null, installPath: null };
		}
	}
}
