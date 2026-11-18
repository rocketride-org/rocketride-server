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
// PACK PIPE — the browser packer of one pipeline (plan §9)
// =============================================================================
//
// The browser twin of the SDK's Node-only `packPipe`: packs ONE pipeline from
// the workspace store (the pipelines mount is `.projects/` in the user's or
// team's tree) into the deploy zip the DEPLOY card sends beside the pipeline
// dict. Packing is PER PIPE, BY REFERENCE: the pipe file at the zip root
// under its basename, the readme and icon its `store` block declares, and
// every file the README references (markdown images and links, HTML
// `<img src>`), laid out relative to the PIPE's directory. Nothing else in
// the folder is packed; two pipes in one folder are two pipes. A pipe without
// a `store` block packs alone and deploys unlisted. The server reads and
// guards the zip again; this only serves bytes, like the app packer.
// =============================================================================

import { zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import type { RocketRideClient } from 'shell';
import { normalizePosixPath, pipeStoreFiles, validateStoreBlock } from 'rocketride';
import type { PipeStoreBlock } from 'rocketride';
import { toScopedStorePath } from '../workspace/vfs/workspace';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The store directory the pipelines mount maps to (the workspace VFS's own value). */
const PROJECTS_DIR = '.projects';

/** The server's receipt cap on zipped bytes (mirrors _ZIP_MAX_ZIPPED). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** The readme cap (a store page, not a book) — the Node packer's. */
const MAX_README_BYTES = 1024 * 1024;

/** The icon cap — the Node packer's. */
const MAX_ICON_BYTES = 256 * 1024;

/** The cap on each file the README references — the Node packer's. */
const MAX_REFERENCED_BYTES = 10 * 1024 * 1024;

/** Fixed entry timestamp: two packs of one pipe hash the same. */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

// =============================================================================
// TYPES
// =============================================================================

/** The packed pipeline: the pipe dict, its listing and the zip. */
export interface PackedPipe {
	/** The pipe's JSON (WITH its `store` block) and its display name filled. */
	pipeline: Record<string, unknown> & { name: string };
	/** The validated store block, null when the pipe carries none (unlisted). */
	store: PipeStoreBlock | null;
	/** Zip entry paths in zip order: the pipe first, then code-point order. */
	files: string[];
	/** The zip bytes for `client.deploy.add({ pipeline, data })`. */
	data: Uint8Array;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Reads ONE store file raw (binaries included). The listing carries no sizes
 * and one fsReadMany call is capped at 32 MiB in total while a referenced
 * file may be 10 MiB, so every file goes in a call of its own.
 *
 * @param client - The connected client.
 * @param pipeDir - The pipe's directory under the pipelines mount ('' at the root).
 * @param rel - The file's path relative to the pipe's directory.
 * @returns The bytes.
 * @throws Error naming the file when it cannot be read.
 */
async function readOne(client: RocketRideClient, pipeDir: string, rel: string): Promise<Uint8Array> {
	const full = pipeDir ? `${pipeDir}/${rel}` : rel;
	const [entry] = await client.fsReadMany([toScopedStorePath(`${PROJECTS_DIR}/${full}`)]);
	if (!entry?.ok || !entry.data) throw new Error(`The pipeline's store listing names ${rel}, but there is no such file beside the pipe (${entry?.error ?? 'unreadable'}).`);
	return entry.data;
}

/**
 * Checks a listing path stays inside the pipe's directory tree. The store VFS
 * has no realpath, so containment is judged on the normalised path alone: a
 * leading `..` after normalisation is an escape.
 *
 * @param rel - The normalised path relative to the pipe's directory.
 * @throws Error naming the file when it leaves the directory.
 */
function requireContained(rel: string): void {
	if (rel === '' || rel.split('/')[0] === '..') throw new Error(`${rel || '.'} resolves outside the pipeline's directory; every listed file must sit beside the pipe or below it.`);
}

/**
 * Checks one file against its cap.
 *
 * @param rel - The file's path, for the error.
 * @param bytes - The bytes read.
 * @param cap - The cap in bytes.
 * @throws Error naming the file when it is over the cap.
 */
function requireUnderCap(rel: string, bytes: Uint8Array, cap: number): void {
	if (bytes.byteLength > cap) throw new Error(`${rel} is ${(bytes.byteLength / 1024).toFixed(0)} KB, over the ${(cap / 1024).toFixed(0)} KB cap.`);
}

// =============================================================================
// PACK
// =============================================================================

/**
 * Packs one open pipeline document for deploy.
 *
 * @param client - The connected client (raw store reads).
 * @param pipePath - The document's path under the pipelines mount (`<dir>/<name>.pipe`).
 * @returns The pipe dict, its store block and the zip.
 * @throws Error when the pipe is not valid JSON, its `store` block is malformed,
 *   a listed file is missing, escapes the pipe's directory or breaches its cap,
 *   or the zip is over the deploy cap.
 */
export async function packPipe(client: RocketRideClient, pipePath: string): Promise<PackedPipe> {
	// Step 1: the pipe, parsed (the artifact the server snapshots)
	const slash = pipePath.lastIndexOf('/');
	const pipeDir = slash >= 0 ? pipePath.slice(0, slash) : '';
	const pipeName = pipePath.slice(slash + 1);
	const stem = pipeName.endsWith('.pipe') ? pipeName.slice(0, -'.pipe'.length) : pipeName;
	const pipeBytes = await readOne(client, pipeDir, pipeName);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(pipeBytes));
	} catch (err) {
		throw new Error(`${pipeName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${pipeName} must hold a JSON object`);
	const pipe = parsed as Record<string, unknown>;
	const pipeline = { ...pipe, name: String(pipe.name || stem) } as Record<string, unknown> & { name: string };

	// Step 2: the store block; absent = unlisted, the pipe packs alone
	const store = pipe.store === undefined ? null : validateStoreBlock(pipe.store);

	// Step 3: the README (one read) and the files it and the block name
	const readmeRel = store?.readme ? normalizePosixPath(store.readme) : null;
	const bytes = new Map<string, Uint8Array>();
	let readmeText: string | null = null;
	if (readmeRel !== null) {
		requireContained(readmeRel);
		const readme = await readOne(client, pipeDir, readmeRel);
		requireUnderCap(readmeRel, readme, MAX_README_BYTES);
		bytes.set(readmeRel, readme);
		readmeText = new TextDecoder().decode(readme);
	}
	const { declared, referenced } = pipeStoreFiles(store, readmeText, readmeRel);
	const iconRel = store?.icon ? normalizePosixPath(store.icon) : null;
	for (const rel of [...declared, ...referenced]) {
		if (rel === pipeName || bytes.has(rel)) continue;
		requireContained(rel);
		const data = await readOne(client, pipeDir, rel);
		requireUnderCap(rel, data, rel === iconRel ? MAX_ICON_BYTES : MAX_REFERENCED_BYTES);
		bytes.set(rel, data);
	}

	// Step 4: zip — the pipe first, then code-point order (the Python packer's
	// `sorted()`): two packs of one pipe hash the same in both languages
	const files = [pipeName, ...[...bytes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
	const tree: Zippable = {};
	tree[pipeName] = [pipeBytes, { mtime: ZIP_EPOCH }];
	for (const rel of files.slice(1)) tree[rel] = [bytes.get(rel) as Uint8Array, { mtime: ZIP_EPOCH }];
	const data = zipSync(tree, { level: 6 });
	if (data.byteLength > MAX_ZIP_BYTES) {
		throw new Error(`The pipeline packs to ${(data.byteLength / (1024 * 1024)).toFixed(1)} MB zipped — over the 50 MB deploy cap.`);
	}
	return { pipeline, store, files, data };
}
