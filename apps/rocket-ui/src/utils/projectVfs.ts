// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * projectVfs — {@link IVirtualFileSystem} adapter over the server project
 * store.
 *
 * Bridges the shell's VFS vocabulary (the one the stock SaveFileDialog
 * browses) onto the projectStore helpers, which prepend PROJECT_DIR and talk
 * to the server over the client's fs* methods. This is the browser host's
 * "RocketVFS" — the VS Code host provides its own adapter over the workspace
 * folder.
 */

import type { RocketRideClient, IVirtualFileSystem } from 'shell';
import { listProjectDir, loadProject, saveProject, renameProject, deleteProject, mkdirProject } from './projectStore';

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds a project-store VFS bound to `client`.
 *
 * The client may be null (not connected yet) — every operation then rejects
 * with "Not connected", which consumers surface inline (e.g. the save
 * dialog's tree notice) instead of crashing.
 *
 * @param client - The connected RocketRide client, or null.
 * @returns A VFS whose paths are relative to the project-store root.
 */
export function createProjectVfs(client: RocketRideClient | null): IVirtualFileSystem {
	/** Returns the client or throws the standard not-connected error. */
	const requireClient = (): RocketRideClient => {
		if (!client) throw new Error('Not connected');
		return client;
	};

	return {
		// Directory listing, normalized to the VFS { name, type } shape.
		list: async (dir: string) => {
			const result = await listProjectDir(requireClient(), dir);
			const entries: { name: string; type: string }[] = result?.entries ?? [];
			return entries.map((e) => ({ name: e.name, type: e.type === 'dir' ? ('dir' as const) : ('file' as const) }));
		},
		read: (path: string) => loadProject(requireClient(), path),
		write: (path: string, content: unknown) => saveProject(requireClient(), path, content),
		rename: (oldPath: string, newPath: string) => renameProject(requireClient(), oldPath, newPath),
		// File deletion only — directory removal goes through rmdirProject,
		// which no VFS consumer needs today.
		delete: (path: string) => deleteProject(requireClient(), path),
		mkdir: (path: string) => mkdirProject(requireClient(), path),
	};
}
