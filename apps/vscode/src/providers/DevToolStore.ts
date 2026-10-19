// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DevToolStore — the pinned dev-tools list, per workspace.
 *
 * A thin wrapper over `context.workspaceState` (the GridConfigStore pattern):
 * one key holding the ordered app-id list a user has added to the sidebar's
 * tool tabs. Pinning is deliberately workspace-local — not server desktop
 * membership — so each workspace keeps its own tool set.
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { readPref, writePref } from './PrefsBag';

/** The system prefs key holding the pinned tool ids (ShellPrefsMap). */
const PINS_KEY = 'devToolPins';

export class DevToolStore {
	/** Fires after every successful add/remove. */
	private changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changeEmitter.event;

	constructor(private context: vscode.ExtensionContext) {}

	/** The pinned tool app ids, in pin order. */
	public getAll(): string[] {
		return readPref<string[]>(this.context, PINS_KEY) ?? [];
	}

	/**
	 * Pins a tool (no-op when already pinned).
	 *
	 * @param appId - The tool's app id.
	 */
	public add(appId: string): void {
		const current = this.getAll();
		if (current.includes(appId)) return;
		writePref(this.context, PINS_KEY, [...current, appId], 'workspace').then(
			() => this.changeEmitter.fire(),
			(err: unknown) => getLogger().error(`[DevToolStore] Failed to persist add: ${err}`),
		);
	}

	/**
	 * Unpins a tool.
	 *
	 * @param appId - The tool's app id.
	 */
	public remove(appId: string): void {
		const current = this.getAll();
		if (!current.includes(appId)) return;
		writePref(this.context, PINS_KEY, current.filter((id) => id !== appId), 'workspace').then(
			() => this.changeEmitter.fire(),
			(err: unknown) => getLogger().error(`[DevToolStore] Failed to persist remove: ${err}`),
		);
	}

	/** Disposes the change emitter. */
	public dispose(): void {
		this.changeEmitter.dispose();
	}
}
