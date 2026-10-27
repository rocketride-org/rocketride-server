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
// VECTOR-UI - THE COLLECTION TAB (what the store node reports about the collection)
// =============================================================================
//
// For now it holds the connection's details as the drawer shows them
// (vector/connections.ts drawerView): the pipeline, the store node, the
// embedding model, dimension, metric and index, with the console's last
// stats filling what the dialect read at discovery lacks. Read-only.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { drawerView } from '../vector/connections';
import ConnectionDrawerDetails from './ConnectionDrawerDetails';
import type { ICollectionPanelProps } from './workbenchProps';

const styles = {
	scroll: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: '0 12px' } as CSSProperties,
};

/**
 * The Collection tab.
 *
 * @param props - {@link ICollectionPanelProps}.
 * @returns The tab's panel.
 */
export function CollectionPanel({ endpoint, probe, console: state }: ICollectionPanelProps): React.ReactElement {
	return (
		<div style={styles.scroll}>
			<ConnectionDrawerDetails drawer={drawerView(endpoint, probe, state.stats.view)} />
		</div>
	);
}

export default CollectionPanel;
