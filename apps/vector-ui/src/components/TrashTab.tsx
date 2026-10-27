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
// VECTOR-UI - THE TRASH TAB (the documents with a chunk in the trash)
// =============================================================================
//
// For now it holds the directory's Trash view as the console had it: the
// trash listing (listed the first time it shows), Restore (at once),
// Delete permanently and Empty trash (each confirmed, with its typed rule).
// The directory's Documents / Trash switch follows the tabs.
// =============================================================================

import React, { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { writesDuringRemoval } from '../vector/consoleModel';
import DocumentDirectory from './DocumentDirectory';
import type { IWorkbenchPanelProps } from './workbenchProps';

const styles = {
	column: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
};

/**
 * The Trash tab.
 *
 * @param props - {@link IWorkbenchPanelProps}.
 * @returns The tab's panel.
 */
export function TrashTab({ entry, model, console: state, selection, visible }: IWorkbenchPanelProps): React.ReactElement {
	// Shown: the controller lists the trash (once), and Load more and Retry page it.
	useEffect(() => {
		if (visible) entry.controller.setView('trash');
	}, [visible, entry]);
	return (
		<div style={styles.column}>
			<DocumentDirectory pager={state.trash} selectedId={selection.document?.objectId ?? null} writes={writesDuringRemoval(model.writes, state.removal.status)} onSelect={(item) => entry.selection.selectDocument({ objectId: item.objectId, path: item.path })} onRemove={(targets) => entry.controller.requestRemove(targets)} onLoadMore={() => entry.controller.loadMoreDocuments()} onRetry={() => entry.controller.retryDocuments()} collection={model.collection} view="trash" onView={(next) => entry.tab.set(next === 'trash' ? 'trash' : 'documents')} trashCount={state.stats.view?.deletedDocuments ?? null} onRestore={(targets) => void entry.controller.restore(targets)} onDelete={(targets) => entry.controller.requestDelete(targets)} onEmptyTrash={() => void entry.controller.requestEmptyTrash()} />
		</div>
	);
}

export default TrashTab;
