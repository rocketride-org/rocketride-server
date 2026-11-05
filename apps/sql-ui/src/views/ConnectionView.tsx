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
import { Banner, Button, ConfirmDialog, ContentHeader, StatusBadge, TabControl, TabPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';
import type { SqlEndpoint } from '../connect';
import { probeExecute, refreshSchema, useExecuteState, useSchema, useSchemaGeneration } from '../schema/schemaStore';
import { useSqlEnv } from '../sqlEnv';
import { runSchemaChecks } from '../schema/quality';
import { useTableRecordRequest } from '../navigation';
import { SqlPageNavProvider } from '../pageNav';
import { pageHasOwnHeader, showsWorkbenchHeader } from '../pageFrame';
import { SCHEMA_ONLY_NOTE_ID, executeGateReason, schemaOnlyExplanation } from '../executeGate';
import { opensShortcutSheet } from '../components/shortcuts';
import GatedButton from '../components/GatedButton';
import ShortcutSheet from '../components/ShortcutSheet';
import type { SqlPageNav, SqlQuerySeed } from '../pageNav';
import OverviewPanel from '../panels/OverviewPanel';
import InsightsPanel from './InsightsPanel';
import { DiagramView } from './DiagramView';
import { QueryView } from './QueryView';
import { TableDataView } from './TableDataView';
import type { FilterChip } from '../sql/filters';
import { leaveDataText, stagedCount } from '../sql/stagedGuard';
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

	// The same region for pages that draw their own header and padding
	// (Query, Data, Design), so the padding is not added twice.
	panelsBare: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	// Why statements are off, between the header and the page.
	schemaOnlyNote: {
		padding: '0 24px 4px',
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
// CONSTANTS
// =============================================================================

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
	const executeState = useExecuteState(endpoint.key);
	const gateReason = executeGateReason(executeState);

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

	// Bumped after a write on the Query page (a History rerun included) or a
	// designer Apply. The Data page takes it as `countEpoch` and forgets the
	// totals it counted, which that write may have changed. Its own Apply
	// keeps its own epoch.
	const [writeEpoch, setWriteEpoch] = useState(0);
	const noteWrite = useCallback((): void => { setWriteEpoch((n) => n + 1); }, []);

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
	const [dataSeed, setDataSeed] = useState<{ table: string; chips: FilterChip[]; seq: number } | null>(null);
	const [designSeed, setDesignSeed] = useState<{ table: string | null; seq: number } | null>(null);
	const seedSeqRef = useRef(0);
	// A data seed asked for while the Data page holds staged changes: it would
	// drop them, so the user is asked first (sql/stagedGuard.ts).
	const [leaveAsk, setLeaveAsk] = useState<{ table: string; chips: FilterChip[]; staged: number } | null>(null);
	const openData = useCallback((table: string, chips: FilterChip[]) => {
		setDataSeed({ table, chips, seq: ++seedSeqRef.current });
		selectPage('data');
	}, [selectPage]);

	// The page navigation the drawer buttons and the history panel consult
	// (in place of opening inner documents).
	const pageNav = useMemo<SqlPageNav>(() => ({
		openQuery: addQuery,
		openTableData: (table: string, chips?: FilterChip[]) => {
			const staged = stagedCount(endpoint.key);
			if (staged > 0) {
				setLeaveAsk({ table, chips: chips ?? [], staged });
				return;
			}
			openData(table, chips ?? []);
		},
		openDesign: (table: string | null) => {
			setDesignSeed({ table, seq: ++seedSeqRef.current });
			selectPage('design');
		},
	}), [addQuery, selectPage, openData, endpoint.key]);

	// First schema reflection as soon as the connection is live.
	useEffect(() => {
		if (env.ready && snapshot.status === 'idle') {
			void refreshSchema(env.getSession(endpoint));
		}
	}, [env, snapshot.status, endpoint]);

	// Find out once per open whether the node runs statements (SELECT 1; see
	// probeExecute). Until it answers, the state is unknown and nothing is
	// disabled. A cleared store (an account switch) forgot the answer, so the
	// guard is per store generation as well as per connection.
	const epoch = useSchemaGeneration();
	const probedRef = useRef<string | null>(null);
	useEffect(() => {
		const probeKey = `${endpoint.key}#${epoch}`;
		if (!env.ready || probedRef.current === probeKey) return;
		probedRef.current = probeKey;
		void probeExecute(env.getSession(endpoint));
	}, [env, endpoint, epoch]);

	// The keyboard shortcut sheet: a header button, and `?` anywhere that is
	// not a text field or the editor.
	// Another connection's document can be mounted but hidden; only the one
	// on screen answers.
	const rootRef = useRef<HTMLDivElement>(null);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (rootRef.current && rootRef.current.getClientRects().length > 0 && opensShortcutSheet(event)) {
				event.preventDefault();
				setShortcutsOpen(true);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

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
		<div ref={rootRef} style={styles.root}>

			{/* Page strip at the very top of the document's content. */}
			<TabControl menu={menu} activeId={activePage} onSelect={selectPage} />

			{showsWorkbenchHeader(activePage) && (
				<ContentHeader
					title={snapshot.schema?.database ?? endpoint.nodeName}
					subtitle={`${dialectLabel} via ${endpoint.pipelineName} / ${endpoint.nodeId}${refreshed}`}
					actions={
						<>
							{gateReason && <span title="allow_execute is off for this node"><StatusBadge variant="warning">Schema only</StatusBadge></span>}
							<Button variant="ghost" onClick={() => setShortcutsOpen(true)} title="Show the keyboard shortcuts (?)">
								Shortcuts
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									if (!env.ready) return;
									void refreshSchema(env.getSession(endpoint), { fresh: true });
									// A node restarted with allow_execute on is noticed here.
									if (executeState === 'off') void probeExecute(env.getSession(endpoint));
								}}
								disabled={!env.ready || snapshot.status === 'loading'}
							>
								{snapshot.status === 'loading' ? 'Reading...' : 'Refresh Schema'}
							</Button>
							<GatedButton variant="primary" onClick={() => pageNav.openQuery({})} gateReason={gateReason} reasonId={SCHEMA_ONLY_NOTE_ID}>
								New Query
							</GatedButton>
						</>
					}
				/>
			)}

			{/* Why statements are off, in words, and a way to look again. */}
			{gateReason && showsWorkbenchHeader(activePage) && (
				<div id={SCHEMA_ONLY_NOTE_ID} style={styles.schemaOnlyNote}>
					<Banner variant="warning">
						<strong>Schema only. </strong>
						{schemaOnlyExplanation(endpoint.nodeName)}{' '}
						<Button variant="ghost" small onClick={() => { if (env.ready) void probeExecute(env.getSession(endpoint)); }}>
							Check again
						</Button>
					</Banner>
				</div>
			)}

			{/* Panel stack — a page mounts on first visit (the diagram only
			    reverse-engineers when actually selected), then every mounted
			    panel stays mounted across switches. Seeded pages remount on a
			    new seed via the seq key. */}
			<div style={pageHasOwnHeader(activePage) ? styles.panelsBare : styles.panels}>
				<SqlPageNavProvider value={pageNav}>
					<TabPanel
						activeId={activePage}
						panels={{
							overview: { content: <OverviewPanel endpoint={endpoint} snapshot={snapshot} /> },
							insights: { content: <InsightsPanel endpoint={endpoint} snapshot={snapshot} /> },
							...(visited.has('diagram') ? { diagram: { content: <DiagramView endpoint={endpoint} onOpenTable={pageNav.openTableData} /> } } : {}),
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
														onWrite={noteWrite}
													/>
												</div>
											))}
										</div>
									),
								},
							} : {}),
							...(dataSeed ? { data: { content: <TableDataView key={dataSeed.seq} endpoint={endpoint} table={dataSeed.table} presetFilters={dataSeed.chips} countEpoch={writeEpoch} onOpenTable={pageNav.openTableData} /> } } : {}),
							...(designSeed ? { design: { content: <TableDesignView key={designSeed.seq} endpoint={endpoint} table={designSeed.table} onWrite={noteWrite} /> } } : {}),
						}}
					/>
				</SqlPageNavProvider>
			</div>

			{shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}

			{leaveAsk && (
				<ConfirmDialog
					title="Discard staged changes?"
					message={leaveDataText(leaveAsk.staged, leaveAsk.table)}
					confirmLabel="Discard and open"
					destructive
					onConfirm={() => { const { table, chips } = leaveAsk; setLeaveAsk(null); openData(table, chips); }}
					onCancel={() => setLeaveAsk(null)}
				/>
			)}
		</div>
	);
};

export default ConnectionView;
