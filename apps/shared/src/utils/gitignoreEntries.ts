// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Pure `.gitignore` entry reconciliation, kept out of `agent-manager.ts` so it
 * is testable without the `vscode` module (same seam as `envFile.ts`).
 */

/**
 * Which of `entries` are not already listed in `content`.
 *
 * Matching is on exact trimmed lines. That is deliberate: a user whose
 * `.gitignore` already says `*.env` or `**\/.env` has a broader rule than we
 * would add, and second-guessing it risks writing a narrower duplicate. The
 * cost of the strict comparison is an occasional redundant line, which is
 * harmless; the cost of being clever is fighting the user's own config.
 */
export function missingGitignoreEntries(content: string, entries: readonly string[]): string[] {
	const present = new Set(content.split('\n').map((line) => line.trim()));
	return entries.filter((entry) => !present.has(entry));
}

/**
 * `content` with any missing entries appended, or `null` when nothing is
 * missing (so the caller can skip the write entirely rather than rewriting a
 * byte-identical file).
 *
 * The user's existing text is preserved byte-for-byte, including any blank
 * lines they left at the end — this file is hand-edited, and silently
 * reformatting someone's `.gitignore` while adding one line to it is the kind
 * of thing that makes a tool untrustworthy. A separating newline is added only
 * when the content does not already end in one.
 */
export function appendGitignoreEntries(content: string, entries: readonly string[]): string | null {
	const missing = missingGitignoreEntries(content, entries);
	if (missing.length === 0) {
		return null;
	}
	const separator = content === '' || content.endsWith('\n') ? '' : '\n';
	return content + separator + missing.join('\n') + '\n';
}
