// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * prefsHost — the browser root's half of the prefs mirror.
 *
 * The manager serves `shell.setPref` / `shell.prefs.attach` on its own bus
 * and publishes one retained topic per partition. The root's OWN React tree
 * then reads prefs exactly the way a webview does — `createPrefsHub(cm)` —
 * because in the root those calls resolve locally (the root bus, the local
 * retained port). One code path for the root, for an App Builder preview
 * iframe, and for a VS Code webview; no "am I the host?" branch anywhere.
 *
 * The VS Code equivalent is apps/vscode/src/providers/toolhost/prefsMirror.ts,
 * which does the same three things against the extension host's bus.
 */

import { useEffect } from 'react';
import { ConnectionManager } from '../connection/connection';
import { registerOpHandlers } from './busOps';
import type { OpImplTable, ShellOpMap, ShellOpSpec } from './busOps';
import { prefsTopic, settingsTopic } from '../components/workspace/prefsStore';
import { SHELL_PARTITION } from '../workspace/workspaceStore';
import type { WorkspaceStore, Partition } from '../workspace/workspaceStore';
import type { SettingValue } from '../components/workspace/types';

/** The prefs + settings ops, declared locally so the shell owns no app's op map. */
interface PrefsHostOpMap extends ShellOpMap {
	'shell.setPref': ShellOpSpec<{ partition: string; key: string; value: unknown }, void>;
	'shell.prefs.attach': ShellOpSpec<{ partition: string }, void>;
	/** Setting override write, partition-routed (absent value = reset/delete). */
	'shell.updateSetting': ShellOpSpec<{ partition: string; key: string; value?: SettingValue }, void>;
	'shell.settings.attach': ShellOpSpec<{ partition: string }, void>;
}

/**
 * Serves the prefs mirror from a {@link WorkspaceStore}.
 *
 * @param store - The manager; the single writer of every partition.
 */
export function usePrefsHost(store: WorkspaceStore): void {
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		// One change signal republishes BOTH of a partition's topics — the
		// store notifies on pref AND settings changes through the same seam.
		const publish = (partition: Partition): void => {
			cm.publish(prefsTopic(partition), store.prefsFor(partition));
			cm.publish(settingsTopic(partition), store.settingsFor(partition));
		};
		const offPrefs = store.onPrefsChanged(publish);

		const impls: OpImplTable<PrefsHostOpMap> = {
			'shell.setPref': async (p) => {
				store.setPref(p.partition, p.key, p.value);
			},
			// Always publishes, even for an empty bag — a realm's `ready`
			// hangs otherwise, and an app with no saved prefs is the norm.
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
		const offOps = registerOpHandlers<PrefsHostOpMap>(cm.ops(), impls);

		// The shell partition waits on no file — publish it immediately so
		// chrome reading theme/sidebarMode is not blocked on a connection.
		publish(SHELL_PARTITION);
		return () => {
			offPrefs();
			offOps();
		};
	}, [store]);
}
