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
import { scopedFileSystem } from 'shared/modules/vfs/scopedFileSystem';
import { getWorkspaceVfs } from './vfs/workspace';

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Builds a project-store VFS bound to the shared workspace view.
 *
 * Routes through the staged workspace (pipelines mount) so staged
 * (uncommitted) pipeline edits are what consumers see — paths stay
 * relative to the project-store root, and read/write keep the parsed-JSON
 * contract (fsReadJson/fsWriteJson shapes). This is the ONLY pipeline
 * file adapter: every pipeline read/write in the app goes through it.
 *
 * The client may be null (not connected yet) — operations then reject with
 * "Not connected", which consumers surface inline (e.g. the save dialog's
 * tree notice) instead of crashing.
 *
 * @param client - The connected RocketRide client, or null.
 * @returns A VFS whose paths are relative to the project-store root.
 */
export function createProjectVfs(client: RocketRideClient | null): IVirtualFileSystem {
	/** Throws the standard not-connected error when no client exists. */
	const requireConnected = (): void => {
		if (!client) throw new Error('Not connected');
	};
	// step: the pipelines mount of the shared staged view, project-relative
	const view = scopedFileSystem(getWorkspaceVfs(), 'pipelines');

	return {
		// Directory listing, normalized to the VFS { name, type } shape.
		list: async (dir: string) => {
			requireConnected();
			return view.list(dir);
		},
		// async so a requireConnected() failure REJECTS (the documented
		// contract) instead of throwing synchronously.
		read: async (path: string) => {
			requireConnected();
			return JSON.parse(String(await view.read(path)));
		},
		write: async (path: string, content: unknown) => {
			requireConnected();
			// step: mirror fsWriteJson's serialization exactly
			await view.write(path, JSON.stringify(content, null, 2));
		},
		rename: async (oldPath: string, newPath: string) => {
			requireConnected();
			await view.rename(oldPath, newPath);
		},
		// Files AND directories: the view routes by actual kind (folders
		// remove recursively at the backend).
		delete: async (path: string) => {
			requireConnected();
			await view.delete(path);
		},
		mkdir: async (path: string) => {
			requireConnected();
			await view.mkdir(path);
		},
	};
}
