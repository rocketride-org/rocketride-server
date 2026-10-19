// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CLIENT OVERRIDES — the ops THIS host answers differently
// =============================================================================
//
// The brokered `client.*` table (shell clientOps.ts) is one shared, generic
// implementation registered at every framework root. A multi-connection host
// answers a few ops with HOST POLICY instead — these register FIRST, and the
// shared table skips them (specific-before-shared):
//
//   - env family: the `connection` dimension resolves dev → the primary
//     manager, deploy → the DeployManager (ext-host-only state).
//
// (The monitor pair is also overridden, but by BusHost itself — cross-realm
// refcounting is broker state, not host policy.)
// =============================================================================

// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { ClientOpMap } from 'shell/src/ops/clientOps';
import type { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';

/** The client for a connection slot — dev is the primary manager; deploy is
 *  the DeployManager singleton (which proxies to dev in shared mode).
 *  Throws the standard not-connected error when the slot has no client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slotClient(connectionManager: ConnectionManager, connection?: 'dev' | 'deploy'): any {
	const manager = connection === 'deploy' ? DeployManager.getDeployInstance() : connectionManager;
	const client = manager.getClient();
	if (!client || !manager.isConnected()) throw new Error('Not connected to server');
	return client;
}

/**
 * Registers this host's `client.*` overrides. Call BEFORE the shared
 * registerClientOps so the hasHandler guard yields to these.
 */
export function registerVscodeClientOverrides(bus: IOpBus, connectionManager: ConnectionManager): void {
	const impls: OpImplTable<ClientOpMap> = {
		'client.account.getEnv': async (p) => slotClient(connectionManager, p.connection).account.getEnv(p.scope, p.scopeId),
		'client.account.setEnv': async (p) => {
			const result = await slotClient(connectionManager, p.connection).account.setEnv(p.scope, p.env, p.scopeId);
			// Env-gate consumers (ProjectProvider) watch the slot's manager.
			const manager = p.connection === 'deploy' ? DeployManager.getDeployInstance() : connectionManager;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(manager as any).emit?.('shell:envKeysChanged');
			return result;
		},
	};
	registerOpHandlers<ClientOpMap>(bus, impls);
}
