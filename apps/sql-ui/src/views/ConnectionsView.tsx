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
// SQL-UI — CONNECTIONS VIEW (Archetype C landing: discovered database nodes)
// =============================================================================

import React, { useEffect, useState } from 'react';
import { useShellConnection } from 'shell';
// App-private connection tiles (owned by this app, not the platform surface).
import { ConnectionCard, ConnectionCardAdd } from '../components/ConnectionCard';
import {
	Banner,
	Button,
	ContentHeader,
	EmptyState,
} from 'shell';
import type { ISqlEndpoint } from '../connect';
import { refreshEndpoints, useSqlEndpoints } from '../connect';
import { connectionUri, getDocs } from '../docs';
import ConnectionDetailPanel from '../components/ConnectionDetailPanel';
import { DatabaseIcon } from '../icons';
import { styles } from '../styles';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Landing view: every database tool node discovered in the caller's running
 * pipelines, as connection cards. Clicking a card (or the add tile) opens the
 * record drawer to inspect and probe the endpoint.
 */
export const ConnectionsView: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const { status, endpoints, error } = useSqlEndpoints();

	// Drawer state: open flag + the endpoint preselected by a card click
	// (null = pick mode from the add tile / header action).
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [drawerEndpoint, setDrawerEndpoint] = useState<ISqlEndpoint | null>(null);

	// Kick off the first discovery as soon as the shell connection is live.
	useEffect(() => {
		if (client && isConnected && status === 'idle') {
			void refreshEndpoints(client);
		}
	}, [client, isConnected, status]);

	/**
	 * Open the record drawer.
	 *
	 * @param endpoint - Preselected endpoint, or null for pick mode.
	 */
	const openDrawer = (endpoint: ISqlEndpoint | null): void => {
		setDrawerEndpoint(endpoint);
		setDrawerOpen(true);
	};

	/**
	 * Open (or focus) the workbench document for a connection. The endpoint
	 * rides as the static document's content payload.
	 *
	 * @param endpoint - The connection to open.
	 */
	const openConnection = (endpoint: ISqlEndpoint): void => {
		getDocs()?.openStaticDocument(connectionUri(endpoint.key), endpoint.nodeName, endpoint);
	};

	// Discovery is still on its first pass (nothing cached to show yet).
	const firstLoad = status === 'idle' || (status === 'loading' && endpoints.length === 0);

	return (
		<div style={styles.root}>
			<ContentHeader
				title="Connections"
				subtitle="SQL databases reachable through your running pipelines. A connection binds to a database tool node in a pipeline."
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => { if (client) void refreshEndpoints(client); }}
							disabled={!client || status === 'loading'}
						>
							{status === 'loading' ? 'Refreshing...' : 'Refresh'}
						</Button>
						<Button variant="primary" onClick={() => openDrawer(null)}>+ New Connection</Button>
					</>
				}
			/>

			<div style={styles.content}>
				{/* Discovery failure — keep any previously discovered cards visible. */}
				{status === 'error' && (
					<div style={{ marginBottom: 16 }}>
						<Banner variant="error">Discovery failed: {error}</Banner>
					</div>
				)}

				{firstLoad ? (
					// First paint: framed progress state, never bare "Loading..." text.
					<EmptyState
						icon={<DatabaseIcon />}
						title="Discovering database nodes"
						description="Scanning your running pipelines for database tool nodes..."
					/>
				) : endpoints.length === 0 ? (
					// Nothing reachable: explain what makes a connection appear.
					<EmptyState
						icon={<DatabaseIcon />}
						title="No database nodes found"
						description="Start a pipeline containing a database node (MySQL, PostgreSQL, or ClickHouse), then refresh."
						action={
							<Button variant="primary" onClick={() => { if (client) void refreshEndpoints(client); }} disabled={!client}>
								Refresh
							</Button>
						}
					/>
				) : (
					// The discovered endpoints as connection cards + the add tile.
					<div style={styles.cardGrid}>
						{endpoints.map((endpoint) => (
							<ConnectionCard
								key={endpoint.key}
								icon={<DatabaseIcon />}
								name={endpoint.nodeName}
								address={`${endpoint.provider} - ${endpoint.pipelineName}`}
								status={endpoint.running ? 'success' : 'muted'}
								statusLabel={endpoint.running ? 'Running' : 'Stopped'}
								connected={endpoint.running}
								onClick={() => openConnection(endpoint)}
								onEdit={() => openDrawer(endpoint)}
							/>
						))}
						<ConnectionCardAdd label="New Connection" onClick={() => openDrawer(null)} />
					</div>
				)}
			</div>

			{/* Record drawer: inspect + probe the selected endpoint. */}
			<ConnectionDetailPanel
				open={drawerOpen}
				client={client}
				endpoints={endpoints}
				endpoint={drawerEndpoint}
				onClose={() => setDrawerOpen(false)}
				onOpen={(endpoint) => {
					setDrawerOpen(false);
					openConnection(endpoint);
				}}
			/>
		</div>
	);
};

export default ConnectionsView;
