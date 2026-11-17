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
 * Pipeline bundles in the sidebar (plan §9, B7).
 *
 * A publishable pipeline is a DIRECTORY `./pipelines/{folder}/` holding ONE
 * `.pipe` beside its readme, icon and assets, mirroring an app's
 * `./apps/{appId}/`. The sidebar shows such a folder as one entry named after
 * the folder (its sources beneath it), never as a folder with one file inside;
 * a flat `.pipe` anywhere still shows, opens and runs as today.
 *
 * The file may be named anything: a pipeline's identity is the `project_id`
 * INSIDE the file (Rod, 2026-11-16), never its name, so a bundle is told by
 * shape alone (a folder whose only pipe, at any depth, sits directly in it).
 *
 * This module is the pure part, shared by both hosts, which discover
 * differently but feed the same `ProjectEntry` list.
 */

import type { ProjectEntry } from './types';

// =============================================================================
// Grammar
// =============================================================================

/**
 * A pipeline's SHORT id (plan §2.1, B5): one dot-free address segment. This
 * is the grammar of the id INSIDE the file, not of the file's name.
 */
export const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The pipeline file extensions, longest first so `.pipe.json` wins. */
const PIPE_EXTENSIONS = ['.pipe.json', '.pipe'];

/**
 * Tells whether a path names a pipeline file, by extension alone (the same
 * rule discovery uses; a bare `.pipe` counts, though it has no display stem).
 *
 * @param path - A '/'-separated path.
 * @returns True for a `.pipe` or `.pipe.json` file.
 */
export function isPipelineFile(path: string): boolean {
	const lower = path.toLowerCase();
	return PIPE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Tells whether a string is a legal short id (dot-free, one segment).
 *
 * @param id - The candidate id.
 * @returns True when it may be a pipeline's short id.
 */
export function isShortId(id: string): boolean {
	return SHORT_ID_PATTERN.test(id);
}

/**
 * The file name a pipeline file path carries without its pipeline extension
 * (`ingest/docBrain.pipe` → `docBrain`). A display stem, never an id.
 *
 * @param path - A '/'-separated path to a `.pipe` or `.pipe.json` file.
 * @returns The stem, or null when the path is not a pipeline file.
 */
export function pipeStemOf(path: string): string | null {
	const name = path.slice(path.lastIndexOf('/') + 1);
	for (const ext of PIPE_EXTENSIONS) {
		if (name.toLowerCase().endsWith(ext) && name.length > ext.length) return name.slice(0, -ext.length);
	}
	return null;
}

/**
 * The bundle paths for a new pipeline file named `name` under `dir`: the
 * folder and the `.pipe` inside it, both carrying the typed name (the folder
 * is the publish unit; the pipeline's id is inside the file).
 *
 * @param dir - The parent directory ('' for the pipelines root), '/'-separated.
 * @param name - The typed file name without extension.
 * @returns The folder path and the file path.
 */
export function bundlePathsFor(dir: string, name: string): { folder: string; file: string } {
	const folder = dir ? `${dir}/${name}` : name;
	return { folder, file: `${folder}/${name}.pipe` };
}

// =============================================================================
// Collapsing
// =============================================================================

/** The parent folder of a path ('' at the root). */
function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * The bundle folders among the discovered entries: a folder (not the root)
 * holding exactly ONE pipeline file directly in it and none deeper. Any other
 * folder is an ordinary directory of pipelines.
 *
 * @param entries - The discovered entries.
 * @returns The bundle folder path of each bundle's pipe, by the pipe's path.
 */
function bundleFolders(entries: ProjectEntry[]): Map<string, string> {
	// Step 1: the pipeline files per DIRECT parent folder
	const direct = new Map<string, ProjectEntry[]>();
	const pipes = entries.filter((e) => e.type !== 'dir' && isPipelineFile(e.path));
	for (const pipe of pipes) {
		const parent = parentOf(pipe.path);
		if (!parent) continue;
		direct.set(parent, [...(direct.get(parent) ?? []), pipe]);
	}
	// Step 2: a folder with one direct pipe and no pipe deeper is a bundle
	const result = new Map<string, string>();
	for (const [folder, inside] of direct) {
		if (inside.length !== 1) continue;
		const deeper = pipes.some((p) => p.path !== inside[0]!.path && p.path.startsWith(`${folder}/`));
		if (!deeper) result.set(inside[0]!.path, folder);
	}
	return result;
}

/**
 * Collapses every bundle in the discovered entries into one entry at the
 * folder's path: the pipe's `projectId` and `sources` ride it and `file`
 * names the `.pipe` inside; everything else under the folder (the folder's
 * own dir entry, readme, icon, assets) is dropped from the list. Flat pipes
 * and ordinary folders pass through unchanged. Pure.
 *
 * @param entries - The discovered entries, flat, '/'-separated paths.
 * @returns The entries with bundles collapsed, in the input's order.
 */
export function collapseBundles(entries: ProjectEntry[]): ProjectEntry[] {
	const folders = bundleFolders(entries);
	if (folders.size === 0) return entries;
	const bundles = new Map<string, ProjectEntry>();
	for (const entry of entries) {
		const folder = folders.get(entry.path);
		if (folder !== undefined) bundles.set(folder, { ...entry, path: folder, type: 'file', file: entry.path });
	}
	// One entry per bundle where its folder first appears; nothing else under
	// a bundle folder is listed
	const emitted = new Set<string>();
	const out: ProjectEntry[] = [];
	for (const entry of entries) {
		const owner = [...bundles.keys()].find((folder) => entry.path === folder || entry.path.startsWith(`${folder}/`));
		if (owner === undefined) {
			out.push(entry);
			continue;
		}
		if (!emitted.has(owner)) {
			emitted.add(owner);
			out.push(bundles.get(owner)!);
		}
	}
	return out;
}

/**
 * The file a sidebar path opens: a bundle entry's `.pipe`, else the path itself.
 *
 * @param entries - The (collapsed) entries the sidebar shows.
 * @param path - The path the user acted on.
 * @returns The pipeline file path.
 */
export function fileOfEntry(entries: ProjectEntry[], path: string): string {
	return entries.find((e) => e.path === path)?.file ?? path;
}

/**
 * The sidebar path a pipeline file is shown under: its bundle's folder when
 * it is a bundle's pipe, else the file path. The inverse of {@link fileOfEntry}.
 *
 * @param entries - The (collapsed) entries the sidebar shows.
 * @param filePath - A pipeline file path.
 * @returns The entry path.
 */
export function entryPathOfFile(entries: ProjectEntry[], filePath: string): string {
	return entries.find((e) => e.file === filePath)?.path ?? filePath;
}
