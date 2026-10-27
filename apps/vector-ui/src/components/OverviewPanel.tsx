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
// VECTOR-UI - THE OVERVIEW TAB (the first tab of a connection)
// =============================================================================
//
// The cards, chips and "counts as of" (StatsStrip) on top, then three
// views on a row of their own (automatic activation: they call nothing):
//
//   Summary    Top folders of the loaded documents (the scope's, while one
//              filters the listing) with their share of the chunks, each
//              showing its documents in Documents (that tab's folder view:
//              the loaded documents under it, nothing listed again); the
//              document fields the listing carries, and the chunk metadata
//              fields once Collection read a sample of them; and quick
//              actions (Add documents where the mount can, Browse documents,
//              New query, Open map).
//   Charts     the collection's four charts; a bar sets its condition on the
//              scope and opens Documents.
//   Insights   the loaded documents that need attention (the chip's count),
//              each opening its drawer in Documents.
//
// Everything counted from the loaded documents says what it was counted
// over (vector/overview.ts). OverviewView renders from plain props, so it is
// rendered in tests; OverviewPanel binds it to the connection.
// =============================================================================

import React, { useId, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import type { IDialectResult, IDocumentItem, IDocumentsFilter, ISampleModel } from '../contract/types';
import { DATA_BAR_TOKEN, TONE_EDGE } from '../vector/colors';
import type { IStatsSlot } from '../vector/consoleStore';
import { documentsFolder } from '../adapters/consoleActions';
import { UPLOADED_LABEL } from '../vector/documents';
import { documentFields } from '../vector/fields';
import type { IFieldsEstimate } from '../vector/fields';
import { directoryView } from '../vector/filters';
import type { IHealthSummary } from '../vector/health';
import { insights, insightsLabel, overLine, topFolders } from '../vector/overview';
import { formatCount } from '../vector/stats';
import { workbenchNonce } from '../vector/workbench';
import type { OverviewView as OverviewViewId, WorkbenchTab } from '../vector/workbench';
import { useValueStore } from '../envContext';
import { styles } from '../styles';
import StatsCharts from './StatsCharts';
import StatsStrip from './StatsStrip';
import TabRow, { tabRowIds } from './TabRow';
import type { ITabRowTab } from './TabRow';
import type { IWorkbenchPanelProps } from './workbenchProps';

const local = {
	root: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	body: (shown: boolean): CSSProperties => ({ flex: 1, minHeight: 0, overflowY: 'auto', display: shown ? 'block' : 'none' }),
	columns: { display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 12, padding: '8px 24px 16px' } as CSSProperties,
	side: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } as CSSProperties,
	more: { marginTop: 6 } as CSSProperties,
	card: { ...styles.panel, padding: '8px 12px' } as CSSProperties,
	heading: { margin: '0 0 6px', fontSize: 13, fontWeight: 600 } as CSSProperties,
	subheading: { margin: '8px 0 4px', fontSize: 12, fontWeight: 600 } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, padding: '2px 6px 4px 0', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	thNum: { textAlign: 'right', fontWeight: 600, padding: '2px 0 4px 6px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	td: { padding: '3px 6px 3px 0', overflowWrap: 'anywhere' } as CSSProperties,
	tdNum: { padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' } as CSSProperties,
	share: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' } as CSSProperties,
	bar: (percent: number): CSSProperties => ({ display: 'inline-block', width: 64, height: 8, border: '1px solid var(--rr-text-primary)', background: `linear-gradient(to right, var(${DATA_BAR_TOKEN}) ${percent}%, transparent ${percent}%)` }),
	note: { ...styles.small, margin: '6px 0 0' } as CSSProperties,
	actions: { display: 'flex', flexWrap: 'wrap', gap: 6 } as CSSProperties,
	charts: { padding: '8px 24px 16px' } as CSSProperties,
	list: { listStyle: 'none', margin: 0, padding: 0 } as CSSProperties,
	insight: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, width: '100%', padding: '4px 0', border: 'none', borderBottom: '1px solid var(--rr-border)', background: 'none', color: 'var(--rr-text-primary)', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' } as CSSProperties,
	path: { overflowWrap: 'anywhere', fontWeight: 600 } as CSSProperties,
	folder: { padding: 0, border: 'none', background: 'none', color: 'var(--rr-text-primary)', font: 'inherit', textAlign: 'left', textDecoration: 'underline', overflowWrap: 'anywhere', cursor: 'pointer' } as CSSProperties,
	padded: { padding: '8px 24px 16px' } as CSSProperties,
};

/** The views, in order. */
const VIEWS: ReadonlyArray<ITabRowTab<OverviewViewId>> = [
	{ id: 'summary', label: 'Summary' },
	{ id: 'charts', label: 'Charts' },
	{ id: 'insights', label: 'Insights' },
];

/** Props for the {@link OverviewView} component: everything it shows, as plain values. */
export interface IOverviewViewProps {
	stats: IStatsSlot;
	dialect: IDialectResult | null;
	readOnly: boolean;
	/** The documents loaded so far (the charts, the fields, and Insights, which are the attention chip's). */
	rows: readonly IDocumentItem[];
	/** Those of them the scope covers (Top folders); the same rows without a scope. */
	scopedRows: readonly IDocumentItem[];
	/** The listing is still loading pages. */
	loading: boolean;
	/** Every document of the listing is loaded. */
	complete: boolean;
	/** The listing is filtered by the scope: the documents counted here are the scope's. */
	scoped: boolean;
	/** What the scope covers, while one applies, or null. */
	scopeLine: string | null;
	/** The scope's conditions (the charts mark the bar they select). */
	scopeFilter: IDocumentsFilter | null;
	/** The map's sample, for the chunk-length chart. */
	sample: ISampleModel | null;
	/** The loaded documents' health (the attention chip). */
	health: IHealthSummary;
	/** Their median chunks per document, or null while the listing loads. */
	median: number | null;
	/** A chart's bar was clicked: its condition on the scope. */
	onChartScope(filter: IDocumentsFilter): void;
	/** Open a document's drawer in Documents. */
	onOpenDocument(objectId: string): void;
	/** Show one folder's loaded documents in Documents (splitPath's folder, or the uploaded label). */
	onOpenFolder(folder: string): void;
	onOpenTab(tab: WorkbenchTab): void;
	/** Open Query with an empty question. */
	onNewQuery(): void;
	/** Open Add documents, or null where the mount cannot add documents. */
	onAddDocuments: (() => void) | null;
	/** The fields Collection read from a sample of chunks, or null before it did. */
	fieldsRead: IFieldsEstimate | null;
	/** The view shown first (tests). */
	initialView?: OverviewViewId;
}

/**
 * The Overview, from plain props.
 *
 * @param props - {@link IOverviewViewProps}.
 * @returns The tab's content.
 */
export function OverviewView(props: IOverviewViewProps): React.ReactElement {
	const { stats, dialect, readOnly, rows, loading, scopeLine, scopeFilter, sample, health, median } = props;
	const [view, setView] = useState<OverviewViewId>(props.initialView ?? 'summary');
	// Each view mounts the first time it shows, then stays (the charts are not drawn again on every switch).
	const [mounted, setMounted] = useState<ReadonlySet<OverviewViewId>>(() => new Set([view]));
	if (!mounted.has(view)) setMounted(new Set([...mounted, view]));
	const prefix = `ov${useId().replace(/:/g, '')}`;
	const flagged = useMemo(() => insights(rows, median), [rows, median]);
	const tabs: Array<ITabRowTab<OverviewViewId>> = VIEWS.map((v) => (v.id === 'insights' ? { id: v.id, label: insightsLabel(health.flagged, health.complete), reserve: insightsLabel(888, false) } : v));
	const panel = (id: OverviewViewId, content: React.ReactNode): React.ReactNode => {
		if (!mounted.has(id)) return null;
		const ids = tabRowIds(prefix, id);
		return (
			<div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} style={local.body(view === id)} data-overview-panel={id}>
				{content}
			</div>
		);
	};
	return (
		<div style={local.root}>
			<StatsStrip stats={stats} dialect={dialect} readOnly={readOnly} scopeLine={scopeLine} health={health} />
			{/* Automatic activation: these views call nothing. */}
			<TabRow<OverviewViewId> tabs={tabs} value={view} onSelect={setView} activation="automatic" label="Overview" idPrefix={prefix} small />
			{panel('summary', <Summary {...props} />)}
			{panel(
				'charts',
				<div style={local.charts}>
					<StatsCharts rows={rows} total={stats.view?.documents ?? null} sample={sample} dialect={dialect} onScope={props.onChartScope} loading={loading} scope={scopeFilter} />
				</div>
			)}
			{panel('insights', <Insights flagged={flagged} health={health} onOpen={props.onOpenDocument} />)}
		</div>
	);
}

/** The Summary view. */
const Summary: React.FC<IOverviewViewProps> = ({ rows, scopedRows, complete, scoped, onOpenTab, onOpenFolder, onNewQuery, onAddDocuments, fieldsRead }) => {
	const folders = useMemo(() => topFolders(scopedRows), [scopedRows]);
	const fields = useMemo(() => documentFields(rows), [rows]);
	const chunkFields = (fieldsRead?.rows ?? []).filter((f) => f.source === 'chunks');
	const over = overLine({ loaded: scopedRows.length, complete, scoped });
	return (
		<>
			<div style={local.columns}>
				<section aria-label="Top folders" style={local.card}>
					<h2 style={local.heading}>Top folders</h2>
					{folders.rows.length === 0 ? (
						<p style={local.note}>No documents loaded yet.</p>
					) : (
						<table style={local.table}>
							<thead>
								<tr>
									<th style={local.th}>Folder</th>
									<th style={local.thNum}>Documents</th>
									<th style={local.thNum}>Chunks</th>
									<th style={local.thNum}>Share of chunks</th>
								</tr>
							</thead>
							<tbody>
								{[...folders.rows, ...(folders.others ? [folders.others] : [])].map((f) => (
									<tr key={f.folder || '(others)'} data-folder={f.folder}>
										<td style={local.td}>
											{f.folder === '' && folders.others ? (
												`Other folders (${formatCount(folders.others.folders)})`
											) : (
												<button type="button" style={local.folder} onClick={() => onOpenFolder(f.folder)} title="Show its documents in Documents">
													{f.folder}
												</button>
											)}
										</td>
										<td style={local.tdNum}>{formatCount(f.documents)}</td>
										<td style={local.tdNum}>{f.chunks === null ? '—' : formatCount(f.chunks)}</td>
										<td style={local.tdNum}>
											{f.share === null ? (
												'—'
											) : (
												<span style={local.share}>
													<span aria-hidden="true" style={local.bar(f.share)} />
													{`${f.share}%`}
												</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{!folders.chunksKnown && folders.rows.length > 0 && <p style={local.note}>The store does not count chunks for every document, so shares are not shown.</p>}
					{over !== null && folders.rows.length > 0 && <p style={local.note}>{over}</p>}
				</section>
				<div style={local.side}>
					<section aria-label="Document fields" style={local.card}>
						<h2 style={local.heading}>Document fields</h2>
						{fields.length === 0 ? (
							<p style={local.note}>No documents loaded yet.</p>
						) : (
							<table style={local.table}>
								<thead>
									<tr>
										<th style={local.th}>Field</th>
										<th style={local.th}>Type</th>
										<th style={local.thNum}>Has a value</th>
									</tr>
								</thead>
								<tbody>
									{fields.map((f) => (
										<tr key={f.name}>
											<td style={local.td}>{f.name}</td>
											<td style={local.td}>{f.type}</td>
											<td style={local.tdNum}>{`${formatCount(f.coverage)} of ${formatCount(f.of)}`}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						{chunkFields.length > 0 && fieldsRead !== null ? (
							<>
								<h3 style={local.subheading}>{`Chunk metadata, from ${formatCount(fieldsRead.chunksRead)} ${fieldsRead.chunksRead === 1 ? 'chunk' : 'chunks'} read`}</h3>
								<table style={local.table}>
									<thead>
										<tr>
											<th style={local.th}>Field</th>
											<th style={local.th}>Type (estimated)</th>
											<th style={local.thNum}>Has a value</th>
										</tr>
									</thead>
									<tbody>
										{chunkFields.map((f) => (
											<tr key={f.name}>
												<td style={local.td}>{f.name}</td>
												<td style={local.td}>{f.type}</td>
												<td style={local.tdNum}>{`${formatCount(f.coverage)} of ${formatCount(f.of)}`}</td>
											</tr>
										))}
									</tbody>
								</table>
							</>
						) : (
							<p style={local.note}>Chunk metadata fields are read from a sample in Collection.</p>
						)}
						<div style={local.more}>
							<Button small variant="secondary" onClick={() => onOpenTab('collection')}>
								Read fields in Collection
							</Button>
						</div>
					</section>
					<section aria-label="Quick actions" style={local.card}>
						<h2 style={local.heading}>Quick actions</h2>
						<div style={local.actions}>
							{onAddDocuments && (
								<Button small variant="secondary" onClick={onAddDocuments}>
									Add documents
								</Button>
							)}
							<Button small variant="secondary" onClick={() => onOpenTab('documents')}>
								Browse documents
							</Button>
							<Button small variant="secondary" onClick={onNewQuery}>
								New query
							</Button>
							<Button small variant="secondary" onClick={() => onOpenTab('map')}>
								Open map
							</Button>
						</div>
					</section>
				</div>
			</div>
		</>
	);
};

/** The Insights view: the loaded documents that need attention. */
const Insights: React.FC<{ flagged: ReturnType<typeof insights>; health: IHealthSummary; onOpen(objectId: string): void }> = ({ flagged, health, onOpen }) => (
	<section aria-label="Documents that need attention" style={local.padded}>
		{flagged.length === 0 ? (
			<p style={local.note}>{health.loaded === 0 ? 'No documents loaded yet.' : `None of the ${formatCount(health.loaded)} ${health.loaded === 1 ? 'document' : 'documents'} loaded needs attention.`}</p>
		) : (
			<ul style={local.list}>
				{flagged.map((doc) => (
					<li key={doc.objectId}>
						<button type="button" style={local.insight} onClick={() => onOpen(doc.objectId)} title="Open it in Documents">
							<span style={local.path}>{doc.path || doc.objectId}</span>
							{doc.flags.map((flag) => (
								<span key={flag.kind} style={styles.chip(TONE_EDGE.warning)} title={flag.detail}>
									{flag.label}
								</span>
							))}
						</button>
					</li>
				))}
			</ul>
		)}
		{!health.complete && health.loaded > 0 && <p style={local.note}>{`Over the ${formatCount(health.loaded)} ${health.loaded === 1 ? 'document' : 'documents'} loaded so far; more may need attention.`}</p>}
	</section>
);

/** Props for the {@link OverviewPanel} component. */
export interface IOverviewPanelProps extends IWorkbenchPanelProps {
	/** What the scope covers, while one applies (vector/filters.ts scopeStripText), or null. */
	scopeLine: string | null;
	/** The loaded documents' health (the "N need attention" chip). */
	health: IHealthSummary;
	/** Their median chunks per document, or null while the listing loads (the same one the health used). */
	median: number | null;
	/** A chart's bar was clicked: set its kind of condition on the scope. */
	onChartScope(filter: IDocumentsFilter): void;
	/** Open Add documents, or null where the mount cannot add documents. */
	onAddDocuments: (() => void) | null;
}

/**
 * The Overview tab, bound to its connection.
 *
 * @param props - {@link IOverviewPanelProps}.
 * @returns The tab's panel.
 */
export function OverviewPanel({ entry, model, console: state, selection, scopeLine, health, median, onChartScope, onAddDocuments }: IOverviewPanelProps): React.ReactElement {
	const dir = state.directory;
	// The documents the scope covers: the store filtered the listing; what it did not apply is matched here.
	// While the scope applies to the list, the documents it keeps, as Documents (and its folder rail) count them: the store
	// filtered the listing, and what it did not apply is matched here. Otherwise every loaded document.
	const scope = model.scope ?? null;
	const scoped = scope !== null && scope.applyTo.documents;
	const cap = model.limits.scope_keys_max;
	const scopedRows = useMemo(() => (scoped && scope !== null ? (directoryView(dir, scope, '', cap).scopeRows ?? []) : dir.rows), [dir, scope, scoped, cap]);
	// The console is in front already: showing one of its tabs is setting it.
	const openTab = (tab: WorkbenchTab): void => entry.tab.set(tab);
	const fieldsRead = useValueStore(entry.fields);
	return (
		<OverviewView
			stats={state.stats}
			dialect={model.connection.dialect}
			readOnly={model.readOnly}
			rows={dir.rows}
			scopedRows={scopedRows}
			loading={dir.status === 'loading'}
			complete={dir.status === 'done'}
			scoped={scoped}
			scopeLine={scopeLine}
			scopeFilter={model.scope?.filter ?? null}
			sample={selection.connectionKey === entry.key ? selection.sampleModel : null}
			health={health}
			median={median}
			onChartScope={(filter) => {
				onChartScope(filter);
				openTab('documents');
			}}
			onOpenDocument={(objectId) => {
				entry.openDocument.set({ nonce: workbenchNonce('document'), objectId });
				openTab('documents');
			}}
			onOpenFolder={(folder) => {
				// The Documents tab's own folder view (C2): its loaded documents under that folder; nothing is listed again.
				documentsFolder(entry).set(folder === UPLOADED_LABEL ? { kind: 'uploaded' } : { kind: 'folder', prefix: folder });
				openTab('documents');
			}}
			onOpenTab={openTab}
			onNewQuery={() => {
				entry.queryPrefill.set({ nonce: workbenchNonce('query'), question: '', mode: 'search' });
				openTab('query');
			}}
			onAddDocuments={onAddDocuments}
			fieldsRead={fieldsRead}
		/>
	);
}

export default OverviewPanel;
