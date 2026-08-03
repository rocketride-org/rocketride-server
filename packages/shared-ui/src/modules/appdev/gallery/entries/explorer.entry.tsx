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
// EXPLORER — GALLERY ENTRY (LAZY)
// =============================================================================

/** Gallery entry for the Explorer document tree (sidebar content). */

import type { IGalleryEntry } from '../galleryTypes';

/** The Explorer gallery entry. */
export const explorerEntry: IGalleryEntry = {
	id: 'explorer',
	name: 'Explorer',
	group: 'sidebar',
	blurb: 'VFS-backed tree/list for pipelines, chats, connections, and files: S3-style flat paths, per-entry children (source components), inline create/rename, and status dots. The host supplies a flat entries array and handles every action via callbacks.',
	lazyDemo: () => import('./demos/ExplorerDemo'),
	code: `import { Explorer, NOOP_VFS } from 'shell';

<Explorer
	vfs={NOOP_VFS}
	config={{ title: 'Pipelines', extensions: ['.pipe'] }}
	entries={[
		{ path: 'chat.pipe', children: [{ id: 'webhook', name: 'Webhook', provider: 'webhook' }] },
		{ path: 'ingest/analyze.pipe' },
	]}
	isConnected={isConnected}
	activeFilePath={openPath}
	onOpenFile={openDocument}
	onRefresh={reloadEntries}
	onFileManage={(action, path, newName) => applyFileAction(action, path, newName)}
/>`,
	props: [
		{ name: 'vfs', type: 'IVirtualFileSystem', dir: 'in', required: true, note: 'Unused but pinned required by the frozen shell contract - pass the stock NOOP_VFS.' },
		{ name: 'config', type: 'ExplorerConfig', dir: 'in', required: true, note: 'Title, extension filter, display-name formatter, empty message, folder toggle.' },
		{ name: 'entries', type: 'ExplorerEntry[]', dir: 'in', required: true, note: 'Flat array of paths; Explorer derives the directory hierarchy by path parsing (S3-style).' },
		{ name: 'statuses', type: 'Map<string, ExplorerStatus>', dir: 'in', note: 'Running/error status per entry or child, keyed by identifier.' },
		{ name: 'isConnected', type: 'boolean', dir: 'in', required: true, note: 'Enables/disables the action buttons.' },
		{ name: 'activeFilePath', type: 'string', dir: 'in', note: 'Currently open file path (row highlight).' },
		{ name: 'fileActions', type: 'ExplorerFileAction[]', dir: 'in', note: 'Host-injected kebab-menu actions (e.g. Export/Download in saas hosts).' },
		{ name: 'onOpenFile', type: '(path: string) => void', dir: 'out', required: true, note: 'Fired when the user clicks a file entry to open it.' },
		{ name: 'onRefresh', type: '() => void', dir: 'out', required: true, note: 'Fired when the user clicks the refresh button.' },
		{ name: 'onFileManage', type: "(action, path, newName?) => void", dir: 'out', note: 'Rename/delete/create operations; when absent, the file-management UI is hidden (display-only).' },
		{ name: 'onChildAction', type: "(action, filePath, childId, documentId?) => void", dir: 'out', note: 'Run/stop buttons on child items; when absent, no action buttons are shown.' },
	],
};
