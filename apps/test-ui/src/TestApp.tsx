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
// TEST APP — Workspace-aware tab manager with connection store
// =============================================================================

import React, { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell';
import { useWorkspace, DocSplitLayout, DocTabs } from 'shell';
import type { Documents } from 'shell';
import { commonStyles } from 'shell';
import { createDocs, destroyDocs, getDocs } from './docs';
import {
	initConnectionStore, destroyConnectionStore,
	type SavedConnection, type TestConnectionContent,
} from './connections';
import TestSessionView from './TestSessionView';
import ConnectionManagerView from './views/ConnectionManagerView';
import { setHasActiveTab } from './navigation';

// =============================================================================
// STYLES
// =============================================================================

const s = {
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

	groupPane: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	content: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	center: {
		...commonStyles.columnFill,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 12,
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
	} as CSSProperties,

};

// =============================================================================
// OPEN CONNECTION AS TAB
// =============================================================================

/** Open a saved connection as a test session tab.
 *  Uses a stable URI per connection so clicking the same connection
 *  in the sidebar reopens the existing tab with its saved viewState. */
export function openConnection(docs: Documents, conn: SavedConnection) {
	const content: TestConnectionContent = {
		connectionId: conn.id,
		url: conn.url,
		apiKey: conn.apiKey,
		config: conn.config,
		selectedPhases: conn.selectedPhases,
	};
	docs.openStaticDocument(`test:${conn.id}`, conn.name, content);
}

// =============================================================================
// MAIN COMPONENT — waits for workspace to be seeded
// =============================================================================

const TestApp: React.FC<ShellAppProps> = (_props) => {
	const { seeded, appState, updateAppState } = useWorkspace();
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!seeded) return;

		createDocs({ appState, updateAppState });
		initConnectionStore(appState, updateAppState);
		setReady(true);

		return () => {
			destroyConnectionStore();
			destroyDocs();
			setReady(false);
		};
	}, [seeded]);

	if (!ready) return <div style={s.center}>Initialising...</div>;
	return <TestAppReady docs={getDocs()!} />;
};

// =============================================================================
// INNER COMPONENT — renders once Documents is ready
// =============================================================================

const TestAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();
	const hasOpenEditors = Object.values(state.groups).some((g) => g.editorIds.length > 0);
	const canCloseGroups = state.rootNode.type === 'split';

	// The ONE globally active editor across all groups
	const activeGroup = state.groups[state.activeGroupId];
	const globalActiveEditorId = activeGroup
		? activeGroup.editorIds[activeGroup.activeEditorIndex] ?? null
		: null;

	// Tell sidebar whether any tabs are open
	useEffect(() => {
		setHasActiveTab(hasOpenEditors);
	}, [hasOpenEditors]);

	// =========================================================================
	// LANDING PAGE — no tabs open
	// =========================================================================

	if (!hasOpenEditors) {
		return <ConnectionManagerView />;
	}

	// =========================================================================
	// TABBED SPLIT LAYOUT
	// =========================================================================

	return (
		<div style={s.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					const activeEditorId = group.editorIds[group.activeEditorIndex];
					const activeEditor = activeEditorId ? state.editors[activeEditorId] : undefined;
					const activeDocUri = activeEditor?.documentUri;
					const activeDoc = activeDocUri ? state.documents[activeDocUri] : undefined;

					return (
						<div
							style={s.groupPane}
							onClick={() => docs.setActiveGroup(groupId)}
						>
							{/* Tab bar */}
							<DocTabs
								docs={docs}
								groupId={groupId}
								isActive={state.activeGroupId === groupId}
								canClose={canCloseGroups}
								onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)}
								onCloseGroup={(gid) => docs.closeGroup(gid)}
							/>

							{/* Session content — all editors rendered, active shown, others hidden */}
							<div style={s.content}>
								{group.editorIds.map((eid, idx) => {
									const editor = state.editors[eid];
									if (!editor) return null;
									const docUri = editor.documentUri;
									const doc = docUri ? state.documents[docUri] : undefined;
									if (!doc || !docUri?.startsWith('test:')) return null;
									const isEditorActive = idx === group.activeEditorIndex;
									return (
										<div
											key={eid}
											style={{
												display: isEditorActive ? 'flex' : 'none',
												flex: 1,
												minHeight: 0,
												flexDirection: 'column' as const,
											}}
										>
											<TestSessionView
												connection={doc.content as TestConnectionContent}
												editorId={eid}
												isActive={eid === globalActiveEditorId}
											/>
										</div>
									);
								})}
							</div>
						</div>
					);
				}}
			/>
		</div>
	);
};

export default TestApp;
