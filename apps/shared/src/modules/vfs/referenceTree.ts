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
// REFERENCE TREE — the read-only .rocketride/ folder's layout and file tree
// =============================================================================

/**
 * RocketRide's reference files appear as the read-only top-level `.rocketride/` folder, served from
 * the connected server, never the user's store. This file owns the layout (where a docs-bundle entry
 * is served, and which are not) and is pure, so every host and the tests share it.
 */

// =============================================================================
// LAYOUT
// =============================================================================

/** The read-only top-level folder RocketRide's reference files are served under. */
export const ROCKETRIDE_ROOT = '.rocketride';

/**
 * Guides in the docs bundle that are not served. README and CLI teach a shell
 * and python_API a Python runtime, and the browser has neither. The builder
 * prompt's router replaces the README's task router.
 */
const HIDDEN_GUIDES = new Set(['ROCKETRIDE_README.md', 'ROCKETRIDE_CLI.md', 'ROCKETRIDE_python_API.md']);

/**
 * Where a docs.zip entry is served below ROCKETRIDE_ROOT: a root-level .md becomes 'docs/<name>';
 * stubs/, manifest.json and HIDDEN_GUIDES are not served (null).
 */
export function docsPathFor(entry: string): string | null {
	if (entry.includes('/') || !entry.endsWith('.md') || HIDDEN_GUIDES.has(entry)) return null;
	return `docs/${entry}`;
}

/**
 * Whether a workspace path is ROCKETRIDE_ROOT or under it.
 *
 * @param path - A canonical workspace path.
 */
export function isReferencePath(path: string): boolean {
	return path === ROCKETRIDE_ROOT || path.startsWith(`${ROCKETRIDE_ROOT}/`);
}

// =============================================================================
// THE TREE
// =============================================================================

/** A read-only file tree, by path below its root. */
export class ReferenceTree {
	/** The folder it is served under (for messages). */
	private readonly root: string;
	/** Text by path below the root. */
	private readonly files: ReadonlyMap<string, string>;
	/** Every folder the file paths imply, '' (the root) included. */
	private readonly dirs = new Set<string>(['']);

	constructor(root: string, files: ReadonlyMap<string, string>) {
		this.root = root;
		this.files = files;
		for (const path of files.keys()) {
			for (let cut = path.indexOf('/'); cut > 0; cut = path.indexOf('/', cut + 1)) this.dirs.add(path.slice(0, cut));
		}
	}

	/**
	 * Lists one folder, its folders built from the file set.
	 *
	 * @param rel - The folder below the root ('' = the root).
	 * @returns Its entries, sorted by name.
	 * @throws For a file, or a folder that does not exist.
	 */
	list(rel: string): Array<{ name: string; type: 'file' | 'dir' }> {
		if (this.files.has(rel)) throw new Error(`${this.workspacePath(rel)} is a file, not a folder.`);
		if (!this.dirs.has(rel)) throw new Error(`No folder at ${this.workspacePath(rel)}.`);
		const prefix = rel ? `${rel}/` : '';
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
		}
		return [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, type]) => ({ name, type }));
	}

	/**
	 * Reads one file.
	 *
	 * @param rel - The file below the root.
	 * @throws For a folder, or for a miss, naming every file that exists.
	 */
	read(rel: string): string {
		const text = this.files.get(rel);
		if (text !== undefined) return text;
		if (this.dirs.has(rel)) throw new Error(`${this.workspacePath(rel)} is a folder, not a file.`);
		const files = [...this.files.keys()].map((path) => this.workspacePath(path));
		throw new Error(`No file at ${this.workspacePath(rel)}.${files.length > 0 ? ` Files: ${files.join(', ')}` : ''}`);
	}

	private workspacePath(rel: string): string {
		return rel ? `${this.root}/${rel}` : this.root;
	}
}
