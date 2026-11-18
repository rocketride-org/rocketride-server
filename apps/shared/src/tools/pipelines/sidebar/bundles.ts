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
 * Pipeline folders in the sidebar (plan §9, rewritten 2026-11-17).
 *
 * ONE cosmetic rule: a folder holding exactly one `.pipe` (none deeper)
 * collapses to one sidebar entry, named after the folder, whose actions act
 * on the pipe inside. Nothing here decides what a pipeline IS or whether it
 * publishes: two pipes in one folder are two pipes, both publishable, free to
 * share files; a pipeline's store listing is the `store` block INSIDE its
 * `.pipe` and its identity is the `project_id` inside the file, never the
 * file's or folder's name.
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

/** The pipeline file extension (the ONE pipeline file kind). */
const PIPE_EXTENSION = '.pipe';

/**
 * Tells whether a path names a pipeline file, by extension alone (the same
 * rule discovery uses; a bare `.pipe` counts, though it has no display stem).
 *
 * @param path - A '/'-separated path.
 * @returns True for a `.pipe` file.
 */
export function isPipelineFile(path: string): boolean {
	return path.toLowerCase().endsWith(PIPE_EXTENSION);
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
 * The file name a pipeline file path carries without its `.pipe` extension
 * (`ingest/docBrain.pipe` → `docBrain`). A display stem, never an id.
 *
 * @param path - A '/'-separated path to a `.pipe` file.
 * @returns The stem, or null when the path is not a pipeline file.
 */
export function pipeStemOf(path: string): string | null {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name.toLowerCase().endsWith(PIPE_EXTENSION) && name.length > PIPE_EXTENSION.length) return name.slice(0, -PIPE_EXTENSION.length);
	return null;
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
 * The collapsible folders among the discovered entries: a folder (not the
 * root) holding exactly ONE pipeline file directly in it and none deeper. Any
 * other folder is an ordinary directory of pipelines.
 *
 * @param entries - The discovered entries.
 * @returns The folder path of each collapsed folder's pipe, by the pipe's path.
 */
function collapsibleFolders(entries: ProjectEntry[]): Map<string, string> {
	// Step 1: the pipeline files per DIRECT parent folder
	const direct = new Map<string, ProjectEntry[]>();
	const pipes = entries.filter((e) => e.type !== 'dir' && isPipelineFile(e.path));
	for (const pipe of pipes) {
		const parent = parentOf(pipe.path);
		if (!parent) continue;
		direct.set(parent, [...(direct.get(parent) ?? []), pipe]);
	}
	// Step 2: a folder with one direct pipe and no pipe deeper collapses
	const result = new Map<string, string>();
	for (const [folder, inside] of direct) {
		if (inside.length !== 1) continue;
		const deeper = pipes.some((p) => p.path !== inside[0]!.path && p.path.startsWith(`${folder}/`));
		if (!deeper) result.set(inside[0]!.path, folder);
	}
	return result;
}

/**
 * Collapses every one-pipe folder in the discovered entries into one entry
 * at the folder's path: the pipe's `projectId` and `sources` ride it and
 * `file` names the `.pipe` inside; everything else under the folder (the
 * folder's own dir entry, readme, icon, assets) is dropped from the list.
 * Flat pipes and folders holding several pipes pass through unchanged. Pure.
 *
 * @param entries - The discovered entries, flat, '/'-separated paths.
 * @returns The entries with one-pipe folders collapsed, in the input's order.
 */
export function collapseBundles(entries: ProjectEntry[]): ProjectEntry[] {
	const folders = collapsibleFolders(entries);
	if (folders.size === 0) return entries;
	const collapsed = new Map<string, ProjectEntry>();
	for (const entry of entries) {
		const folder = folders.get(entry.path);
		if (folder !== undefined) collapsed.set(folder, { ...entry, path: folder, type: 'file', file: entry.path });
	}
	// One entry per collapsed folder where it first appears; nothing else
	// under it is listed
	const emitted = new Set<string>();
	const out: ProjectEntry[] = [];
	for (const entry of entries) {
		const owner = [...collapsed.keys()].find((folder) => entry.path === folder || entry.path.startsWith(`${folder}/`));
		if (owner === undefined) {
			out.push(entry);
			continue;
		}
		if (!emitted.has(owner)) {
			emitted.add(owner);
			out.push(collapsed.get(owner)!);
		}
	}
	return out;
}

/**
 * The file a sidebar path opens: a collapsed entry's `.pipe`, else the path itself.
 *
 * @param entries - The (collapsed) entries the sidebar shows.
 * @param path - The path the user acted on.
 * @returns The pipeline file path.
 */
export function fileOfEntry(entries: ProjectEntry[], path: string): string {
	return entries.find((e) => e.path === path)?.file ?? path;
}

/**
 * The sidebar path a pipeline file is shown under: its folder when it is a
 * collapsed folder's pipe, else the file path. The inverse of {@link fileOfEntry}.
 *
 * @param entries - The (collapsed) entries the sidebar shows.
 * @param filePath - A pipeline file path.
 * @returns The entry path.
 */
export function entryPathOfFile(entries: ProjectEntry[], filePath: string): string {
	return entries.find((e) => e.file === filePath)?.path ?? filePath;
}
