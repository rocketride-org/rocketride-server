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
// APP FILES — design-loop file vocabulary (text extensions, skip dirs)
// =============================================================================

/**
 * Pure classification helpers for the design loop. File I/O lives on the
 * shared workspace view (workspace/workspace.ts) — the per-app VFS backend
 * and bulk loader that used to live here are gone with it.
 */


/** File extensions the design loop loads as text into Monaco models. */
const TEXT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'json', 'css', 'scss', 'less', 'md', 'svg', 'html', 'txt', 'rrapp', 'gitignore', 'yaml', 'yml']);

/** Store subtrees the loop never loads (derived outputs, never user truth). */
export const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git'];

/**
 * Whether a file participates in the design loop as text.
 *
 * @param name - The leaf file name (or any path — the leaf is derived).
 */
export function isTextFile(name: string): boolean {
	const leaf = name.split('/').pop() ?? name;
	const ext = leaf.split('.').pop()?.toLowerCase() ?? '';
	return TEXT_EXTENSIONS.has(ext) || leaf.startsWith('.');
}
