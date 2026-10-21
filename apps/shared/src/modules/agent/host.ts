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

/** Read-only access to the RocketRide guides, by path relative to '.rocketride/'. */
export interface GuideSource {
	/**
	 * Every guide path, relative to '.rocketride/' (e.g. 'docs/ROCKETRIDE_APPS.md').
	 *
	 * @returns The guide paths.
	 */
	paths(): string[];
	/**
	 * Reads one guide.
	 *
	 * @param path - A path from paths().
	 * @returns The guide text.
	 */
	read(path: string): Promise<string>;
}

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

/** What the mounting app provides to the agent. */
export interface AgentHost {
	/** The workspace the agent reads and edits. */
	vfs: IWorkspaceFileSystem;
	/** The RocketRide guides the agent may read. */
	guides: GuideSource;
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
