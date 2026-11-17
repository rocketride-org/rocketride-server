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
// PIPE BUNDLE — the publish unit of a pipeline (plan §9, B7)
// =============================================================================
//
// A pipeline publishes as a FOLDER: `pipelines/<pipeId>/` holding exactly one
// `.pipe` (what runs), beside the store manifest `<stem>.rrpipe` (display
// only: name, tagline, description, category, tags, icon, links, mode,
// plans — never publisher or author, which the server derives), `readme.md`
// (the store page), an icon, and `assets/` (the images the readme references).
// `packPipeBundle` reads that folder and builds the zip the deploy door takes
// as `data` beside the pipeline dict (pipe-at-root layout, deterministic
// entries). Node.js only, like the app packer; the browser twin lives in
// rocket-ui over its store VFS.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { MAX_ICON_BYTES, MAX_README_IMAGE_BYTES } from './scan.js';

// =============================================================================
// TYPES
// =============================================================================

/** The store manifest of a pipeline (`<stem>.rrpipe`), display only. */
export interface PipeManifest {
	/** Display name (defaults to the pipe's `name`, else the stem). */
	name?: string;
	/** One-line tagline for the store card. */
	tagline?: string;
	/** Store page description. */
	description?: string;
	/** Store category. */
	category?: string;
	/** Free tags. */
	tags?: string[];
	/** Bundle-relative icon path (`icon.svg` | `icon.png`). */
	icon?: string;
	/** Links the listing shows. */
	links?: { docs?: string; support?: string };
	/** Monetization mode, the app model: 'free' | 'subscription' | 'paywall'. */
	mode?: 'free' | 'subscription' | 'paywall';
	/** Subscription plans (the app plan machinery). */
	plans?: unknown[];
}

/** The result of {@link packPipeBundle}. */
export interface PackedPipeBundle {
	/** The pipeline dict (the `.pipe` JSON, display `name` filled). */
	pipeline: Record<string, unknown> & { name: string };
	/** The manifest as read (an empty object when the folder has none). */
	manifest: PipeManifest;
	/** The zip bytes to pass as `deploy.add({ kind: 'pipe', pipeline, data })`. */
	data: Uint8Array;
	/** Bundle-relative paths packed, in zip order. */
	files: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The readme file name the store page reads. */
export const PIPE_README_NAME = 'readme.md';

/** The folder of images the readme references. */
export const PIPE_ASSETS_DIR = 'assets';

/** The icon file names a bundle may carry, in preference order. */
export const PIPE_ICON_NAMES = ['icon.svg', 'icon.png'] as const;

/** Manifest keys the server accepts; anything else is refused at pack time. */
const MANIFEST_KEYS = new Set(['name', 'tagline', 'description', 'category', 'tags', 'icon', 'links', 'mode', 'plans']);

/** The readme cap (a store page, not a book). */
export const MAX_PIPE_README_BYTES = 1024 * 1024;

/** The manifest cap. */
export const MAX_PIPE_MANIFEST_BYTES = 64 * 1024;

/** Fixed entry timestamp: two packs of one folder hash the same. */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

// =============================================================================
// FOLDER
// =============================================================================

/**
 * The bundle folder of a path: the folder itself, or the folder of a `.pipe`
 * that is the only pipe in it. `null` when the path is neither — a bare pipe
 * beside other pipes, or no pipe at all (the B7 refusal).
 *
 * @param target - A folder or a `.pipe` file.
 * @returns The bundle folder, or null.
 */
export function pipeBundleFolderOf(target: string): string | null {
	const stat = fs.existsSync(target) ? fs.statSync(target) : null;
	if (!stat) return null;
	const folder = stat.isDirectory() ? target : path.dirname(target);
	const pipes = fs.readdirSync(folder).filter((name) => name.endsWith('.pipe'));
	if (pipes.length !== 1) return null;
	if (!stat.isDirectory() && path.basename(target) !== pipes[0]) return null;
	return folder;
}

/**
 * The one `.pipe` of a bundle folder and its stem.
 *
 * @param folder - The bundle folder.
 * @returns `{ file, stem }`.
 * @throws Error when the folder holds no pipe or more than one.
 */
export function pipeOfBundle(folder: string): { file: string; stem: string } {
	const pipes = fs.readdirSync(folder).filter((name) => name.endsWith('.pipe'));
	if (pipes.length === 0) throw new Error(`${folder} holds no .pipe file — a pipeline bundle is one folder with one .pipe`);
	if (pipes.length > 1) throw new Error(`${folder} holds ${pipes.length} .pipe files — a pipeline bundle is one folder with one .pipe`);
	return { file: path.join(folder, pipes[0]), stem: pipes[0].slice(0, -'.pipe'.length) };
}

// =============================================================================
// MANIFEST
// =============================================================================

/**
 * Reads and checks the bundle's `<stem>.rrpipe`.
 *
 * @param folder - The bundle folder.
 * @param stem - The pipe's stem.
 * @returns The manifest, or an empty object when the file is absent.
 * @throws Error on unparseable JSON, an unknown key, a bad mode, or an icon path outside the folder.
 */
export function readPipeManifest(folder: string, stem: string): PipeManifest {
	const file = path.join(folder, `${stem}.rrpipe`);
	if (!fs.existsSync(file)) return {};
	const raw = fs.readFileSync(file);
	if (raw.byteLength > MAX_PIPE_MANIFEST_BYTES) throw new Error(`${stem}.rrpipe exceeds ${MAX_PIPE_MANIFEST_BYTES} bytes`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString('utf8'));
	} catch (err) {
		throw new Error(`${stem}.rrpipe is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${stem}.rrpipe must hold a JSON object`);
	const manifest = parsed as Record<string, unknown>;
	for (const key of Object.keys(manifest)) {
		if (!MANIFEST_KEYS.has(key)) throw new Error(`${stem}.rrpipe: unknown key "${key}" (allowed: ${[...MANIFEST_KEYS].join(', ')})`);
	}
	if (manifest.mode !== undefined && !['free', 'subscription', 'paywall'].includes(String(manifest.mode))) {
		throw new Error(`${stem}.rrpipe: mode must be free, subscription or paywall`);
	}
	if (manifest.tags !== undefined && (!Array.isArray(manifest.tags) || manifest.tags.some((t) => typeof t !== 'string'))) {
		throw new Error(`${stem}.rrpipe: tags must be a list of strings`);
	}
	if (manifest.icon !== undefined) {
		const icon = String(manifest.icon).replace(/\\/g, '/');
		if (icon.startsWith('/') || icon.split('/').includes('..')) throw new Error(`${stem}.rrpipe: icon must be a path inside the bundle`);
	}
	return manifest as PipeManifest;
}

// =============================================================================
// PACK
// =============================================================================

/**
 * Packs a pipeline bundle folder into the deploy zip.
 *
 * Entries: the `.pipe`, the `.rrpipe` when present, `readme.md` when present,
 * the icon (the manifest's, else the first of {@link PIPE_ICON_NAMES} found),
 * and every file under `assets/`. Nothing else in the folder is packed.
 *
 * @param folder - The bundle folder (`pipelines/<pipeId>/`).
 * @returns The pipeline dict, the manifest and the zip.
 * @throws Error on a malformed folder, an unparseable pipe or manifest, or a breached cap.
 */
export function packPipeBundle(folder: string): PackedPipeBundle {
	// Step 1: the one pipe, parsed (the artifact the server snapshots)
	const { file, stem } = pipeOfBundle(folder);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`${path.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path.basename(file)} must hold a JSON object`);
	const pipe = parsed as Record<string, unknown>;

	// Step 2: the manifest; the display name falls back pipe -> manifest -> stem
	const manifest = readPipeManifest(folder, stem);
	const name = String(pipe.name || manifest.name || stem);
	const pipeline = { ...pipe, name } as Record<string, unknown> & { name: string };

	// Step 3: the content files, each under its cap
	const zip = new AdmZip();
	const files: string[] = [];
	const add = (rel: string, bytes: Buffer): void => {
		zip.addFile(rel, bytes);
		const entry = zip.getEntry(rel);
		if (entry) entry.header.time = ZIP_EPOCH;
		files.push(rel);
	};
	add(path.basename(file), fs.readFileSync(file));
	const manifestPath = path.join(folder, `${stem}.rrpipe`);
	if (fs.existsSync(manifestPath)) add(`${stem}.rrpipe`, fs.readFileSync(manifestPath));
	const readmePath = path.join(folder, PIPE_README_NAME);
	if (fs.existsSync(readmePath)) {
		const readme = fs.readFileSync(readmePath);
		if (readme.byteLength > MAX_PIPE_README_BYTES) throw new Error(`${PIPE_README_NAME} exceeds ${MAX_PIPE_README_BYTES} bytes`);
		add(PIPE_README_NAME, readme);
	}
	const iconRel = manifest.icon ? String(manifest.icon).replace(/\\/g, '/') : PIPE_ICON_NAMES.find((n) => fs.existsSync(path.join(folder, n)));
	if (iconRel) {
		const iconPath = path.join(folder, iconRel);
		if (!fs.existsSync(iconPath)) throw new Error(`the manifest names icon "${iconRel}" but the bundle has no such file`);
		const icon = fs.readFileSync(iconPath);
		if (icon.byteLength > MAX_ICON_BYTES) throw new Error(`${iconRel} exceeds ${MAX_ICON_BYTES} bytes`);
		add(iconRel, icon);
	}
	const assetsDir = path.join(folder, PIPE_ASSETS_DIR);
	if (fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
		const walk = (dir: string, rel: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const childRel = `${rel}/${entry.name}`;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
				else if (entry.isFile()) {
					const bytes = fs.readFileSync(path.join(dir, entry.name));
					if (bytes.byteLength > MAX_README_IMAGE_BYTES) throw new Error(`${childRel} exceeds ${MAX_README_IMAGE_BYTES} bytes`);
					add(childRel, bytes);
				}
			}
		};
		walk(assetsDir, PIPE_ASSETS_DIR);
	}
	return { pipeline, manifest, data: new Uint8Array(zip.toBuffer()), files };
}
