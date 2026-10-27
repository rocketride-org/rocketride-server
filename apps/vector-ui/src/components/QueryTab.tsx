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
// VECTOR-UI - THE QUERY TAB (Search, Compare and Ask over a connection)
// =============================================================================
//
// Three modes on a tab row of their own (Search, Compare, Ask), with "New
// query" and "History (N)" at its end; the row never moves when a run starts
// or its results land. The mode is the connection's (`entry.queryMode`), so "Ask about
// these" anywhere opens Ask, and every mode stays mounted while another is
// shown: Search and Compare are one SearchPanel (question A, the mode, k, the
// threshold and the last run carry over), Ask is the ChatPanel. Where the
// chat cannot ask (no Chat source, a dev-tool mount), Ask says why and offers
// "Use Search".
//
// Every finished run is recorded in the mount's Query history
// (`env.queryHistory`: the workspace preferences in the full app, the
// document's life in a dev-tool mount), shown in the History aside docked
// beside the modes: Load fills the form, Rerun runs an entry again with its
// mode and k and the threshold, scope and table filter chosen now
// (vector/queryHistory.ts).
//
// Questions come in two ways, each taken once: through the connection
// (`entry.queryPrefill`: "Use as query", "New query"), which this tab clears
// as it takes it, so a tab mounted later still gets it and a remount does not
// take it again; and from inside the tab ("Open in Search" from an answer,
// History's Load and Rerun).
//
// The focus never falls to <body>: when a mode change hides the focused
// control (a result's "ask about this", "Open in Search", "Use Search"), it
// moves to the shown mode's first control (vector/queryFocus.ts).
//
// A result's document name asks the Documents tab to show it in its drawer
// (`entry.openDocument`, taken once by its nonce); "open" still opens the
// document's own tab at the chunk.
//
// QueryTab binds the connection's stores; QueryWorkbench is the tab itself,
// with everything it needs as props.
// =============================================================================

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { useReadable, useValueStore, useVectorEnv } from '../envContext';
import type { IQueryHistorySource } from '../env';
import type { ConsoleActions, ConsoleModel, SelectionStore, VectorChannels } from '../contract/types';
import { styles as appStyles } from '../styles';
import { QUERY_MODES, QUERY_MODE_LABELS, needsFocusRescue, nextQueryTab, primaryTarget } from '../vector/queryFocus';
import type { ActiveFocus, QueryFocusTarget } from '../vector/queryFocus';
import { modeOptions, takePrefill } from '../vector/searchWorkbench';
import type { AskHandoff, ChatPrefill, SearchHandoff } from '../vector/searchWorkbench';
import { loadPlan, rerunPlan } from '../vector/queryHistory';
import type { QueryHistoryItem, QueryRunRecord } from '../vector/queryHistory';
import type { IQueryPrefill, QueryMode } from '../vector/workbench';
import ChatPanel from './ChatPanel';
import HistoryAside from './HistoryAside';
import SearchPanel from './SearchPanel';
import type { IQueryTabProps } from './workbenchProps';

const styles = {
	root: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--rr-text-primary)' } as CSSProperties,
	bar: { flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	tabs: { display: 'flex', gap: 2 } as CSSProperties,
	tab: { background: 'none', border: 'none', borderBottom: '2px solid transparent', padding: '4px 12px', fontSize: 13, color: 'var(--rr-text-primary)', cursor: 'pointer', fontFamily: 'inherit' } as CSSProperties,
	selected: { borderBottom: '2px solid var(--rr-border-focus)', fontWeight: 600 } as CSSProperties,
	barEnd: { display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	toggle: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11, minWidth: '8.5em' } as CSSProperties,
	body: { flex: 1, minHeight: 0, display: 'flex', flexWrap: 'wrap', gap: 12 } as CSSProperties,
	main: { flex: '999 1 520px', minWidth: 0, minHeight: 0, height: '100%', overflowY: 'auto' } as CSSProperties,
	ask: { height: '100%', display: 'flex', flexDirection: 'column' } as CSSProperties,
	notice: { ...appStyles.small, margin: '0 0 6px' } as CSSProperties,
};

/** Props for the {@link QueryWorkbench} component. */
export interface IQueryWorkbenchProps {
	/** The console's model (whether the chat can ask). */
	model: ConsoleModel;
	/** The model with the scope as it applies to search and the chat. */
	surfaceModel: ConsoleModel;
	channels: VectorChannels;
	selection: SelectionStore;
	actions: ConsoleActions;
	/** The mode shown. */
	mode: QueryMode;
	onMode(mode: QueryMode): void;
	/** A question handed in through the connection, or null. */
	prefill: IQueryPrefill | null;
	/** The prefill was taken (the connection forgets it). */
	onPrefillTaken(): void;
	/** The documents the next chat question is restricted to, or null. */
	chatDocuments: readonly string[] | null;
	/** Why the chat's question goes to every document while a scope is on, or null. */
	chatNotice: string | null;
	onClearChatScope(): void;
	/** True while the tab is the one shown and its document is in front. */
	visible: boolean;
	/** The mount's Query history. */
	history: IQueryHistorySource;
	/** The connection's key in it. */
	historyKey: string;
	/** Show a document in the Documents tab's drawer (a result's name). Absent: names are plain text. */
	onShowDocument?(objectId: string): void;
}

/**
 * Where the page's focus is, against the tab.
 *
 * @returns 'body', 'hidden' (on a control with no layout box) or 'shown'.
 */
function activeFocus(): ActiveFocus {
	const active = document.activeElement;
	if (active === null || active === document.body) return 'body';
	return active.getClientRects().length === 0 ? 'hidden' : 'shown';
}

/**
 * Move the focus to one of the tab's controls (each is marked `data-query-focus`).
 *
 * @param root - The tab.
 * @param target - The control.
 */
function focusIn(root: HTMLElement | null, target: QueryFocusTarget): void {
	root?.querySelector<HTMLElement>(`[data-query-focus="${target}"]`)?.focus();
}

/**
 * The Query tab: the tab row, Search and Compare (one panel), Ask.
 *
 * @param props - {@link IQueryWorkbenchProps}.
 * @returns The tab.
 */
export function QueryWorkbench({ model, surfaceModel, channels, selection, actions, mode, onMode, prefill, onPrefillTaken, chatDocuments, chatNotice, onClearChatScope, visible, history, historyKey, onShowDocument }: IQueryWorkbenchProps): React.ReactElement {
	const root = useRef<HTMLDivElement>(null);
	const tabRefs = useRef<Partial<Record<QueryMode, HTMLButtonElement | null>>>({});
	const ids = useId();
	const [search, setSearch] = useState<SearchHandoff | null>(null);
	const [ask, setAsk] = useState<AskHandoff | null>(null);
	const [focusNext, setFocusNext] = useState<QueryFocusTarget | null>(null);
	const sequence = useRef(0);
	const searchId = `${ids}-search`;
	const askId = `${ids}-ask`;
	const asideId = `${ids}-history`;
	const options = modeOptions(surfaceModel);
	const asking = { chatAvailable: surfaceModel.chat.enabled && channels.chat !== null, searchable: options.some((option) => option.enabled) };
	const entries = useReadable(useMemo(() => history.entries(historyKey), [history, historyKey])) as readonly QueryHistoryItem[];
	const recording = useReadable(useMemo(() => history.recording(historyKey), [history, historyKey]));
	const [historyOpen, setHistoryOpen] = useState(false);

	/**
	 * A nonce for a handoff made here.
	 *
	 * @returns A new nonce.
	 */
	const nonce = (): string => `query-${(sequence.current += 1)}`;

	// A question handed in through the connection: taken once, then cleared, so a later mount or a remount does not take it again.
	useEffect(() => {
		if (prefill === null) return;
		const taken = takePrefill(prefill, mode);
		onMode(taken.mode);
		if (taken.search !== null) setSearch(taken.search);
		if (taken.ask !== null) setAsk(taken.ask);
		onPrefillTaken();
		setFocusNext(primaryTarget(taken.mode, asking));
		// Taken once per prefill; the tab's other state does not restart it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [prefill]);

	// A requested focus waits until the tab is shown.
	useEffect(() => {
		if (focusNext === null || !visible) return;
		focusIn(root.current, focusNext);
		setFocusNext(null);
	}, [focusNext, visible, mode]);

	// A mode change that hid the focused control (or left the focus nowhere) moves it to the shown mode's first control.
	useEffect(() => {
		if (!visible || typeof document === 'undefined') return;
		if (needsFocusRescue(activeFocus())) focusIn(root.current, primaryTarget(mode, asking));
		// On a change of mode or of visibility only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, visible]);

	/**
	 * "Open in Search" from an answer: Search runs the search "Why these?" made, with the answer's cited chunks marked.
	 *
	 * @param brought - The question, its cited chunks, and the k and documents "Why these?" searched.
	 */
	const openInSearch = (brought: ChatPrefill): void => {
		setSearch({ nonce: nonce(), question: brought.question, run: true, chat: brought });
		onMode('search');
	};

	/**
	 * Record a finished run in the mount's history (nothing while recording is off).
	 *
	 * @param run - The run.
	 */
	const record = (run: QueryRunRecord): void => history.record(historyKey, run);

	/**
	 * What Rerun would do with an entry now, or why it cannot.
	 *
	 * @param entry - The entry.
	 * @param handoffNonce - The nonce its handoff gets.
	 * @returns The plan.
	 */
	const rerunOf = (entry: QueryHistoryItem, handoffNonce: string): ReturnType<typeof rerunPlan> => rerunPlan(entry, { options, chat: { enabled: asking.chatAvailable, reason: surfaceModel.chat.reason }, nonce: handoffNonce });

	/**
	 * Load: the entry back in the form (or Ask's box), nothing run; the focus goes to that box.
	 *
	 * @param entry - The entry.
	 */
	const load = (entry: QueryHistoryItem): void => {
		const plan = loadPlan(entry, nonce());
		onMode(plan.mode);
		if (plan.search !== null) setSearch(plan.search);
		if (plan.ask !== null) setAsk(plan.ask);
		setFocusNext(primaryTarget(plan.mode, asking));
		if (plan.notes.length > 0) actions.announce(plan.notes.join(' '));
	};

	/**
	 * Rerun: the entry's mode and k, with the threshold, scope and table filter chosen now (the focus stays on Rerun).
	 *
	 * @param entry - The entry.
	 */
	const rerun = (entry: QueryHistoryItem): void => {
		const plan = rerunOf(entry, nonce());
		if (!plan.ok) return;
		onMode(plan.mode);
		if (plan.search !== null) setSearch(plan.search);
		if (plan.ask !== null) setAsk(plan.ask);
	};

	/** "New query": an empty Search form (the last run stays in History). */
	const newQuery = (): void => {
		setSearch({ nonce: nonce(), question: '', run: false, chat: null, clear: true });
		onMode('search');
		setFocusNext('question');
	};

	/**
	 * The tab row's keys: Left/Right move (and show) the next mode, Home/End the first and last.
	 *
	 * @param event - The key event on a tab.
	 */
	const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
		const next = nextQueryTab(mode, event.key);
		if (next === null) return;
		event.preventDefault();
		onMode(next);
		tabRefs.current[next]?.focus();
	};

	return (
		<div ref={root} style={styles.root} data-component="QueryTab">
			<div style={styles.bar} data-query-bar="">
				<div role="tablist" aria-label="Query" style={styles.tabs}>
					{QUERY_MODES.map((id) => (
						<button
							key={id}
							ref={(element) => {
								tabRefs.current[id] = element;
							}}
							type="button"
							role="tab"
							id={`${ids}-tab-${id}`}
							aria-selected={mode === id}
							aria-controls={id === 'ask' ? askId : searchId}
							tabIndex={mode === id ? 0 : -1}
							data-query-focus={mode === id ? 'tab' : undefined}
							style={mode === id ? { ...styles.tab, ...styles.selected } : styles.tab}
							onClick={() => onMode(id)}
							onKeyDown={onTabKey}
						>
							{QUERY_MODE_LABELS[id]}
						</button>
					))}
				</div>
				<div style={styles.barEnd}>
					<button type="button" style={styles.button} title="Empty the Search form; the last run stays in History" onClick={newQuery}>
						New query
					</button>
					<button type="button" style={styles.toggle} aria-expanded={historyOpen} aria-controls={asideId} data-query-focus="history-toggle" onClick={() => setHistoryOpen((open) => !open)}>
						{`History (${entries.length})`}
					</button>
				</div>
			</div>
			<div style={styles.body}>
				<div style={styles.main}>
					<div id={searchId} role="tabpanel" aria-labelledby={`${ids}-tab-${mode === 'compare' ? 'compare' : 'search'}`} hidden={mode === 'ask'} data-surface="search">
						<SearchPanel key={surfaceModel.connectionKey} model={surfaceModel} channels={channels} selection={selection} actions={actions} comparing={mode === 'compare'} handoff={search} onRecord={record} onShowDocument={onShowDocument} />
					</div>
					<div id={askId} role="tabpanel" aria-labelledby={`${ids}-tab-ask`} hidden={mode !== 'ask'} data-surface="ask" style={mode === 'ask' ? styles.ask : undefined}>
						{model.chat.enabled && chatNotice !== null && (
							<p role="status" data-chat-scope-notice="" style={styles.notice}>
								{chatNotice}
							</p>
						)}
						<ChatPanel model={surfaceModel} channels={channels} selection={selection} actions={actions} scope={chatDocuments} onClearScope={onClearChatScope} onOpenInSearch={openInSearch} onUseSearch={() => onMode('search')} handoff={ask} onRecord={record} />
					</div>
				</div>
				{historyOpen && (
					<HistoryAside
						id={asideId}
						entries={entries}
						recording={recording}
						onRecording={(on) => history.setRecording(historyKey, on)}
						note={history.note}
						now={Date.now()}
						rerunOf={(entry) => rerunOf(entry, 'preview')}
						onLoad={load}
						onRerun={rerun}
						onPin={(id) => history.togglePin(historyKey, id)}
						onNote={(id, text) => history.setNote(historyKey, id, text)}
						onRemove={(id) => history.remove(historyKey, id)}
						onClear={() => history.clear(historyKey)}
						onClose={() => {
							setHistoryOpen(false);
							setFocusNext('history-toggle');
						}}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * The Query tab of a connection's workbench.
 *
 * @param props - {@link IQueryTabProps}.
 * @returns The tab's panel.
 */
export function QueryTab({ entry, model, channels, actions, visible, surfaceModel, chatDocuments, chatNotice, onClearChatScope }: IQueryTabProps): React.ReactElement {
	const env = useVectorEnv();
	const mode = useValueStore(entry.queryMode);
	const prefill = useValueStore(entry.queryPrefill);
	const requests = useRef(0);
	return (
		<QueryWorkbench
			model={model}
			surfaceModel={surfaceModel}
			channels={channels}
			selection={entry.selection}
			actions={actions}
			mode={mode}
			onMode={(next) => entry.queryMode.set(next)}
			prefill={prefill}
			onPrefillTaken={() => entry.queryPrefill.set(null)}
			chatDocuments={chatDocuments}
			chatNotice={chatNotice}
			onClearChatScope={onClearChatScope}
			visible={visible}
			history={env.queryHistory}
			historyKey={entry.key}
			onShowDocument={(objectId) => {
				// The Documents tab opens its drawer on it and clears the request (taken once, by its nonce).
				requests.current += 1;
				entry.openDocument.set({ nonce: `query-${requests.current}`, objectId });
				actions.openTab?.('documents');
			}}
		/>
	);
}

export default QueryTab;
