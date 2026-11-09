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
// RESOLVE: a check's path, when the agent named the file differently
// =============================================================================

/**
 * Task 2.6. A check names an exact path, but an agent may save the pipeline
 * as support_chat.pipe instead of support-chat.pipe, or move a file. When the
 * named path is not in the final workspace, the check uses the one file that
 * fits: a file the turn added (a renamed or moved file is a new path), under the same top folder
 * (pipelines/, apps/, nodes/), with the same extension and, for a pipeline
 * the task started with, the same project_id inside. No candidate, or more
 * than one, leaves the path as it was, so the check fails on the missing
 * file as before. Every substitution is recorded.
 */

/** One check that used another file than the one it names. */
export interface Substitution {
	check: string;
	wanted: string;
	used: string;
}

/** The files the turn added or changed: in the final workspace, and new or different from the start. */
export function changedFiles(start: Record<string, string>, final: Record<string, string>): string[] {
	return Object.keys(final).filter((f) => final[f] !== start[f]);
}

/** The project_id of a pipeline's text, or undefined. */
function projectId(text: string | undefined): unknown {
	try {
		return text === undefined ? undefined : (JSON.parse(text) as { project_id?: unknown }).project_id;
	} catch {
		return undefined;
	}
}

/**
 * The file a check should read for the path it names.
 *
 * @param wanted - The path the check names.
 * @param start - The workspace the task started with.
 * @param final - The workspace at the end.
 * @returns The path to use, and when it is another file, why; or why none fits.
 */
export function resolvePath(wanted: string, start: Record<string, string>, final: Record<string, string>): { path: string; substituted: boolean; why: string } {
	if (wanted in final) return { path: wanted, substituted: false, why: 'exact' };
	const top = wanted.split('/')[0];
	const ext = /\.[^./]+$/.exec(wanted)?.[0] ?? '';
	const id = ext === '.pipe' ? projectId(start[wanted]) : undefined;
	const candidates = Object.keys(final).filter((f) => !(f in start) && f.split('/')[0] === top && f.endsWith(ext) && (id === undefined || projectId(final[f]) === id));
	if (candidates.length === 1) return { path: candidates[0], substituted: true, why: `${wanted} is not there; ${candidates[0]} is the one added ${ext || 'extensionless'} file under ${top}/${id === undefined ? '' : ` with project_id ${String(id)}`}` };
	return { path: wanted, substituted: false, why: candidates.length ? `${wanted} is not there, and ${candidates.length} added files could be it: ${candidates.join(', ')}` : `${wanted} is not there, and no added file could be it` };
}
