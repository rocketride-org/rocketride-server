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
import { DeveloperIdentity, IdentityFeed, STATUS_TIMEOUT_MS, makeRegisterDeveloperHandler, toWizardIdentity } from '../appdev/developerIdentity';
import { getLogger } from '../shared/util/output';

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

	/** Resolves and claims the org's developer id (see appdev/developerIdentity). */
	/** Logs an appdev failure to the RocketRide output channel. */
	const logError = (message: string): void => {
		getLogger().error(`[appdev] ${message}`);
	};
	const developer = new DeveloperIdentity(connectionManager, STATUS_TIMEOUT_MS, logError);

	const buildIdentity = async (): Promise<NewAppIdentity> => {
		// Same resolution scaffolding acts on (resolveForScaffold), so the form
		// shows what Create will do, including a failed lookup.
		return toWizardIdentity(await developer.resolve(), {
			workspaceOpen: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			existingFolders: await listAppFolders(),
		});
	};

	/** Stamps each identity with a revision and pushes only the newest. */
	const feed = new IdentityFeed(buildIdentity, broadcast);

	const impls: OpImplTable<AppDevOpMap> = {
		'host.appdev.identity': () => feed.refresh(false),
		'host.appdev.scaffold': async (p) => {
			// Resolve the developer id NOW — the wizard is modeless, so the
			// form may have been open across a login/logout. scaffoldApp
			// re-validates the id + folder and opens the App Builder itself.
			// A failed live lookup rejects here rather than creating local.<name>.
			const developerId = await developer.resolveForScaffold();
			await scaffoldApp({
				appId: `${developerId}.${p.appName}`,
				appName: p.displayName,
				frame: p.frame,
			});
			// The real builder is open — retire the untitled document.
			closeWizard();
		},
		'host.appdev.registerDeveloper': makeRegisterDeveloperHandler({ identity: developer, feed, log: logError }),
		'host.appdev.closeWizard': async () => closeWizard(),
	};
	registerOpHandlers<AppDevOpMap>(bus, impls);

	// A login/logout while the modeless wizard sits open changes the linkage
	// name — push the fresh identity to every realm.
	const push = (): void => {
		feed.refresh(true).catch((err: unknown) => {
			logError(`identity refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};
	for (const event of ['shell:statusChange', 'shell:accountUpdate'] as const) {
		connectionManager.on(event, push);
		context.subscriptions.push({ dispose: () => connectionManager.off(event, push) });
	}
}
