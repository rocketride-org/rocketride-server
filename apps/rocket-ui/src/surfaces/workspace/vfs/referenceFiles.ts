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
// REFERENCE FILES — the server's guide bundle behind the workspace's .rocketride/
// =============================================================================

/**
 * The workspace's read-only `.rocketride/` folder is the connected server's
 * public docs bundle (GET /client/docs, the same docs.zip VS Code and
 * `rocketride init` install), unzipped in the browser and held in memory.
 * Nothing is written to the store. Which bundle entries are served, and
 * where, is docsPathFor's rule in shared.
 */

import { strFromU8, unzipSync } from 'fflate';
import { ROCKETRIDE_ROOT, ReferenceTree, docsPathFor } from 'shared/modules/vfs/referenceTree';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The server's docs bundle, same-origin like typesFeed's /client/shell. */
const DOCS_URL = '/client/docs';

/** How long the fetch may take: the first tree walk waits for it. */
const FETCH_TIMEOUT_MS = 10_000;

/** A zip's first four bytes (a local file header). A page that isn't a zip, such as the SPA's HTML, fails this. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

// =============================================================================
// LOADER
// =============================================================================

/** The load in flight or done; a failed load is cleared so the next call retries. */
let loading: Promise<ReferenceTree> | null = null;

/**
 * The connected server's `.rocketride/` tree: GET /client/docs, unzipped in
 * memory. Loaded once per page; a failed load is not kept, so the next call
 * retries.
 *
 * @throws "The server's guide bundle couldn't be loaded (GET /client/docs: <reason>). Refresh the workspace to try again."
 */
export function loadRocketRideReference(): Promise<ReferenceTree> {
	loading ??= fetchReference().catch((err: unknown) => {
		loading = null;
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`The server's guide bundle couldn't be loaded (GET ${DOCS_URL}: ${reason}). Refresh the workspace to try again.`);
	});
	return loading;
}

/**
 * Fetches and unzips the bundle, keeping only the entries docsPathFor serves.
 *
 * @throws With the bare reason: the HTTP status, a body that is not a zip, or the network or unzip error.
 */
async function fetchReference(): Promise<ReferenceTree> {
	const response = await fetch(DOCS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!ZIP_MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error(`not a zip (${response.headers.get('content-type') ?? 'no content type'})`);
	const files = new Map<string, string>();
	for (const [name, data] of Object.entries(unzipSync(bytes))) {
		const path = docsPathFor(name);
		if (path) files.set(path, strFromU8(data));
	}
	return new ReferenceTree(ROCKETRIDE_ROOT, files);
}
