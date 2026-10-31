// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolStore — the pinned dev-tools list, per workspace.
 *
 * A thin wrapper over ONE key in the `shell` prefs partition: the ordered
 * app-id list a user has added to the sidebar's tool tabs. The host reads the
 * workspace manager directly (it IS the manager's process); webviews see the
 * same key through the mirror.
 */

import * as vscode from 'vscode';
// Deep import on purpose — ext-host-safe .ts leaf (see busHost.ts).
import { appPartition } from 'shell/src/workspace/workspaceStore';
import { PIPE_BUILDER_APP_ID } from '../shared/types';
import type { WorkspaceStore } from 'shell/src/workspace/workspaceStore';
import { readDevToolPins, storeToolIds, DEV_TOOL_PINS_KEY } from 'shell/src/workspace/devToolPins';

// The ONE toolbar list (workspace/devToolPins): order AND tool set in one
// array, `builtin.<id>` for what the bundle carries and a bare app id for a
// store tool. This store speaks STORE TOOL IDS, so it reads the store
// entries out and writes them back into their slots.


export class DevToolStore {
	/** Fires after every successful add/remove. */
	private changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changeEmitter.event;

	constructor(private prefs: WorkspaceStore) {}

	/** The pinned STORE tool app ids, in toolbar order. */
	public getAll(): string[] {
		return storeToolIds(this.readList());
	}

	/** The whole toolbar list (builtins included). */
	private readList(): string[] {
		return readDevToolPins(this.prefs.prefsFor(appPartition(PIPE_BUILDER_APP_ID)));
	}

	/**
	 * Pins a tool (no-op when already pinned).
	 *
	 * @param appId - The tool's app id.
	 */
	public add(appId: string): void {
		const list = this.readList();
		if (list.includes(appId)) return;
		this.prefs.setPref(appPartition(PIPE_BUILDER_APP_ID), DEV_TOOL_PINS_KEY, [...list, appId]);
		this.changeEmitter.fire();
	}

	/**
	 * Unpins a tool.
	 *
	 * @param appId - The tool's app id.
	 */
	public remove(appId: string): void {
		const list = this.readList();
		if (!list.includes(appId)) return;
		this.prefs.setPref(
			appPartition(PIPE_BUILDER_APP_ID),
			DEV_TOOL_PINS_KEY,
			list.filter((id) => id !== appId),
		);
		this.changeEmitter.fire();
	}

	/** Disposes the change emitter. */
	public dispose(): void {
		this.changeEmitter.dispose();
	}
}
