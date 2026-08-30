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
// SQL-UI — CONNECTION VIEW (Archetype B workbench document for one connection)
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import { Button, ContentHeader, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint } from '../connect';
import { refreshSchema, useSchema } from '../schema/schemaStore';
import { diagramUri, getDocs, nextQueryDoc } from '../docs';
import OverviewPanel from '../panels/OverviewPanel';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConnectionView} component. */
export interface IConnectionViewProps {
	/** The connection's endpoint. */
	endpoint: ISqlEndpoint;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Document root: TabControl strip, then header, then the panel stack.
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Panel stack region: fills the remaining height; each panel scrolls itself.
	panels: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		padding: '20px 24px 24px',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Workbench document for one connection. Renders the page strip (Overview
 * today; Query / Data / Diagram land with their phases), the standard page
 * header, and the active panel. Kicks the first schema reflection on mount.
 */
export const ConnectionView: React.FC<IConnectionViewProps> = ({ endpoint }) => {
	const { client, isConnected } = useShellConnection();
	const snapshot = useSchema(endpoint.key);

	// The active page of this document's TabControl.
	const [activePage, setActivePage] = useState('overview');

	// First schema reflection as soon as the connection is live.
	useEffect(() => {
		if (client && isConnected && snapshot.status === 'idle') {
			void refreshSchema(client, endpoint);
		}
	}, [client, isConnected, snapshot.status, endpoint]);

	// The document's pages — grows as later phases land.
	const menu: ViewMenu = {
		entries: [{ id: 'overview', label: 'Overview' }],
	};

	// Header subtitle: dialect + pipeline binding + snapshot freshness.
	const dialectLabel = snapshot.dialect !== 'unknown' ? snapshot.dialect : endpoint.provider;
	const refreshed = snapshot.refreshedAt ? ` — schema read ${new Date(snapshot.refreshedAt).toLocaleTimeString()}` : '';

	return (
		<div style={styles.root}>
			{/* Page strip at the very top of the document's content. */}
			<TabControl menu={menu} activeId={activePage} onSelect={setActivePage} />

			<ContentHeader
				title={snapshot.schema?.database ?? endpoint.nodeName}
				subtitle={`${dialectLabel} via ${endpoint.pipelineName} / ${endpoint.nodeId}${refreshed}`}
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => {
								if (client) void refreshSchema(client, endpoint);
							}}
							disabled={!client || snapshot.status === 'loading'}
						>
							{snapshot.status === 'loading' ? 'Reading...' : 'Refresh Schema'}
						</Button>
						<Button variant="secondary" onClick={() => getDocs()?.openStaticDocument(diagramUri(endpoint.key), `${endpoint.nodeName} - diagram`, endpoint)}>
							Diagram
						</Button>
						<Button
							variant="primary"
							onClick={() => {
								// New query documents carry their endpoint + label as
								// the static document's content payload.
								const { uri, label } = nextQueryDoc(endpoint.key);
								getDocs()?.openStaticDocument(uri, label, { endpoint, label });
							}}
						>
							New Query
						</Button>
					</>
				}
			/>

			{/* Panel stack — every panel stays mounted across page switches. */}
			<div style={styles.panels}>
				<TabPanel
					activeId={activePage}
					panels={{
						overview: { content: <OverviewPanel endpoint={endpoint} snapshot={snapshot} client={client} /> },
					}}
				/>
			</div>
		</div>
	);
};

export default ConnectionView;
