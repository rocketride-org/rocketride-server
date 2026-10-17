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

/** The one workspaceState key holding the pinned tool ids. */
const STORAGE_KEY = 'rr.devTools';

export class DevToolStore {
	/** Fires after every successful add/remove. */
	private changeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.changeEmitter.event;

	constructor(private context: vscode.ExtensionContext) {}

	/** The pinned tool app ids, in pin order. */
	public getAll(): string[] {
		return this.context.workspaceState.get<string[]>(STORAGE_KEY, []);
	}

	/**
	 * Pins a tool (no-op when already pinned).
	 *
	 * @param appId - The tool's app id.
	 */
	public add(appId: string): void {
		const current = this.getAll();
		if (current.includes(appId)) return;
		this.context.workspaceState.update(STORAGE_KEY, [...current, appId]).then(
			() => this.changeEmitter.fire(),
			(err: unknown) => console.error(`[DevToolStore] Failed to persist add: ${err}`),
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
		this.context.workspaceState.update(STORAGE_KEY, current.filter((id) => id !== appId)).then(
			() => this.changeEmitter.fire(),
			(err: unknown) => console.error(`[DevToolStore] Failed to persist remove: ${err}`),
		);
	}

	/** Disposes the change emitter. */
	public dispose(): void {
		this.changeEmitter.dispose();
	}
}
