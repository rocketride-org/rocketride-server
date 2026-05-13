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

/**
 * App loader — converts server-provided app entries into runtime
 * AppManifestEntry objects with Module Federation lazy loaders.
 *
 * Used by both bootstrap.tsx (initial probe) and Shell.tsx (post-auth
 * app replacement) to register MF remotes and wrap them with load().
 */

import { registerRemotes, loadRemote } from '@module-federation/runtime';
import type { AppManifestEntry, AppDescriptor, AppSettingDefinition } from '../workspace/types';

/**
 * Shape of an app entry from the server (rrext_public_probe or ConnectResult).
 * Matches the AppManifestEntry from the client SDK but without the load() function.
 */
export interface ServerAppEntry {
	/** Unique app identifier (e.g. "rocketride.hello"). */
	id: string;
	/** Module Federation remote name (e.g. "rocketride_hello"). */
	moduleId: string;
	/** Human-readable app name. */
	name: string;
	/** Short description. */
	description?: string;
	/** URL path to the app's icon. */
	icon?: string;
	/** Category tags. */
	categories?: string[];
	/** App-specific setting definitions. */
	settings?: unknown[];
	/** URL to the MF remote entry file. */
	entry: string;
	/** Whether the app UI requires auth to render. */
	authenticated?: boolean;
	/** Whether to show the header bar. */
	showHeader?: boolean;
	/** Whether to show the status bar. */
	showStatusBar?: boolean;
	/** Whether the app is visible to unauthenticated users. */
	public?: boolean;
}

/**
 * Register server-provided apps as Module Federation remotes and wrap
 * each with a lazy `load()` function.
 *
 * Called at bootstrap with public apps from the server probe, and again
 * after auth with the user's full entitled app set from ConnectResult.
 *
 * @param serverApps - App entries from the server.
 * @returns Array of AppManifestEntry objects ready for the shell.
 */
export function registerAndMapApps(serverApps: ServerAppEntry[]): AppManifestEntry[] {
	// Drop entries missing a remoteEntry URL — the server may include
	// apps that have no built UI yet (e.g. server-only nodes).
	// Without this guard, MF's normalizeRemote crashes on undefined.
	const validApps = serverApps.filter((a) => a.entry);

	// Register all MF remotes so loadRemote() can resolve them.
	// force: true overwrites any previously registered remotes (e.g. from
	// the pre-auth probe) with the post-auth set.
	registerRemotes(
		validApps.map((a) => ({ name: a.moduleId, entry: a.entry })),
		{ force: true },
	);

	// Map server entries to runtime AppManifestEntry objects with lazy loaders
	return validApps.map((a) => ({
		id:            a.id,
		moduleId:      a.moduleId,
		name:          a.name,
		description:   a.description,
		icon:          a.icon,
		categories:    a.categories,
		settings:      (a.settings ?? []) as AppSettingDefinition[],
		authenticated: a.authenticated,
		showHeader:    a.showHeader,
		showStatusBar: a.showStatusBar,
		public:        a.public,
		load: () =>
			(loadRemote(`${a.moduleId}/AppDescriptor`) as Promise<{ default: AppDescriptor }>)
				.then((m) => m.default),
	}));
}
