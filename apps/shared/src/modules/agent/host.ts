// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// AGENT HOST — everything the agent needs from the app that mounts it
// =============================================================================

/**
 * The agent lives in shared code and never imports its host. The host (today
 * rocket-ui) builds one AgentHost at startup and hands it over with
 * setAgentHost(); agent code reads it back with getAgentHost(). Tests set a
 * fake host built from the in-memory workspace.
 */

import type { AppErrorRow, ConsoleRow, WatchStatus } from '../../tools/appdev/types';
import type { IWorkspaceFileSystem } from '../vfs/vfsTypes';

// =============================================================================
// THE SEAM
// =============================================================================

/** A running dev session for one app: rebuilds and live console, error and build feeds. */
export interface AgentDevSession {
	/** The app this session serves. */
	readonly appId: string;
	/** Whether a preview is attached, so console and errors are live. */
	readonly previewAttached: boolean;
	/**
	 * Asks for a rebuild. Resolves early when a build is already running (the
	 * rebuild only queues), so callers must watch subscribeWatch for the result.
	 */
	rebuild(): Promise<void>;
	/**
	 * Listens to the preview's console output.
	 *
	 * @param l - Called once per console row.
	 * @returns Unsubscribe function.
	 */
	subscribeConsole(l: (row: ConsoleRow) => void): () => void;
	/**
	 * Listens to the preview's runtime errors.
	 *
	 * @param l - Called once per error row.
	 * @returns Unsubscribe function.
	 */
	subscribeErrors(l: (row: AppErrorRow) => void): () => void;
	/**
	 * Listens to build state changes.
	 *
	 * @param l - Called on every watch status change.
	 * @returns Unsubscribe function.
	 */
	subscribeWatch(l: (s: WatchStatus) => void): () => void;
}

/**
 * The rejection of an editor's save that wrote nothing because the user
 * dropped or replaced its text while it waited its turn (Reload, Discard
 * mine, Overwrite, closing with Don't Save). What waits on it stops: Save &
 * Run runs nothing, a publish publishes nothing, and the agent's edit after
 * Save mine first is refused. It is the user's own doing, so no editor shows
 * it as a failure.
 */
export class SaveDroppedError extends Error {
	constructor(path: string) {
		super(`${path} was not saved: its changes were dropped or replaced while the save waited its turn.`);
		this.name = 'SaveDroppedError';
	}
}

/** The open editors of a path with unsaved changes, as the agent's question about them drives them. */
export interface EditorControl {
	/**
	 * Saves each dirty editor in turn and calls `stored` as each one lands, so a
	 * later one's failure still counts as a change. Rejects when a save fails,
	 * and with SaveDroppedError when the user dropped the buffer while the save
	 * waited its turn.
	 */
	save(stored: () => void): Promise<void>;
	/** Drops the editor's buffer and shows the stored file again. */
	discard(): Promise<void>;
}

/** What the mounting app provides to the agent. */
export interface AgentHost {
	/** The workspace the agent reads and edits; its read-only `.rocketride/` holds the guides. */
	vfs: IWorkspaceFileSystem;
	/**
	 * The workspace's scope ('' for the user's own files, 'team-<id>' for a
	 * team's); a conversation runs only in the scope it started in. Hosts with
	 * one scope leave it out.
	 */
	readonly scopeKey?: string;
	/**
	 * A scope's name for the user (a team's name), when the host has it.
	 *
	 * @param scopeKey - The scope key.
	 * @returns The name, or undefined to name the scope by its id.
	 */
	scopeName?(scopeKey: string): string | undefined;
	/** The open editor that holds a path, for the agent's question about unsaved changes; without it a dirty file is refused. */
	editor?(path: string): EditorControl | null;
	/**
	 * Creates a new app from a template.
	 *
	 * @param req - The app's name, display name and optional template.
	 * @returns The new app's id and its bare folder name under apps/ (e.g. 'daybook-ui', not 'apps/daybook-ui').
	 */
	scaffoldApp(req: { appName: string; displayName: string; template?: 'Blank' | 'Dashboard' }): Promise<{ appId: string; folder: string }>;
	/**
	 * Packs an app folder into a deployable bundle.
	 *
	 * @param folder - The app's bare folder name under apps/ (e.g. 'daybook-ui').
	 * @returns The packed bytes.
	 */
	packApp(folder: string): Promise<Uint8Array>;
	/**
	 * The running dev session for an app.
	 *
	 * @param appId - The app to look up.
	 * @returns The session, or null when none is running.
	 */
	devSession(appId: string): AgentDevSession | null;
	/**
	 * The user's approval mode and grants, live. Without it a run asks for
	 * everything the approval list rates as asking, nothing is always allowed,
	 * and the chat shows no mode switch.
	 */
	approvals?: HostApprovals;
	/**
	 * Opens a workspace file in its editor, for a file link on a turn's card.
	 * Hosts without editors leave it out, and the link does nothing.
	 *
	 * @param path - The workspace path.
	 * @returns Whether an editor opened.
	 */
	openFile?(path: string): Promise<boolean>;
}

// =============================================================================
// APPROVAL SETTINGS — the user's mode and grants, as the agent reads them
// =============================================================================

/**
 * Ask: an action the approval list rates as asking waits for the user's OK.
 * Auto: it runs without asking. Auto judges nothing; it just doesn't ask, and
 * an action the list never allows stays refused.
 */
export type ApprovalMode = 'ask' | 'auto';

/** The routine kinds a card can offer "Always allow" for. Publishing, submitting, removing a deployment and deleting a file are never among them. */
export type Grant = 'schedules' | 'deploymentToggles';

/** The user's approval settings at one moment. */
export interface ApprovalPrefs {
	/** Ask first, or don't ask. */
	readonly mode: ApprovalMode;
	/** The kinds the user has always allowed. */
	readonly grants: Readonly<Record<Grant, boolean>>;
}

/**
 * The user's approval settings as a run sees them. It reads them and hears
 * every change; it can turn a grant on for the user's "Always allow" click,
 * and has no way to set the mode.
 */
export interface ApprovalSettings {
	/**
	 * The settings now.
	 *
	 * @returns The mode and grants.
	 */
	read(): ApprovalPrefs;
	/**
	 * Calls back after every change.
	 *
	 * @param listener - Called with no arguments; read() has the new settings.
	 * @returns The unsubscribe.
	 */
	subscribe(listener: () => void): () => void;
	/**
	 * Turns a grant on. Called only for the user's "Always allow" click.
	 *
	 * @param kind - The grant the card offered.
	 */
	grant(kind: Grant): void;
}

/** The chat's mode switch: the same settings, plus the one thing only the user does, setting the mode. */
export interface ApprovalControls extends ApprovalSettings {
	/**
	 * Sets the mode for every agent chat at once.
	 *
	 * @param mode - Ask first, or don't ask.
	 */
	setMode(mode: ApprovalMode): void;
}

/**
 * The user's approval settings as the host hands them over, as two separate
 * handles: a run gets `run`, which has no way to set the mode, and only UI
 * code gets `controls`.
 */
export interface HostApprovals {
	/** What a run reads, hears and grants through. */
	readonly run: ApprovalSettings;
	/** What the chat's mode switch uses. */
	readonly controls: ApprovalControls;
}

// =============================================================================
// REGISTRY
// =============================================================================

/** The installed host; null until the app calls setAgentHost(). */
let current: AgentHost | null = null;

/**
 * Installs the host. Call once at startup, before any agent runs.
 *
 * @param host - The host to install; replaces any earlier one.
 */
export function setAgentHost(host: AgentHost): void {
	current = host;
}

/**
 * The installed host, or a loud failure when startup never set one.
 *
 * @returns The installed host.
 */
export function getAgentHost(): AgentHost {
	if (!current) throw new Error('The agent host is not configured — rocket-ui sets it at startup.');
	return current;
}

/**
 * The installed host, or null when none is set. For UI that renders in hosts
 * that may not serve the agent; agent code uses getAgentHost().
 *
 * @returns The installed host, or null.
 */
export function findAgentHost(): AgentHost | null {
	return current;
}
