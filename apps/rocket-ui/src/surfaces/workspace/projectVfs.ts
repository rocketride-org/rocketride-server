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
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { saveDocumentEditor } from '../../agent/editorControls';
import { getWorkspaceVfs } from './vfs/workspace';

/** The workspace mount that holds pipelines; project-store paths are relative to it. */
const PIPELINES_MOUNT = 'pipelines';

/** The project-store VFS, plus the workspace view's path versions (see IWorkspaceFileSystem). */
export interface ProjectVfs extends IVirtualFileSystem {
	/** Writes a pipeline, serialized as fsWriteJson does; `expect` is the version it was loaded at. */
	write(path: string, content: unknown, origin?: string, expect?: number): Promise<void>;
	readVersioned(path: string, opts?: { stored?: boolean }): Promise<{ content: unknown; version: number }>;
	version(path: string): number;
}

/** The workspace view path of a project-store path ('chat.pipe' is 'pipelines/chat.pipe'). */
export function pipelineViewPath(path: string): string {
	return `${PIPELINES_MOUNT}/${path.replace(/^\/+/, '')}`;
}

/** The newest pipeline write called through a project VFS, whether it landed, and the path's version when it did. */
interface PipelineWrite {
	text: string;
	landed: boolean;
	version?: number;
}

const pipelineWritesByView = new WeakMap<IWorkspaceFileSystem, Map<string, PipelineWrite>>();

/**
 * The newest pipeline write called through a project VFS on each path of a
 * view. It lands once the view keeps it (the store in auto mode, the staging
 * store in manual mode); until then a reload would lose it.
 */
function pipelineWrites(workspace: IWorkspaceFileSystem): Map<string, PipelineWrite> {
	let writes = pipelineWritesByView.get(workspace);
	if (!writes) {
		writes = new Map();
		pipelineWritesByView.set(workspace, writes);
	}
	return writes;
}

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
export function createProjectVfs(client: RocketRideClient | null): ProjectVfs {
	/** Throws the standard not-connected error when no client exists. */
	const requireConnected = (): void => {
		if (!client) throw new Error('Not connected');
	};
	// step: the pipelines mount of the shared staged view, project-relative
	const workspace = getWorkspaceVfs();
	const view = scopedFileSystem(workspace, PIPELINES_MOUNT);

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
		write: async (path: string, content: unknown, origin?: string, expect?: number) => {
			requireConnected();
			// step: mirror fsWriteJson's serialization exactly
			const text = JSON.stringify(content, null, 2);
			const mine: PipelineWrite = { text, landed: false };
			pipelineWrites(workspace).set(pipelineViewPath(path), mine);
			// step: the view counts the write's version when the write is called, so read it
			// before awaiting: mutations queued behind this one move the version meanwhile
			const writing = view.write(path, text, origin, expect);
			mine.version = view.version(path);
			await writing;
			mine.landed = true;
		},
		readVersioned: async (path: string, opts?: { stored?: boolean }) => {
			requireConnected();
			const { content, version } = await view.readVersioned(path, opts);
			return { content: JSON.parse(String(content)), version };
		},
		version: (path: string) => view.version(path),
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

// =============================================================================
// DOCUMENTS — the pipeline tabs' adapter, and the canvas save
// =============================================================================

/** What a canvas save wrote, by Documents URI, while it asks Documents to mark the tab clean. */
const marking = new Map<string, string>();

/** The view version each pipeline object was read or saved at; Documents holds the object as it is. */
const loadedVersions = new WeakMap<object, number>();

/** The version a pipeline object Documents holds was read or saved at; undefined for content this page did not read or save. */
export function loadedVersion(content: unknown): number | undefined {
	return typeof content === 'object' && content !== null ? loadedVersions.get(content) : undefined;
}

/**
 * The content adapter Documents reads and writes pipeline tabs through: the project VFS with
 * Documents' lenient error contract. Reads take the stored pipeline past every unsaved buffer and
 * note its version (loadedVersion). A canvas saves through savePipeline, then asks Documents to
 * mark the tab clean, which lands here with the content just written and is skipped. Any other
 * write (the close dialog's Save) is made by the pipeline's canvas at its loaded version, and
 * rejects when it did not land so Documents keeps the tab open.
 */
export function createDocumentsVfs(client: RocketRideClient | null): IVirtualFileSystem {
	const projectVfs = createProjectVfs(client);
	return {
		list: async (dir: string) => {
			try {
				return await projectVfs.list(dir);
			} catch {
				return [];
			}
		},
		read: async (uri: string) => {
			try {
				const { content, version } = await projectVfs.readVersioned(uri, { stored: true });
				if (typeof content === 'object' && content !== null) loadedVersions.set(content, version);
				return content;
			} catch {
				return null;
			}
		},
		write: async (uri: string, content: unknown) => {
			if (!content) return;
			const text = JSON.stringify(content, null, 2);
			if (marking.get(uri) === text) return;
			const saving = saveDocumentEditor(getWorkspaceVfs(), uri);
			if (!saving) throw new Error(`${uri} was not saved: no open canvas holds it, so its version cannot be checked.`);
			await saving;
			// step: the newest write of the pipeline landed with this content, and nothing changed the path since
			// (a discard, or a later write of the same text that was not kept, moves its version)
			const write = pipelineWrites(getWorkspaceVfs()).get(pipelineViewPath(uri));
			if (write?.landed !== true || write.version !== projectVfs.version(uri) || write.text !== text) throw new Error(`${uri} was not saved: the canvas did not save this content.`);
		},
		rename: (oldPath: string, newPath: string) => projectVfs.rename(oldPath, newPath),
		delete: (path: string) => projectVfs.delete(path),
		mkdir: (path: string) => projectVfs.mkdir(path),
	};
}

/**
 * Saves the pipeline a canvas holds: one write at the version the canvas
 * loaded, then Documents marks the tab clean (its adapter writes nothing for
 * it). Typing during the write, or a mutation queued behind it, leaves the
 * tab dirty.
 *
 * @returns The version of this write, the canvas's new loaded version.
 */
export async function savePipeline(projectVfs: ProjectVfs, docs: { getState(): { documents: Record<string, { content: unknown } | undefined> }; saveDocument(uri: string): Promise<void> } | null, saveFilename: string, uri: string, project: unknown, expect: number): Promise<number> {
	const writing = projectVfs.write(saveFilename, project, 'editor', expect);
	const mine = projectVfs.version(saveFilename);
	await writing;
	if (typeof project === 'object' && project !== null) loadedVersions.set(project, mine);
	const written = JSON.stringify(project, null, 2);
	// step: a mutation queued behind this write (a discard, another write) moved the path on, so this
	// save is not what the path holds: the tab stays dirty
	if (projectVfs.version(saveFilename) !== mine) return mine;
	if (docs && JSON.stringify(docs.getState().documents[uri]?.content, null, 2) === written) {
		marking.set(uri, written);
		try {
			await docs.saveDocument(uri);
		} finally {
			marking.delete(uri);
		}
	}
	return mine;
}

/**
 * Reloads the pipeline a canvas holds through Documents, past every editor's
 * unsaved buffer.
 *
 * @returns The version the reloaded content belongs to, or null when nothing reloaded (the pipeline is gone or not valid JSON, or typing landed during the read), so the canvas keeps its version.
 */
export async function reloadPipeline(docs: { getState(): { documents: Record<string, { version: number; dirty: boolean; content: unknown } | undefined> }; revertDocument(uri: string): Promise<void> } | null, uri: string): Promise<number | null> {
	if (!docs) return null;
	const before = docs.getState().documents[uri]?.version;
	await docs.revertDocument(uri);
	// step: Documents counts a reload only when its read gave content, and leaves the document clean only when it applied it
	const after = docs.getState().documents[uri];
	return after !== undefined && after.version !== before && !after.dirty ? (loadedVersion(after.content) ?? null) : null;
}
