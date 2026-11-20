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
// GRAPH-UI - GRAPH VIEW (toolbar, notices, legend, captions, and the lazy canvas)
// =============================================================================
//
// The canvas (React Flow, d3-force worker) is a separate chunk: it loads when the
// Graph tab is first shown, so the editor, the Table, the Raw view and the history
// open without it. If the chunk cannot load (offline, blocked), the view says so
// and points at the Table, which holds every returned row.
//
// Every canvas action is also a BUTTON here, not only a key or a double click:
// expand, collapse, dismiss, connect, find path and inspect all work from the
// toolbar on the focused (and, for paths, the two selected) nodes.
// =============================================================================

import React, { Component, Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Banner, Button, EmptyState, Modal } from 'shell';
import { assignLabelColors } from '../graph/colors';
import type { ILabelColor } from '../graph/colors';
import { captionChoices, captionOf } from '../graph/captions';
import type { IGraphSession, IGraphState } from '../graph/graphSession';
import { DATA_CHANGED_TEXT } from '../graph/identity';
import { KEY_HELP } from '../graph/keynav';
import { legendOf } from '../graph/legend';
import { GRID_NOTICE, STOP_WAITING_NOTE, canvasBudgetText } from '../graph/wording';
import type { LayoutStatus } from '../canvas/useGraphLayout';
import { GraphIcon } from '../icons';

// The canvas is imported for its TYPES only above; the value comes through the lazy boundary.
const GraphCanvas = lazy(() => import('../canvas/GraphCanvas'));

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as CSSProperties,
	toolbar: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	focused: { fontSize: 12, color: 'var(--rr-text-secondary)', marginRight: 6, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	// Notices float over the top of the canvas: one that appears or goes must never resize it (and shift the graph).
	notices: { position: 'absolute', top: 6, left: 10, right: 10, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none' } as CSSProperties,
	notice: { pointerEvents: 'auto', background: 'var(--rr-bg-paper)', borderRadius: 6 } as CSSProperties,
	canvas: { flex: 1, minHeight: 0, position: 'relative' } as CSSProperties,
	legend: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '6px 10px', borderTop: '1px solid var(--rr-border)', fontSize: 12, maxHeight: 76, overflowY: 'auto' } as CSSProperties,
	swatch: (fill: string): CSSProperties => ({ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: fill, border: '1px solid var(--rr-text-primary)', marginRight: 6, verticalAlign: 'middle' }),
	select: { fontSize: 12, padding: '2px 4px', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border-input)', borderRadius: 4 } as CSSProperties,
};

// =============================================================================
// ERROR BOUNDARY (the canvas chunk may fail to load)
// =============================================================================

/** Catches a failed canvas chunk or a canvas crash and offers the Table instead. */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
	state = { failed: null as string | null };
	static getDerivedStateFromError(error: unknown): { failed: string } {
		return { failed: error instanceof Error ? error.message : String(error) };
	}
	render(): ReactNode {
		if (this.state.failed === null) return this.props.children;
		return (
			<EmptyState
				icon={<GraphIcon />}
				title="The graph view could not load"
				description={`${this.state.failed}. The Table tab lists every returned row, and the query editor is unaffected.`}
				action={<Button variant="primary" onClick={() => this.setState({ failed: null })}>Try again</Button>}
			/>
		);
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Props. */
export interface IGraphViewProps {
	session: IGraphSession;
	/** Every label of the connection (from its schema), so colours stay stable between queries. */
	schemaLabels: readonly string[];
	/** Caption choice per label, owned by the workbench (persisted per connection). */
	captions: ReadonlyMap<string, string>;
	onCaption(label: string, choice: string): void;
	/** Open the inspector for a node. */
	onInspect(id: string): void;
	/** Text identifying this result, for the layout seed. */
	seedKey: string;
	announce(text: string): void;
}

/**
 * The graph view.
 *
 * @param props - See {@link IGraphViewProps}.
 * @returns The view.
 */
export const GraphView: React.FC<IGraphViewProps> = ({ session, schemaLabels, captions, onCaption, onInspect, seedKey, announce }) => {
	const state: IGraphState = useSyncExternalStore(session.subscribe, session.getState, session.getState);
	const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>({ state: 'idle' });
	const [helpOpen, setHelpOpen] = useState(false);
	// An informational notice floats over the canvas, so it leaves by itself; a warning or an error stays until the next action.
	const [expiredNotice, setExpiredNotice] = useState<unknown>(null);
	useEffect(() => {
		if (!state.notice || state.notice.variant !== 'info') return undefined;
		const notice = state.notice;
		const timer = window.setTimeout(() => setExpiredNotice(notice), 6000);
		return () => window.clearTimeout(timer);
	}, [state.notice]);

	const colors = useMemo<ReadonlyMap<string, ILabelColor>>(() => {
		const labels = new Set(schemaLabels);
		for (const node of state.model.nodes.values()) for (const l of node.labels.slice(0, 1)) labels.add(l);
		return assignLabelColors(labels);
	}, [schemaLabels, state.model.nodes]);
	const legend = useMemo(() => legendOf(state.model, colors), [state.model, colors]);
	const budget = canvasBudgetText(state.model);
	const focused = state.focusedId !== null ? state.model.nodes.get(state.focusedId) : undefined;
	const focusedCaption = focused ? captionOf(focused, captions.get(focused.labels[0] ?? '')) : null;
	const busy = state.busy !== null;
	const hasMore = state.model.hiddenNodes > 0 && state.model.nodes.size < 1000;
	// Out of date: a write ran after the drawing, or this element came back as a different one. Nothing is fetched for it.
	const focusedStale = state.stale || (focused !== undefined && state.staleIds.has(focused.id));

	if (state.model.nodes.size === 0) {
		return <EmptyState icon={<GraphIcon />} title="Nothing to draw" description="This result has no nodes. The Table tab lists every returned row." />;
	}

	return (
		<div style={styles.root}>
			<div style={styles.toolbar} role="toolbar" aria-label="Graph actions">
				<span style={styles.focused} title={focusedCaption ?? ''}>{focusedCaption ? `Focused: ${focusedCaption}` : 'No node focused'}</span>
				<Button variant="ghost" small disabled={!focused || busy || focusedStale} title="Fetch up to 100 new neighbours (E)" onClick={() => focused && void session.expand(focused.id)}>Expand</Button>
				<Button variant="ghost" small disabled={!focused} title="Remove what hangs only from this node (C)" onClick={() => focused && session.collapse(focused.id)}>Collapse</Button>
				<Button variant="ghost" small disabled={!focused} title="Remove this node from the canvas (Delete or Backspace)" onClick={() => focused && session.dismiss(focused.id)}>Dismiss</Button>
				<Button variant="ghost" small disabled={!focused} title="Open the inspector (Enter)" onClick={() => focused && onInspect(focused.id)}>Inspect</Button>
				<Button variant="ghost" small disabled={busy || state.stale || state.model.nodes.size < 2} title="Draw the relationships among the nodes on the canvas" onClick={() => void session.connect()}>Connect nodes</Button>
				<Button variant="ghost" small disabled={busy || state.stale || state.selected.size !== 2} title="Select two nodes with Space, then find a path (P)" onClick={() => void session.findPath()}>Find path</Button>
				{busy && <Button variant="ghost" small title={STOP_WAITING_NOTE} onClick={() => session.stopWaiting()}>Stop waiting</Button>}
				{hasMore && <Button variant="ghost" small onClick={() => session.showMore()}>Show more nodes</Button>}
				<Button variant="ghost" small ariaExpanded={helpOpen} onClick={() => setHelpOpen(true)}>Keys</Button>
				{state.progress && <span style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }} role="status">{state.progress}</span>}
				{state.selected.size > 0 && <Button variant="ghost" small onClick={() => session.clearSelection()}>{`Clear selection (${state.selected.size})`}</Button>}
			</div>

			<div style={styles.canvas}>
				<div style={styles.notices}>
					{state.stale && (
						<div style={styles.notice}>
							<Banner variant="warning">{DATA_CHANGED_TEXT}</Banner>
						</div>
					)}
					{state.notice && state.notice !== expiredNotice && (
						<div style={styles.notice}>
							<Banner variant={state.notice.variant === 'info' ? 'info' : state.notice.variant}>
								<div>{state.notice.text}</div>
								{state.notice.detail && <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{state.notice.detail}</div>}
							</Banner>
						</div>
					)}
					{budget && (
						<div style={styles.notice}>
							<Banner variant="info">{budget}</Banner>
						</div>
					)}
					{layoutStatus.state === 'fallback' && (
						<div style={styles.notice}>
							<Banner variant="warning">{`${GRID_NOTICE} (${layoutStatus.detail})`}</Banner>
						</div>
					)}
					{layoutStatus.state === 'ready' && layoutStatus.timedOut && (
						<div style={styles.notice}>
							<Banner variant="info">The layout stopped early to stay responsive; the positions are usable and you can drag nodes.</Banner>
						</div>
					)}
				</div>
				<CanvasBoundary>
					<Suspense fallback={<EmptyState icon={<GraphIcon />} title="Loading the graph view" description="The canvas loads on first use." />}>
						<GraphCanvas
							model={state.model}
							colors={colors}
							captions={captions}
							selected={state.selected}
							focusedId={state.focusedId}
							staleIds={state.staleIds}
							staleRelationshipIds={state.staleRelationshipIds}
							allStale={state.stale}
							seedKey={seedKey}
							expandHint={state.hint}
							highlighted={state.highlight}
							onFocus={(id) => session.focus(id)}
							onInspect={onInspect}
							onToggleSelect={(id) => session.toggleSelect(id)}
							onExpand={(id) => void session.expand(id)}
							onCollapse={(id) => session.collapse(id)}
							onDismiss={(id) => session.dismiss(id)}
							onFindPath={() => void session.findPath()}
							onClearSelection={() => session.clearSelection()}
							onHelp={() => setHelpOpen(true)}
							announce={announce}
							onLayoutStatus={setLayoutStatus}
						/>
					</Suspense>
				</CanvasBoundary>
			</div>

			<div style={styles.legend} aria-label="Legend">
				{legend.map((entry) => (
					<span key={entry.label || '(none)'}>
						<span style={styles.swatch(entry.fill)} aria-hidden="true" />
						{`${entry.name} (${entry.count})`}
					</span>
				))}
				<details style={{ marginLeft: 'auto' }}>
					<summary style={{ cursor: 'pointer' }}>Captions</summary>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
						{legend.filter((e) => e.label !== '').slice(0, 12).map((entry) => {
							const nodes = [...state.model.nodes.values()].filter((n) => n.labels[0] === entry.label);
							const choices = captionChoices(nodes);
							return (
								<label key={entry.label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
									<span style={{ minWidth: 80 }}>{entry.name}</span>
									<select style={styles.select} aria-label={`Caption for ${entry.name}`} value={captions.get(entry.label) ?? ''} onChange={(event) => onCaption(entry.label, event.target.value)}>
										<option value="">automatic</option>
										{choices.map((choice) => (
											<option key={choice.value} value={choice.value}>{choice.label}</option>
										))}
									</select>
								</label>
							);
						})}
					</div>
				</details>
			</div>

			{helpOpen && (
				<Modal title="Graph keyboard" onClose={() => setHelpOpen(false)}>
					<table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
						<tbody>
							{KEY_HELP.map((row) => (
								<tr key={row.keys}>
									<th scope="row" style={{ textAlign: 'left', padding: '4px 12px 4px 0', whiteSpace: 'nowrap' }}>{row.keys}</th>
									<td style={{ padding: '4px 0' }}>{row.does}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Modal>
			)}
		</div>
	);
};

export default GraphView;
