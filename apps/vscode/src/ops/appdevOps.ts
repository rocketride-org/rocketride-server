// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APPDEV OPS — the VS Code extension host's app-scaffold implementations
// =============================================================================
//
// The vocabulary is declared in shared/ops/appdevOps.ts; this host scaffolds
// into the OPEN WORKSPACE (apps/<name>/) and opens the App Builder on the
// new app's .rrapp file — both ext-host capabilities. The identity push
// keeps a modeless wizard honest across login/logout.
// =============================================================================

import * as vscode from 'vscode';
// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { AppDevOpMap } from 'shared/ops/appdevOps';
import type { NewAppIdentity } from 'shared/tools/appdev/types';
import type { ConnectionManager } from '../connection/connection';
import { listAppFolders, scaffoldApp } from '../appdev/scaffolder';

/** The developer id applied when the org has none or the connection is local/offline. */
const DEFAULT_DEVELOPER_ID = 'local';

/** What the registrations need from the host. */
interface IAppDevOpsDeps {
	context: vscode.ExtensionContext;
	connectionManager: ConnectionManager;
	/** Fire-and-forget op to every attached realm (BusHost.broadcastEmitOp). */
	broadcast: (op: string, params: unknown) => void;
}

/**
 * Registers the app-scaffold ops and the identity change feed (disposed via
 * context.subscriptions).
 */
export function registerVscodeAppDevOps(bus: IOpBus, deps: IAppDevOpsDeps): void {
	const { context, connectionManager, broadcast } = deps;

	/**
	 * Resolves the developer id from the connected server's account info.
	 * Falls back to 'local' when there is no connection, no organization, or
	 * no developer id set — the historical appManifest.publisher default.
	 */
	const resolveDeveloperId = (): { developerId: string; source: 'organization' | 'default' } => {
		const client = connectionManager.getClient();
		if (!client || !connectionManager.isConnected()) {
			return { developerId: DEFAULT_DEVELOPER_ID, source: 'default' };
		}
		const accountInfo = client.getAccountInfo() as { organization?: { developerId?: string } } | null;
		const developerId = accountInfo?.organization?.developerId;
		return developerId ? { developerId, source: 'organization' } : { developerId: DEFAULT_DEVELOPER_ID, source: 'default' };
	};

	const buildIdentity = async (): Promise<NewAppIdentity> => {
		const { developerId, source } = resolveDeveloperId();
		return {
			developerId,
			source,
			workspaceOpen: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			existingFolders: await listAppFolders(),
		};
	};

	const impls: OpImplTable<AppDevOpMap> = {
		'host.appdev.identity': () => buildIdentity(),
		'host.appdev.scaffold': async (p) => {
			// Resolve the developer id NOW — the wizard is modeless, so the
			// form may have been open across a login/logout. scaffoldApp
			// re-validates the id + folder and opens the App Builder itself.
			const developerId = resolveDeveloperId().developerId;
			await scaffoldApp({
				appId: `${developerId}.${p.appName}`,
				appName: p.displayName,
				frame: p.frame,
			});
		},
	};
	registerOpHandlers<AppDevOpMap>(bus, impls);

	// A login/logout while the modeless wizard sits open changes the linkage
	// name — push the fresh identity to every realm.
	const push = (): void => {
		void buildIdentity().then(
			(identity) => broadcast('host.appdev.identityChanged', identity),
			() => { /* best effort — the page can re-pull */ }
		);
	};
	for (const event of ['shell:statusChange', 'shell:accountUpdate'] as const) {
		connectionManager.on(event, push);
		context.subscriptions.push({ dispose: () => connectionManager.off(event, push) });
	}
}
