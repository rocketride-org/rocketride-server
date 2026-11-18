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
// PIPE PACK — the publish unit of a pipeline (plan §9)
// =============================================================================
//
// A pipeline publishes PER PIPE, BY REFERENCE: `packPipe` takes the path of
// one `.pipe` and builds the zip the deploy door takes as `data` beside the
// pipeline dict. The zip holds the pipe itself at the root under its own
// basename, the readme and icon the pipe's `store` block declares, and every
// file the README references (markdown images and links, HTML `<img src>`),
// laid out as they sit relative to the pipe file's directory. There is no
// folder rule: two pipes in one folder are two pipes and may share files.
// Nothing unreferenced is packed; every packed file must really live inside
// the pipe file's directory tree. Without a `store` block the pack is the
// pipe alone (an UNLISTED artifact). Node.js only, like the app packer; the
// rules themselves are the pure `client/pipe-store.ts`.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { defaultStoreBlock, normalizePosixPath, PIPE_ICON_SVG, pipeReadmeStub, pipeStoreFiles, validateStoreBlock } from '../client/pipe-store.js';
import type { PipeStoreBlock } from '../client/pipe-store.js';
import { MAX_ICON_BYTES, MAX_README_IMAGE_BYTES } from './scan.js';

// =============================================================================
// TYPES
// =============================================================================

/** The result of {@link packPipe}. */
export interface PackedPipe {
	/** The pipeline dict (the `.pipe` JSON, display `name` filled). */
	pipeline: Record<string, unknown>;
	/** The validated store block, or null when the pipe carries none (unlisted). */
	store: PipeStoreBlock | null;
	/** Paths packed, relative to the pipe file's directory, in zip order. */
	files: string[];
	/** The zip bytes to pass as `deploy.add({ kind: 'pipe', pipeline, data })`. */
	data: Uint8Array;
	/** Advisory notes (an undeclared icon or readme). */
	warnings: string[];
}

/** The result of {@link scaffoldPipe}. */
export interface CreatedPipe {
	/** Workspace-relative POSIX path of the created folder. */
	folder: string;
	/** Workspace-relative POSIX path of the `.pipe` file. */
	pipePath: string;
	/** Workspace-relative POSIX paths of the files written. */
	files: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The readme cap (a store page, not a book). */
export const MAX_PIPE_README_BYTES = 1024 * 1024;

/** Fixed entry timestamp: two packs of one pipe hash the same. */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

/** Pipe id grammar: one dot-free address segment (the developer id is attached at deploy). */
const PIPE_ID_RE = /^[A-Za-z0-9_-]+$/;

// =============================================================================
// READS
// =============================================================================

/**
 * Reads one file of the pipe's tree, refusing a path whose real location
 * leaves the pipe file's directory.
 *
 * `fs.readFileSync` follows symlinks: a link inside the tree pointing at a
 * file outside it would pack that file, and a `..` reference would read a
 * sibling's. Every read resolves the real path and requires it under the
 * real directory of the pipe.
 *
 * @param pipeDir - The pipe file's directory.
 * @param rel - The path relative to it (posix).
 * @returns The bytes.
 * @throws Error naming the path when it is missing, not a file, or outside.
 */
function readContained(pipeDir: string, rel: string): Buffer {
	if (rel.split('/')[0] === '..') throw new Error(`${rel} resolves outside the pipe file's directory`);
	const root = fs.realpathSync(pipeDir);
	const abs = path.join(pipeDir, ...rel.split('/'));
	if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist beside the pipe`);
	const real = fs.realpathSync(abs);
	if (!real.startsWith(root + path.sep)) throw new Error(`${rel} resolves outside the pipe file's directory`);
	if (!fs.statSync(real).isFile()) throw new Error(`${rel} is not a file`);
	return fs.readFileSync(real);
}

// =============================================================================
// PACK
// =============================================================================

/**
 * Packs one pipeline into the deploy zip.
 *
 * Entries: the `.pipe` at the root under its own basename, then — in
 * code-point order — the declared readme and icon and every file the README
 * references, each at its path relative to the pipe file's directory.
 *
 * @param pipePath - The `.pipe` file.
 * @returns The pipeline dict, the store block, the zip, and any warnings.
 * @throws Error when the path is not a `.pipe`, the JSON is invalid, the
 *   store block is invalid, a declared or referenced file is missing or
 *   resolves outside the pipe's directory, or a cap is breached.
 */
export function packPipe(pipePath: string): PackedPipe {
	// Step 1: the pipe, parsed (the artifact the server snapshots)
	const base = path.basename(pipePath);
	if (!base.endsWith('.pipe')) throw new Error(`${pipePath} is not a .pipe file`);
	if (!fs.existsSync(pipePath) || !fs.statSync(pipePath).isFile()) throw new Error(`${pipePath} does not exist`);
	const pipeDir = path.dirname(pipePath);
	const pipeBytes = fs.readFileSync(pipePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(pipeBytes.toString('utf8'));
	} catch (err) {
		throw new Error(`${base} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${base} must hold a JSON object`);
	const pipe = parsed as Record<string, unknown>;
	const stem = base.slice(0, -'.pipe'.length);
	const pipeline: Record<string, unknown> = { ...pipe, name: String(pipe.name || stem) };

	// Step 2: the store block — present = listable, absent = unlisted
	const store = pipe.store === undefined ? null : validateStoreBlock(pipe.store);
	const warnings: string[] = [];
	if (store && !store.icon) warnings.push('store.icon is not declared, so tiles show a generic glyph');
	if (store && !store.readme) warnings.push('store.readme is not declared, so the listing has no page');

	// Step 3: the declared files, each under its cap
	const entries = new Map<string, Buffer>();
	const readmeRel = store?.readme ? normalizePosixPath(store.readme) : null;
	let readmeText: string | null = null;
	if (readmeRel) {
		const readme = readContained(pipeDir, readmeRel);
		if (readme.byteLength > MAX_PIPE_README_BYTES) throw new Error(`${readmeRel} exceeds ${MAX_PIPE_README_BYTES} bytes`);
		entries.set(readmeRel, readme);
		readmeText = readme.toString('utf8');
	}
	if (store?.icon) {
		const iconRel = normalizePosixPath(store.icon);
		const icon = readContained(pipeDir, iconRel);
		if (icon.byteLength > MAX_ICON_BYTES) throw new Error(`${iconRel} exceeds ${MAX_ICON_BYTES} bytes`);
		entries.set(iconRel, icon);
	}

	// Step 4: the README's references, resolved against the README and laid
	// out relative to the pipe; a reference that escapes upward is refused
	// by the containment read, by name
	for (const rel of pipeStoreFiles(store, readmeText, readmeRel).referenced) {
		if (entries.has(rel) || rel === base) continue;
		const bytes = readContained(pipeDir, rel);
		if (bytes.byteLength > MAX_README_IMAGE_BYTES) throw new Error(`${rel} exceeds ${MAX_README_IMAGE_BYTES} bytes`);
		entries.set(rel, bytes);
	}

	// Step 5: the zip — pipe first, then code-point order (the Python
	// packer's `sorted()`), fixed timestamps: identical bytes on every pack
	const zip = new AdmZip();
	const files: string[] = [];
	const add = (rel: string, bytes: Buffer): void => {
		zip.addFile(rel, bytes);
		const entry = zip.getEntry(rel);
		if (entry) entry.header.time = ZIP_EPOCH;
		files.push(rel);
	};
	add(base, pipeBytes);
	for (const rel of [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) add(rel, entries.get(rel) as Buffer);
	return { pipeline, store, files, data: new Uint8Array(zip.toBuffer()), warnings };
}

// =============================================================================
// SCAFFOLD (a new pipeline)
// =============================================================================

/**
 * Scaffolds a new pipeline — the ONE scaffold behind `rocketride pipe new`
 * and `client.deploy.createPipe()`. Writes `<dir>/<pipeId>/<pipeId>.pipe`
 * with the default `store` block, the placeholder `icon.svg` the app
 * scaffold ships, a `README.md` stub, and an empty `assets/` directory.
 *
 * @param workspaceRoot - The workspace folder that owns `<dir>`.
 * @param pipeId - The pipeline id: one dot-free segment of letters, digits,
 *   `_` or `-` (the deploying organization's developer id is attached at
 *   deploy, never written into the file).
 * @param options.name - Display name (default: the id).
 * @param options.dir - The pipelines directory, relative to the workspace
 *   (default `pipelines`).
 * @returns The created folder, pipe path and files, workspace-relative.
 * @throws Error on an invalid id or an existing pipe file.
 */
export function scaffoldPipe(workspaceRoot: string, pipeId: string, options: { name?: string; dir?: string } = {}): CreatedPipe {
	// step: identity — validate before touching disk
	if (!PIPE_ID_RE.test(pipeId)) throw new Error(`Pipeline id "${pipeId}" is invalid — one dot-free segment of letters, digits, _ or -.`);
	const dir = normalizePosixPath(options.dir ?? 'pipelines') || 'pipelines';
	const folderRel = `${dir}/${pipeId}`;
	const folderAbs = path.join(path.resolve(workspaceRoot), ...folderRel.split('/'));
	const pipeRel = `${folderRel}/${pipeId}.pipe`;
	const pipeAbs = path.join(folderAbs, `${pipeId}.pipe`);
	if (fs.existsSync(pipeAbs)) throw new Error(`"${pipeRel}" already exists — pick another id or remove the file.`);

	// step: the files — components first (the layout the editor expects),
	// identity and the listing block after
	const name = options.name ?? pipeId;
	const pipe = { components: [], project_id: pipeId, name, description: '', store: defaultStoreBlock() };
	const files: Array<[string, string]> = [
		[`${pipeId}.pipe`, `${JSON.stringify(pipe, null, 2)}\n`],
		['icon.svg', PIPE_ICON_SVG],
		['README.md', pipeReadmeStub(name)],
	];
	fs.mkdirSync(path.join(folderAbs, 'assets'), { recursive: true });
	for (const [rel, content] of files) fs.writeFileSync(path.join(folderAbs, rel), content);
	return { folder: folderRel, pipePath: pipeRel, files: files.map(([rel]) => `${folderRel}/${rel}`) };
}
