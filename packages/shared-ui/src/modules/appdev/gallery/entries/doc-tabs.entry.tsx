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
// DOC TABS — GALLERY ENTRY (DOC-ONLY, HOST CHROME)
// =============================================================================

/**
 * Doc-only gallery entry for DocTabs. No live demo: the document model
 * (Documents / DocSplitLayout) lives in shell-ui, which shared-ui cannot
 * import - and the strip is standard frame chrome, not a component to
 * restyle. The snippet and props are transcribed from the style guide.
 */

import type { IGalleryEntry } from '../galleryTypes';

/** The DocTabs gallery entry. */
export const docTabsEntry: IGalleryEntry = {
	id: 'doc-tabs',
	name: 'DocTabs',
	group: 'chrome',
	blurb: 'The document tab strip at the top of the client area - one tab per open editor per group, VS Code document model: modified dots, hover close, drag to reorder and between split groups. Tabbed (Archetype B) apps only; never draw a lookalike tab bar for documents.',
	docNote: 'Host chrome - part of the standard frame. The APP owns the document model behind it (one Documents instance over its VFS); DocSplitLayout renders the split tree and each pane renders its own DocTabs strip. For pages INSIDE one document use TabControl - DocTabs only switches documents.',
	code: `import { Documents, DocTabs, DocSplitLayout } from 'shell-ui';

// The app owns the document model: one Documents instance over its VFS.
const docs = new Documents(vfs);

// Anything that opens a document adds a tab (Explorer onOpenFile, deep links).
docs.openDocument('ingest/analyze.pipe');

// Client area: DocSplitLayout renders the split tree; each pane renders its
// own DocTabs strip bound to its editor group.
<DocSplitLayout
	docs={docs}
	renderPane={(groupId) => (
		<>
			<DocTabs docs={docs} groupId={groupId} isActive canClose={false} />
			<PipelineEditor docs={docs} groupId={groupId} />
		</>
	)}
/>`,
	props: [
		{ name: 'docs', type: 'Documents', dir: 'in', required: true, note: 'The app-owned document store to read state from and dispatch actions to.' },
		{ name: 'groupId', type: 'string', dir: 'in', required: true, note: 'The editor group whose tabs render in this strip.' },
		{ name: 'isActive', type: 'boolean', dir: 'in', note: 'Whether this group is the focused group (drives the brand underline).' },
		{ name: 'canClose', type: 'boolean', dir: 'in', note: 'Whether the whole group may be closed (false when it is the only group).' },
		{ name: 'onDirtyClose', type: '(editorId, documentUri) => void', dir: 'out', note: "Fired instead of closing when the tab's document has unsaved changes; the app shows its confirm dialog." },
		{ name: 'onSplit', type: '(groupId, orientation) => void', dir: 'out', note: 'Requests splitting this group horizontally or vertically.' },
		{ name: 'onCloseGroup', type: '(groupId) => void', dir: 'out', note: 'Requests closing this entire group.' },
	],
};
