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
// TYPES FEED — shell.d.ts + vendored SDK types from the served shell.tgz
// =============================================================================

/**
 * Feeds the editor the SERVER-VERSIONED type surfaces: shell.d.ts (the
 * frozen platform contract) and the vendored rocketride SDK's declaration
 * tree, both extracted from GET /client/shell (shell.tgz) IN THE BROWSER —
 * DecompressionStream gunzips, a minimal tar reader walks the entries.
 * Extracted declarations cache in IndexedDB keyed by the tgz's byte length
 * (a cheap, good-enough version fingerprint: the tgz changes with every
 * platform build). The React type packages are NOT here — they ship inside
 * the bundle (shared/modules/monaco typescriptSetup).
 */

import { cacheGet, cachePut } from './idbCache';

// =============================================================================
// TAR READER
// =============================================================================

/** One extracted tar entry. */
interface TarEntry {
	/** Entry path as stored (e.g. 'package/shell.d.ts'). */
	path: string;
	/** Entry bytes. */
	data: Uint8Array;
}

/**
 * Walks a POSIX ustar archive (the npm-pack format) and returns its file
 * entries. Handles the ustar prefix field and zero-block termination;
 * everything non-file (dirs, pax headers) is skipped — pax path overrides
 * are not needed for npm tarballs of this size.
 *
 * @param bytes - The decompressed tar bytes.
 * @returns The file entries.
 */
function readTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	const decoder = new TextDecoder();
	/** Reads a NUL-terminated string field. */
	const field = (offset: number, length: number): string => {
		const slice = bytes.subarray(offset, offset + length);
		const nul = slice.indexOf(0);
		return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
	};
	let pos = 0;
	while (pos + 512 <= bytes.length) {
		// step: two consecutive zero blocks terminate the archive
		if (bytes.subarray(pos, pos + 512).every((b) => b === 0)) break;
		const name = field(pos, 100);
		const sizeOctal = field(pos + 124, 12).trim();
		const size = parseInt(sizeOctal || '0', 8) || 0;
		const typeflag = bytes[pos + 156];
		const prefix = field(pos + 345, 155);
		const path = prefix ? `${prefix}/${name}` : name;
		// typeflag '0' or NUL = regular file
		if (typeflag === 48 || typeflag === 0) {
			entries.push({ path, data: bytes.subarray(pos + 512, pos + 512 + size) });
		}
		// step: advance past the 512-aligned data blocks
		pos += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

// =============================================================================
// FEED
// =============================================================================

/** One declaration file for the editor, at its virtual path. */
export interface TypeLib {
	/** Virtual path (file:///node_modules/...). */
	path: string;
	/** Declaration text. */
	content: string;
}

/**
 * Fetches shell.tgz and extracts the editor's server-versioned type libs:
 *
 *  - shell.d.ts            -> node_modules/shell/index.d.ts
 *  - vendored SDK d.ts     -> node_modules/rocketride/<their tgz paths>
 *  - a synthesized rocketride entry d.ts re-exporting the SDK barrel
 *
 * Cached in IndexedDB keyed by the tgz byte length.
 *
 * @returns The type libs to register as extraLibs.
 */
export async function fetchPlatformTypeLibs(): Promise<TypeLib[]> {
	// step: fetch the tgz (small; HTTP-cached by the browser anyway)
	const response = await fetch('/client/shell');
	if (!response.ok) throw new Error(`GET /client/shell failed: ${response.status}`);
	const gz = new Uint8Array(await response.arrayBuffer());

	// step: cache hit on the byte-length fingerprint
	const cacheKey = `shell-tgz:${gz.byteLength}`;
	const cached = await cacheGet<TypeLib[]>('types', cacheKey);
	if (cached) return cached;

	// step: gunzip via the native stream, then walk the tar
	const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
	const tar = new Uint8Array(await new Response(stream).arrayBuffer());
	const entries = readTar(tar);
	const decoder = new TextDecoder();

	const libs: TypeLib[] = [];
	for (const entry of entries) {
		// npm packs everything under 'package/'
		const rel = entry.path.replace(/^package\//, '');
		if (rel === 'shell.d.ts') {
			libs.push({ path: 'file:///node_modules/shell/index.d.ts', content: decoder.decode(entry.data) });
		} else if (rel.startsWith('node_modules/rocketride/') && rel.endsWith('.d.ts')) {
			libs.push({ path: `file:///${rel}`, content: decoder.decode(entry.data) });
		}
	}
	// step: synthesize the rocketride package entry — the vendored types
	// barrel lives at dist/types/client/index.d.ts (the SDK's types field)
	if (libs.some((l) => l.path === 'file:///node_modules/rocketride/dist/types/client/index.d.ts')) {
		libs.push({ path: 'file:///node_modules/rocketride/index.d.ts', content: "export * from './dist/types/client/index';\n" });
	}

	void cachePut('types', cacheKey, libs);
	return libs;
}
