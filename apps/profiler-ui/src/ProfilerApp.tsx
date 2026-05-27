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
// PROFILER APP — Main client area component
// =============================================================================
//
// Initialises the Documents singleton and ConnectionStore on mount.
// When connection tabs are open, renders DocSplitLayout with DocTabs and
// ProfilerView. When no tabs are open, renders the ConnectionManagerView
// landing page.
//
// Pattern matches ModelsApp from models-ui.
// =============================================================================

import React, { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useWorkspace, DocSplitLayout, DocTabs } from 'shell-ui';
import type { Documents } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import { createDocs, destroyDocs, getDocs } from './docs';
import { initConnectionStore, destroyConnectionStore } from './connections';
import type { ConnectionContent } from './connections';
import ProfilerView from './views/ProfilerView';
import ConnectionManagerView from './views/ConnectionManagerView';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Root container fills the entire client area. */
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

	/** Wrapper for a single editor group pane. */
	groupPane: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	/** Content area below the tab bar. */
	content: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	/** Loading / initialising placeholder. */
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
// MAIN COMPONENT
// =============================================================================

/**
 * Profiler app — client area.
 *
 * Initialises the Documents singleton (no VFS — all tabs are static documents)
 * and the ConnectionStore (saved connections persisted in workspace appState).
 * Switches between the connection manager landing page and tabbed profiler views.
 */
const ProfilerApp: React.FC<ShellAppProps> = (_props) => {
	const { seeded, appState, updateAppState, settings } = useWorkspace();
	const [ready, setReady] = useState(false);

	// =========================================================================
	// INITIALISE DOCUMENTS + CONNECTION STORE
	// =========================================================================

	useEffect(() => {
		// Wait for workspace to be seeded before reading appState
		if (!seeded) return;

		// Create Documents instance (no VFS, static documents only)
		createDocs({ appState, updateAppState });

		// Initialise saved connections from appState (seeds default from settings).
		// Bridge the workspace functional updater to the key/value API that
		// ConnectionStore expects.
		const keyValueUpdater = (key: string, value: unknown) => {
			updateAppState((prev) => ({ ...prev, [key]: value }));
		};
		initConnectionStore(appState, keyValueUpdater, settings);

		setReady(true);

		return () => {
			destroyConnectionStore();
			destroyDocs();
			setReady(false);
		};
	}, [seeded]);

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!ready) return <div style={styles.center}>Initialising...</div>;
	return <ProfilerAppReady docs={getDocs()!} />;
};

// =============================================================================
// INNER COMPONENT — renders once Documents is ready
// =============================================================================

/**
 * Inner component separated so the useStore() hook is called unconditionally.
 * Subscribes to the Documents state and decides between the connection manager
 * landing page and the tabbed split layout.
 *
 * @param props.docs - The initialised Documents instance.
 */
const ProfilerAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();

	// Check if any editor group has open editors
	const hasOpenEditors = Object.values(state.groups).some((g) => g.editorIds.length > 0);

	// Whether there are multiple groups (controls close-group button visibility)
	const canCloseGroups = state.rootNode.type === 'split';

	// =========================================================================
	// RENDER — LANDING PAGE (no tabs open)
	// =========================================================================

	if (!hasOpenEditors) {
		return <ConnectionManagerView />;
	}

	// =========================================================================
	// RENDER — TABBED SPLIT LAYOUT
	// =========================================================================

	return (
		<div style={styles.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					// Find the active editor's document
					const activeEditorId = group.editorIds[group.activeEditorIndex];
					const activeEditor = activeEditorId ? state.editors[activeEditorId] : undefined;
					const activeDocUri = activeEditor?.documentUri;
					const activeDoc = activeDocUri ? state.documents[activeDocUri] : undefined;

					return (
						<div
							style={styles.groupPane}
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

							{/* Profiler content */}
							<div style={styles.content}>
								{activeDoc && activeEditorId && activeDocUri?.startsWith('conn:') ? (
									<ProfilerView
										host={(activeDoc.content as ConnectionContent).host}
										port={(activeDoc.content as ConnectionContent).port}
										name={activeEditor!.label}
									/>
								) : (
									<ConnectionManagerView />
								)}
							</div>
						</div>
					);
				}}
			/>
		</div>
	);
};

export default ProfilerApp;
