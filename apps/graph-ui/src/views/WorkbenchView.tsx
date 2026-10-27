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
// GRAPH-UI - WORKBENCH VIEW (browse one connection: Overview and query tabs)
// =============================================================================
//
// The browsing document of one connection. Everything here READS: the editors
// send `read_query`, Ask only drafts, a label or type click in the sidebar runs
// the generated 25-row preview, and the graph's expand/connect/path actions are
// reads. Changing data is the write console's job, and exists only where the
// node allows it.
//
// The document opens on Overview (drawn from the schema already loaded, no
// request of its own) beside Query 1. Nothing runs by itself: Explore runs its
// sample on a click. Each query tab (graph/queryTabs.ts) owns a run surface with
// its own editor, runs, graph session and load slot. A hidden tab keeps its
// surface mounted (its runs, result, session and how its graph is shown) but
// draws no canvas or grid, so a tab shown again lays its graph out again: moved
// nodes go back to computed places. Text that arrives from elsewhere opens its
// own tab, so no draft is replaced: a sidebar preview (run), an Ask draft (not
// run), History's Run again (run) and Open in new tab, a saved query or a
// template, and the graph's "New query from here". Only History's "Load into
// editor" and Saved's "Insert" go into an existing tab (the query tab shown
// last), as an edit the editor can undo. Query 1 keeps the persisted draft the
// one editor had before tabs; the other tabs last for the session, and closing
// one whose text was edited asks first. At most MAX_QUERY_TABS: past that, a
// sentence says to close one, and nothing is dropped.
//
// The tabs have a row of their own, and the shown tab's controls the row under
// it: its run bar (each surface portals its bar there) or Overview's actions.
// Sharing one row moved the tabs whenever the bar's width changed, and a run
// changes it, so nothing beside the tabs can move them. Every read of every tab, and Ask, goes through one request gate
// (graph/requestGate.ts), so the workbench sends one request at a time (Refresh
// schema is the connection's, for every document, and is not counted). While a
// tab's graph fills the document, the document hides what it covers.
//
// A sidebar click is a preview REQUEST (graph/previews.ts): this workbench takes
// it by its nonce, once, whenever it mounts, so the click that summoned a cold
// dev-tool webview is not lost. A request waits while this connection has not
// answered its check yet, instead of being dropped.
//
// History and Saved are an inline side panel (SidePanel), never a drawer. As a
// dev tool there is no Connections landing: the connection details (what the
// node reports, Test connection) show inline in this document, under its header
// (ConnectionDetailsPanel, never a drawer), toggled by a Details header action
// and opened, with a test, by Test connection where the connection cannot be
// browsed. The full app keeps its landing.
// =============================================================================

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, ConfirmDialog, ContentHeader, EmptyState, StatusBadge, ToggleGroup } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { announcer } from '../adapters/explorer';
import { patternCheck } from '../cypher/classify';
import { isRefusal } from '../cypher/recipes';
import { useGraphEndpoints, useGraphEnv, usePendingPreview, useSchemaView } from '../env';
import { DETAILS_CLOSED, connectionView, detailsPanelAfter, surfaceGate } from '../graph/connections';
import type { DetailsPanelAction, IDetailsPanelState } from '../graph/connections';
import { canWrite, engineText, parseDialect, targetText } from '../graph/dialect';
import { previewFor, previewStatement } from '../graph/previews';
import type { IGraphPreview } from '../graph/previews';
import { FIRST_QUERY_TAB, OVERVIEW_TAB, activateTab, askTitle, clipTitle, closeTab, historyTitle, initialTabs, placeRequest, previewTitle } from '../graph/queryTabs';
import type { IQueryTabsState, QueryTabOrigin, TabRequest } from '../graph/queryTabs';
import { EXPLORE_CYPHER } from '../graph/templates';
import { GraphIcon } from '../icons';
import { styles as shared } from '../styles';
import AskBar, { ASK_DRAFT_HEADLINE, askCheckText, askDraftText, askKeptText } from '../components/AskBar';
import ConnectionDetailsPanel from '../components/ConnectionDetailsPanel';
import HistoryPanel from '../components/HistoryPanel';
import OverviewPanel from '../components/OverviewPanel';
import QueryTabs, { panelElementId, tabElementId } from '../components/QueryTabs';
import RunSurface from '../components/RunSurface';
import SavedQueriesPanel from '../components/SavedQueriesPanel';
import SidePanel from '../components/SidePanel';
import { createLoadSlot } from '../graph/loadSlot';
import type { ILoadSlot } from '../graph/loadSlot';
import { createRequestGate } from '../graph/requestGate';

/** Nothing is remembered here: a request is taken through the env, which clears it for every later mount. */
const NONE_TAKEN: ReadonlySet<string> = new Set();

/** What the side panel shows. */
type SideView = 'history' | 'saved';

const SIDE_OPTIONS: { id: SideView; label: string }[] = [
	{ id: 'history', label: 'History' },
	{ id: 'saved', label: 'Saved' },
];

const styles = {
	// The tab row holds the tabs and nothing else, so they keep their place whatever the shown tab does.
	tabRow: { flex: '0 0 auto', display: 'flex', alignItems: 'center', minHeight: 38, padding: '0 24px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	// Under it, the shown tab's controls, right-aligned: its run bar, which fills the row and wraps only inside it, or
	// Overview's actions. Its 4 px bottom padding is what the hidden editor's divider sits over (RunSurface).
	controlRow: { flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', padding: '4px 24px' } as CSSProperties,
	barHost: { flex: '1 1 auto', minWidth: 0, display: 'flex' } as CSSProperties,
	notice: { padding: '8px 24px 0' } as CSSProperties,
	body: { flex: 1, minHeight: 0, display: 'flex' } as CSSProperties,
	panes: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	pane: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	hidden: { display: 'none' } as CSSProperties,
	surface: { flex: 1, minHeight: 0 } as CSSProperties,
	overview: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	overviewActions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 } as CSSProperties,
	overviewBody: { flex: 1, minHeight: 0, overflowY: 'auto' } as CSSProperties,
	askNote: { marginTop: 4, fontSize: 12 } as CSSProperties,
	askActions: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } as CSSProperties,
};

/** Props. */
export interface IWorkbenchViewProps {
	endpoint: IExplorerEndpoint;
}

/**
 * The workbench of one connection.
 *
 * @param props - See {@link IWorkbenchViewProps}.
 * @returns The view.
 */
export const WorkbenchView: React.FC<IWorkbenchViewProps> = ({ endpoint }) => {
	const env = useGraphEnv();
	const { probes } = useGraphEndpoints();
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const dialectNow = useRef(dialect);
	dialectNow.current = dialect;
	const schema = useSchemaView(endpoint.key);
	const view = connectionView(endpoint, probe);
	const writable = canWrite(dialect);
	// A surface that has been on screen stays through a re-probe (see surfaceGate): it pauses instead of unmounting.
	const opened = useRef(false);
	if (view.openable) opened.current = true;
	const gate = surfaceGate(view, opened.current);

	// A dev-tool frame shows the connection details inline here (see detailsPanelAfter).
	const inFrame = env.mount === 'frame';
	const [details, setDetails] = useState<IDetailsPanelState>(DETAILS_CLOSED);
	const panel = (action: DetailsPanelAction): void => setDetails((current) => detailsPanelAfter(current, action));
	const idPrefix = `graph-wb${useId().replace(/:/g, '')}`;

	// ── Tabs: the pure model, one load slot per tab, and what each tab's editor holds ──
	const [tabs, setTabs] = useState<IQueryTabsState>(initialTabs);
	const tabsNow = useRef(tabs);
	const commitTabs = useCallback((next: IQueryTabsState) => {
		tabsNow.current = next;
		setTabs(next);
	}, []);
	// Each tab's own mailbox for its editor, for the life of the tab (see loadSlot.ts).
	const slots = useRef(new Map<string, ILoadSlot>());
	const slotOf = useCallback((id: string): ILoadSlot => {
		let slot = slots.current.get(id);
		if (!slot) {
			slot = createLoadSlot();
			slots.current.set(id, slot);
		}
		return slot;
	}, []);
	const [seqs, setSeqs] = useState<Readonly<Record<string, number>>>({});
	const texts = useRef(new Map<string, string>());
	// The text each tab was opened with, so closing one that was edited can ask first.
	const opening = useRef(new Map<string, string>());
	// The tab whose close waits for a confirmation, and a request for the tab shown next to take the focus after it.
	const [closing, setClosing] = useState<string | null>(null);
	const [focusTabs, setFocusTabs] = useState(0);
	// The shown tab's run bar goes into the control row (an element of this document).
	const [barHost, setBarHost] = useState<HTMLElement | null>(null);
	// One request at a time across the tabs (graph/requestGate.ts).
	const [requests] = useState(createRequestGate);
	// True while a tab's graph fills the document: everything it covers is hidden (RunSurface onFullScreen).
	const [fullScreen, setFullScreen] = useState(false);
	// Why the last tab was not opened (the limit), until a tab opens or closes.
	const [tabsNotice, setTabsNotice] = useState<string | null>(null);
	// The banner on each tab Ask opened (its line, and what the text check found), until it is dismissed.
	const [askNotes, setAskNotes] = useState<Readonly<Record<string, { text: string; check: string | null }>>>({});

	const gateNow = useRef(gate);
	gateNow.current = gate;
	// Put text into the tab a request names (a new one, or the query tab shown last). A run is asked for only while the
	// surfaces are on screen and can run it: nothing is queued to run by itself later.
	const deliver = useCallback((request: TabRequest): string | null => {
		const placed = placeRequest(tabsNow.current, request);
		if ('refused' in placed) {
			setTabsNotice(placed.refused);
			announcer.announce(placed.refused);
			return null;
		}
		setTabsNotice(null);
		commitTabs(placed.state);
		if (!opening.current.has(placed.target)) opening.current.set(placed.target, placed.put.insert ? '' : placed.put.text);
		const now = gateNow.current;
		const runNow = placed.put.run && now.mounted && now.paused === null;
		if (placed.put.run && !runNow) announcer.announce(`The statement was put in the editor but not run. ${now.paused ?? 'This connection cannot be browsed yet.'}`);
		const seq = slotOf(placed.target).put({ text: placed.put.text, run: runNow, insert: placed.put.insert });
		setSeqs((current) => ({ ...current, [placed.target]: seq }));
		return placed.target;
	}, [commitTabs, slotOf]);

	const activate = useCallback((id: string) => commitTabs(activateTab(tabsNow.current, id)), [commitTabs]);
	const closeNow = useCallback((id: string) => {
		commitTabs(closeTab(tabsNow.current, id));
		slots.current.delete(id);
		texts.current.delete(id);
		opening.current.delete(id);
		setSeqs(({ [id]: _gone, ...rest }) => rest);
		setAskNotes(({ [id]: _gone, ...rest }) => rest);
		setTabsNotice(null);
	}, [commitTabs]);
	// A tab's text is kept nowhere else (Query 1's draft aside), so closing one that was edited asks first.
	const close = useCallback((id: string) => {
		const text = texts.current.get(id) ?? '';
		const edited = id !== FIRST_QUERY_TAB && text.trim() !== '' && text !== (opening.current.get(id) ?? '');
		if (edited) setClosing(id);
		else closeNow(id);
	}, [closeNow]);
	const newQuery = useCallback(() => {
		deliver({ kind: 'new', origin: 'query', text: '', run: false });
	}, [deliver]);
	const openText = useCallback((origin: QueryTabOrigin, title: string, cypher: string): void => {
		if (deliver({ kind: 'new', origin, title: clipTitle(title), text: cypher, run: false })) announcer.announce(`${clipTitle(title)} opened in a new tab. It has not been run.`);
	}, [deliver]);
	// The graph's and the Overview's "New query": with no text, an empty tab like + New query.
	const openNewQuery = useCallback((cypher: string, title: string) => (cypher.trim() === '' ? newQuery() : openText('graph', title, cypher)), [newQuery, openText]);

	// The 25-row statement of a label or type, in a tab of its own: run for a preview, not run for "New query"
	// (graph/previews.ts previewStatement says which, for every kind of request).
	const openPreview = useCallback((request: Pick<IGraphPreview, 'action' | 'name'>) => {
		const current = dialectNow.current;
		if (!current) {
			announcer.announce('This connection cannot be browsed now, so the preview was not run.');
			return;
		}
		const engine = { dialect: current.dialect, version: current.engineVersion, shortestPath: current.capabilities.shortest_path === true };
		const { recipe, run } = previewStatement(engine, request);
		const name = request.name;
		const title = run ? previewTitle(name) : `${clipTitle(name)} (new query)`;
		if (isRefusal(recipe)) {
			announcer.announce(recipe.refusal);
			deliver({ kind: 'new', origin: 'preview', title, text: `// ${recipe.refusal}`, run: false });
			return;
		}
		deliver({ kind: 'new', origin: 'preview', title, text: recipe.cypher, run });
	}, [deliver]);

	// Explore: show the Explore tab while it still holds the sample, or open one and run the sample (one click, safe on
	// every engine). An Explore tab whose text was edited is left as it is.
	const explore = useCallback(() => {
		const existing = tabsNow.current.tabs.find((tab) => tab.origin === 'explore' && (texts.current.get(tab.id) ?? EXPLORE_CYPHER) === EXPLORE_CYPHER);
		if (existing) {
			activate(existing.id);
			return;
		}
		deliver({ kind: 'new', origin: 'explore', title: 'Explore', text: EXPLORE_CYPHER, run: true });
	}, [activate, deliver]);
	const refreshSchema = useCallback(() => {
		announcer.announce('Reading the schema again.');
		void env.loadSchema(endpoint.key, { fresh: true });
	}, [env, endpoint.key]);

	// ── Ask (shown on demand from a tab's run bar; its draft opens a new tab) ──
	const [askOpen, setAskOpen] = useState(false);
	// Which Ask tab shows what the text check found.
	const [askCheckOpen, setAskCheckOpen] = useState<string | null>(null);
	const [askFocus, setAskFocus] = useState(0);
	const askFrom = useRef<string | null>(null);
	const toggleAsk = useCallback(() => {
		if (!askOpen) setAskFocus((n) => n + 1);
		setAskOpen(!askOpen);
	}, [askOpen]);
	// An answer can come long after the question. It is dropped when the tab it was asked from is gone, and it opens
	// behind the tab shown unless that is still the tab it was asked from.
	const onDraft = useCallback((cypher: string, question: string): boolean => {
		const from = askFrom.current;
		if (from !== null && !tabsNow.current.tabs.some((tab) => tab.id === from)) {
			announcer.announce('The draft from Ask was dropped: the tab it was asked from is closed.');
			return true;
		}
		const shown = from === null || tabsNow.current.active === from;
		const title = askTitle(question);
		const id = deliver({ kind: 'new', origin: 'ask', title, text: cypher, run: false, ask: { question, from: from ?? '' }, activate: shown });
		if (id === null) return false;
		setAskNotes((current) => ({ ...current, [id]: { text: askDraftText(question), check: askCheckText(patternCheck(cypher)) } }));
		announcer.announce(shown ? 'The draft from Ask opened in a new tab. It has not been run.' : `The draft from Ask opened in a new tab, ${title}, behind the one shown. It has not been run.`);
		return true;
	}, [deliver]);

	// ── History and Saved (one inline side panel) ────────────────────────────
	const [side, setSide] = useState<SideView | null>(null);
	const toggleSide = useCallback((which: SideView) => setSide((current) => (current === which ? null : which)), []);
	const currentQuery = useCallback(() => {
		const id = tabsNow.current.lastQuery;
		const tab = tabsNow.current.tabs.find((t) => t.id === id);
		return tab ? { title: tab.title, text: texts.current.get(tab.id) ?? '' } : null;
	}, []);

	// No probe yet (opened from a stale link or right after a refresh): ask the node who it is.
	useEffect(() => {
		if (env.ready && !probe && endpoint.state === 'ready') void env.probe(endpoint.key);
	}, [env, probe, endpoint.key, endpoint.state]);

	// A click on a label or relationship type in the sidebar: the 25-row preview, in a new tab, run. The request is TAKEN
	// (by nonce) only when it can be acted on; while the connection is still being checked it waits.
	const pending = usePendingPreview();
	useEffect(() => {
		const request = previewFor(pending, endpoint.key, NONE_TAKEN, Date.now());
		if (!request) return;
		const waiting = !dialect && !probe && (endpoint.state === 'ready' || endpoint.state === 'probing');
		if (waiting) return;
		if (!env.previews.consume(request.nonce)) return;
		openPreview(request);
	}, [pending, env, endpoint.key, endpoint.state, dialect, probe, openPreview]);

	const openWrite = (): void => {
		env.openDocument({ kind: 'write', endpoint });
	};
	const subtitle = dialect ? [engineText(dialect), targetText(dialect)].filter(Boolean).join(' · ') : view.address;
	const failed = endpoint.state === 'unreachable' || endpoint.state === 'inaccessible';

	return (
		<div style={fullScreen ? shared.documentRootCovered : shared.documentRoot}>
			<ContentHeader
				title={view.title}
				subtitle={subtitle}
				actions={
					inFrame || writable ? (
						<>
							{inFrame && (
								<Button variant="ghost" onClick={() => panel('toggle')} ariaExpanded={details.open} title="What the node reports about itself, and Test connection.">
									Details
								</Button>
							)}
							{writable && (
								<Button variant="ghost" onClick={openWrite} title="Open the console that can change data. It asks before it sends a statement that looks like a write.">
									Write console
								</Button>
							)}
						</>
					) : undefined
				}
			/>
			{inFrame && details.open && (
				<ConnectionDetailsPanel
					key={endpoint.key}
					endpoint={endpoint}
					probe={probe}
					testRequest={details.testRequest}
					onTest={(target) => (env.ready ? env.probe(target.key) : Promise.resolve(null))}
					onClose={() => panel('close')}
				/>
			)}
			{gate.mounted ? (
				<>
					<div style={styles.tabRow}>
						<QueryTabs
							tabs={[{ id: OVERVIEW_TAB, title: 'Overview', closable: false }, ...tabs.tabs.map((tab) => ({ id: tab.id, title: tab.title, closable: true }))]}
							active={tabs.active}
							idPrefix={idPrefix}
							onActivate={activate}
							onClose={close}
							onNew={newQuery}
							focusRequest={focusTabs}
						/>
					</div>
					<div style={styles.controlRow}>
						<div ref={setBarHost} style={tabs.active === OVERVIEW_TAB ? styles.hidden : styles.barHost} />
						{tabs.active === OVERVIEW_TAB && (
							<div style={styles.overviewActions}>
								<Button variant="primary" onClick={explore} title="Open the Explore tab and run a sample of 25 relationships with their end nodes">
									Explore
								</Button>
								<Button variant="ghost" onClick={newQuery}>
									New query
								</Button>
								<Button variant="ghost" onClick={refreshSchema} title="Read this connection's schema again">
									Refresh schema
								</Button>
							</div>
						)}
					</div>
					{tabsNotice && (
						<div style={styles.notice}>
							<Banner variant="warning">{tabsNotice}</Banner>
						</div>
					)}
					<div style={askOpen ? undefined : styles.hidden}>
						<AskBar
							endpoint={endpoint}
							focusSeq={askFocus}
							onAsked={() => { askFrom.current = tabsNow.current.lastQuery; }}
							onDraft={onDraft}
							gate={requests}
							onClose={() => {
								setAskOpen(false);
								// The focus was in the bar: give it to the Ask button that showed it, in the control row.
								barHost?.querySelector<HTMLElement>('[data-ask-toggle] button')?.focus();
							}}
						/>
					</div>
					<div style={styles.body}>
						<div style={styles.panes}>
							<div role="tabpanel" id={panelElementId(idPrefix, OVERVIEW_TAB)} aria-labelledby={tabElementId(idPrefix, OVERVIEW_TAB)} style={tabs.active === OVERVIEW_TAB ? styles.overview : styles.hidden}>
								<div style={styles.overviewBody}>
									<OverviewPanel endpoint={endpoint} dialect={dialect} onPreview={(kind, name) => openPreview({ action: kind === 'type' ? 'type-preview' : 'label-preview', name })} onNewQuery={openNewQuery} onExplore={explore} onRefreshSchema={refreshSchema} />
								</div>
							</div>
							{tabs.tabs.map((tab) => {
								const shown = tab.id === tabs.active;
								const note = askNotes[tab.id];
								const from = tab.ask ? tabs.tabs.find((t) => t.id === tab.ask?.from) ?? null : null;
								return (
									<div key={tab.id} role="tabpanel" id={panelElementId(idPrefix, tab.id)} aria-labelledby={tabElementId(idPrefix, tab.id)} style={shown ? styles.pane : styles.hidden}>
										{note !== undefined && (
											<div style={styles.notice}>
												<Banner variant="info">
													<strong>{ASK_DRAFT_HEADLINE}</strong> {note.text}
													<div style={styles.askNote}>{from ? askKeptText(from.title) : 'Ask always opens a new tab, so no other tab changed.'}</div>
													{note.check !== null && askCheckOpen === tab.id && <div style={styles.askNote}>{note.check}</div>}
													<div style={styles.askActions}>
														{note.check !== null && (
															<>
																{/* Visible without opening Details: the text check flagged this draft. */}
																<StatusBadge variant="warning">Check before running</StatusBadge>
																<Button variant="ghost" small ariaExpanded={askCheckOpen === tab.id} onClick={() => setAskCheckOpen(askCheckOpen === tab.id ? null : tab.id)}>
																	{askCheckOpen === tab.id ? 'Hide details' : 'Details'}
																</Button>
															</>
														)}
														{from && (
															<Button variant="ghost" small onClick={() => activate(from.id)}>
																{`Back to ${from.title}`}
															</Button>
														)}
														<Button variant="ghost" small onClick={() => setAskNotes(({ [tab.id]: _gone, ...rest }) => rest)}>
															Dismiss
														</Button>
													</div>
												</Banner>
											</div>
										)}
										<div style={styles.surface}>
											<RunSurface
												endpoint={endpoint}
												mode="read"
												paused={gate.paused}
												loadSlot={slotOf(tab.id)}
												loadSeq={seqs[tab.id] ?? 0}
												tabId={tab.id}
												draftKey={tab.id === FIRST_QUERY_TAB ? undefined : null}
												defaultText={tab.id === FIRST_QUERY_TAB ? undefined : ''}
												active={shown}
												onTextChange={(text) => texts.current.set(tab.id, text)}
												onOpenHistory={() => toggleSide('history')}
												historyOpen={side === 'history'}
												onOpenSaved={() => toggleSide('saved')}
												savedOpen={side === 'saved'}
												onAsk={toggleAsk}
												askOpen={askOpen}
												onNewQuery={openNewQuery}
												barHost={barHost}
												gate={requests}
												onFullScreen={setFullScreen}
											/>
										</div>
									</div>
								);
							})}
						</div>
						{side && (
							<SidePanel
								title={side === 'history' ? 'History' : 'Saved queries'}
								subtitle={view.title}
								switcher={
									// The shell's ToggleGroup drops aria-label, so the group's name is on a wrapper.
									<span role="group" aria-label="Show history or saved queries">
										<ToggleGroup options={SIDE_OPTIONS} value={side} onChange={(id) => setSide(id)} />
									</span>
								}
								onClose={() => setSide(null)}
							>
								{side === 'history' ? (
									<HistoryPanel
										endpointKey={endpoint.key}
										nodeName={view.title}
										onLoad={(cypher) => {
											if (deliver({ kind: 'replace', text: cypher })) announcer.announce('The statement is in the editor. It has not been run.');
										}}
										onRerun={(cypher) => {
											deliver({ kind: 'new', origin: 'history', title: historyTitle(cypher), text: cypher, run: true });
										}}
										onOpenInNewTab={(cypher) => openText('history', historyTitle(cypher), cypher)}
										announce={(text) => announcer.announce(text)}
									/>
								) : (
									<SavedQueriesPanel
										endpointKey={endpoint.key}
										nodeName={view.title}
										schema={schema}
										dialect={dialect?.dialect ?? null}
										current={currentQuery}
										onOpen={(name, cypher, origin) => openText(origin, name, cypher)}
										onInsert={(cypher) => {
											if (deliver({ kind: 'insert', text: cypher })) announcer.announce('Inserted in the editor at the caret. It has not been run.');
										}}
										announce={(text) => announcer.announce(text)}
									/>
								)}
							</SidePanel>
						)}
					</div>
					{closing !== null && (
						<ConfirmDialog
							title={`Close ${tabs.tabs.find((tab) => tab.id === closing)?.title ?? 'this tab'}?`}
							message="Its text is not kept anywhere else. History keeps only the statements that were run."
							confirmLabel="Close tab"
							destructive
							onConfirm={() => {
								const id = closing;
								setClosing(null);
								closeNow(id);
								setFocusTabs((n) => n + 1);
							}}
							onCancel={() => {
								setClosing(null);
								setFocusTabs((n) => n + 1);
							}}
						/>
					)}
				</>
			) : (
				<>
					{failed && view.blocked && (
						<div style={styles.notice}>
							<Banner variant="error">{view.blocked}</Banner>
						</div>
					)}
					<EmptyState
						icon={<GraphIcon />}
						title={endpoint.state === 'ready' ? 'This connection cannot be browsed yet' : 'This connection is not available'}
						description={failed ? 'Nothing can be browsed until the node answers.' : (view.blocked ?? 'The connection has not answered yet.')}
						action={
							inFrame ? (
								<Button variant="primary" onClick={() => panel('test')}>
									Test connection
								</Button>
							) : (
								<Button variant="primary" onClick={() => env.openDocument({ kind: 'connections' })}>
									Open Connections
								</Button>
							)
						}
					/>
				</>
			)}
		</div>
	);
};

export default WorkbenchView;
