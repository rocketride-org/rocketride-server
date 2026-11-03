// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HOST ENV OPS — the slot-resolved env family (`host.env.*`)
// =============================================================================
//
// The Environment page's env reads/writes carry a `connection` dimension:
// dev resolves to the primary manager, deploy to the DeployManager — state
// that lives ONLY in the extension-host process, which is why these are
// `host.*` ops rather than calls on a realm client (a realm client always
// rides the primary connection's socket).
//
// (The monitor pair is also overridden, but by BusHost itself — cross-realm
// refcounting is broker state, not host policy.)
// =============================================================================

// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { HostOpMap } from 'shared/ops/hostOps';
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
 * Registers this host's slot-resolved `host.env.*` implementations.
 */
export function registerVscodeClientOverrides(bus: IOpBus, connectionManager: ConnectionManager): void {
	const impls: OpImplTable<HostOpMap> = {
		'host.env.get': async (p) => slotClient(connectionManager, p.connection).account.getEnv(p.scope, p.scopeId),
		'host.env.set': async (p) => {
			const result = await slotClient(connectionManager, p.connection).account.setEnv(p.scope, p.env, p.scopeId);
			// Env-gate consumers (ProjectProvider) watch the slot's manager.
			const manager = p.connection === 'deploy' ? DeployManager.getDeployInstance() : connectionManager;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(manager as any).emit?.('shell:envKeysChanged');
			return result;
		},
	};
	registerOpHandlers<HostOpMap>(bus, impls);
}
