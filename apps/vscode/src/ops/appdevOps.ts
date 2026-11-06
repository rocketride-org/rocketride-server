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
	/** Closes the UNBOUND (untitled) App Builder panel, if one is open —
	 *  the wizard's Cancel, and the retire step after a scaffold succeeds. */
	closeWizard: () => void;
}

/**
 * Registers the app-scaffold ops and the identity change feed (disposed via
 * context.subscriptions).
 */
export function registerVscodeAppDevOps(bus: IOpBus, deps: IAppDevOpsDeps): void {
	const { context, connectionManager, broadcast, closeWizard } = deps;

	/** A developer id claimed from the wizard this session, keyed by org. The
	 *  account info is captured at login, so it won't show the claim until a
	 *  reconnect — this bridges the gap if the status lookup lags too. */
	let claimed: { orgId: string | undefined; developerId: string } | null = null;

	/**
	 * Resolves the developer id: the login-time account info first, then a
	 * live developer_status lookup (catches a claim made since login). Falls
	 * back to 'local' when there is no connection, no organization, or no
	 * developer id set — the historical appManifest.publisher default.
	 * canRegisterDeveloper is true only when the server answered and the org
	 * has no id yet (OSS servers always carry one; a failed lookup hides the form).
	 */
	const resolveDeveloperId = async (): Promise<{ developerId: string; source: 'organization' | 'default'; canRegisterDeveloper: boolean }> => {
		const fallback = { developerId: DEFAULT_DEVELOPER_ID, source: 'default' as const, canRegisterDeveloper: false };
		const client = connectionManager.getClient();
		if (!client || !connectionManager.isConnected()) return fallback;
		const accountInfo = client.getAccountInfo() as { organization?: { developerId?: string } } | null;
		const fromLogin = accountInfo?.organization?.developerId;
		if (fromLogin) return { developerId: fromLogin, source: 'organization', canRegisterDeveloper: false };
		if (claimed && claimed.orgId === client.getOrgId()) return { developerId: claimed.developerId, source: 'organization', canRegisterDeveloper: false };
		try {
			const status = await client.developerStatus();
			if (status?.developerId) return { developerId: status.developerId, source: 'organization', canRegisterDeveloper: false };
			return { ...fallback, canRegisterDeveloper: true };
		} catch {
			return fallback;
		}
	};

	const buildIdentity = async (): Promise<NewAppIdentity> => {
		const { developerId, source, canRegisterDeveloper } = await resolveDeveloperId();
		return {
			developerId,
			source,
			workspaceOpen: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			existingFolders: await listAppFolders(),
			canRegisterDeveloper,
		};
	};

	const impls: OpImplTable<AppDevOpMap> = {
		'host.appdev.identity': () => buildIdentity(),
		'host.appdev.scaffold': async (p) => {
			// Resolve the developer id NOW — the wizard is modeless, so the
			// form may have been open across a login/logout. scaffoldApp
			// re-validates the id + folder and opens the App Builder itself.
			const developerId = (await resolveDeveloperId()).developerId;
			await scaffoldApp({
				appId: `${developerId}.${p.appName}`,
				appName: p.displayName,
				frame: p.frame,
			});
			// The real builder is open — retire the untitled document.
			closeWizard();
		},
		'host.appdev.registerDeveloper': async (p) => {
			const client = connectionManager.getClient();
			if (!client || !connectionManager.isConnected()) throw new Error('Not connected to server');
			const requested = p.developerId.trim();
			if (!requested) throw new Error('Enter a developer id');
			const res = (await client.registerDeveloper(requested)) as { developerId?: string } | undefined;
			claimed = { orgId: client.getOrgId(), developerId: res?.developerId || requested };
			// Every open wizard (and this caller) picks up the new linkage name.
			const identity = await buildIdentity();
			broadcast('host.appdev.identityChanged', identity);
			return identity;
		},
		'host.appdev.closeWizard': async () => closeWizard(),
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
