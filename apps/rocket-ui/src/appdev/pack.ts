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
// PACK — the browser source packer (fflate zip of the .appdev working copy)
// =============================================================================

/**
 * Packs one app's working copy into the deploy zip: the VFS tree, verbatim
 * (byte-identical to what the user authored — the pack IS the provenance),
 * in the app-at-root layout the server validates (package.json at the zip
 * root carrying appManifest; no metadata.appRoot needed). The server does
 * the one true bundle; this only serves bytes.
 *
 * The Node app-pack (rocketride/app-pack) stays Node-only by design — this
 * is its browser twin over the store VFS, enforcing the same 50 MB zipped
 * cap the server enforces on receipt.
 */

import { zipSync } from 'fflate';
import type { RocketRideClient } from 'shell';
import { appPath } from './appStore';
import { getStagedWorkspace, getWorkspaceVfs } from '../workspace/workspace';

/** The server's receipt cap on zipped bytes (mirrors _ZIP_MAX_ZIPPED). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** Store subtrees the pack never carries (derived outputs). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

/**
 * Packs the app folder into a zip (all files, text and binary — the pack
 * carries user truth verbatim, not just what the design loop edits).
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @returns The zip bytes, ready for client.deploy.add.
 */
export async function packAppSource(client: RocketRideClient, folder: string): Promise<Uint8Array> {
	// step: walk through the workspace VIEW (identical to the base once the
	// commit-first gate below holds; one inventory path either way)
	const view = getWorkspaceVfs();
	const paths: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		const entries = await view.list(rel ? `apps/${folder}/${rel}` : `apps/${folder}`);
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.type === 'dir') {
				if (!SKIP_DIRS.has(entry.name)) await walk(childRel);
			} else if (entry.name !== '.dirmarker') {
				paths.push(childRel);
			}
		}
	};
	await walk('');
	if (!paths.includes('package.json')) {
		throw new Error('The app folder has no package.json — nothing deployable.');
	}

	// step: D2 — pack operates on COMMITTED files only. With the gate held,
	// the view and the base agree, so the whole tree bulk-reads from the
	// store in one path (binaries included; the raw batch is the documented
	// binary escape hatch — the view contract is text-only).
	const pendingCount = [...getStagedWorkspace().changedPaths().keys()]
		.filter((vp) => vp === `apps/${folder}` || vp.startsWith(`apps/${folder}/`)).length;
	if (pendingCount > 0) {
		throw new Error(`${pendingCount} uncommitted change(s) in this app — commit them first (status bar: Commit all), then deploy.`);
	}
	const tree: Record<string, Uint8Array> = {};
	for (let i = 0; i < paths.length; i += 256) {
		const chunk = paths.slice(i, i + 256);
		const results = await client.fsReadMany(chunk.map((p) => appPath(folder, p)));
		results.forEach((entry, idx) => {
			if (entry.ok && entry.data) tree[chunk[idx]] = entry.data;
			else throw new Error(`Cannot read ${chunk[idx]}: ${entry.error ?? 'unreadable'}.`);
		});
	}

	// step: zip + enforce the transport cap BEFORE any upload
	const zipped = zipSync(tree, { level: 6 });
	if (zipped.byteLength > MAX_ZIP_BYTES) {
		throw new Error(`Packed source is ${(zipped.byteLength / (1024 * 1024)).toFixed(1)} MB zipped — over the 50 MB deploy cap.`);
	}
	return zipped;
}
