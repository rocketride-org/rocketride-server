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
// SCAFFOLD PIPE — the browser scaffold of a new pipeline (plan §9)
// =============================================================================
//
// The browser twin of the SDK's Node-only `scaffoldPipe`, over the workspace
// store's pipelines mount: `<dir>/<pipeId>/` holding `<pipeId>.pipe` (the id,
// the display name, the default store block), `icon.svg` (the app scaffold's
// placeholder), `README.md` (the SDK's stub) and an empty `assets/` — the same
// files the CLI and VS Code write, so a pipeline looks the same wherever it
// was born.
// =============================================================================

import { defaultStoreBlock, PIPE_ICON_SVG, pipeReadmeStub } from 'rocketride';
import { scopedFileSystem } from 'shared/modules/vfs/scopedFileSystem';
import { getWorkspaceVfs } from '../workspace/vfs/workspace';

// =============================================================================
// TYPES
// =============================================================================

/** What the scaffold wrote, as paths under the pipelines mount. */
export interface ScaffoldedPipe {
	/** The pipeline's folder. */
	folder: string;
	/** The `.pipe` file. */
	pipePath: string;
	/** Every file written, in write order. */
	files: string[];
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/**
 * Scaffolds a new pipeline folder in the workspace store.
 *
 * @param dir - The parent directory under the pipelines mount ('' for its root).
 * @param pipeId - The pipeline's short id: the folder and file name AND `project_id`.
 * @param displayName - The pipeline's display name (`name`, the README title).
 * @param project - The untitled document's content; its components ride along.
 * @returns The folder, the pipe's path and the files written.
 * @throws Error when a write fails; the folder THIS call made is removed if it is still empty.
 */
export async function scaffoldPipe(dir: string, pipeId: string, displayName: string, project: unknown): Promise<ScaffoldedPipe> {
	const view = scopedFileSystem(getWorkspaceVfs(), 'pipelines');
	const folder = dir ? `${dir}/${pipeId}` : pipeId;
	const pipePath = `${folder}/${pipeId}.pipe`;
	const files: string[] = [];
	// Step 1: the folder
	await view.mkdir(folder);
	try {
		// Step 2: the pipe — the untitled document's components stay; the
		// identity and the store block are the scaffold's
		const base = project && typeof project === 'object' && !Array.isArray(project) ? (project as Record<string, unknown>) : {};
		const pipe = { ...base, project_id: pipeId, name: displayName, store: defaultStoreBlock(), components: Array.isArray(base.components) ? base.components : [] };
		await view.write(pipePath, `${JSON.stringify(pipe, null, 2)}\n`);
		files.push(pipePath);
		// Step 3: what the block points at — the icon, the README — and assets/
		await view.write(`${folder}/icon.svg`, PIPE_ICON_SVG);
		files.push(`${folder}/icon.svg`);
		await view.write(`${folder}/README.md`, pipeReadmeStub(displayName));
		files.push(`${folder}/README.md`);
		await view.mkdir(`${folder}/assets`);
	} catch (err) {
		// A failed write must leave the name retryable: the folder THIS call
		// made goes if it is still empty (never anyone else's content).
		const left = await view.list(folder).catch(() => null);
		if (left && left.length === 0) await view.delete(folder).catch(() => undefined);
		throw err;
	}
	return { folder, pipePath, files };
}
