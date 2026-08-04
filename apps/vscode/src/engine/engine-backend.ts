// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-backend.ts — Abstract base class and shared types for engine backends.
 *
 * Each connection mode (local, service, docker, cloud, onprem) implements
 * EngineBackend. The EngineManager owns one backend at a time and drives
 * its lifecycle via start/stop/dispose.
 */

import type { ConnectionMode, ConnectionGroupConfig } from '../config';

/**
 * Lifecycle phase of an engine backend.
 * - `idle`    — no engine running
 * - `working` — starting up, installing, or performing a long operation
 * - `ready`   — engine running and accepting connections
 * - `error`   — engine failed; `error` field carries the reason
 */
export type EnginePhase = 'idle' | 'working' | 'ready' | 'error';

/** Structured status event emitted by backends during lifecycle transitions. */
export interface EngineStatusEvent {
	/** Current lifecycle phase. */
	phase: EnginePhase;
	/** Human-readable status message for the UI. */
	message: string;
	/** WebSocket URI when the engine is ready (e.g. `ws://localhost:12345`). */
	uri?: string;
	/** Semantic version of the running engine. */
	version?: string;
	/** Error description when phase is `error`. */
	error?: string;
	/** Optional engine log line (e.g. "Installing wheel...") shown in the sidebar progress log. */
	logLine?: string;
}

/** Callback signature for emitting status events from a backend to its owner. */
export type StatusEmitter = (event: EngineStatusEvent) => void;

/**
 * Snapshot of an engine's installation/runtime state.
 * Returned by static `getStatus()` methods — no running backend required.
 */
export interface EngineBackendStatus {
	/** Runtime state of the engine process or container. */
	state: 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';
	/** Installed semantic version, or null if not installed. */
	version: string | null;
	/** ISO date when this version was published, or null. */
	publishedAt: string | null;
	/** Filesystem path to the engine installation, or null. */
	installPath: string | null;
}

/** Version metadata for a running engine. */
export interface EngineInfo {
	/** Semantic version string. */
	version: string;
	/** ISO date when this version was published. */
	publishedAt: string;
}

/** Result of an `ioControl` operation dispatched to a backend. */
export interface IoControlResult {
	/** Whether the operation succeeded. */
	success: boolean;
	/** Error message if the operation failed. */
	error?: string;
	/** Arbitrary data returned by the operation. */
	data?: Record<string, unknown>;
}

/** Optional progress callback for long-running ioControl operations. */
export type IoProgressCallback = (message: string) => void;

/**
 * Abstract base class for all engine backends (local, service, docker, etc.).
 *
 * Subclasses implement the lifecycle methods; the base class holds the
 * status emitter so every backend can report phase transitions uniformly.
 */
export abstract class EngineBackend {
	/** Callback to emit status events to the owning EngineManager. */
	protected readonly emitStatus: StatusEmitter;

	constructor(emitStatus: StatusEmitter) {
		this.emitStatus = emitStatus;
	}

	/**
	 * Starts the engine with the given config. May install, download, or
	 * spawn a process depending on the backend.
	 * @param config - Connection group configuration (host, port, keys, etc.).
	 * @param token - Cancellation token to abort long-running startup.
	 */
	abstract start(config: ConnectionGroupConfig, token?: import('vscode').CancellationToken): Promise<void>;

	/** Gracefully stops the engine process/container. */
	abstract stop(): Promise<void>;

	/** Re-emits the backend's current status event (used after reconnect or reconcile). */
	abstract emitCurrentStatus(): void;

	/** Returns version info for the running engine, or null if not available. */
	abstract getInfo(): EngineInfo | null;

	/** Releases all resources held by this backend (processes, watchers, temp files). */
	abstract dispose(): Promise<void>;

}
