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
// REAL CONTAINMENT — the resolved-path half of a folder rule
// =============================================================================
//
// A lexical check (path.resolve + startsWith) keeps `..` inside a folder but
// not a symlink: `assets -> /elsewhere` passes it and the file ops then reach
// outside. This helper settles the REAL paths: the folder's realpath, the
// destination's nearest existing ancestor's realpath, and — when the
// destination exists — the destination itself (never a symlink, never
// resolving outside). It runs after the lexical check, never instead of it.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Whether `candidate` is `root` or lies under it (path.relative is
 * case-insensitive on Windows, as the filesystem is).
 */
function isWithin(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether a path exists at all (a dangling symlink counts as present). */
async function exists(target: string): Promise<boolean> {
	try {
		await fs.promises.lstat(target);
		return true;
	} catch {
		return false;
	}
}

// =============================================================================
// ASSERT
// =============================================================================

/**
 * Asserts that `target` stays inside `root` once symlinks are resolved.
 *
 * Step 1: the root's realpath. Step 2: the nearest EXISTING ancestor of the
 * target must resolve inside it (a write creates the rest as real folders
 * under that ancestor). Step 3: an existing target must not be a symlink
 * and must resolve inside the root.
 *
 * @param root - The folder's absolute path (the app folder, the pipe's folder).
 * @param target - The absolute path the caller lexically resolved under `root`.
 * @param message - The error text to throw with (the caller's existing wording).
 * @throws Error with `message` when any resolved path leaves the root.
 */
export async function assertRealContained(root: string, target: string, message: string): Promise<void> {
	const realRoot = await fs.promises.realpath(root);
	// Step 2: walk up to the nearest existing ancestor
	let ancestor = path.dirname(target);
	while (!(await exists(ancestor))) {
		const up = path.dirname(ancestor);
		if (up === ancestor) break;
		ancestor = up;
	}
	if (!isWithin(realRoot, await fs.promises.realpath(ancestor))) throw new Error(message);
	// Step 3: the destination itself, when it is already there
	if (await exists(target)) {
		const stat = await fs.promises.lstat(target);
		if (stat.isSymbolicLink()) throw new Error(message);
		if (!isWithin(realRoot, await fs.promises.realpath(target))) throw new Error(message);
	}
}
