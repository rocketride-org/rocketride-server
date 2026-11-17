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

// =============================================================================
// TOOL DOC URI — the `tool:<appId>[/<docKey>]` convention, spelled once
// =============================================================================
//
// A tool document's identity: `tool:<appId>` for the tool's single/generic
// frame (docKey ''), `tool:<appId>/<docKey>` for a per-document frame.
// Dependency-free so every host realm (browser, VS Code extension host)
// composes and parses the SAME convention instead of hand-rolling it —
// the audit found eight independent spellings with three different ideas
// of what an absent docKey means. Canonical here: the empty string IS the
// generic frame's key (matching DevToolProps.documents.open('')).
// =============================================================================

/** The tool-document URI prefix. */
export const TOOL_DOC_PREFIX = 'tool:';

/**
 * Composes a tool document's URI.
 *
 * @param appId - The tool's app id.
 * @param docKey - The per-document key; '' (or omitted) = the generic frame.
 * @returns The document URI.
 */
export function toolDocUri(appId: string, docKey = ''): string {
	return docKey ? `${TOOL_DOC_PREFIX}${appId}/${docKey}` : `${TOOL_DOC_PREFIX}${appId}`;
}

/**
 * Parses a tool document's URI.
 *
 * @param uri - Any document URI.
 * @returns The appId and docKey ('' = the generic frame), or null when the
 *          URI is not a tool document.
 */
export function parseToolDocUri(uri: string): { appId: string; docKey: string } | null {
	if (!uri.startsWith(TOOL_DOC_PREFIX)) return null;
	const rest = uri.slice(TOOL_DOC_PREFIX.length);
	const slash = rest.indexOf('/');
	if (slash < 0) return { appId: rest, docKey: '' };
	return { appId: rest.slice(0, slash), docKey: rest.slice(slash + 1) };
}

/**
 * The active-doc key one tool's SIDEBAR should see for a fronted document:
 * the docKey when the document belongs to this tool ('' = generic frame),
 * or null when another document is fronted (clear highlight).
 *
 * @param uri - The fronted document's URI (or null/undefined when none).
 * @param appId - The sidebar's tool id.
 * @returns The per-tool activeDocKey value.
 */
export function activeDocKeyFor(uri: string | null | undefined, appId: string): string | null {
	if (!uri) return null;
	const parsed = parseToolDocUri(uri);
	return parsed && parsed.appId === appId ? parsed.docKey : null;
}
