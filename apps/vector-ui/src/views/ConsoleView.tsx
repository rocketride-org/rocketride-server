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
// VECTOR-UI - CONSOLE VIEW (the workbench: the main screen of a connection)
// =============================================================================
//
// The default document of every connection. Under its header (Refresh,
// Details, Add documents) a row of tabs of its own: Overview, Documents,
// Query, Map, Collection and Trash (vector/workbench.ts; the tab is the
// connection's `entry.tab`, so the map's and the chat's actions can switch
// it). Under the tab row, on every tab: the blocked banner, the inline write
// confirmation and the connection's Details (both inline in both mounts:
// rocket-ui keeps hidden documents mounted, so nothing here is a window-wide
// overlay), the pending bar and the write status line. Each tab's panel is
// mounted the first time it shows, then stays mounted and hidden, so it
// keeps its state (the map gets `visible` so its canvas sleeps while
// hidden). Add documents is an aside beside the panels, kept mounted once
// opened.
//
// The console's calls and their pacing live in its controller
// (vector/consoleStore.ts); this view renders the controller's snapshot and
// forwards clicks.
//
// THE SCOPE. The directory's ScopeBar sets the connection's scope (the
// entry's value store, read by the map and search as ConsoleModel.scope);
// this view hands its conditions and path box to the controller's listing
// while its Documents toggle is on, resolves the documents it covers from the listing
// (vector/filters.ts resolveScope: their objectIds once it holds every
// document, the count above limits.scope_keys_max), scopes the chat to them
// while the Chat toggle is on (never above the cap), and keeps the saved
// filters of the connection. A surface is scoped exactly when its toggle reads
// on (vector/consoleModel.ts consoleScope): until the scope's documents are
// known the chat asks every document and says so above it, search waits for
// them, and the map keeps the scope it drew with (mapScopeFor), so it samples
// once, when they are known.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Availability, IDocumentsFilter, IScopeState } from '../contract/types';
import { Banner, Button, ContentHeader } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { makeConsoleActions } from '../adapters/consoleActions';
import { savedFilters } from '../adapters/connections';
import { announcer } from '../adapters/explorer';
import { useConnection, useEndpointsState, useLiveEndpoint, useVectorEnv } from '../envContext';
import AddDocumentsAside from '../components/AddDocumentsAside';
import CollectionPanel from '../components/CollectionPanel';
import ConnectionDetailsPanel from '../components/ConnectionDetailsPanel';
import DocumentsTab from '../components/DocumentsTab';
import InlineRemoveConfirm from '../components/InlineRemoveConfirm';
import OverviewPanel from '../components/OverviewPanel';
import PendingBar from '../components/PendingBar';
import QueryTab from '../components/QueryTab';
import TrashTab from '../components/TrashTab';
import WorkbenchTabs from '../components/WorkbenchTabs';
import type { IWorkbenchPanelProps } from '../components/workbenchProps';
import { consoleScope, mapScopeFor } from '../vector/consoleModel';
import { CONDITION_KINDS, checkScope, conditionAvailability, listingFilter, resolveScope, scopeStripText, scopeView, scopeWith } from '../vector/filters';
import type { ConditionKind } from '../vector/filters';
import { healthSummary, medianChunks } from '../vector/health';
import { savedFiltersFor } from '../vector/savedFilters';
import { roleLine, vectorCardView } from '../vector/connections';
import { providerTitle } from '../vector/support';
import { BUSY } from '../vector/wording';
import type { WorkbenchTab } from '../vector/workbench';
import { styles } from '../styles';
import MapView from './MapView';

const layout = {
	banner: { padding: '8px 24px 0' } as CSSProperties,
	status: { ...styles.small, padding: '6px 24px' } as CSSProperties,
	/** The panels beside the Add documents aside. */
	body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' } as CSSProperties,
	panels: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	/** One tab's panel: shown or hidden, never unmounted once shown (the Overview's strip has its own gutters). */
	panel: (shown: boolean, gutter: number): CSSProperties => ({ flex: 1, minHeight: 0, minWidth: 0, display: shown ? 'flex' : 'none', flexDirection: 'column', padding: gutter }),
};

/** Props for the {@link ConsoleView} component. */
export interface IConsoleViewProps {
	/** The endpoint the document was opened with (the live one is looked up). */
	opened: IExplorerEndpoint;
	/** False while another document is the active tab. */
	active: boolean;
}

/**
 * The console.
 *
 * @param props - {@link IConsoleViewProps}.
 * @returns The view.
 */
export const ConsoleView: React.FC<IConsoleViewProps> = ({ opened, active }) => {
	const env = useVectorEnv();
	const endpoint = useLiveEndpoint(opened);
	const { probes } = useEndpointsState();
	const probe = probes[endpoint.key];
	const { entry, console: state, selection, tab, chatScope, model, channels } = useConnection(endpoint);
	const card = vectorCardView(endpoint, probe);
	const dialect = model.connection.dialect;

	// First load once the store node answered as a vector store; later loads are the controller's.
	useEffect(() => {
		if (card.openable && !entry.opened) {
			entry.opened = true;
			entry.controller.open();
		}
	}, [card.openable, entry]);
	// Hidden (another document): no quick stats, and the directory pauses.
	useEffect(() => {
		entry.controller.setVisible(active);
	}, [active, entry]);
	useEffect(() => {
		entry.controller.setWritesEnabled(model.writes.enabled);
	}, [model.writes.enabled, entry]);
	// A document selected elsewhere (the map, the chat's sources) lists its chunks here.
	const selectedId = selection.document?.objectId ?? null;
	useEffect(() => {
		if (selectedId !== state.chunks.objectId) entry.controller.selectDocument(selectedId);
	}, [selectedId, state.chunks.objectId, entry]);

	// The scope: its conditions and path box go to the listing while it filters the list; its documents resolve from the listing.
	const scope = model.scope ?? null;
	const cap = model.limits.scope_keys_max;
	const listing = scope !== null && scope.applyTo.documents ? listingFilter(scope.filter) : null;
	const listingKey = JSON.stringify(listing);
	useEffect(() => {
		entry.controller.setFilter(listing);
		// The key is the listing filter's meaning; the object is rebuilt every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listingKey, entry]);
	useEffect(() => {
		const current = entry.scope.get();
		if (current === null) return;
		const next = resolveScope(current, state.directory, cap);
		if (next !== current) entry.scope.set(next);
	}, [scope, state.directory, cap, entry]);
	const setScope = (next: IScopeState | null): void => entry.scope.set(next);
	const caveatsKey = [...(dialect?.caveats ?? []), ...(state.stats.view?.caveats ?? [])].join('|');
	const available = useMemo(() => {
		const caveats = caveatsKey === '' ? [] : caveatsKey.split('|');
		const out: Partial<Record<ConditionKind, Availability>> = {};
		for (const kind of CONDITION_KINDS) out[kind] = conditionAvailability(kind, { caveats, rows: state.directory.rows });
		return out;
	}, [caveatsKey, state.directory.rows]);
	// What the chat, search and the map are handed: each scoped exactly when the ScopeBar shows its toggle on.
	const wiring = useMemo(() => consoleScope(chatScope, scope, state.directory, cap), [chatScope, scope, state.directory, cap]);
	const surfaceModel = useMemo(() => (wiring.applied === (model.scope ?? null) ? model : { ...model, scope: wiring.applied }), [model, wiring.applied]);
	// The map keeps the scope it drew with while a new scope's documents are on their way (state from the last render).
	const [mapScope, setMapScope] = useState<IScopeState | null>(null);
	const nextMapScope = mapScopeFor(mapScope, wiring);
	if (nextMapScope !== mapScope) setMapScope(nextMapScope);
	const mapModel = useMemo(() => (nextMapScope === (model.scope ?? null) ? model : { ...model, scope: nextMapScope }), [model, nextMapScope]);
	const scopeLine = wiring.scope !== null ? scopeStripText(scopeView(wiring.scope, state.directory, cap), state.stats.view) : null;
	// The "N need attention" chip: the loaded documents' health; complete only for the whole, finished listing.
	const health = useMemo(() => {
		const settled = state.directory.status !== 'loading' && state.directory.status !== 'idle';
		return healthSummary(state.directory.rows, { medianChunks: settled ? medianChunks(state.directory.rows) : null, complete: state.directory.status === 'done' && state.directory.filter === null });
	}, [state.directory]);
	// A chart's bar sets its kind of condition (a chunk range, a file type, a period) and keeps the others.
	// Kept between renders so the memoised charts are not drawn again for nothing.
	const scopeFromChart = useCallback(
		(filter: IDocumentsFilter): void => {
			const next = scopeWith(scope, scope?.filter.path_contains ?? '', filter);
			const refused = checkScope(next);
			if (refused !== null) announcer.announce(refused);
			else entry.scope.set(next);
		},
		[scope, entry]
	);

	// Saved filters: per connection, in memory (the app's map, emptied on a change of identity).
	const savedStore = useMemo(() => savedFiltersFor(savedFilters, entry.key), [entry.key]);
	const [saved, setSaved] = useState(() => savedStore.list());
	useEffect(() => setSaved(savedStore.list()), [savedStore]);
	const saveFilter = (name: string, filter: IDocumentsFilter): string | null => {
		const outcome = savedStore.save(name, filter);
		if (!outcome.ok) return outcome.error;
		setSaved(savedStore.list());
		announcer.announce(`Saved the filter "${outcome.saved.name}".`);
		return null;
	};
	const deleteFilter = (id: string): void => {
		savedStore.remove(id);
		setSaved(savedStore.list());
	};

	// The chat: "Ask about these" first, else the scope's documents while its Chat toggle is on and they are known.
	const chatDocuments = wiring.chat;
	const clearChatScope = (): void => {
		if (chatScope !== null) entry.chatScope.set(null);
		else if (scope !== null) entry.scope.set({ ...scope, applyTo: { ...scope.applyTo, chat: false } });
	};

	const actions = useMemo(
		() =>
			makeConsoleActions(entry, {
				openDocument: (objectId, chunkId) => {
					const row = entry.controller.getState().directory.rows.find((r) => r.objectId === objectId);
					env.openDocument(entry.ctx.endpoint, objectId, row?.path ?? null, chunkId);
				},
				// Focuses this console's tab: nothing changes while it is in front; in a split it activates its group.
				showConsole: () => env.openConsole(entry.ctx.endpoint),
				announce: (text) => announcer.announce(text),
			}),
		[entry, env]
	);

	// Each panel mounts the first time its tab shows, then stays (state from the last render, as the map's scope).
	const [mounted, setMounted] = useState<ReadonlySet<WorkbenchTab>>(() => new Set([tab]));
	if (!mounted.has(tab)) setMounted(new Set([...mounted, tab]));
	const [details, setDetails] = useState(false);
	const [adding, setAdding] = useState(false);
	const [addingMounted, setAddingMounted] = useState(false);
	const panel = (id: WorkbenchTab): IWorkbenchPanelProps => ({ entry, model, channels, actions, console: state, selection, visible: active && tab === id });

	const title = `${providerTitle(endpoint.provider)}${model.collection ? ` · ${model.collection}` : ''}`;
	const subtitle = `"${endpoint.pipelineName}" · ${endpoint.nodeName || endpoint.nodeId} · ${roleLine(endpoint)}`;
	const refreshing = state.stats.status === 'loading';

	return (
		<div style={styles.root} data-console={endpoint.nodeId}>
			<ContentHeader
				title={title}
				subtitle={subtitle}
				actions={
					<>
						<Button variant="ghost" disabled={!card.openable || !entry.opened} onClick={() => entry.controller.refresh()}>
							{refreshing ? BUSY.refreshing : 'Refresh'}
						</Button>
						<Button variant="ghost" pressed={details} onClick={() => setDetails((open) => !open)}>
							Details
						</Button>
						<Button
							variant="ghost"
							pressed={adding}
							onClick={() => {
								setAddingMounted(true);
								setAdding((open) => !open);
							}}
						>
							Add documents
						</Button>
					</>
				}
			/>
			<WorkbenchTabs value={tab} onChange={(id) => entry.tab.set(id)} trashCount={state.stats.view?.deletedDocuments ?? null} />
			{card.blocked && (
				<div style={layout.banner}>
					<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{card.blocked}</Banner>
				</div>
			)}
			<InlineRemoveConfirm entry={entry} probe={probe} />
			{details && <ConnectionDetailsPanel key={endpoint.key} endpoint={endpoint} probe={probe} stats={state.stats.view} onTest={(target) => env.probe(target.key)} onClose={() => setDetails(false)} />}
			<PendingBar {...panel(tab)} />
			{(state.removal.status === 'running' || state.removal.message) && (
				<div role="status" style={layout.status}>
					{state.removal.status === 'running' ? (state.removal.message ?? BUSY.removing) : state.removal.message}
				</div>
			)}
			<div style={layout.body}>
				<div style={layout.panels}>
					{mounted.has('overview') && (
						<div style={layout.panel(tab === 'overview', 0)}>
							<OverviewPanel {...panel('overview')} scopeLine={scopeLine} health={health} onChartScope={scopeFromChart} />
						</div>
					)}
					{mounted.has('documents') && (
						<div style={layout.panel(tab === 'documents', 12)}>
							<DocumentsTab {...panel('documents')} scope={scope} onScope={setScope} cap={cap} available={available} saved={saved} onSave={saveFilter} onDeleteSaved={deleteFilter} scopeLine={scopeLine} health={health} />
						</div>
					)}
					{mounted.has('query') && (
						<div style={layout.panel(tab === 'query', 12)}>
							<QueryTab {...panel('query')} surfaceModel={surfaceModel} chatDocuments={chatDocuments} chatNotice={wiring.chatNotice} onClearChatScope={clearChatScope} />
						</div>
					)}
					{mounted.has('map') && (
						<div style={layout.panel(tab === 'map', 12)}>
							<MapView model={mapModel} channels={channels} selection={entry.selection} actions={actions} visible={active && tab === 'map'} documents={entry.documents} writes={entry.writes} />
						</div>
					)}
					{mounted.has('collection') && (
						<div style={layout.panel(tab === 'collection', 12)}>
							<CollectionPanel {...panel('collection')} endpoint={endpoint} probe={probe} />
						</div>
					)}
					{mounted.has('trash') && (
						<div style={layout.panel(tab === 'trash', 12)}>
							<TrashTab {...panel('trash')} />
						</div>
					)}
				</div>
				{addingMounted && <AddDocumentsAside model={model} channels={channels} actions={actions} endpoint={endpoint} open={adding} onClose={() => setAdding(false)} />}
			</div>
		</div>
	);
};

export default ConsoleView;
