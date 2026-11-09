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
// GUIDES: which guides the agent read in a trial
// =============================================================================

/**
 * Task 2.7. In the browser the guides never reach the engine one by one: the
 * page fetches /client/docs once (one HTTP line in trace.jsonl) and the
 * agent's reads of .rocketride/ are answered from the browser's own copy. So
 * the reads show only in the saved session's thinking rows, one line per
 * tool call: `- read_file .rocketride/docs/ROCKETRIDE_CONCEPTS.md — ok`.
 *
 * A guide read is #2885's served read (recordings.ts SERVED_READS):
 * read_file, search_files, list_directory or stat_file on a path under
 * .rocketride/, and rocketride_client's getServices or getService, which
 * read the node catalog.
 */

/** One read of a guide. */
export interface GuideRead {
	tool: string;
	path: string;
	ok: boolean;
}

/** What a trial read: each guide read, and the catalog calls. */
export interface GuideReads {
	reads: GuideRead[];
	/** The distinct guide paths read without an error. */
	files: string[];
	catalogCalls: number;
}

const READ_TOOLS = new Set(['read_file', 'search_files', 'list_directory', 'stat_file']);
const CATALOG_METHODS = new Set(['getServices', 'getService']);
/** A tool line in a thinking row: `- <tool> <argument> — <ok | error: ...>`. */
const TOOL_LINE = /^- (\S+)(?: (\S+))? — (.*)$/;

/**
 * Reads the guide reads out of the thinking rows' text.
 *
 * @param rows - Each thinking row's text, in order.
 */
export function guideReads(rows: string[]): GuideReads {
	const reads: GuideRead[] = [];
	let catalogCalls = 0;
	for (const line of rows.flatMap((r) => r.split('\n'))) {
		const m = TOOL_LINE.exec(line.trim());
		if (!m) continue;
		const [, tool, arg = '', result] = m;
		if (tool === 'rocketride_client' && CATALOG_METHODS.has(arg)) catalogCalls++;
		else if (READ_TOOLS.has(tool) && arg.replace(/^\/+/, '').startsWith('.rocketride')) reads.push({ tool, path: arg.replace(/^\/+/, ''), ok: result.startsWith('ok') });
	}
	const files = [...new Set(reads.filter((r) => r.ok && r.tool === 'read_file').map((r) => r.path))].sort();
	return { reads, files, catalogCalls };
}
