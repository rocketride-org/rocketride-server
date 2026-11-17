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
// PACK BUNDLE — the browser packer of a pipeline bundle (plan §9, B7)
// =============================================================================
//
// The browser twin of the SDK's Node-only `packPipeBundle`: reads the bundle
// folder of an open pipeline from the workspace store (the pipelines mount is
// `.projects/<folder>` in the user's or team's tree) and builds the deploy
// zip the DEPLOY card sends beside the pipeline dict — the pipe, its .rrpipe
// manifest, readme.md, the icon and assets/, nothing else. The server reads
// and guards the zip again; this only serves bytes, like the app packer.
// =============================================================================

import { zipSync } from 'fflate';
import type { RocketRideClient } from 'shell';
import { scopedFileSystem } from 'shared/modules/vfs/scopedFileSystem';
import { pipeStemOf } from 'shared/tools/pipelines/sidebar/bundles';
import { getWorkspaceVfs, toScopedStorePath } from '../workspace/vfs/workspace';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The store directory the pipelines mount maps to (the workspace VFS's own value). */
const PROJECTS_DIR = '.projects';

/** The server's receipt cap on zipped bytes (mirrors _ZIP_MAX_ZIPPED). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** The icon file names a bundle may carry, in preference order. */
const ICON_NAMES = ['icon.svg', 'icon.png'];

// =============================================================================
// TYPES
// =============================================================================

/** The packed bundle: the pipe dict and the zip. */
export interface PackedBundle {
	/** The pipe's JSON with its display name filled. */
	pipeline: Record<string, unknown> & { name: string };
	/** The zip bytes for `client.deploy.add({ kind: 'pipe', pipeline, data })`. */
	data: Uint8Array;
}

// =============================================================================
// PACK
// =============================================================================

/**
 * Packs the bundle folder of an open pipeline document.
 *
 * @param client - The connected client (raw store reads).
 * @param pipePath - The document's path under the pipelines mount (`<folder>/<stem>.pipe`).
 * @returns The pipe dict and the zip.
 * @throws Error when the folder is not a bundle (no pipe, another pipe beside it) or a read fails.
 */
export async function packPipeBundle(client: RocketRideClient, pipePath: string): Promise<PackedBundle> {
	// Step 1: the folder, and the one pipe in it
	const slash = pipePath.lastIndexOf('/');
	const folder = slash >= 0 ? pipePath.slice(0, slash) : '';
	const stem = pipeStemOf(pipePath);
	if (!folder || !stem) {
		throw new Error('This pipeline is not in a bundle folder. Move it to pipelines/<id>/<id>.pipe (beside its readme, icon and assets) to deploy it.');
	}
	if (pipePath.endsWith('.pipe.json')) {
		throw new Error(`A pipeline bundle takes <id>.pipe; rename ${pipePath.slice(slash + 1)} to ${stem}.pipe to deploy it.`);
	}
	const view = scopedFileSystem(getWorkspaceVfs(), 'pipelines');
	const entries = await view.list(folder);
	const pipes = entries.filter((e) => e.type !== 'dir' && e.name.endsWith('.pipe')).map((e) => e.name);
	if (pipes.length !== 1 || pipes[0] !== `${stem}.pipe`) {
		throw new Error(`${folder}/ holds ${pipes.length} .pipe files; a pipeline bundle is one folder with one .pipe. Move this pipeline to its own folder to deploy it.`);
	}

	// Step 2: the files the bundle carries, nothing else. The manifest is
	// read first: its `icon` names the icon file (the server requires that
	// exact entry); the default names apply only without one.
	const names = new Set(entries.filter((e) => e.type !== 'dir').map((e) => e.name));
	const picked: string[] = [`${stem}.pipe`];
	let manifestName = '';
	let manifestIcon = '';
	if (names.has(`${stem}.rrpipe`)) {
		picked.push(`${stem}.rrpipe`);
		const manifest = JSON.parse(String(await view.read(`${folder}/${stem}.rrpipe`))) as Record<string, unknown>;
		manifestName = typeof manifest.name === 'string' ? manifest.name : '';
		manifestIcon = typeof manifest.icon === 'string' ? manifest.icon.replace(/\\/g, '/') : '';
	}
	if (names.has('readme.md')) picked.push('readme.md');
	const icon = manifestIcon || ICON_NAMES.find((n) => names.has(n));
	if (icon) {
		if (manifestIcon && !names.has(manifestIcon) && !manifestIcon.startsWith('assets/')) {
			throw new Error(`The manifest names icon "${manifestIcon}" but the bundle has no such file.`);
		}
		if (!manifestIcon || !manifestIcon.startsWith('assets/')) picked.push(icon);
	}
	if (entries.some((e) => e.type === 'dir' && e.name === 'assets')) {
		const walk = async (rel: string): Promise<void> => {
			for (const entry of await view.list(`${folder}/${rel}`)) {
				const childRel = `${rel}/${entry.name}`;
				if (entry.type === 'dir') await walk(childRel);
				else if (entry.name !== '.dirmarker') picked.push(childRel);
			}
		};
		await walk('assets');
	}

	// Step 3: the bytes, read raw from the store (binaries included)
	const tree: Record<string, Uint8Array> = {};
	for (let i = 0; i < picked.length; i += 256) {
		const chunk = picked.slice(i, i + 256);
		const results = await client.fsReadMany(chunk.map((rel) => toScopedStorePath(`${PROJECTS_DIR}/${folder}/${rel}`)));
		results.forEach((entry, idx) => {
			if (entry.ok && entry.data) tree[chunk[idx]] = entry.data;
			else throw new Error(`Cannot read ${folder}/${chunk[idx]}: ${entry.error ?? 'unreadable'}.`);
		});
	}
	const pipe = JSON.parse(new TextDecoder().decode(tree[`${stem}.pipe`])) as Record<string, unknown>;
	const pipeline = { ...pipe, name: String(pipe.name || manifestName || stem) } as Record<string, unknown> & { name: string };

	// Step 4: zip + the transport cap BEFORE any upload
	const data = zipSync(tree, { level: 6 });
	if (data.byteLength > MAX_ZIP_BYTES) {
		throw new Error(`The bundle is ${(data.byteLength / (1024 * 1024)).toFixed(1)} MB zipped — over the 50 MB deploy cap.`);
	}
	return { pipeline, data };
}
