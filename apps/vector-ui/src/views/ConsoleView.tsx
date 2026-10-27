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
// it). Neither row moves when a run starts or an answer lands: the tab row
// is its own row, and Refresh keeps its width while it says Refreshing…
// (only for a refresh someone asked for, never the 15 s quick tick).
//
// Under the tab row, on every tab, the banners of a lasting state: the
// console cannot open; the store is unreachable (after a refresh someone
// asked for failed, or two quick ticks in a row: one failed tick moves
// nothing); the collection needs repair or was built with another model;
// writes are off; the collection is empty. Then the inline write
// confirmation of the console's own requests and the connection's Details
// (both inline in both mounts: rocket-ui keeps hidden documents mounted, so
// nothing here is a window-wide overlay). Each tab's panel is mounted the
// first time it shows, then stays mounted and hidden, so it keeps its state
// (the map gets `visible` so its canvas sleeps while hidden). Under the
// panels, what comes and goes after a press: the pending bar and the write's
// line (an alert of its own when the write failed, the store's audit of each
// batch beside it, behind "Write details"), so neither moves a row above it.
// Add documents is an aside beside the panels, kept mounted once opened (an
// upload in flight keeps following its progress).
//
// FOCUS. A confirmation that closes with the focus inside it (and, after
// Cancel, cannot give it back to its opener) gives it to the row the shown
// panel marks `data-return-focus` (the row after the ones written), else to
// that panel's grid, else to the current tab. A tab switch made from inside
// a panel (Show on map, a quick action) moves the focus to the new tab, so
// it never stays on an element of a hidden panel.
//
// THE DIALECT. When fresh stats say the collection exists but the probe
// read at discovery says it does not, the store is probed again, once per
// disagreement, so the index and size fill in without a Test connection.
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

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Availability, IDocumentsFilter, IScopeState } from '../contract/types';
import { Banner, Button, ContentHeader } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { makeConsoleActions } from '../adapters/consoleActions';
import { savedFilters } from '../adapters/connections';
import { announcer } from '../adapters/explorer';
import { useConnection, useEndpointsState, useLiveEndpoint, useValueStore, useVectorEnv } from '../envContext';
import AddDocumentsAside from '../components/AddDocumentsAside';
import CollectionPanel from '../components/CollectionPanel';
import ConnectionDetailsPanel from '../components/ConnectionDetailsPanel';
import DocumentsTab from '../components/DocumentsTab';
import InlineRemoveConfirm from '../components/InlineRemoveConfirm';
import OverviewPanel from '../components/OverviewPanel';
import PendingBar, { PENDING_BAR_HEIGHT } from '../components/PendingBar';
import QueryTab from '../components/QueryTab';
import TrashTab from '../components/TrashTab';
import WorkbenchTabs, { workbenchIds } from '../components/WorkbenchTabs';
import WriteAuditDetails from '../components/WriteAuditDetails';
import type { IWorkbenchPanelProps } from '../components/workbenchProps';
import { CONSOLE_ORIGIN } from '../vector/confirm';
import { consoleScope, mapScopeFor } from '../vector/consoleModel';
import { TABBABLE, firstFocusable, focusLost } from '../vector/focus';
import { CONDITION_KINDS, checkScope, conditionAvailability, listingFilter, resolveScope, scopeStripText, scopeView, scopeWith } from '../vector/filters';
import type { ConditionKind } from '../vector/filters';
import { healthSummary, medianChunks } from '../vector/health';
import { savedFiltersFor } from '../vector/savedFilters';
import { roleLine, vectorCardView } from '../vector/connections';
import { providerTitle } from '../vector/support';
import { REPAIR_NEEDED_TEXT, collectionMissing, formatCount } from '../vector/stats';
import { BUSY, CAVEAT_SENTENCES, EMPTY } from '../vector/wording';
import { NO_FAILURES, RESULT_FIRST_MS, bottomSlot, focusStranded, reprobeFor, statsFailures, unreachableShown } from '../vector/workbench';
import type { BottomSlot, SlotWrite, WorkbenchTab } from '../vector/workbench';
import { styles } from '../styles';
import MapView from './MapView';

const layout = {
	banner: { padding: '8px 24px 0' } as CSSProperties,
	bannerAction: { marginLeft: 8 } as CSSProperties,
	/** Two labels in one cell: the button keeps the width of the longer one, whichever shows. */
	held: { display: 'inline-grid' } as CSSProperties,
	heldLabel: (shown: boolean): CSSProperties => ({ gridArea: '1 / 1', visibility: shown ? 'visible' : 'hidden' }),
	/**
	 * The bottom slot: one line of the pending bar's height, always there and the same whether empty or full, so a
	 * stage, a write's result or a cancel never changes the height of the panels above (the map's canvas, a grid).
	 */
	slot: { flexShrink: 0, boxSizing: 'border-box', height: PENDING_BAR_HEIGHT, margin: '0 12px 8px', display: 'flex', alignItems: 'stretch', minWidth: 0 } as CSSProperties,
	/** The write line in the slot: its sentence (announced), then the audit disclosure beside it (not announced). */
	writeLine: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 8, padding: '0 12px' } as CSSProperties,
	/** The sentence takes the room left, so Write details (and a failure's Dismiss) sit at the slot's right end. */
	status: { ...styles.small, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	/** The panels beside the Add documents aside. */
	body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' } as CSSProperties,
	panels: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	/** One tab's panel: shown or hidden, never unmounted once shown (the Overview's strip has its own gutters). */
	panel: (shown: boolean, gutter: number): CSSProperties => ({ flex: 1, minHeight: 0, minWidth: 0, display: shown ? 'flex' : 'none', flexDirection: 'column', padding: gutter }),
};

/**
 * One tab's panel: shown or hidden, never unmounted once shown; named by its tab.
 *
 * @param props.id - The tab.
 * @param props.shown - Whether it is the tab shown.
 * @param props.gutter - Its padding (the Overview's strip has its own gutters).
 * @param props.prefix - The workbench's id prefix.
 * @param props.children - The panel's content.
 * @returns The panel.
 */
const WorkbenchPanel: React.FC<{ id: WorkbenchTab; shown: boolean; gutter: number; prefix: string; children: React.ReactNode }> = ({ id, shown, gutter, prefix, children }) => {
	const ids = workbenchIds(prefix, id);
	return (
		<div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} style={layout.panel(shown, gutter)} data-workbench-panel={id}>
			{children}
		</div>
	);
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
	const { health, median } = useMemo(() => {
		const settled = state.directory.status !== 'loading' && state.directory.status !== 'idle';
		const median = settled ? medianChunks(state.directory.rows) : null;
		return { median, health: healthSummary(state.directory.rows, { medianChunks: median, complete: state.directory.status === 'done' && state.directory.filter === null }) };
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
	const openAdding = (): void => {
		setAddingMounted(true);
		setAdding(true);
	};
	const prefix = `wb${useId().replace(/:/g, '')}`;
	// The bottom slot's one line (bottomSlot): the pending bar while documents are staged, else the write's line. A
	// write's result that lands while documents are staged shows first (seen, not only announced): a running write and
	// a failure until the staged set changes (or Dismiss), a result for a few seconds; never swapped out from under the
	// focus or the pointer.
	const staged = useValueStore(entry.staged);
	const removal = state.removal;
	// Each write's line is its own object (the store sets a new one per write), so a Dismiss lasts until the next.
	const [dismissed, setDismissed] = useState<typeof removal | null>(null);
	const write: SlotWrite = removal === dismissed || (removal.status !== 'running' && removal.message === null) ? null : removal.status === 'running' ? 'running' : removal.status === 'error' ? 'failure' : 'result';
	const [fresh, setFresh] = useState(false);
	const [stagedSince, setStagedSince] = useState(false);
	// The staged set changed (the user acted). Declared first, so a write that changes the staged set and lands its
	// result in the same render still shows the result.
	useEffect(() => setStagedSince(true), [staged]);
	useEffect(() => {
		setStagedSince(false);
		setFresh(true);
		const timer = setTimeout(() => setFresh(false), RESULT_FIRST_MS);
		return () => clearTimeout(timer);
	}, [removal]);
	const slotRef = useRef<HTMLDivElement>(null);
	const [inSlot, setInSlot] = useState({ focus: false, pointer: false });
	const showing = useRef<BottomSlot>('empty');
	const slot = bottomSlot({ staged: staged.size, write, fresh, stagedSince, held: inSlot.focus || inSlot.pointer, showing: showing.current });
	const panel = (id: WorkbenchTab): IWorkbenchPanelProps => ({ entry, model, channels, actions, console: state, selection, visible: active && tab === id });
	// Where the focus goes after a confirmation closes: the shown panel's marked row, else its grid, else the current tab.
	const root = useRef<HTMLDivElement>(null);
	const currentTab = (): HTMLElement | null => root.current?.querySelector<HTMLElement>('[data-workbench-tabs] [role="tab"][aria-selected="true"]') ?? null;
	// The same order as the pending bar's (components/focusTargets.ts): the row the grid marks, its row in the tab order,
	// the grid, then the tab.
	const returnFocus = (): HTMLElement | null => {
		const shown = root.current?.querySelector<HTMLElement>(`[data-workbench-panel="${tab}"]`) ?? null;
		const inShown = (selector: string): HTMLElement | null => shown?.querySelector<HTMLElement>(selector) ?? null;
		return firstFocusable([inShown('[data-return-focus]'), inShown('[data-grid-focus] [data-grid-row][tabindex="0"]'), inShown('[data-grid-focus]'), currentTab()]);
	};
	// The slot changed what it shows: what it shows now is what it showed last; and a control in it that left with the
	// focus (Dismiss, the pending bar going) hands the focus to the slot's first control, else the shown panel's chain.
	useLayoutEffect(() => {
		showing.current = slot;
		if (typeof document === 'undefined' || !inSlot.focus) return;
		const node = slotRef.current;
		if (focusLost(document.activeElement, document.body, null)) firstFocusable([node?.querySelector<HTMLElement>(TABBABLE) ?? null, returnFocus()])?.focus();
		const focus = !!node && node.contains(document.activeElement);
		setInSlot((was) => (was.focus === focus ? was : { ...was, focus }));
		// Only when the slot's content changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slot]);
	// Where the focus goes when Add documents closes and its opener cannot take it back: the header's button, else the tab.
	const asideFocus = (): HTMLElement | null => firstFocusable([root.current?.querySelector<HTMLElement>('[data-add-documents] button'), currentTab()]);
	// A tab switch made from inside a panel leaves the focus on an element now hidden: it goes to the new tab.
	useLayoutEffect(() => {
		if (typeof document === 'undefined') return;
		const focused = document.activeElement;
		if (!(focused instanceof HTMLElement) || !root.current?.contains(focused) || !focusStranded(focused, tab)) return;
		currentTab()?.focus();
	}, [tab]);

	// Refreshing… only for a refresh someone asked for; the quick tick every 15 s changes nothing in the header.
	const [refreshAsked, setRefreshAsked] = useState(false);
	const statsLoading = state.stats.status === 'loading';
	useEffect(() => {
		if (!statsLoading && refreshAsked) setRefreshAsked(false);
	}, [statsLoading, refreshAsked]);
	const refreshing = refreshAsked && statsLoading;
	const refresh = (): void => {
		// A refresh already running is not asked again.
		if (refreshing) return;
		setRefreshAsked(true);
		entry.controller.refresh();
	};

	// B1(b): fresh stats say the collection exists while the probe read at discovery says it does not: probe again,
	// once per disagreement (a store whose probe keeps disagreeing is not asked on every quick tick).
	const reprobed = useRef<string | null>(null);
	const disagree = state.stats.view !== null && state.stats.view.collectionExists && dialect?.health.collection_exists === false;
	useEffect(() => {
		const next = reprobeFor(reprobed.current, disagree, endpoint.key);
		reprobed.current = next.tried;
		if (next.probe) void env.probe(endpoint.key);
	}, [disagree, env, endpoint.key]);

	const title = `${providerTitle(endpoint.provider)}${model.collection ? ` · ${model.collection}` : ''}`;
	const subtitle = `"${endpoint.pipelineName}" · ${endpoint.nodeName || endpoint.nodeId} · ${roleLine(endpoint)}`;
	const statsError = state.stats.status === 'error' ? state.stats.error : null;
	// The store failed: said above every tab only once it is more than one quick tick (unreachableShown).
	const failures = useRef(NO_FAILURES);
	failures.current = statsFailures(failures.current, { status: state.stats.status, error: state.stats.error, asked: refreshAsked });
	const unreachable = statsError !== null && unreachableShown(failures.current, state.stats.view !== null);
	// One "Empty collection" rule with the chip and the connection card (vector/stats.ts collectionMissing), or no documents.
	const missing = collectionMissing(dialect, state.stats.view);
	const emptyCollection = missing || state.stats.view?.documents === 0;
	const inTrash = state.stats.view?.deletedDocuments ?? 0;
	const emptyText = !missing && inTrash > 0 ? `No documents outside the trash (${formatCount(inTrash)} in the Trash).` : EMPTY.noDocuments;

	return (
		<div ref={root} style={styles.root} data-console={endpoint.nodeId}>
			<ContentHeader
				title={title}
				subtitle={subtitle}
				actions={
					<>
						<Button variant="ghost" disabled={!card.openable || !entry.opened} onClick={refresh}>
							<span style={layout.held}>
								<span style={layout.heldLabel(!refreshing)}>Refresh</span>
								<span style={layout.heldLabel(refreshing)}>{BUSY.refreshing}</span>
							</span>
						</Button>
						<Button variant="ghost" pressed={details} onClick={() => setDetails((open) => !open)}>
							Details
						</Button>
						<span data-add-documents="">
							<Button variant="ghost" pressed={adding} onClick={() => (adding ? setAdding(false) : openAdding())}>
								Add documents
							</Button>
						</span>
					</>
				}
			/>
			<WorkbenchTabs value={tab} onChange={(id) => entry.tab.set(id)} trashCount={state.stats.view?.deletedDocuments ?? null} idPrefix={prefix} mounted={mounted} />
			{card.blocked && (
				<div style={layout.banner}>
					<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{card.blocked}</Banner>
				</div>
			)}
			{!card.blocked && unreachable && statsError !== null && (
				<div style={layout.banner}>
					<Banner variant="error">
						{statsError.headline}
						{statsError.detail ? ` ${statsError.detail}` : ''}
						{state.stats.view !== null ? ' The Overview keeps the last figures read.' : ''}
						<span style={layout.bannerAction}>
							<Button small variant="secondary" onClick={refresh}>
								Retry
							</Button>
						</span>
					</Banner>
				</div>
			)}
			{!card.blocked && dialect?.health.control_record === false && (
				<div style={layout.banner}>
					<Banner variant="warning">{REPAIR_NEEDED_TEXT}</Banner>
				</div>
			)}
			{!card.blocked && dialect?.health.model_mismatch === true && (
				<div style={layout.banner}>
					<Banner variant="warning">{CAVEAT_SENTENCES.model_mismatch}</Banner>
				</div>
			)}
			{!card.blocked && entry.opened && !model.writes.enabled && model.writes.reason !== null && (
				<div style={layout.banner}>
					<Banner variant="info">{model.writes.reason}</Banner>
				</div>
			)}
			{!card.blocked && !unreachable && emptyCollection && (
				<div style={layout.banner}>
					<Banner variant="info">
						{emptyText}
						{model.ingest.enabled ? (
							<span style={layout.bannerAction}>
								<Button small variant="secondary" onClick={openAdding}>
									Add documents
								</Button>
							</span>
						) : (
							` ${model.ingest.reason ?? ''}`
						)}
					</Banner>
				</div>
			)}
			<InlineRemoveConfirm entry={entry} probe={probe} origin={CONSOLE_ORIGIN} returnFocus={returnFocus} />
			{details && <ConnectionDetailsPanel key={endpoint.key} endpoint={endpoint} probe={probe} stats={state.stats.view} onTest={(target) => env.probe(target.key)} onClose={() => setDetails(false)} />}
			<div style={layout.body}>
				<div style={layout.panels}>
					{mounted.has('overview') && (
						<WorkbenchPanel id="overview" shown={tab === 'overview'} gutter={0} prefix={prefix}>
							<OverviewPanel {...panel('overview')} scopeLine={scopeLine} health={health} median={median} onChartScope={scopeFromChart} onAddDocuments={model.ingest.enabled ? openAdding : null} />
						</WorkbenchPanel>
					)}
					{mounted.has('documents') && (
						<WorkbenchPanel id="documents" shown={tab === 'documents'} gutter={12} prefix={prefix}>
							<DocumentsTab {...panel('documents')} scope={scope} onScope={setScope} cap={cap} available={available} saved={saved} onSave={saveFilter} onDeleteSaved={deleteFilter} scopeLine={scopeLine} health={health} />
						</WorkbenchPanel>
					)}
					{mounted.has('query') && (
						<WorkbenchPanel id="query" shown={tab === 'query'} gutter={12} prefix={prefix}>
							<QueryTab {...panel('query')} surfaceModel={surfaceModel} chatDocuments={chatDocuments} chatNotice={wiring.chatNotice} onClearChatScope={clearChatScope} />
						</WorkbenchPanel>
					)}
					{mounted.has('map') && (
						<WorkbenchPanel id="map" shown={tab === 'map'} gutter={12} prefix={prefix}>
							<MapView model={mapModel} channels={channels} selection={entry.selection} actions={actions} visible={active && tab === 'map'} documents={entry.documents} writes={entry.writes} />
						</WorkbenchPanel>
					)}
					{mounted.has('collection') && (
						<WorkbenchPanel id="collection" shown={tab === 'collection'} gutter={12} prefix={prefix}>
							<CollectionPanel {...panel('collection')} endpoint={endpoint} probe={probe} />
						</WorkbenchPanel>
					)}
					{mounted.has('trash') && (
						<WorkbenchPanel id="trash" shown={tab === 'trash'} gutter={12} prefix={prefix}>
							<TrashTab {...panel('trash')} />
						</WorkbenchPanel>
					)}
					{/* Under the panels, one line of a fixed height: what comes and goes after a press never moves a row above it. */}
					<div
						ref={slotRef}
						style={layout.slot}
						data-bottom-slot=""
						onFocus={() => setInSlot((was) => (was.focus ? was : { ...was, focus: true }))}
						onBlur={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInSlot((was) => ({ ...was, focus: false }));
						}}
						onPointerEnter={() => setInSlot((was) => ({ ...was, pointer: true }))}
						onPointerLeave={() => setInSlot((was) => ({ ...was, pointer: false }))}
					>
						{slot === 'pending' && <PendingBar {...panel(tab)} />}
						{slot === 'write' && (
							<div style={layout.writeLine} data-write-line="" title={state.removal.message ?? undefined}>
								{state.removal.status === 'error' ? (
									// Its own element, so a failure is announced as one (a role changed on the same element often is not).
									<div key="alert" role="alert" style={layout.status}>
										{state.removal.message}
									</div>
								) : (
									<div key="status" role="status" style={layout.status}>
										{state.removal.status === 'running' ? (state.removal.message ?? BUSY.removing) : state.removal.message}
									</div>
								)}
								{/* Outside the live element: opening it does not announce the line again. */}
								{(state.removal.status === 'done' || state.removal.status === 'error') && <WriteAuditDetails audit={state.removal.audit} />}
								{write === 'failure' && (
									<Button small variant="ghost" onClick={() => setDismissed(removal)}>
										Dismiss
									</Button>
								)}
							</div>
						)}
					</div>
				</div>
				{addingMounted && <AddDocumentsAside model={model} channels={channels} actions={actions} endpoint={endpoint} open={adding} onClose={() => setAdding(false)} returnFocus={asideFocus} />}
			</div>
		</div>
	);
};

export default ConsoleView;
