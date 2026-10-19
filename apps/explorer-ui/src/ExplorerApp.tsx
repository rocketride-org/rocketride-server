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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps, DevToolProps } from 'shell';
import { commonStyles } from 'shell';
import { createToolChannel, createToolController, useConnectionReady, useShellConnection, useWorkspace, DocTabs, DocSplitLayout, AppLayout, EmptyState, BxFolderOpen } from 'shell';
import type { Documents } from 'shell';
import type { ExplorerOps } from './ops';
import { createLocalExplorerFs, createRemoteExplorerFs } from './fs';
import type { IExplorerFs } from './fs';
import { createDocs, destroyDocs, getDocs } from './docs';
import { createStoreVfs, isFileLoadError, isLiveBlobUrl, forgetBlobUrl } from './store';
import { getMediaInfo } from './mediaTypes';
import {
	AudioViewer, BinaryViewer, DocxViewer, HexViewer, ImageViewer,
	JsonViewer, MarkdownViewer, MonacoViewer, PdfViewer, SpreadsheetViewer,
	TextViewer, VideoViewer,
} from './viewers';
import type { ViewerId } from './viewerRegistry';
import ExplorerSidebar from './ExplorerSidebar';
import { attachExplorerPeerHost } from './explorerBridge';

// =============================================================================
// BLOB URL REF-COUNTING
// =============================================================================
// Documents share content by URI across panes, so multiple FilePane components
// may reference the same blob URL. We ref-count to ensure revokeObjectURL is
// only called when the last pane releases its reference.

const blobRefCounts = new Map<string, number>();

function retainBlobUrl(url: string): void {
	blobRefCounts.set(url, (blobRefCounts.get(url) ?? 0) + 1);
}

function releaseBlobUrl(url: string): void {
	const count = (blobRefCounts.get(url) ?? 1) - 1;
	if (count <= 0) {
		blobRefCounts.delete(url);
		URL.revokeObjectURL(url);
		// A document may still hold this string as content — forgetting it
		// makes isLiveBlobUrl false, so the next pane re-reads instead of
		// rendering a dead reference.
		forgetBlobUrl(url);
	} else {
		blobRefCounts.set(url, count);
	}
}

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
	/** Per-tab file pane — kept mounted so per-viewer state survives tab switches. */
	tabPane: {
		flex: 1,
		minHeight: 0,
		flexDirection: 'column',
	} as CSSProperties,
	/** Active tab pane (visible). */
	tabPaneVisible: {
		display: 'flex',
	} as CSSProperties,
	/** Inactive tab pane (hidden but mounted). */
	tabPaneHidden: {
		display: 'none',
	} as CSSProperties,
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const ExplorerApp: React.FC<ShellAppProps> = () => {
	const { client, isConnected } = useShellConnection();
	const { loaded, appState, updateAppState } = useWorkspace();
	const [ready, setReady] = useState(false);

	// The FULL APP's store surface: the realm legitimately owns a client, so
	// the viewers get the LOCAL fs (dev-tool frames get the remote one).
	const fs = useMemo(() => createLocalExplorerFs(isConnected), [isConnected]);

	useEffect(() => {
		if (!client || !loaded) return;

		const vfs = createStoreVfs(createLocalExplorerFs(true));
		createDocs(vfs, { appState, updateAppState });
		setReady(true);

		return () => { destroyDocs(); setReady(false); };
	}, [client, loaded]);

	// Sidebar node memoized once: ExplorerSidebar takes no props and reads all
	// its state from the shared singletons, so the slot registration is stable.
	const sidebar = useMemo(() => <ExplorerSidebar />, []);

	// Two-column app: the file-tree Explorer sidebar mounts once Documents is
	// ready (it shares the singleton with the editor surface).
	if (!ready) return <AppLayout showStatus><div style={styles.welcome}>Initialising...</div></AppLayout>;
	return (
		<AppLayout sidebar={sidebar} showStatus>
			<ExplorerAppReady docs={getDocs()!} fs={fs} />
		</AppLayout>
	);
};

// =============================================================================
// DEV-TOOL SURFACE — the explorer without shell chrome
// =============================================================================

/**
 * Dev-tool surface — the editor groups without the shell AppLayout chrome,
 * for host workbenches that mount the tool directly (the VS Code dev-tool
 * panel). The file tree lives in the HOST's sidebar (devToolSidebar below);
 * its opens/renames/moves arrive over the peer channel and are applied to
 * this document's Documents singleton. No workspace binding: tab layout is
 * session-local here.
 */
export const ExplorerDevTool: React.FC<DevToolProps> = ({ peer, channel }) => {
	// THIS FRAME HOLDS NO ROCKETRIDE CLIENT: every store interaction is a
	// controller op, and readiness is the host-published `host:connection`
	// system topic replicated over the tool channel.
	const toolChannel = useMemo(() => channel ?? createToolChannel(peer), [channel, peer]);
	const engineReady = useConnectionReady(toolChannel);
	const call = useMemo(() => createToolController<ExplorerOps>(peer), [peer]);
	const fs = useMemo(() => createRemoteExplorerFs(call, engineReady), [call, engineReady]);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!engineReady) return;
		createDocs(createStoreVfs(createRemoteExplorerFs(call, true)));
		setReady(true);
		return () => { destroyDocs(); setReady(false); };
	}, [engineReady, call]);

	// Frame side of the tree's peer protocol — apply incoming document
	// actions, publish the active path for the tree highlight.
	useEffect(() => {
		if (!ready) return;
		return attachExplorerPeerHost(peer);
	}, [ready, peer]);

	if (!ready) return <div style={styles.welcome}>Initialising...</div>;
	return <ExplorerAppReady docs={getDocs()!} fs={fs} />;
};

// =============================================================================
// INNER COMPONENT — renders once Documents is ready
// =============================================================================

const ExplorerAppReady: React.FC<{ docs: Documents; fs: IExplorerFs }> = ({ docs, fs }) => {
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
										<EmptyState
											icon={<BxFolderOpen size={40} />}
											title="No file open"
											description="Select a file from the sidebar to view or edit it."
										/>
									</div>
								) : (
									group.editorIds.map((editorId, idx) => {
										const editor = state.editors[editorId];
										if (!editor) return null;
										const isActive = idx === group.activeEditorIndex;
										return (
											<div
												key={editorId}
												style={{ ...styles.tabPane, ...(isActive ? styles.tabPaneVisible : styles.tabPaneHidden) }}
											>
												<FilePane
													docs={docs}
													fs={fs}
													uri={editor.documentUri}
													editorId={editorId}
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

const FilePane: React.FC<{ docs: Documents; fs: IExplorerFs; uri: string; editorId: string }> = ({ docs, fs, uri, editorId }) => {
	const state = docs.useStore();
	const doc = state.documents[uri];
	const editor = state.editors[editorId];
	const { category, contentMode } = getMediaInfo(uri);
	const viewerOverride = editor?.viewState?.viewerId as ViewerId | undefined;

	// Blob documents store a local blob: URL as content — but the Documents
	// store can hand back content that OUTLIVED the session that minted it
	// (a dead blob: URL after a reload, or raw text from before the media
	// table classified this extension as blob). Anything that is not a
	// this-session blob URL and not a load-error sentinel is stale: re-read
	// it from the server. A pending load (content === '') re-reads too,
	// exactly as before.
	useEffect(() => {
		if (contentMode === 'blob' && doc && !isLiveBlobUrl(doc.content) && !isFileLoadError(doc.content)) {
			docs.revertDocument(uri);
		}
	}, [contentMode, doc, uri, docs]);

	// Ref-count blob URLs so we only revoke when no pane references them.
	const prevBlobRef = useRef<string | null>(null);
	useEffect(() => {
		const url = (contentMode === 'blob' && doc?.content && typeof doc.content === 'string' && doc.content.startsWith('blob:'))
			? doc.content
			: null;

		// Release previous blob URL if it changed
		if (prevBlobRef.current && prevBlobRef.current !== url) {
			releaseBlobUrl(prevBlobRef.current);
		}

		// Retain the new blob URL
		if (url && url !== prevBlobRef.current) {
			retainBlobUrl(url);
		}

		prevBlobRef.current = url;

		return () => {
			if (prevBlobRef.current) {
				releaseBlobUrl(prevBlobRef.current);
				prevBlobRef.current = null;
			}
		};
	}, [contentMode, doc?.content]);

	if (!doc) return null;

	// A blob load that failed leaves a FileLoadError sentinel as content; extract
	// its message so viewers can show the error instead of hanging on "Loading...".
	// Genuine pending loads keep content === '' (loadError undefined) → "Loading...".
	const loadError = isFileLoadError(doc.content) ? doc.content.message : undefined;
	// Blob viewers only ever see a LIVE blob URL — stale content (see the
	// revert effect above) reads as "still loading" while the re-read runs.
	const content = typeof doc.content === 'string'
		? (contentMode === 'blob' && doc.content && !isLiveBlobUrl(doc.content) ? '' : doc.content)
		: '';

	// --- Viewer override: if the user chose "Open with…", use that viewer ---

	if (viewerOverride) {
		switch (viewerOverride) {
			case 'monaco':      return <MonacoViewer docs={docs} uri={uri} content={content} />;
			case 'text':        return <TextViewer docs={docs} uri={uri} content={content} />;
			case 'json':        return <JsonViewer content={content} />;
			case 'markdown':    return <MarkdownViewer content={content} />;
			case 'hex':         return fs.ready ? <HexViewer fs={fs} uri={uri} /> : null;
			case 'image':       return <ImageViewer content={content} uri={uri} error={loadError} />;
			case 'pdf':         return <PdfViewer content={content} uri={uri} error={loadError} />;
			case 'docx':        return <DocxViewer content={content} loadError={loadError} />;
			case 'spreadsheet': return <SpreadsheetViewer content={content} loadError={loadError} />;
			case 'video':       return fs.ready ? <VideoViewer fs={fs} uri={uri} /> : null;
			case 'audio':       return fs.ready ? <AudioViewer fs={fs} uri={uri} /> : null;
			case 'binary':      return <BinaryViewer />;
		}
	}

	// --- Default dispatch based on file category ---

	// Link viewers: video/audio fetch their own presigned URL through the seam
	if (category === 'video' && fs.ready) return <VideoViewer fs={fs} uri={uri} />;
	if (category === 'audio' && fs.ready) return <AudioViewer fs={fs} uri={uri} />;

	// Blob viewers: content is a blob: URL loaded by the store
	if (category === 'image') return <ImageViewer content={content} uri={uri} error={loadError} />;
	if (category === 'pdf') return <PdfViewer content={content} uri={uri} error={loadError} />;
	if (category === 'docx') return <DocxViewer content={content} loadError={loadError} />;
	if (category === 'spreadsheet') return <SpreadsheetViewer content={content} loadError={loadError} />;

	// Inline viewers: content is the file text
	if (category === 'markdown') return <MarkdownViewer content={content} />;
	if (category === 'binary') return fs.ready ? <HexViewer fs={fs} uri={uri} /> : <BinaryViewer />;

	// Code, JSON, and plain text all use the Monaco editor
	return <MonacoViewer docs={docs} uri={uri} content={content} />;
};

export default ExplorerApp;
