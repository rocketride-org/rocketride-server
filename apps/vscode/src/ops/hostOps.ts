// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HOST OPS — the VS Code extension host's implementations
// =============================================================================
//
// The `host.*` vocabulary is declared in shared/ops/hostOps.ts; THIS file is
// the extension-host side of it (apps/rocket-ui/src/ops is the cloud side).
// Implementations lean on capabilities only this process has: the system
// browser, the secret/memento stores, the server probe, and the SECOND
// (deploy) connection.
// =============================================================================

import * as vscode from 'vscode';
// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import { assertExternalUrl } from 'shared/ops/hostOps';
import type { HostOpMap, EnvSlotsPayload, EnvSlotState } from 'shared/ops/hostOps';
import type { ConnectionManager } from '../connection/connection';
import { DeployManager } from '../connection/deploy-manager';
import { ConfigManager } from '../config';
import { getStripePublishableKey } from '../providers/shared/stripe-key';
import { readPrefsSnapshot, writePref } from '../providers/PrefsBag';
import { FrameworkProvider } from '../providers/toolhost/frameworkProvider';

/** What the registrations need from the host. */
interface IVscodeHostOpsDeps {
	context: vscode.ExtensionContext;
	connectionManager: ConnectionManager;
	/** Fire-and-forget op to every attached realm (BusHost.broadcastEmitOp). */
	broadcast: (op: string, params: unknown) => void;
}

/**
 * Registers the extension host's `host.*` implementations and starts the
 * env-slot change feed (disposed via context.subscriptions).
 */
export function registerVscodeHostOps(bus: IOpBus, deps: IVscodeHostOpsDeps): void {
	const { context, connectionManager, broadcast } = deps;

	const impls: OpImplTable<HostOpMap> = {
		'host.openExternal': async (p) => {
			await vscode.env.openExternal(vscode.Uri.parse(assertExternalUrl(p.url)));
		},
		'host.stripeKey': async () => {
			const client = connectionManager.getClient();
			if (!client || !connectionManager.isConnected()) return { key: null, reason: 'no-connection' };
			const res = await getStripePublishableKey(client);
			return { key: res.key || null, ...(res.key ? {} : { reason: res.probed ? 'no-billing' : 'probe-failed' }) };
		},
		'host.prefs.snapshot': async () => readPrefsSnapshot(context),
		'host.prefs.set': async (p) => {
			await writePref(context, p.key, p.value, p.scope === 'global' ? 'global' : 'workspace');
		},
		'host.envSlots': async () => envSlotsPayload(connectionManager),
		// `popup` is meaningless here — VS Code has no window-modal surface,
		// so an overlay request degrades to the page (by design).
		'host.openPage': async (p) => {
			if (!FrameworkProvider.openPage(p.page, p.args ?? [])) {
				throw new Error(`Unknown framework page: ${p.page}`);
			}
		},
		// A page that is not open is a no-op; only an unknown NAME rejects.
		'host.closePage': async (p) => {
			if (!FrameworkProvider.closePage(p.page)) {
				throw new Error(`Unknown framework page: ${p.page}`);
			}
		},
		// The bus peer's frame SUMMON: a sidebar event found no live frame.
		'host.openToolPanel': async (p) => {
			await vscode.commands.executeCommand('rocketride.devtool.open', p.appId);
		},
		// The App Builder document for an app (the sidebar's MY APPS rows).
		'host.app.open': async (p) => {
			await vscode.commands.executeCommand('rocketride.app.open', p.appId);
		},
	};
	registerOpHandlers<HostOpMap>(bus, impls);

	// Env-slot change feed: push on either manager's status/account changes.
	// The deploy slot's state lives only in this process (DeployManager is
	// ext-host-only), so the Environment page realm reads it through the ops.
	const push = (): void => broadcast('host.envSlotsChanged', envSlotsPayload(connectionManager));
	const dm = DeployManager.getDeployInstance();
	for (const event of ['shell:statusChange', 'shell:accountUpdate'] as const) {
		connectionManager.on(event, push);
		context.subscriptions.push({ dispose: () => connectionManager.off(event, push) });
		dm.on(event, push);
		context.subscriptions.push({ dispose: () => dm.off(event, push) });
	}
}

// =============================================================================
// ENV SLOT STATE
// =============================================================================

function envSlotsPayload(connectionManager: ConnectionManager): EnvSlotsPayload {
	return {
		shared: DeployManager.getDeployInstance().isSharedMode(),
		slots: [buildEnvSlotState(connectionManager, 'development'), buildEnvSlotState(connectionManager, 'deployment')],
	};
}

/** Live connection + account-derived permission flags for one slot. */
function buildEnvSlotState(connectionManager: ConnectionManager, slot: 'development' | 'deployment'): EnvSlotState {
	const config = ConfigManager.getInstance().getConfig();
	const connectionMode = slot === 'deployment' ? config.deployment.connectionMode : config.development.connectionMode;

	const manager = slot === 'deployment' ? DeployManager.getDeployInstance() : connectionManager;
	const client = manager.getClient();
	const isConnected = !!client && manager.isConnected();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const accountInfo: any = isConnected ? client?.getAccountInfo() : undefined;

	const capabilities: string[] = accountInfo?.capabilities ?? [];
	const org = accountInfo?.organization;
	const isOrgAdmin = (org?.permissions ?? []).includes('org.admin');
	const devTeamId = accountInfo?.devTeam;
	let isTeamAdmin = isOrgAdmin; // org admin → implicit team admin
	if (!isTeamAdmin && devTeamId && org?.teams) {
		const team = org.teams.find((t: { id: string; permissions: string[] }) => t.id === devTeamId);
		isTeamAdmin = team?.permissions?.includes('team.admin') ?? false;
	}

	return {
		slot,
		isConnected,
		isSaas: capabilities.includes('saas'),
		connectionMode,
		isOrgAdmin,
		isTeamAdmin,
		orgId: org?.id,
		teamId: devTeamId,
	};
}
