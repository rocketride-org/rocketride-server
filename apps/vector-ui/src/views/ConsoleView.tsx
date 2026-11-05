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
// VECTOR-UI - CONSOLE VIEW (R2-R5, R9: the main screen of a connection)
// =============================================================================
//
// The default document of every connection. Across the top, the database
// summary (StatsStrip); on the left, every document by its path with its
// trash button (and, one switch away, the Trash: Restore, Delete permanently,
// Empty trash) and, under it, the selected document's chunks; on the right,
// adding documents above the chat. The Map is a second tab of the same
// document: both stay mounted (the map gets `visible` so its canvas sleeps
// while hidden), and every map action lands back here through the console's
// actions and the shared selection.
//
// The console's calls and their pacing live in its controller
// (vector/consoleStore.ts); this view renders the controller's snapshot and
// forwards clicks. Writes are confirmed by the app-level dialog host.
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Availability, IDocumentsFilter, IScopeState } from '../contract/types';
import { Banner, Button, ContentHeader, EmptyState, ToggleGroup } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { makeConsoleActions } from '../adapters/consoleActions';
import { savedFilters } from '../adapters/connections';
import type { ConsoleTab } from '../adapters/connections';
import { VECTOR_PROVIDERS, announcer } from '../adapters/explorer';
import { useConnection, useEndpointsState, useLiveEndpoint, useVectorEnv } from '../envContext';
import ChatPanel from '../components/ChatPanel';
import ChunkList from '../components/ChunkList';
import DocumentDirectory from '../components/DocumentDirectory';
import IngestPanel from '../components/IngestPanel';
import StatsStrip from '../components/StatsStrip';
import { alsoReaches, consoleScope, mapScopeFor, writesDuringRemoval } from '../vector/consoleModel';
import { CONDITION_KINDS, checkScope, conditionAvailability, listingFilter, resolveScope, scopeStripText, scopeView, scopeWith } from '../vector/filters';
import type { ConditionKind } from '../vector/filters';
import { healthSummary, medianChunks } from '../vector/health';
import { savedFiltersFor } from '../vector/savedFilters';
import { roleLine, vectorCardView } from '../vector/connections';
import { consoleColumns } from '../vector/layout';
import { providerTitle } from '../vector/support';
import { BUSY } from '../vector/wording';
import { styles } from '../styles';
import MapView from './MapView';

/** The console's two tabs. */
const TABS: Array<{ id: ConsoleTab; label: string }> = [
	{ id: 'console', label: 'Console' },
	{ id: 'map', label: 'Map' },
];

/** Props for the {@link ConsoleView} component. */
export interface IConsoleViewProps {
	/** The endpoint the document was opened with (the live one is looked up). */
	opened: IExplorerEndpoint;
	/** False while another document is the active tab. */
	active: boolean;
	/** More header actions after Refresh (a dev-tool frame's Details). */
	headerActions?: React.ReactNode;
	/** Shown under the header (a dev-tool frame's inline confirmation and connection details). */
	beforeBody?: React.ReactNode;
}

/**
 * The console.
 *
 * @param props - {@link IConsoleViewProps}.
 * @returns The view.
 */
export const ConsoleView: React.FC<IConsoleViewProps> = ({ opened, active, headerActions, beforeBody }) => {
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
	// Hidden (another tab, another document): no quick stats, and the directory pauses.
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

	// Stack the panels below the layout's breakpoint.
	const body = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = body.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth > 0) setWidth(el.clientWidth);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const cols = consoleColumns(width);

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
						<ToggleGroup small options={TABS} value={tab} onChange={(id) => entry.tab.set(id)} />
						<Button variant="ghost" disabled={!card.openable || !entry.opened} onClick={() => entry.controller.refresh()}>
							{refreshing ? BUSY.refreshing : 'Refresh'}
						</Button>
						{headerActions}
					</>
				}
			/>
			{card.blocked && (
				<div style={{ padding: '8px 24px 0' }}>
					<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{card.blocked}</Banner>
				</div>
			)}
			{beforeBody}
			<StatsStrip stats={state.stats} dialect={dialect} readOnly={model.readOnly} documents={state.directory.rows} scopeLine={scopeLine} sample={selection.connectionKey === entry.key ? selection.sampleModel : null} loading={state.directory.status === 'loading'} scopeFilter={scope?.filter ?? null} onScope={scopeFromChart} health={health} />
			{(state.removal.status === 'running' || state.removal.message) && (
				<div role="status" style={{ ...styles.small, padding: '6px 24px' }}>
					{state.removal.status === 'running' ? (state.removal.message ?? BUSY.removing) : state.removal.message}
				</div>
			)}
			<div ref={body} style={{ flex: 1, minHeight: 0, display: tab === 'console' ? 'flex' : 'none', flexDirection: cols.stacked ? 'column' : 'row', gap: 12, padding: 12, overflow: cols.stacked ? 'auto' : 'hidden' }}>
				<div style={{ flex: cols.stacked ? 'none' : `0 0 ${cols.left}`, height: cols.stacked ? 520 : undefined, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
					<DocumentDirectory pager={state.view === 'trash' ? state.trash : state.directory} selectedId={selectedId} writes={writesDuringRemoval(model.writes, state.removal.status)} onSelect={(item) => entry.selection.selectDocument({ objectId: item.objectId, path: item.path })} onRemove={(targets) => entry.controller.requestRemove(targets)} onLoadMore={() => entry.controller.loadMoreDocuments()} onRetry={() => entry.controller.retryDocuments()} collection={model.collection} scope={scope} onScope={setScope} cap={cap} available={available} saved={saved} onSave={saveFilter} onDeleteSaved={deleteFilter} view={state.view} onView={(next) => entry.controller.setView(next)} trashCount={state.stats.view?.deletedDocuments ?? null} onRestore={(targets) => void entry.controller.restore(targets)} onDelete={(targets) => entry.controller.requestDelete(targets)} onEmptyTrash={() => void entry.controller.requestEmptyTrash()} />
					<ChunkList chunks={state.chunks} path={selection.document?.path ?? null} onMore={() => entry.controller.loadMoreChunks()} onOpen={(chunkId) => actions.openDocument(state.chunks.objectId ?? '', chunkId)} onMap={(key) => actions.showOnMap([key], 'document')} />
				</div>
				<div style={{ flex: cols.stacked ? 'none' : `1 1 ${cols.right}`, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0 }}>
					<div style={{ flex: cols.stacked ? 'none' : `0 0 ${cols.ingest}`, minHeight: cols.stacked ? 260 : 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }} aria-label="Add documents" role="region">
						{model.ingest.enabled ? <IngestPanel model={model} channels={channels} actions={actions} alsoReaches={alsoReaches(endpoint, VECTOR_PROVIDERS)} /> : <EmptyState title="Add documents" description={model.ingest.reason ?? undefined} />}
					</div>
					<div style={{ flex: cols.stacked ? 'none' : `1 1 ${cols.chat}`, minHeight: cols.stacked ? 360 : 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }} aria-label="Chat" role="region">
						{model.chat.enabled && wiring.chatNotice !== null && (
							<p role="status" data-chat-scope-notice="" style={{ ...styles.small, margin: '0 0 6px' }}>
								{wiring.chatNotice}
							</p>
						)}
						{/* Where chat cannot work at all (a dev-tool mount), the panel still offers Search, which needs no LLM, under the reason. */}
						{model.chat.enabled || env.degraded !== null ? <ChatPanel model={surfaceModel} channels={channels} selection={entry.selection} actions={actions} scope={chatDocuments} onClearScope={clearChatScope} /> : <EmptyState title="Chat" description={model.chat.reason ?? undefined} />}
					</div>
				</div>
			</div>
			<div style={{ flex: 1, minHeight: 0, display: tab === 'map' ? 'flex' : 'none', flexDirection: 'column', padding: 12 }}>
				<MapView model={mapModel} channels={channels} selection={entry.selection} actions={actions} visible={active && tab === 'map'} documents={entry.documents} writes={entry.writes} />
			</div>
		</div>
	);
};

export default ConsoleView;
