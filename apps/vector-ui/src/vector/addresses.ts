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
// VECTOR - DOCUMENT ADDRESSES (pure)
// =============================================================================
//
// Every document the app opens has a URI whose first segment names its scheme:
//
//   connections                        the landing page (no connection)
//   console:<key>                      the console of one connection (its Map is a tab inside it)
//   document:<key>:<encoded objectId>  one stored document of one connection
//
// Opening the same URI focuses the existing tab, so a connection has one
// console and a document one tab. Endpoint keys carry no raw ':' (their fields
// are percent-encoded), and the objectId is percent-encoded too, so the key is
// everything between the scheme and the last ':'.
// =============================================================================

import { endpointKeyFromAnyUri } from 'shared/explorer';
import { DOC_SCHEMES } from '../adapters/explorer';

/** URI of the Connections landing document. */
export const CONNECTIONS_URI = 'connections';

/**
 * The console document of a connection.
 *
 * @param endpointKey - The endpoint's key.
 * @returns The URI.
 */
export function consoleUri(endpointKey: string): string {
	return `console:${endpointKey}`;
}

/**
 * The document tab of one stored document.
 *
 * @param endpointKey - The endpoint's key.
 * @param objectId - The document's objectId.
 * @returns The URI.
 */
export function documentUri(endpointKey: string, objectId: string): string {
	return `document:${endpointKey}:${encodeURIComponent(objectId)}`;
}

/**
 * Whether a URI is a console document.
 *
 * @param uri - A document URI.
 * @returns True for `console:` URIs.
 */
export function isConsoleUri(uri: string): boolean {
	return uri.startsWith('console:');
}

/**
 * Whether a URI is a document tab.
 *
 * @param uri - A document URI.
 * @returns True for `document:` URIs.
 */
export function isDocumentUri(uri: string): boolean {
	return uri.startsWith('document:');
}

/**
 * The endpoint key of ANY of the app's documents, so the sidebar stays bound to
 * a connection while one of its document tabs is active.
 *
 * @param uri - A document URI.
 * @returns The key, or null for the landing document.
 */
export function endpointKeyFromUri(uri: string): string | null {
	return endpointKeyFromAnyUri(uri, DOC_SCHEMES);
}

/**
 * A stored document's title (its tab, its dev-tool document): its path's last segment, else the start of its objectId.
 *
 * @param objectId - The document.
 * @param path - Its path, when known.
 * @returns The title.
 */
export function documentTitle(objectId: string, path: string | null): string {
	return path ? (path.split(/[\\/]/).pop() ?? path) : objectId.slice(0, 8);
}
