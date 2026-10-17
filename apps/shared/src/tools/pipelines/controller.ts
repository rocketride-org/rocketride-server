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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/PIPELINES — the discovery loop (scan → parse → entries → watch)
// =============================================================================
//
// The `.pipe` discovery that used to run in the VS Code extension host, now
// the pipelines CONTROLLER's own loop over the generic workspace-FS
// capability: find the files, parse them (shared parse.ts), build the
// sidebar's ProjectEntry rows, and rescan on file events. Service-catalog
// changes re-derive source components from the cached parses — callers hook
// their catalog signal to `refresh({ reparse: false })`.
// =============================================================================

import { parsePipelineContent } from './parse';
import type { ParsedPipelineFile, ServiceClassInfo } from './parse';
import type { IToolWorkspaceFs } from '../core/workspaceFs';
import type { ProjectEntry } from '../../modules/sidebar/types';

/** The globs that are pipeline files. */
export const PIPELINE_FILE_GLOBS = ['**/*.pipe', '**/*.pipe.json'];
/** node_modules never holds a user pipeline. */
export const PIPELINE_SCAN_EXCLUDE = '**/node_modules/**';
/** Debounce for file-event rescans (saves touch create+change in bursts). */
export const PIPELINE_RESCAN_DEBOUNCE_MS = 300;

/** What the discovery loop needs beyond the FS capability. */
export interface IPipelineDiscoveryOptions {
	/** The current service catalog (classType source detection + titles);
	 *  undefined while the catalog has not arrived. Read per build. */
	getServices(): Record<string, ServiceClassInfo> | undefined;
}

/** The running loop's handle. */
export interface IPipelineDiscovery {
	/**
	 * Re-runs the pipeline build. `reparse: false` rebuilds entries from the
	 * cached parses only — the service-catalog-changed path, where files on
	 * disk are unchanged but source detection and titles are not.
	 */
	refresh(opts?: { reparse?: boolean }): void;
	/** Stops the loop (watch, debounce, in-flight builds). */
	stop(): void;
}

/** Strips the matching workspace root, '/'-normalized (display path). */
function toRelativePath(fsPath: string, roots: string[]): string {
	const normalized = fsPath.replace(/\\/g, '/');
	for (const root of roots) {
		const rootNorm = root.replace(/\\/g, '/').replace(/\/$/, '');
		if (normalized.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) {
			return normalized.slice(rootNorm.length + 1);
		}
	}
	return normalized;
}

/**
 * Runs the pipelines controller's discovery loop: one scan now, a debounced
 * rescan on every pipeline-file event. Superseded runs never overwrite
 * newer results; a failed scan keeps the previous entries.
 *
 * @param fs - The workspace-FS capability.
 * @param options - The service-catalog accessor.
 * @param onEntries - Receives each fresh entry set (the controller's state).
 * @returns The running loop's handle.
 */
export function startPipelineDiscovery(fs: IToolWorkspaceFs, options: IPipelineDiscoveryOptions, onEntries: (entries: ProjectEntry[]) => void): IPipelineDiscovery {
	let seq = 0;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Raw file text per path from the last full scan — catalog-only refreshes
	// re-derive entries without touching the file system.
	let lastContents = new Map<string, string>();
	let lastRoots: string[] = [];

	const buildEntries = (): ProjectEntry[] => {
		const services = options.getServices();
		const entries: ProjectEntry[] = [];
		for (const [fsPath, content] of lastContents) {
			const parsed: ParsedPipelineFile = parsePipelineContent(content, fsPath, services);
			const relativePath = toRelativePath(fsPath, lastRoots);
			if (!parsed.isValid) {
				entries.push({ path: relativePath });
				continue;
			}
			const sources = parsed.sourceComponents
				.map((sc) => ({
					id: sc.id,
					name: sc.name || (sc.provider ? services?.[sc.provider]?.title : undefined) || sc.id,
					...(sc.provider !== undefined ? { provider: sc.provider } : {}),
				}))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
			entries.push({
				path: relativePath,
				...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
				sources,
			});
		}
		entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
		return entries;
	};

	const rescan = (reparse: boolean): void => {
		const mine = ++seq;
		void (async () => {
			if (reparse) {
				const [roots, found] = await Promise.all([
					fs.workspaceRoots(),
					Promise.all(PIPELINE_FILE_GLOBS.map((glob) => fs.findFiles(glob, PIPELINE_SCAN_EXCLUDE))),
				]);
				const paths = [...new Set(found.flat())];
				const contents = new Map<string, string>();
				await Promise.all(paths.map(async (path) => {
					try {
						contents.set(path, await fs.readTextFile(path));
					} catch {
						// Unreadable mid-save — the debounced follow-up event retries.
					}
				}));
				if (mine !== seq) return;
				lastContents = contents;
				lastRoots = roots;
			}
			if (mine !== seq) return;
			onEntries(buildEntries());
		})().catch(() => {
			// A failed scan keeps the previous entries; the next event retries.
		});
	};

	rescan(true);
	const offWatch = fs.watch(PIPELINE_FILE_GLOBS, (path) => {
		if (path.includes('node_modules')) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timer = undefined; rescan(true); }, PIPELINE_RESCAN_DEBOUNCE_MS);
	});

	return {
		refresh(opts) {
			if (stopped) return;
			rescan(opts?.reparse !== false);
		},
		stop() {
			stopped = true;
			seq++;
			if (timer) clearTimeout(timer);
			offWatch();
		},
	};
}
