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
// VECTOR-UI - THE QUERY TAB (search, compare and the chat over a connection)
// =============================================================================
//
// For now it holds the chat panel as the console had it: the thread with
// its sources and "Why these?", and its Search toggle (Semantic, Keyword,
// Hybrid, Auto, the threshold, Compare, "Copy as node setting"). Where chat
// cannot work at all (a dev-tool mount) the panel still offers Search under
// the reason. A notice says when a scoped question goes to every document.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { EmptyState } from 'shell';
import { useVectorEnv } from '../envContext';
import { styles as appStyles } from '../styles';
import ChatPanel from './ChatPanel';
import type { IQueryTabProps } from './workbenchProps';

const styles = {
	column: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } as CSSProperties,
	notice: { ...appStyles.small, margin: '0 0 6px' } as CSSProperties,
};

/**
 * The Query tab.
 *
 * @param props - {@link IQueryTabProps}.
 * @returns The tab's panel.
 */
export function QueryTab({ entry, model, channels, actions, surfaceModel, chatDocuments, chatNotice, onClearChatScope }: IQueryTabProps): React.ReactElement {
	const env = useVectorEnv();
	return (
		<div style={styles.column} aria-label="Chat" role="region">
			{model.chat.enabled && chatNotice !== null && (
				<p role="status" data-chat-scope-notice="" style={styles.notice}>
					{chatNotice}
				</p>
			)}
			{/* Where chat cannot work at all (a dev-tool mount), the panel still offers Search, which needs no LLM, under the reason. */}
			{model.chat.enabled || env.degraded !== null ? <ChatPanel model={surfaceModel} channels={channels} selection={entry.selection} actions={actions} scope={chatDocuments} onClearScope={onClearChatScope} /> : <EmptyState title="Chat" description={model.chat.reason ?? undefined} />}
		</div>
	);
}

export default QueryTab;
