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
// WORKSPACE INVENTORY — every app, node package and pipeline in one call
// =============================================================================

/**
 * The agent's first call in a session. `list_workspace` answers "what is
 * here?" so the model never has to walk `apps/`, `nodes/` and `pipelines/`
 * itself: each app with its manifest id and name, each node package with its
 * service manifests, each pipeline file. Rod wrote this tool and deleted it on
 * 2026-10-17; this port adds whether each app is open. `readApps` and
 * `findApp` are shared with the app tools and check_app, so every tool
 * resolves "which app?" the same way.
 */

import { AgentTool, AgentToolkit } from '../tools';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { messageOf } from './common';

// =============================================================================
// TYPES
// =============================================================================

/** One app under `apps/`. */
export interface AppEntry {
	/** The folder name under `apps/` (for example `daybook-ui`). */
	folder: string;
	/** The workspace path of the folder (for example `apps/daybook-ui`). */
	path: string;
	/** The manifest id, when the manifest has one. */
	id?: string;
	/** The manifest display name. */
	name?: string;
	/** The manifest description. */
	description?: string;
	/** The manifest mode (managed or manual). */
	mode?: string;
	/** Whether the app has a running dev session. Always false without an id. */
	open: boolean;
	/** Why the manifest could not be used; the app still lists. */
	error?: string;
	/** True when package.json itself could not be read, so nothing is known about the manifest; `error` carries the read error. */
	unreadable?: boolean;
}

/** One node package under `nodes/`. */
interface NodeEntry {
	/** The folder name under `nodes/`. */
	folder: string;
	/** The workspace path of the folder. */
	path: string;
	/** The file names of its `services.*.json` manifests. */
	services: string[];
}

/** One pipeline file under `pipelines/`. */
interface PipelineEntry {
	/** The workspace path of the file. */
	path: string;
	/** The file name, extension included. */
	name: string;
}

// =============================================================================
// READING
// =============================================================================

/** What an app shows when its package.json gives no manifest to read. */
const NO_MANIFEST = 'package.json has no readable appManifest';

/**
 * Lists a folder's entries, treating a missing folder as empty. A workspace
 * with no apps, nodes or pipelines yet has none of the three roots, and the
 * memory workspace throws on a missing folder where the real view does not.
 *
 * @param vfs - The workspace view.
 * @param dir - The folder to list.
 * @returns Its entries, or none when it does not exist.
 */
async function entriesOf(vfs: IWorkspaceFileSystem, dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
	return (await vfs.stat(dir)) === 'dir' ? vfs.list(dir) : [];
}

/**
 * Narrows a manifest field to text. A manifest is user-written JSON, so a
 * field of the wrong type reads as absent rather than leaking into the result.
 *
 * @param value - The raw field.
 * @returns The text, or undefined when it is not a string.
 */
function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * The appManifest in a package.json's content.
 *
 * @param raw - What the read returned: text, or an object already parsed.
 * @returns The manifest object; undefined when the JSON does not parse or holds no appManifest object.
 */
function manifestOf(raw: unknown): Record<string, unknown> | undefined {
	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			// step: JSON.parse throws only a SyntaxError here: the file is broken, which the agent can fix
			return undefined;
		}
	}
	const manifest = (parsed as { appManifest?: unknown } | null | undefined)?.appManifest;
	return typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : undefined;
}

/**
 * Reads one app folder: its manifest from `package.json`. A missing
 * package.json, JSON that does not parse, or no appManifest object gives an
 * entry with the manifest `error`, because the agent can fix those.
 *
 * @param vfs - The workspace view.
 * @param folder - The folder name under `apps/`.
 * @param isOpen - Whether an app id has a running dev session.
 * @returns The app's entry.
 * @throws When package.json exists but cannot be read: that says nothing about its manifest.
 */
async function readApp(vfs: IWorkspaceFileSystem, folder: string, isOpen: (appId: string) => boolean): Promise<AppEntry> {
	const path = `apps/${folder}`;
	const file = `${path}/package.json`;
	if ((await vfs.stat(file)) !== 'file') return { folder, path, open: false, error: NO_MANIFEST };
	const manifest = manifestOf(await vfs.read(file));
	if (!manifest) return { folder, path, open: false, error: NO_MANIFEST };
	const id = text(manifest.id);
	return {
		folder,
		path,
		id,
		name: text(manifest.name),
		description: text(manifest.description),
		mode: text(manifest.mode),
		open: id !== undefined && isOpen(id),
	};
}

/**
 * Reads every app under `apps/`. Other tools use this to turn "which app?"
 * into a folder and an id.
 *
 * @param vfs - The workspace view (the staged one, so unsaved apps list too).
 * @param isOpen - Whether an app id has a running dev session.
 * @returns One entry per folder under `apps/`, in folder order; empty when `apps/` does not exist. An app whose package.json cannot be read lists as `unreadable`, with the read error.
 */
export async function readApps(vfs: IWorkspaceFileSystem, isOpen: (appId: string) => boolean): Promise<AppEntry[]> {
	const entries = await entriesOf(vfs, 'apps');
	return Promise.all(
		entries
			.filter((e) => e.type === 'dir')
			// step: an app that cannot be read still lists, so one bad app cannot hide the others
			.map((e) => readApp(vfs, e.name, isOpen).catch((err: unknown): AppEntry => ({ folder: e.name, path: `apps/${e.name}`, open: false, error: `package.json could not be read: ${messageOf(err)}`, unreadable: true })))
	);
}

/**
 * Finds the app a tool call names.
 *
 * @param apps - The apps from `readApps`.
 * @param ref - A folder name, a manifest id or a manifest name.
 * @returns The matching app; a folder match wins over an id, and an id over a name.
 * @throws When no app matches; the message lists the apps that exist.
 */
export function findApp(apps: AppEntry[], ref: string): AppEntry {
	const found = apps.find((a) => a.folder === ref) ?? apps.find((a) => a.id === ref) ?? apps.find((a) => a.name === ref);
	if (found) return found;
	const known = apps.map((a) => (a.id ? `${a.folder} (${a.id})` : a.folder)).join(', ');
	throw new Error(`No app '${ref}'. Apps: ${known || 'none'}`);
}

/**
 * Reads every node package under `nodes/`: the `services.*.json` manifests in each folder.
 *
 * @param vfs - The workspace view.
 * @returns One entry per folder, in folder order; empty when `nodes/` does not exist.
 */
async function readNodes(vfs: IWorkspaceFileSystem): Promise<NodeEntry[]> {
	const entries = await entriesOf(vfs, 'nodes');
	return Promise.all(
		entries
			.filter((e) => e.type === 'dir')
			.map(async (e) => ({
				folder: e.name,
				path: `nodes/${e.name}`,
				services: (await entriesOf(vfs, `nodes/${e.name}`)).filter((f) => f.type === 'file' && /^services\..+\.json$/.test(f.name)).map((f) => f.name),
			}))
	);
}

/**
 * Reads every pipeline file on the `pipelines/` mount.
 *
 * @param vfs - The workspace view.
 * @returns One entry per `.pipe` file; empty when `pipelines/` does not exist.
 */
async function readPipelines(vfs: IWorkspaceFileSystem): Promise<PipelineEntry[]> {
	return (await entriesOf(vfs, 'pipelines')).filter((e) => e.type === 'file' && e.name.endsWith('.pipe')).map((e) => ({ path: `pipelines/${e.name}`, name: e.name }));
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The workspace inventory toolkit: one tool, `list_workspace`. */
export class InventoryToolkit extends AgentToolkit {
	readonly name = 'inventory';
	readonly instructions = "Call list_workspace first to get oriented: it lists every app (with its id and whether it's open), node package and pipeline.";

	/** The workspace view the inventory reads. */
	private readonly vfs: IWorkspaceFileSystem;
	/** Whether an app id has a running dev session. */
	private readonly isOpen: (appId: string) => boolean;

	/**
	 * Builds the toolkit.
	 *
	 * @param vfs - The workspace view (the staged one, so unsaved entities list too).
	 * @param isOpen - Whether an app id has a running dev session.
	 */
	constructor(vfs: IWorkspaceFileSystem, isOpen: (appId: string) => boolean) {
		super();
		this.vfs = vfs;
		this.isOpen = isOpen;
	}

	/**
	 * The `list_workspace` tool.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'list_workspace',
				description: "List the whole workspace in one call: every app (manifest id, name, description, mode, and whether it's open), every node package (with its service manifests) and every pipeline file. Call it first in a session to learn what exists instead of walking folders.",
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				execute: async () => {
					const [apps, nodes, pipelines] = await Promise.all([readApps(this.vfs, this.isOpen), readNodes(this.vfs), readPipelines(this.vfs)]);
					return JSON.stringify({ apps, nodes, pipelines }, null, 1);
				},
			}),
		];
	}
}
