// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-registry.ts — Global engine instance registry.
 *
 * Manages one EngineManager per connection mode. The reconciler examines
 * the dev + deploy configurations and ensures exactly the right set of
 * engines are running — starting what's needed, stopping what's not,
 * and leaving alone what's already running with the right config.
 *
 * ConnectionManager and DeployManager don't own engines — they look up
 * the engine for their mode from this registry.
 *
 * Usage:
 *   // On settings change:
 *   await reconcile(devConfig, deployConfig);
 *
 *   // To get the engine for a mode:
 *   const engine = getEngine('service');
 *
 *   // On extension deactivation:
 *   await disposeAll();
 */

import { EventEmitter } from 'events';
import { EngineManager, type EngineManagerConfig, type EngineStatusEvent } from './engine-manager';
import { ConfigManager, type ConnectionMode, type ConnectionGroupConfig } from '../config';
import type { IoControlResult, IoProgressCallback } from './engine-backend';
import { EngineLocal } from './local/engine-local';
import { EngineService } from './service/engine-service';
import { EngineDocker } from './docker/engine-docker';
import { EngineCloud } from './cloud/engine-cloud';
import { EngineOnprem } from './onprem/engine-onprem';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Maps each required connection mode to its group config.
 * Built by the reconciler to determine which engines should be running.
 */
export type EngineNeeds = Map<ConnectionMode, ConnectionGroupConfig>;

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * EngineRegistry — global singleton managing one EngineManager per mode.
 *
 * Events:
 *   'status' → EngineStatusEvent (relayed from any active engine, with mode added)
 */
export class EngineRegistry extends EventEmitter {
	private static instance: EngineRegistry;

	/** One EngineManager per active mode. */
	private readonly engines = new Map<ConnectionMode, EngineManager>();

	/** Directory config passed to EngineManager constructors. */
	private readonly config: EngineManagerConfig;

	private constructor(config: EngineManagerConfig) {
		super();
		this.config = config;
	}

	/** Returns the singleton registry instance. Creates it on first call. */
	static getInstance(config?: EngineManagerConfig): EngineRegistry {
		if (!EngineRegistry.instance) {
			if (!config) throw new Error('EngineRegistry must be initialized with config on first call');
			EngineRegistry.instance = new EngineRegistry(config);
		}
		return EngineRegistry.instance;
	}

	// =========================================================================
	// LOOKUP
	// =========================================================================

	/** Returns the EngineManager for the given mode, or undefined if not running. */
	getEngine(mode: ConnectionMode): EngineManager | undefined {
		return this.engines.get(mode);
	}

	/** Returns all currently active engines. */
	getActiveEngines(): Map<ConnectionMode, EngineManager> {
		return new Map(this.engines);
	}

	// =========================================================================
	// RECONCILER
	// =========================================================================

	/**
	 * Examines the dev and deploy configurations and ensures exactly the
	 * right engines are running.
	 *
	 * - Engines not mentioned by either config are stopped and removed.
	 * - Engines already running for a mentioned mode are left alone.
	 * - Engines needed but not running are created and started.
	 *
	 * @param devConfig - The development connection config.
	 * @param deployConfig - The deployment connection config (null = shared with dev).
	 */
	async reconcile(): Promise<void> {
		const config = ConfigManager.getInstance().getConfig();
		const devMode = config.development.connectionMode;
		const deployMode = config.deployment.connectionMode;

		const needed = new Set<ConnectionMode>();
		if (devMode) needed.add(devMode);
		if (deployMode && deployMode !== devMode) {
			needed.add(deployMode);
		}

		// Pass 1: Stop engines no longer needed.
		// Each backend emits idle/error — ConnectionManagers watching that
		// connectedMode will disconnect their WebSocket clients.
		for (const [mode, engine] of this.engines) {
			if (!needed.has(mode)) {
				await engine.teardown();
				await engine.dispose();
				this.engines.delete(mode);
			}
		}

		// Pass 2: Start/check engines that are needed.
		// Each backend emits ready — ConnectionManagers matching their
		// effectiveMode will connect.
		for (const mode of needed) {
			if (!this.engines.has(mode)) {
				const engine = new EngineManager(this.config);
				engine.on('status', (event: EngineStatusEvent) => {
					this.emit('status', { ...event, mode });
				});
				this.engines.set(mode, engine);
			}

			const group = mode === devMode ? 'development' : 'deployment';
			const groupConfig = config[group];
			const checksum = ConfigManager.getInstance().getGroupChecksum(group);
			const engine = this.engines.get(mode)!;

			const needsRestart = engine.mode !== mode
				|| engine.phase === 'idle'
				|| engine.phase === 'error'
				|| engine.configChecksum !== checksum;

			if (needsRestart) {
				if (engine.mode === mode && engine.phase !== 'idle') {
					// Same mode but config changed — tear down first so it restarts clean
					await engine.teardown();
				}
				await engine.transitionTo(mode, groupConfig, checksum);
			} else {
				// Already running with same config — re-emit status so new/changed connections pick it up
				engine.emitCurrentStatus();
			}
		}
	}

	// =========================================================================
	// OPERATIONS — forwarded to the right engine by mode
	// =========================================================================

	/**
	 * Dispatches a panel command to the right backend class by mode.
	 * Single entry point for all UI-initiated engine operations (install,
	 * update, remove, etc.) that go directly to the backend, not through
	 * a running EngineManager instance.
	 *
	 * @param mode - Target engine mode.
	 * @param command - Backend-specific command string (e.g. 'install', 'update', 'remove').
	 * @param params - Optional command parameters.
	 * @returns Result indicating success/failure and optional data.
	 */
	async ioControl(mode: ConnectionMode, command: string, params?: Record<string, unknown>): Promise<IoControlResult> {
		const onProgress: IoProgressCallback = (message) => {
			this.emit('progress', { mode, command, message });
		};
		switch (mode) {
			case 'local': return EngineLocal.ioControl(mode, command, params, onProgress);
			case 'service': return EngineService.ioControl(mode, command, params, onProgress);
			case 'docker': return EngineDocker.ioControl(mode, command, params, onProgress);
			case 'cloud': return EngineCloud.ioControl(mode, command, params, onProgress);
			case 'onprem': return EngineOnprem.ioControl(mode, command, params, onProgress);
			default: return { success: false, error: `Unknown mode: ${mode}` };
		}
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Stops all engines and clears the registry. */
	async disposeAll(): Promise<void> {
		for (const [mode, engine] of this.engines) {
			try {
				await engine.teardown();
				await engine.dispose();
			} catch {
				// Best effort during shutdown
			}
			this.engines.delete(mode);
		}
	}
}
