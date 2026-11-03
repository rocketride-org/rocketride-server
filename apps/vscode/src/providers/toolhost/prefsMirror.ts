// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PREFS MIRROR — the extension host's workspace manager
// =============================================================================
//
// VS Code had NO workspace manager, which is why PrefsBag existed: with no
// manager, Mementos were the only store available, and the extension's prefs
// were a parallel mechanism to the browser shell's. This file closes that —
// the SAME WorkspaceStore the browser root runs, instantiated here over the
// extension's connection, serving the same two ops onto the same retained
// topics. One prefs API for every app, as decided.
//
// Consequence worth stating: extension prefs now live in the server's file
// store (`.workspace/`), not in Mementos, so they roam with the server rather
// than with the local VS Code install — and the extension and the cloud shell
// share one bag per app. That is the point of unifying them.
//
// Deep imports on purpose: ext-host-safe `.ts` leaves only (see busHost.ts).
// =============================================================================

import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import { WorkspaceStore, SHELL_PARTITION } from 'shell/src/workspace/workspaceStore';
import type { Partition } from 'shell/src/workspace/workspaceStore';
import { prefsTopic, settingsTopic } from 'shell/src/components/workspace/prefsStore';
import type { HostOpMap } from 'shared/ops/hostOps';
import type { IRetainedRegistry } from 'shell/src/ops/retained';
import type { ConnectionManager } from '../../connection/connection';

/** What the mirror needs from the host. */
export interface IPrefsMirrorDeps {
	/** The root op bus — the two prefs ops register here. */
	bus: IOpBus;
	/** The root's retained registry — where the per-partition topics live. */
	retained: IRetainedRegistry;
	/** The development connection; the store writes through its client. */
	connectionManager: ConnectionManager;
}

/**
 * Starts the extension host's workspace manager and its prefs mirror.
 *
 * @param deps - See {@link IPrefsMirrorDeps}.
 * @returns The store (for synchronous host-side reads) and a disposer.
 */
export function startPrefsMirror(deps: IPrefsMirrorDeps): { store: WorkspaceStore; dispose(): void } {
	const { bus, retained, connectionManager } = deps;

	// `defaultAppId` names the active partition, which only matters to a
	// shell with an app surface — the extension host has none, and never
	// mutates that partition. `headless` keeps the placeholder purely
	// in-memory: no read probe at load, no file ever materialized —
	// `.workspace/` holds one `<appId>.workspace.json` per REAL app only.
	// (global.json's `activeAppId` is written but read by nobody, so the
	// two hosts cannot fight over it.)
	const store = new WorkspaceStore({ defaultAppId: 'vscode', headless: true });

	// One change signal republishes BOTH of a partition's topics — the store
	// notifies on pref AND settings changes through the same seam.
	const publish = (partition: Partition): void => {
		retained.publish(prefsTopic(partition), store.prefsFor(partition));
		retained.publish(settingsTopic(partition), store.settingsFor(partition));
	};
	const offPrefs = store.onPrefsChanged(publish);

	const syncConnection = (): void => store.setConnection(connectionManager.getClient() ?? null, connectionManager.isConnected());
	syncConnection();
	const events = ['shell:connected', 'shell:disconnected', 'shell:statusChange'] as const;
	for (const event of events) connectionManager.on(event, syncConnection);

	const impls: OpImplTable<HostOpMap> = {
		'shell.setPref': async (p) => {
			store.setPref(p.partition, p.key, p.value);
		},
		// Always publishes, even for an empty bag — the realm's `ready` hangs
		// otherwise, and an app with no saved prefs is the common case.
		'shell.prefs.attach': async (p) => {
			await store.ensurePartition(p.partition);
			publish(p.partition);
		},
		'shell.updateSetting': async (p) => {
			store.updateSetting(p.partition, p.key, p.value);
		},
		'shell.settings.attach': async (p) => {
			await store.ensurePartition(p.partition);
			publish(p.partition);
		},
	};
	registerOpHandlers<HostOpMap>(bus, impls);

	// The shell partition has no file of its own to wait for — publish it now
	// so chrome reading theme/sidebarMode is not blocked on a connection.
	publish(SHELL_PARTITION);

	return {
		store,
		dispose() {
			offPrefs();
			for (const event of events) connectionManager.off(event, syncConnection);
			store.dispose();
		},
	};
}

