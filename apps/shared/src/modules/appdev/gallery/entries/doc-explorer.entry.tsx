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
// DOC EXPLORER — GALLERY ENTRY (DOC-ONLY, DOCUMENT SYSTEM)
// =============================================================================

/** Doc-only gallery entry for the DocExplorer alias of Explorer. */

import type { IGalleryEntry } from '../galleryTypes';

/** The DocExplorer gallery entry. */
export const docExplorerEntry: IGalleryEntry = {
	id: 'doc-explorer',
	name: 'DocExplorer',
	group: 'documents',
	blurb: "The document system's name for Explorer: the identical component re-exported with Doc* type aliases for the document-flavored vocabulary.",
	doc: `\`DocExplorer\` IS \`Explorer\` — a thin re-export, not a fork. Both names (and both sets of type names) refer to the same component and types, and both are frozen on the surface, so use whichever vocabulary fits the app: \`Explorer\`/\`ExplorerEntry\` standalone, \`DocExplorer\`/\`DocEntry\` when wiring the document system (its \`onOpenFile\` feeding \`docs.openDocument\`).

See the **Explorer** entry (Sidebar content) for the live demo and the full prop table.`,
	code: `import { DocExplorer, Documents, NOOP_VFS } from 'shell';

// Sidebar: the document-flavored Explorer feeding the Documents model.
<DocExplorer
	vfs={NOOP_VFS}
	config={{ title: 'Pipelines', extensions: ['.pipe'] }}
	entries={entries}
	isConnected={isConnected}
	onOpenFile={(path) => docs.openDocument(path)}
	onRefresh={reloadEntries}
/>`,
	propsLabel: 'Type aliases',
	props: [
		{ name: 'DocExplorer', type: 'Explorer', dir: 'in', note: 'The component itself - identical to Explorer.' },
		{ name: 'DocExplorerProps', type: 'IExplorerProps', dir: 'in', note: 'Full prop contract - documented on the Explorer entry.' },
		{ name: 'DocExplorerConfig', type: 'ExplorerConfig', dir: 'in', note: 'Title, extension filter, display-name formatter, empty message, folder toggle.' },
		{ name: 'DocEntry', type: 'ExplorerEntry', dir: 'in', note: 'One flat path entry ({ path, type?, documentId?, children? }).' },
		{ name: 'DocEntryChild', type: 'ExplorerChild', dir: 'in', note: 'An expandable child item ({ id, name, provider? }).' },
		{ name: 'DocEntryStatus', type: 'ExplorerStatus', dir: 'in', note: 'Per-entry status ({ running, errors, warnings }).' },
	],
};
