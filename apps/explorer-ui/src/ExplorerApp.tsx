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
// EXPLORER APP — multi-tab file viewer/editor for the RocketRide store
// =============================================================================
//
// Uses the Documents library for multi-tab + split-pane support.  Each tab
// is a file from the server store.  The file's media type determines which
// viewer component renders it and how the data is loaded:
//
//   inline — text string read via fsReadString (text, markdown, JSON)
//   link   — presigned URL for native streaming (video, audio)
//   blob   — data fetched from presigned URL, served as blob: URL
//            (images, PDF, docx, spreadsheets)
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import { useShellConnection, useWorkspace, DocTabs, DocSplitLayout } from 'shell-ui';
import type { Documents } from 'shell-ui';
import { createDocs, destroyDocs, getDocs } from './docs';
import { createStoreVfs } from './store';
import { getMediaInfo } from './mediaTypes';
import {
	AudioViewer, BinaryViewer, DocxViewer, ImageViewer,
	JsonViewer, MarkdownViewer, PdfViewer, SpreadsheetViewer,
	TextViewer, VideoViewer,
} from './viewers';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		overflow: 'hidden',
	} as CSSProperties,
	groupPane: {
		...commonStyles.columnFill,
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,
	content: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 14,
		flexDirection: 'column',
		gap: 12,
	} as CSSProperties,
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const ExplorerApp: React.FC<ShellAppProps> = () => {
	const { client, isConnected } = useShellConnection();
	const { loaded, appState, updateAppState } = useWorkspace();
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!client || !loaded) return;

		const vfs = createStoreVfs(client);
		createDocs(vfs, { appState, updateAppState });
		setReady(true);

		return () => { destroyDocs(); setReady(false); };
	}, [client, loaded]);

	if (!ready) return <div style={styles.welcome}>Initialising...</div>;
	return <ExplorerAppReady docs={getDocs()!} />;
};

// =============================================================================
// INNER COMPONENT — renders once Documents is ready
// =============================================================================

const ExplorerAppReady: React.FC<{ docs: Documents }> = ({ docs }) => {
	const state = docs.useStore();
	const canCloseGroups = state.rootNode.type === 'split';

	// --- Ctrl+S handler -------------------------------------------------------

	useEffect(() => {
		const handler = () => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return;
			const editorId = group.editorIds[group.activeEditorIndex];
			if (!editorId) return;
			const editor = s.editors[editorId];
			if (!editor) return;
			docs.saveDocument(editor.documentUri);
		};
		window.addEventListener('tab:save', handler);
		return () => window.removeEventListener('tab:save', handler);
	}, []);

	return (
		<div style={styles.container}>
			<DocSplitLayout
				docs={docs}
				renderPane={(groupId: string) => {
					const group = state.groups[groupId];
					if (!group) return null;

					return (
						<div
							style={styles.groupPane}
							onClick={() => docs.setActiveGroup(groupId)}
						>
							<DocTabs
								docs={docs}
								groupId={groupId}
								isActive={state.activeGroupId === groupId}
								canClose={canCloseGroups}
								onSplit={(gid, dir) => docs.splitGroupWithDocument(gid, dir)}
								onCloseGroup={(gid) => docs.closeGroup(gid)}
							/>

							<div style={styles.content}>
								{group.editorIds.length === 0 ? (
									<div style={styles.welcome}>
										<div style={{ fontSize: 16, fontWeight: 600 }}>File Explorer</div>
										<div>Open a file from the sidebar to view its contents.</div>
									</div>
								) : (
									group.editorIds.map((editorId, idx) => {
										const editor = state.editors[editorId];
										if (!editor) return null;
										const isActive = idx === group.activeEditorIndex;
										return (
											<div
												key={editorId}
												style={{
													display: isActive ? 'flex' : 'none',
													flex: 1,
													minHeight: 0,
													flexDirection: 'column',
												}}
											>
												<FilePane
													docs={docs}
													uri={editor.documentUri}
												/>
											</div>
										);
									})
								)}
							</div>
						</div>
					);
				}}
			/>
		</div>
	);
};

// =============================================================================
// FILE PANE — dispatches to the correct viewer based on file type
// =============================================================================

const FilePane: React.FC<{ docs: Documents; uri: string }> = ({ docs, uri }) => {
	const { client } = useShellConnection();
	const state = docs.useStore();
	const doc = state.documents[uri];
	const { category, contentMode } = getMediaInfo(uri);

	// Blob documents store a local blob: URL as content.  These aren't
	// persisted, so re-read from the server when content is missing.
	useEffect(() => {
		if (contentMode === 'blob' && doc && !doc.content) {
			docs.revertDocument(uri);
		}
	}, [contentMode, doc, uri, docs]);

	// Revoke blob URLs on unmount to free memory.
	useEffect(() => {
		return () => {
			if (contentMode === 'blob' && doc?.content && typeof doc.content === 'string' && doc.content.startsWith('blob:')) {
				URL.revokeObjectURL(doc.content);
			}
		};
	}, [contentMode, doc?.content]);

	if (!doc) return null;

	const content = typeof doc.content === 'string' ? doc.content : '';

	// --- Link viewers: video/audio get the client and fetch their own URL ---

	if (category === 'video' && client) return <VideoViewer client={client} uri={uri} />;
	if (category === 'audio' && client) return <AudioViewer client={client} uri={uri} />;

	// --- Blob viewers: content is a blob: URL loaded by the store -----------

	if (category === 'image') return <ImageViewer content={content} uri={uri} />;
	if (category === 'pdf') return <PdfViewer content={content} uri={uri} />;
	if (category === 'docx') return <DocxViewer content={content} />;
	if (category === 'spreadsheet') return <SpreadsheetViewer content={content} />;

	// --- Inline viewers: content is the file text ---------------------------

	if (category === 'json') return <JsonViewer content={content} />;
	if (category === 'markdown') return <MarkdownViewer content={content} />;
	if (category === 'binary') return <BinaryViewer />;

	// Default: editable text
	return <TextViewer docs={docs} uri={uri} content={content} />;
};

export default ExplorerApp;
