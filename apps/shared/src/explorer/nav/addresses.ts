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
// EXPLORER NAV — DOCUMENT ADDRESSES (recovering a connection key from a URI)
// =============================================================================
//
// Every Explorer document is addressed by a URI whose first segment names its
// scheme and whose next segment is the connection's endpoint key:
//
//   connection:<key>                bare   — the key is everything after the scheme
//   diagram:<key>                   bare
//   query:<key>:<n>                 suffixed — the key, then exactly one `:segment`
//   table:<key>:<table>             suffixed
//
// The sidebar needs the key from ANY of them, so a schema tree stays bound
// while a query tab is active. Pre-v1 keys contain colons (`projectId:source:nodeId`),
// so a suffixed scheme strips exactly ONE trailing `:segment` instead of
// splitting on ':'. That is only sound because every suffix is colon-free: a
// generated counter, or a name percent-encoded by {@link encodeSegment}
// (encodeURIComponent escapes ':' as '%3A').
//
// The schemes belong to the app; this module only knows the rule.
// =============================================================================

/** The schemes of one app's documents. */
export interface IDocSchemes {
	/** Schemes whose URI carries the key verbatim: `scheme:<key>`. */
	bare: readonly string[];
	/** Schemes that append one colon-free `:segment` after the key. */
	suffixed: readonly string[];
}

/**
 * Extract the endpoint key from ANY of an app's document URIs.
 *
 * @param uri - A document URI of any scheme.
 * @param schemes - The app's schemes.
 * @returns The endpoint key, or null for non-endpoint documents (the landing doc).
 */
export function endpointKeyFromAnyUri(uri: string, schemes: IDocSchemes): string | null {
	const cut = uri.indexOf(':');
	if (cut <= 0) return null;
	const scheme = uri.slice(0, cut);
	const rest = uri.slice(cut + 1);
	if (rest === '') return null;
	if (schemes.bare.includes(scheme)) return rest;
	if (schemes.suffixed.includes(scheme)) {
		const suffixAt = rest.lastIndexOf(':');
		return suffixAt > 0 ? rest.slice(0, suffixAt) : null;
	}
	return null;
}

/**
 * Extract the endpoint key from one scheme's URI.
 *
 * @param uri - A document URI.
 * @param scheme - The scheme to accept.
 * @returns The endpoint key, or null when the URI is not of that scheme.
 */
export function endpointKeyFromUri(uri: string, scheme: string): string | null {
	return uri.startsWith(`${scheme}:`) ? uri.slice(scheme.length + 1) : null;
}

/**
 * Create a monotonic counter for generated document suffixes (query tab
 * numbers, create-table drafts).
 *
 * @returns A function returning 1, 2, 3, ….
 */
export function createCounter(): () => number {
	let value = 0;
	return () => {
		value += 1;
		return value;
	};
}
