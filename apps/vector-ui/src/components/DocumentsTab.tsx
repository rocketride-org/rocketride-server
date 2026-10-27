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
// VECTOR-UI - THE DOCUMENTS TAB (the workbench's listing of a connection)
// =============================================================================
//
// For now it holds the directory as the console had it (every document by
// its path, the ScopeBar, saved filters, folder grouping, "Needs attention",
// multi-select and export) and, under it, the selected document's chunks.
// The Trash is its own tab; the directory's Documents / Trash switch follows
// the tabs. A document's Move to trash still confirms at once.
// =============================================================================

import React, { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { writesDuringRemoval } from '../vector/consoleModel';
import ChunkList from './ChunkList';
import DocumentDirectory from './DocumentDirectory';
import type { IDocumentsTabProps } from './workbenchProps';

const styles = {
	column: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 } as CSSProperties,
};

/**
 * The Documents tab.
 *
 * @param props - {@link IDocumentsTabProps}.
 * @returns The tab's panel.
 */
export function DocumentsTab({ entry, model, actions, console: state, selection, visible, scope, onScope, cap, available, saved, onSave, onDeleteSaved }: IDocumentsTabProps): React.ReactElement {
	// Load more and Retry page the listing the controller's view names: the documents while this tab shows.
	useEffect(() => {
		if (visible) entry.controller.setView('active');
	}, [visible, entry]);
	const selectedId = selection.document?.objectId ?? null;
	return (
		<div style={styles.column}>
			<DocumentDirectory pager={state.directory} selectedId={selectedId} writes={writesDuringRemoval(model.writes, state.removal.status)} onSelect={(item) => entry.selection.selectDocument({ objectId: item.objectId, path: item.path })} onRemove={(targets) => entry.controller.requestRemove(targets)} onLoadMore={() => entry.controller.loadMoreDocuments()} onRetry={() => entry.controller.retryDocuments()} collection={model.collection} scope={scope} onScope={onScope} cap={cap} available={available} saved={saved} onSave={onSave} onDeleteSaved={onDeleteSaved} view="active" onView={(next) => entry.tab.set(next === 'trash' ? 'trash' : 'documents')} trashCount={state.stats.view?.deletedDocuments ?? null} />
			<ChunkList chunks={state.chunks} path={selection.document?.path ?? null} onMore={() => entry.controller.loadMoreChunks()} onOpen={(chunkId) => actions.openDocument(state.chunks.objectId ?? '', chunkId)} onMap={(key) => actions.showOnMap([key], 'document')} />
		</div>
	);
}

export default DocumentsTab;
