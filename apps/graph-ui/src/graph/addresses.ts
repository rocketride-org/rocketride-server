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
// GRAPH - DOCUMENT ADDRESSES (pure)
// =============================================================================
//
// Every document the app opens has a URI whose first segment names its scheme and
// whose rest is the connection's endpoint key:
//
//   connections          the landing page (no connection)
//   workbench:<key>      the browsing workbench of one connection
//   write:<key>          the write console of one connection (only where the node allows it)
//
// Opening the same URI focuses the existing tab, so a connection has at most one
// workbench and one write console open. Keys carry no raw ':' (they are
// percent-encoded fields), so the key is simply everything after the scheme.
// =============================================================================

import { endpointKeyFromAnyUri } from 'shared/explorer';
import { DOC_SCHEMES } from '../adapters/explorer';

/** URI of the Connections landing document. */
export const CONNECTIONS_URI = 'connections';

/**
 * The workbench document of a connection.
 *
 * @param endpointKey - The endpoint's key.
 * @returns The URI.
 */
export function workbenchUri(endpointKey: string): string {
	return `workbench:${endpointKey}`;
}

/**
 * The write console document of a connection.
 *
 * @param endpointKey - The endpoint's key.
 * @returns The URI.
 */
export function writeUri(endpointKey: string): string {
	return `write:${endpointKey}`;
}

/**
 * Whether a URI is a workbench document.
 *
 * @param uri - A document URI.
 * @returns True for `workbench:` URIs.
 */
export function isWorkbenchUri(uri: string): boolean {
	return uri.startsWith('workbench:');
}

/**
 * Whether a URI is a write console document.
 *
 * @param uri - A document URI.
 * @returns True for `write:` URIs.
 */
export function isWriteUri(uri: string): boolean {
	return uri.startsWith('write:');
}

/**
 * The endpoint key of ANY of the app's documents, so the sidebar stays bound to
 * a connection while its write console (or workbench) is the active tab.
 *
 * @param uri - A document URI.
 * @returns The key, or null for the landing document.
 */
export function endpointKeyFromUri(uri: string): string | null {
	return endpointKeyFromAnyUri(uri, DOC_SCHEMES);
}
