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
 * A publishable pipeline is a DIRECTORY `./pipelines/{pipeId}/` holding
 * `{pipeId}.pipe` beside its readme, icon and assets, mirroring an app's
 * `./apps/{appId}/`. The sidebar shows such a folder as ONE entry named after
 * the pipe (its sources beneath it), never as a folder with one file inside;
 * a flat `.pipe` anywhere still shows, opens and runs as today.
 *
 * This module is the pure part: recognising a bundle in the discovered
 * entries, collapsing it, and the short-id grammar a bundle's name follows.
 * It is shared by both hosts, which discover differently but feed the same
 * `ProjectEntry` list.
 */

import type { ProjectEntry } from './types';

// =============================================================================
// Grammar
// =============================================================================

/**
 * A pipeline's SHORT id (plan §2.1, B5): one dot-free address segment, which
 * is also what a bundle folder and its `.pipe` are named.
 */
export const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The pipeline file extensions, longest first so `.pipe.json` wins. */
const PIPE_EXTENSIONS = ['.pipe.json', '.pipe'];

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
 * The pipeline name a file path carries: the file name without its pipeline
 * extension (`ingest/docBrain.pipe` → `docBrain`).
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
 * The bundle paths for a new pipeline named `name` under `dir`: the folder
 * and the `.pipe` inside it, both carrying the name.
 *
 * @param dir - The parent directory ('' for the pipelines root), '/'-separated.
 * @param name - The pipeline's short id.
 * @returns The folder path and the file path.
 */
export function bundlePathsFor(dir: string, name: string): { folder: string; file: string } {
	const folder = dir ? `${dir}/${name}` : name;
	return { folder, file: `${folder}/${name}.pipe` };
}

// =============================================================================
// Collapsing
// =============================================================================

/**
 * Tells whether a pipeline file is the pipe of a bundle: it sits in a folder
 * of its own name (`…/docBrain/docBrain.pipe`).
 *
 * @param path - The file's '/'-separated path.
 * @returns The bundle folder's path, or null when the file is a flat pipe.
 */
export function bundleFolderOf(path: string): string | null {
	const stem = pipeStemOf(path);
	if (stem === null) return null;
	const slash = path.lastIndexOf('/');
	if (slash < 0) return null;
	const folder = path.slice(0, slash);
	const folderName = folder.slice(folder.lastIndexOf('/') + 1);
	return folderName === stem ? folder : null;
}

/**
 * Collapses every bundle in the discovered entries into one entry at the
 * folder's path: the pipe's `projectId` and `sources` ride it, `file` names
 * the `.pipe` inside, and everything else under the folder (the folder's own
 * dir entry, readme, icon, assets, nested dirs) is dropped from the list.
 * Flat pipes and ordinary folders pass through unchanged. Pure.
 *
 * @param entries - The discovered entries, flat, '/'-separated paths.
 * @returns The entries with bundles collapsed, in the input's order.
 */
export function collapseBundles(entries: ProjectEntry[]): ProjectEntry[] {
	// Step 1: find the bundles — a pipe in a folder of its own name
	const bundles = new Map<string, ProjectEntry>();
	for (const entry of entries) {
		if (entry.type === 'dir') continue;
		const folder = bundleFolderOf(entry.path);
		if (folder !== null && !bundles.has(folder)) {
			bundles.set(folder, { ...entry, path: folder, type: 'file', file: entry.path });
		}
	}
	if (bundles.size === 0) return entries;
	// Step 2: one entry per bundle where its folder first appears; nothing
	// else under a bundle folder is listed
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
 * The sidebar path a pipeline file is shown under: its bundle folder when it
 * is a bundle's pipe, else the file path. The inverse of {@link fileOfEntry}.
 *
 * @param filePath - A pipeline file path.
 * @returns The entry path.
 */
export function entryPathOfFile(filePath: string): string {
	return bundleFolderOf(filePath) ?? filePath;
}
