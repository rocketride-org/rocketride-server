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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, ContentHeader, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';
import type { SqlEndpoint } from '../connect';
import { refreshSchema, useSchema } from '../schema/schemaStore';
import { useSqlEnv } from '../sqlEnv';
import { runSchemaChecks } from '../schema/quality';
import { useTableRecordRequest } from '../navigation';
import { SqlPageNavProvider } from '../pageNav';
import type { SqlPageNav, SqlQuerySeed } from '../pageNav';
import OverviewPanel from '../panels/OverviewPanel';
import InsightsPanel from './InsightsPanel';
import { DiagramView } from './DiagramView';
import { QueryView } from './QueryView';
import { TableDataView } from './TableDataView';
import { TableDesignView } from './TableDesignView';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConnectionView} component. */
export interface ConnectionViewProps {
	/** The connection's endpoint. */
	endpoint: SqlEndpoint;
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

	// ── Query page (instance strip over the active instance) ─────────────────

	queryPage: {
		// The TabPanel body is a BLOCK scroll container, so `flex: 1` has no
		// effect here — an explicit height is what keeps the chain of
		// percentage heights below (QueryView → editor region → Monaco)
		// definite. Without it the editor collapses to zero.
		height: '100%',
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	queryStrip: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		flexWrap: 'wrap',
		paddingBottom: 8,
		flexShrink: 0,
	} as CSSProperties,

	queryChip: (active: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: '3px 6px 3px 10px',
		borderRadius: 5,
		fontSize: 12,
		cursor: 'pointer',
		userSelect: 'none',
		border: `1px solid ${active ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		background: active ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-input)',
		color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	}),

	queryChipClose: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 16,
		height: 16,
		border: 'none',
		borderRadius: 3,
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
		padding: 0,
		fontSize: 12,
		lineHeight: 1,
	} as CSSProperties,

	queryInstance: (active: boolean): CSSProperties => ({
		display: active ? 'flex' : 'none',
		flex: 1,
		minHeight: 0,
		flexDirection: 'column',
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Workbench document for one connection. Renders the page strip (Overview
 * today; Query / Data / Diagram land with their phases), the standard page
 * header, and the active panel. Kicks the first schema reflection on mount.
 */
export const ConnectionView: React.FC<ConnectionViewProps> = ({ endpoint }) => {
	const env = useSqlEnv();
	const snapshot = useSchema(endpoint.key);

	// The active page of this document's TabControl.
	const [activePage, setActivePage] = useState('overview');

	// Pages visited at least once — LAZY mounting: the diagram only reverse-
	// engineers when its page is first selected, then stays mounted (TabPanel
	// display-hides it) so switching back is instant.
	const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['overview']));
	const selectPage = useCallback((id: string) => {
		setActivePage(id);
		setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
	}, []);

	// The QUERY page is permanent and holds any number of query INSTANCES —
	// each keeps its own editor/results state (all stay mounted; the strip
	// switches which is visible). Opening a query adds an instance instead of
	// replacing the page.
	const [queries, setQueries] = useState<Array<{ id: number; label: string; seed: SqlQuerySeed }>>([]);
	const [activeQueryId, setActiveQueryId] = useState<number | null>(null);
	const nextQueryIdRef = useRef(0);

	const addQuery = useCallback((seed: SqlQuerySeed) => {
		const id = ++nextQueryIdRef.current;
		setQueries((prev) => [...prev, { id, label: seed.label ?? `Query ${id}`, seed }]);
		setActiveQueryId(id);
		selectPage('query');
	}, [selectPage]);

	const closeQuery = useCallback((id: number) => {
		setQueries((prev) => {
			const at = prev.findIndex((q) => q.id === id);
			const next = prev.filter((q) => q.id !== id);
			setActiveQueryId((cur) => (cur === id ? next[Math.max(0, at - 1)]?.id ?? null : cur));
			return next;
		});
	}, []);

	// A first visit to the Query page starts with one empty instance (and
	// closing the last one resets to a fresh empty instance the same way).
	useEffect(() => {
		if (visited.has('query') && queries.length === 0) addQuery({});
	}, [visited, queries.length, addQuery]);

	// On-demand page seeds. Data / design are PAGES of this document (one
	// surface each, no inner documents); a new seed remounts the page's
	// content via the seq key, replacing what it showed.
	const [dataSeed, setDataSeed] = useState<{ table: string; seq: number } | null>(null);
	const [designSeed, setDesignSeed] = useState<{ table: string | null; seq: number } | null>(null);
	const seedSeqRef = useRef(0);

	// The page navigation the drawer buttons and the history panel consult
	// (in place of opening inner documents).
	const pageNav = useMemo<SqlPageNav>(() => ({
		openQuery: addQuery,
		openTableData: (table: string) => {
			setDataSeed({ table, seq: ++seedSeqRef.current });
			selectPage('data');
		},
		openDesign: (table: string | null) => {
			setDesignSeed({ table, seq: ++seedSeqRef.current });
			selectPage('design');
		},
	}), [addQuery, selectPage]);

	// First schema reflection as soon as the connection is live.
	useEffect(() => {
		if (env.ready && snapshot.status === 'idle') {
			void refreshSchema(env.getSession(endpoint));
		}
	}, [env, snapshot.status, endpoint]);

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
		selectPage('overview');
	}, [tableRequest, endpoint.key, selectPage]);

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

	// The document's pages. Overview / Query / Insights / Diagram are
	// permanent (Query right after Overview); Data / Design appear once
	// something has seeded them.
	const menu: ViewMenu = {
		entries: [
			{ id: 'overview', label: 'Overview' },
			{ id: 'query', label: 'Query' },
			{ id: 'insights', label: 'Insights', count: warningCount },
			{ id: 'diagram', label: 'Diagram' },
			...(dataSeed ? [{ id: 'data', label: 'Data' }] : []),
			...(designSeed ? [{ id: 'design', label: 'Design' }] : []),
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
			? ` (task-start snapshot, read ${stampTime})`
			: ` (snapshot re-read ${stampTime})`)
		: '';

	return (
		<div style={styles.root}>

			{/* Page strip at the very top of the document's content. */}
			<TabControl menu={menu} activeId={activePage} onSelect={selectPage} />

			<ContentHeader
				title={snapshot.schema?.database ?? endpoint.nodeName}
				subtitle={`${dialectLabel} via ${endpoint.pipelineName} / ${endpoint.nodeId}${refreshed}`}
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => { if (env.ready) void refreshSchema(env.getSession(endpoint), { fresh: true }); }}
							disabled={!env.ready || snapshot.status === 'loading'}
						>
							{snapshot.status === 'loading' ? 'Reading...' : 'Refresh Schema'}
						</Button>
						<Button variant="primary" onClick={() => pageNav.openQuery({})}>
							New Query
						</Button>
					</>
				}
			/>

			{/* Panel stack — a page mounts on first visit (the diagram only
			    reverse-engineers when actually selected), then every mounted
			    panel stays mounted across switches. Seeded pages remount on a
			    new seed via the seq key. */}
			<div style={styles.panels}>
				<SqlPageNavProvider value={pageNav}>
					<TabPanel
						activeId={activePage}
						panels={{
							overview: { content: <OverviewPanel endpoint={endpoint} snapshot={snapshot} /> },
							insights: { content: <InsightsPanel endpoint={endpoint} snapshot={snapshot} /> },
							...(visited.has('diagram') ? { diagram: { content: <DiagramView endpoint={endpoint} /> } } : {}),
							...(visited.has('query') ? {
								query: {
									content: (
										<div style={styles.queryPage}>
											{/* Instance strip: switch between open queries, close
											    them, start another. Every instance stays mounted so
											    its editor/results state survives switching. */}
											<div style={styles.queryStrip} role="tablist" aria-label="Open queries">
												{queries.map((q) => (
													<div
														key={q.id}
														role="tab"
														aria-selected={q.id === activeQueryId}
														tabIndex={0}
														style={styles.queryChip(q.id === activeQueryId)}
														onClick={() => setActiveQueryId(q.id)}
														onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveQueryId(q.id); } }}
													>
														<span>{q.label}</span>
														<button
															type="button"
															style={styles.queryChipClose}
															title={`Close ${q.label}`}
															aria-label={`Close ${q.label}`}
															onClick={(e) => { e.stopPropagation(); closeQuery(q.id); }}
														>
															✕
														</button>
													</div>
												))}
												<Button variant="ghost" small onClick={() => addQuery({})}>+ New</Button>
											</div>
											{queries.map((q) => (
												<div key={q.id} style={styles.queryInstance(q.id === activeQueryId)}>
													<QueryView
														endpoint={endpoint}
														label={q.label}
														{...(q.seed.sql !== undefined ? { initialSql: q.seed.sql } : {})}
														{...(q.seed.origin !== undefined ? { origin: q.seed.origin } : {})}
													/>
												</div>
											))}
										</div>
									),
								},
							} : {}),
							...(dataSeed ? { data: { content: <TableDataView key={dataSeed.seq} endpoint={endpoint} table={dataSeed.table} /> } } : {}),
							...(designSeed ? { design: { content: <TableDesignView key={designSeed.seq} endpoint={endpoint} table={designSeed.table} /> } } : {}),
						}}
					/>
				</SqlPageNavProvider>
			</div>
		</div>
	);
};

export default ConnectionView;
