// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * DeployManager — manages the deployment connection.
 *
 * Operates in one of two modes, controlled by the `deployTargetMode` setting:
 *
 *   **Shared mode** (`deployTargetMode === null`, "Deploy to a different target"
 *   unchecked):  The deploy connection proxies to the dev ConnectionManager.
 *   `getClient()`, `isConnected()`, `getConnectionStatus()`, etc. all delegate
 *   to the dev singleton.  Dev connection events are re-emitted under the deploy
 *   manager's own event keys so consumers don't need to know about the sharing.
 *   `connect()` and `disconnect()` are no-ops — the dev connection owns the
 *   lifecycle.
 *
 *   **Independent mode** (`deployTargetMode` has a value):  The deploy manager
 *   runs its own connection with deploy-specific settings (host, API key, mode).
 *   This is the original behavior — a fully independent ConnectionManager
 *   subclass.
 *
 * When the user toggles the checkbox (config change), the manager transitions:
 *   shared → independent:  stops forwarding, connects independently
 *   independent → shared:  disconnects own connection, starts forwarding
 *
 * Architecture:
 *   ConnectionManager  — dev connection (singleton)
 *   DeployManager      — deploy connection (separate singleton, extends ConnectionManager)
 *   Both share:        — ConfigManager, CloudAuthProvider, engine install path
 */

import { ConnectionManager } from './connection';
import type { ConnectionStatus } from '../shared/types';
import type { RocketRideClient } from 'rocketride';

// =============================================================================
// DEPLOY MANAGER
// =============================================================================

export class DeployManager extends ConnectionManager {
	private static deployInstance: DeployManager;

	/** Tracks whether we were in shared mode before a config change. */
	private wasShared: boolean = true;

	/** Bound listeners forwarding dev events → deploy events in shared mode. */
	private forwardHandlers: Map<string, (...args: unknown[]) => void> = new Map();

	private constructor() {
		super('deployment');
	}

	// =========================================================================
	// SINGLETON
	// =========================================================================

	/**
	 * Returns the singleton DeployManager instance.
	 * Separate from ConnectionManager.getInstance() — these are independent connections.
	 */
	public static getDeployInstance(): DeployManager {
		if (!DeployManager.deployInstance) {
			DeployManager.deployInstance = new DeployManager();
		}
		return DeployManager.deployInstance;
	}

	// =========================================================================
	// SHARED vs INDEPENDENT MODE
	// =========================================================================

	/** True when the deploy connection shares the dev connection (connectionMode === null). */
	public isSharedMode(): boolean {
		return this.configManager.getConfig().deployment.connectionMode === null;
	}

	private getDevManager(): ConnectionManager {
		return ConnectionManager.getInstance();
	}

	// =========================================================================
	// EVENT FORWARDING (shared mode)
	// =========================================================================

	/** Events forwarded from the dev connection in shared mode. */
	private static readonly FORWARDED_EVENTS = ['shell:statusChange', 'shell:statusMessage', 'shell:connected', 'shell:disconnected', 'shell:error', 'shell:event', 'shell:accountUpdate', 'shell:servicesUpdated'];

	/**
	 * Subscribes to the dev connection and re-emits events under the deploy
	 * manager's own keys.  Idempotent — safe to call if already forwarding.
	 */
	private startForwarding(): void {
		if (this.forwardHandlers.size > 0) return; // already forwarding

		const dev = this.getDevManager();
		for (const eventName of DeployManager.FORWARDED_EVENTS) {
			const handler = (...args: unknown[]) => this.emit(eventName, ...args);
			this.forwardHandlers.set(eventName, handler);
			dev.on(eventName, handler);
		}
	}

	/** Removes all forwarding listeners from the dev connection. */
	private stopForwarding(): void {
		if (this.forwardHandlers.size === 0) return;

		const dev = this.getDevManager();
		for (const [eventName, handler] of this.forwardHandlers) {
			dev.removeListener(eventName, handler);
		}
		this.forwardHandlers.clear();
	}

	// =========================================================================
	// PUBLIC ACCESSORS — proxy in shared mode
	// =========================================================================

	public override getClient(): RocketRideClient | undefined {
		return this.isSharedMode() ? this.getDevManager().getClient() : super.getClient();
	}

	public override isConnected(): boolean {
		return this.isSharedMode() ? this.getDevManager().isConnected() : super.isConnected();
	}

	public override isConnecting(): boolean {
		return this.isSharedMode() ? this.getDevManager().isConnecting() : super.isConnecting();
	}

	public override isDisconnected(): boolean {
		return this.isSharedMode() ? this.getDevManager().isDisconnected() : super.isDisconnected();
	}

	public override hasCredentials(): boolean {
		return this.isSharedMode() ? this.getDevManager().hasCredentials() : super.hasCredentials();
	}

	public override getConnectionStatus(): ConnectionStatus {
		return this.isSharedMode() ? this.getDevManager().getConnectionStatus() : super.getConnectionStatus();
	}

	public override getHttpUrl(): string {
		return this.isSharedMode() ? this.getDevManager().getHttpUrl() : super.getHttpUrl();
	}

	public override getWebSocketUrl(): string {
		return this.isSharedMode() ? this.getDevManager().getWebSocketUrl() : super.getWebSocketUrl();
	}

	public override getCachedServices(): { services: Record<string, unknown>; servicesError?: string } {
		return this.isSharedMode() ? this.getDevManager().getCachedServices() : super.getCachedServices();
	}

	public override async refreshServices(): Promise<void> {
		if (this.isSharedMode()) return this.getDevManager().refreshServices();
		return super.refreshServices();
	}

	// =========================================================================
	// ENGINE STATUS — no-op in shared mode (dev CM handles it)
	// =========================================================================

	/**
	 * In shared mode the dev ConnectionManager owns the engine lifecycle
	 * and WebSocket connection — the deploy manager must not react to
	 * engine status events or it will open a second connection with
	 * potentially stale deploy credentials.
	 */
	protected override shouldHandleEngineStatus(): boolean {
		return !this.isSharedMode();
	}

	/**
	 * Always register the engine status listener, even in shared mode.
	 * When the user switches from shared → independent, the listener
	 * must already be in place to receive the 'ready' event from the
	 * newly started engine.
	 */
	public override setEngineRegistry(registry: import('../engine').EngineRegistry): void {
		super.setEngineRegistry(registry);
	}

	// =========================================================================
	// CONNECT / DISCONNECT — no-ops in shared mode
	// =========================================================================

	public override async connect(): Promise<void> {
		if (this.isSharedMode()) return; // dev connection owns the lifecycle
		return super.connect();
	}

	public override async disconnect(): Promise<void> {
		if (this.isSharedMode()) return;
		return super.disconnect();
	}


	// =========================================================================
	// INITIALIZATION — start forwarding or connect independently
	// =========================================================================

	public override async initialize(): Promise<void> {
		this.wasShared = this.isSharedMode();

		if (this.wasShared) {
			this.startForwarding();
			// Replay current dev state so listeners don't stay stale
			const devStatus = this.getDevManager().getConnectionStatus();
			this.emit('shell:statusChange', devStatus);
			if (this.getDevManager().isConnected()) {
				this.emit('shell:connected');
			}
			return;
		}

		// Independent mode — normal initialization
		return super.initialize();
	}

	// =========================================================================
	// CONFIG CHANGE — handle transitions between shared and independent
	// =========================================================================

	/**
	 * Handles config changes with four transition cases based on whether
	 * the deploy connection was/is in shared mode (connectionMode === null).
	 *
	 * The key invariant: in shared mode, we forward dev events and don't
	 * own a connection. In independent mode, we own our own WebSocket.
	 * Transitions must tear down the old mode before setting up the new one.
	 */
	protected override async handleConfigurationChanged(): Promise<void> {
		const nowShared = this.isSharedMode();

		if (this.wasShared && nowShared) {
			// Case 1: Stayed shared — dev CM handles its own reconnect, nothing to do
			return;
		}

		if (!this.wasShared && !nowShared) {
			// Case 2: Stayed independent — reconnect with new deploy-specific config
			this.wasShared = nowShared;
			await super.disconnect();
			await this.updateCredentialsStatus();
			await this.connect();
			return;
		}

		if (this.wasShared && !nowShared) {
			// Case 3: Shared -> independent — user just configured a separate deploy target.
			// Must stop forwarding dev events before starting our own connection.
			this.stopForwarding();
			this.wasShared = nowShared;
			await super.disconnect();
			await this.updateCredentialsStatus();
			await this.connect();
			// Ask the registry to reconcile — if the deploy engine is already
			// running it will re-emit 'ready', which handleEngineStatus() picks
			// up and connects the WebSocket.
			if (this.engineRegistry) {
				await this.engineRegistry.reconcile();
			}
			return;
		}

		// Case 4: Independent -> shared — user unchecked "Deploy to a different target".
		// Tear down our own connection and start proxying dev events instead.
		this.wasShared = nowShared;
		await super.disconnect();
		this.startForwarding();

		// Replay current dev state so deploy-side listeners see the correct status
		const devStatus = this.getDevManager().getConnectionStatus();
		this.emit('shell:statusChange', devStatus);
		if (this.getDevManager().isConnected()) {
			this.emit('shell:connected');
		}
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public override async dispose(): Promise<void> {
		this.stopForwarding();
		if (!this.isSharedMode()) {
			return super.dispose();
		}
		// In shared mode, don't dispose the inherited client/manager — we don't own them
		this.removeAllListeners();
	}
}
