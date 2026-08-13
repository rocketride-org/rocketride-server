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
// DOCUMENTS MODEL — GALLERY ENTRY (DOC-ONLY, DOCUMENT SYSTEM)
// =============================================================================

/** Doc-only gallery entry for the Documents document/editor/group model. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Documents model gallery entry. */
export const documentsModelEntry: IGalleryEntry = {
	id: 'documents-model',
	name: 'Documents (model)',
	group: 'documents',
	blurb: 'The app-owned document / editor / group model behind the document UI: VS Code semantics (dirty tracking, splits, per-editor viewports) as one React-subscribable store.',
	doc: `One \`Documents\` instance per app, created over the app's VFS and optionally bound to the workspace for persistence. Everything document-shaped flows through it:

- **Documents** — one per URI, in-memory \`content\`, \`dirty\`/\`version\`/\`isNew\` tracking; static (non-VFS) documents for monitors and webviews.
- **Editors** — views onto a document with independent scroll/cursor/view state; the same document can be open in several panes.
- **Groups & layout** — editor groups arranged in a binary split tree (\`LayoutLeaf\` / \`LayoutSplit\`), rendered by \`DocSplitLayout\`.

React binding is \`docs.useStore()\` (tear-free \`useSyncExternalStore\`); non-React code uses \`getState()\` / \`subscribe()\`. With a \`WorkspaceBinding\` the model restores from workspace appState and debounce-saves every change.`,
	docNote: 'The APP owns the instance - create ONE Documents per app and pass it down; DocTabs and DocSplitLayout only read from and dispatch to it.',
	code: `import { Documents } from 'shell';
import { useWorkspace } from 'shell';

// One instance per app, bound to the workspace for persistence.
const { appState, updateAppState } = useWorkspace();
const docs = useMemo(() => new Documents(vfs, { appState, updateAppState }), []);

// Opening, editing, saving - all through the model:
await docs.openDocument('ingest/analyze.pipe');
docs.updateContent('ingest/analyze.pipe', nextContent); // marks dirty
await docs.saveDocument('ingest/analyze.pipe');         // writes VFS, marks clean

// React binding: re-render on every model change.
const state = docs.useStore();`,
	propsLabel: 'Methods',
	props: [
		{ name: 'new Documents(vfs?, workspace?)', type: '(IVirtualFileSystem | null, WorkspaceBinding?) => Documents', dir: 'in', note: 'Create the model; with a WorkspaceBinding it restores from appState and debounce-saves on change.' },
		{ name: 'useStore', type: '() => DocumentsState', dir: 'out', note: 'React hook - tear-free subscription to the full model state.' },
		{ name: 'getState / subscribe', type: '() => DocumentsState / (listener) => unsubscribe', dir: 'out', note: 'Non-React access: snapshot without subscribing, or listener fired on every change.' },
		{ name: 'openDocument', type: '(uri, groupId?) => Promise<void>', dir: 'in', note: 'Open (or focus) a VFS-backed document.' },
		{ name: 'openStaticDocument', type: '(uri, label, content?, groupId?) => void', dir: 'in', note: 'Open a non-VFS document (monitor/webview); never dirty, skips read/write.' },
		{ name: 'createDocument', type: '(groupId?, initialContent?) => string', dir: 'in', note: 'New untitled document; returns the assigned URI.' },
		{ name: 'updateContent', type: '(uri, content) => void', dir: 'in', note: 'Set in-memory content and mark dirty (no-op if unchanged).' },
		{ name: 'saveDocument / revertDocument', type: '(uri) => Promise<void>', dir: 'in', note: 'Write to the VFS and mark clean / re-read from the VFS discarding changes.' },
		{ name: 'closeEditor / discardDocument', type: '(editorId) => void / (uri) => void', dir: 'in', note: 'Close one editor (disposes clean docs, collapses empty groups) / force-remove a document regardless of dirty.' },
		{ name: 'splitGroup / splitGroupWithDocument', type: '(groupId, orientation) => string', dir: 'in', note: 'Split a group into a new pane (empty, or cloning the active document); returns the new group id.' },
		{ name: 'moveEditor / closeGroup', type: '(editorId, targetGroupId) => void / (groupId) => void', dir: 'in', note: 'Move an editor between groups / close a whole group (recreates the default when it was the last).' },
		{ name: 'setActiveEditor / setActiveGroup', type: '(groupId, editorIndex) => void / (groupId) => void', dir: 'in', note: 'Activate an editor within a group / focus a group.' },
		{ name: 'updateEditorViewport / updateEditorViewState', type: '(editorId, patch) => void', dir: 'in', note: 'Persist scroll/cursor position / opaque per-editor view state (e.g. Monaco).' },
		{ name: 'updateSplitSizes', type: '(splitNodeId, [a, b]) => void', dir: 'in', note: 'Persist pane pixel sizes after a drag resize.' },
		{ name: 'destroy', type: '() => void', dir: 'in', note: 'Flush persistence and clear state/listeners on app teardown.' },
	],
	sections: [
		{
			label: 'Types',
			rows: [
				{ name: 'Document', type: '{ uri, content, dirty, version, editorCount, isNew, static? }', dir: 'in', note: 'One open document per URI; content is stored and returned as-is.' },
				{ name: 'Editor', type: '{ id, documentUri, scrollTop, scrollLeft, cursorLine, cursorColumn, label, viewState? }', dir: 'in', note: 'A view onto a document with its own viewport.' },
				{ name: 'EditorGroup', type: '{ id, editorIds, activeEditorIndex }', dir: 'in', note: 'A pane holding ordered editors.' },
				{ name: 'LayoutNode', type: 'LayoutLeaf | LayoutSplit', dir: 'in', note: 'The split tree: leaves wrap one group; splits hold exactly two children plus orientation and remembered sizes.' },
				{ name: 'DocumentsState', type: '{ documents, editors, groups, rootNode, activeGroupId }', dir: 'in', note: 'The complete model snapshot returned by useStore/getState.' },
				{ name: 'WorkspaceBinding', type: '{ appState, updateAppState }', dir: 'in', note: 'Optional shell persistence binding - wire it to useWorkspace for restore + debounced save.' },
				{ name: 'SplitOrientation', type: "'horizontal' | 'vertical'", dir: 'in', note: 'Split direction for the layout tree.' },
			],
		},
	],
};
