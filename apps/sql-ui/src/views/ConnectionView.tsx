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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection } from 'shell';
import { Button, ContentHeader, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint } from '../connect';
import { refreshSchema, useSchema } from '../schema/schemaStore';
import { diagramUri, getDocs, nextQueryDoc } from '../docs';
import { HistoryPrefsBridge } from '../history/historyStore';
import { runSchemaChecks } from '../schema/quality';
import { useTableRecordRequest } from '../navigation';
import OverviewPanel from '../panels/OverviewPanel';
import InsightsPanel from './InsightsPanel';

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

	// The record drawer belongs to OverviewPanel, and TabPanel hides the
	// inactive panel with `display: none` — so a table opened from Insights,
	// or from the sidebar tree while Insights is in front, would raise a
	// drawer nobody can see. Bring Overview forward with it. Requests made
	// before this document mounted are not acted on: the ref starts at
	// whatever sequence was already in the store.
	const tableRequest = useTableRecordRequest();
	const seenRequestRef = useRef(tableRequest?.seq ?? 0);
	useEffect(() => {
		if (!tableRequest || tableRequest.key !== endpoint.key) return;
		if (tableRequest.seq === seenRequestRef.current) return;
		seenRequestRef.current = tableRequest.seq;
		setActivePage('overview');
	}, [tableRequest, endpoint.key]);

	// Snapshot-only review findings; the count rides the Insights tab so the
	// page advertises whether it has anything to say before it is opened.
	//
	// WARNINGS only. An `info` finding is something to know, not something to
	// do, and counting both would put a number on the tab of every healthy
	// ClickHouse schema (where "no primary key" is how the engine reflects
	// every table). A badge that is always lit stops being read.
	const warningCount = useMemo(
		() => runSchemaChecks(snapshot.schema, snapshot.dialect)
			.filter((finding) => finding.severity === 'warning').length,
		[snapshot.schema, snapshot.dialect],
	);

	// The document's pages — grows as later phases land.
	const menu: ViewMenu = {
		entries: [
			{ id: 'overview', label: 'Overview' },
			{ id: 'insights', label: 'Insights', count: warningCount },
		],
	};

	// Header subtitle: dialect + pipeline binding + snapshot freshness.
	//
	// The stamp distinguishes the two things a "read" can mean here. A node
	// with the `refresh_schema` tool actually re-reads the database; a node
	// without it serves the reflection taken when its task started, however
	// recently we asked. Saying "schema read HH:MM" for both would let the
	// second case pass for the first, which is exactly the confusion that
	// makes a Refresh button look broken after a CREATE TABLE.
	const dialectLabel = snapshot.dialect !== 'unknown' ? snapshot.dialect : endpoint.provider;
	const stampTime = snapshot.refreshedAt ? new Date(snapshot.refreshedAt).toLocaleTimeString() : '';
	const refreshed = snapshot.refreshedAt
		? (snapshot.stale
			? ` — task-start snapshot, read ${stampTime}`
			: ` — snapshot re-read ${stampTime}`)
		: '';

	return (
		<div style={styles.root}>
			{/* Query history is persisted through workspace preferences, and
			    those may only be written while SQL Explorer is on screen. An
			    open workbench keeps that channel alive, so a run recorded from
			    any query document on this connection is actually saved. */}
			<HistoryPrefsBridge />

			{/* Page strip at the very top of the document's content. */}
			<TabControl menu={menu} activeId={activePage} onSelect={setActivePage} />

			<ContentHeader
				title={snapshot.schema?.database ?? endpoint.nodeName}
				subtitle={`${dialectLabel} via ${endpoint.pipelineName} / ${endpoint.nodeId}${refreshed}`}
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => { if (client) void refreshSchema(client, endpoint, { fresh: true }); }}
							disabled={!client || snapshot.status === 'loading'}
						>
							{snapshot.status === 'loading' ? 'Reading...' : 'Refresh Schema'}
						</Button>
						<Button
							variant="secondary"
							onClick={() => getDocs()?.openStaticDocument(diagramUri(endpoint.key), `${endpoint.nodeName} - diagram`, endpoint)}
						>
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
						insights: { content: <InsightsPanel endpoint={endpoint} snapshot={snapshot} /> },
					}}
				/>
			</div>
		</div>
	);
};

export default ConnectionView;
