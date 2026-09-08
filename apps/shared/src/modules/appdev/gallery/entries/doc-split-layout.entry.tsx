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
// DOC SPLIT LAYOUT — GALLERY ENTRY (DOC-ONLY, DOCUMENT SYSTEM)
// =============================================================================

/** Doc-only gallery entry for the DocSplitLayout split-tree renderer. */

import type { IGalleryEntry } from '../galleryTypes';

/** The DocSplitLayout gallery entry. */
export const docSplitLayoutEntry: IGalleryEntry = {
	id: 'doc-split-layout',
	name: 'DocSplitLayout',
	group: 'documents',
	blurb: 'The recursive split-tree renderer for the client area: reads the layout tree from a Documents instance and renders nested resizable panes.',
	doc: `\`DocSplitLayout\` walks the model's \`LayoutNode\` tree and renders one resizable pane (allotment) per leaf, calling \`renderPane(groupId)\` for each. The app supplies the pane body — typically a \`DocTabs\` strip bound to the group plus the editor for its active document. Drag-resizes are debounced back into the model (\`updateSplitSizes\`), so pane sizes persist with the workspace.`,
	docNote: 'The layout tree lives in the Documents model, not in this component - splitting and closing panes are MODEL operations (splitGroup / closeGroup), usually triggered from DocTabs callbacks.',
	code: `import { Documents, DocTabs, DocSplitLayout } from 'shell';

// Client area of a tabbed app: one pane per editor group.
<DocSplitLayout
	docs={docs}
	renderPane={(groupId) => (
		<>
			<DocTabs
				docs={docs}
				groupId={groupId}
				isActive={docs.useStore().activeGroupId === groupId}
				onSplit={(id, orientation) => docs.splitGroupWithDocument(id, orientation)}
				onCloseGroup={(id) => docs.closeGroup(id)}
			/>
			<PipelineEditor docs={docs} groupId={groupId} />
		</>
	)}
/>`,
	props: [
		{ name: 'docs', type: 'Documents', dir: 'in', required: true, note: 'The app-owned model instance whose layout tree is rendered.' },
		{ name: 'renderPane', type: '(groupId: string) => ReactNode', dir: 'in', required: true, note: 'Renders one leaf pane - typically its DocTabs strip plus the active editor.' },
	],
};
