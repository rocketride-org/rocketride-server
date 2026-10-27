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
// GRAPH-UI - INSPECTOR (a node, relationship or path, in full, beside the canvas)
// =============================================================================
//
// An inline column to the right of the canvas, not a drawer: rocket-ui keeps every
// document mounted, and a modal left open in a document nobody is looking at traps
// Tab, locks scroll and takes Escape for the whole window. This panel has no
// overlay, no focus trap and no listener on the document.
//
// It follows the selection: a click opens it for that element WITHOUT taking
// focus, so the canvas keeps panning and keyboard navigation continues. Opened by
// an explicit request (Enter or Inspect) it moves focus to its heading
// (`focusToken` changes). Escape closes it while focus is inside; Close is a button.
//
// It shows labels or type, the id (flagged as a live handle), every property with
// the user's own key names and exact values, and - for a node - the relationships
// that are drawn for it ("N drawn": the database's own count is not known here),
// each of which opens its own view. That list is also the keyboard and
// screen-reader route to relationships. Copy JSON copies the wire form.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, LabelValue, Section } from 'shell';
import { CHIP_TEXT_TOKEN } from '../canvas/tokens';
import { captionOf } from '../graph/captions';
import type { IGraphSession, IGraphState, IInspectTarget } from '../graph/graphSession';
import { STALE_ELEMENT_TEXT, STALE_RELATIONSHIP_TEXT } from '../graph/identity';
import { inspectNode, inspectPath, inspectRelationship } from '../graph/inspector';
import { relationshipsOf } from '../graph/model';
import type { ISchemaView } from '../graph/schema';
import { STOP_WAITING_NOTE } from '../graph/wording';
import { CopyBlocked, copyText } from './ResultViews';

/** Props. */
export interface IInspectorPanelProps {
	state: IGraphState;
	session: IGraphSession;
	captions: ReadonlyMap<string, string>;
	announce(text: string): void;
	/** Open a new query tab with this text, not run. Without it the button is not offered. */
	onNewQuery?(cypher: string, title: string): void;
	/** Start picking the second node of a path from this node. */
	onFindPathFrom?(id: string): void;
	/** Changes when the panel was opened by request: focus moves to the heading then. */
	focusToken: number;
	/** The connection's schema, for the sampled type of a null property. */
	schema?: ISchemaView | null;
	/** The panel was closed from inside (Escape or Close): put focus back where the person was. */
	onClosed?(): void;
}

/** A label or type, as a small pill. Its text is the primary text colour: the shell's chip draws its text in the info colour, which is 3.5:1 on this panel in RocketRide Light. */
const chipStyle: React.CSSProperties = { display: 'inline-block', margin: '0 6px 4px 0', padding: '1px 9px', borderRadius: 11, fontSize: 12, lineHeight: '18px', color: `var(${CHIP_TEXT_TOKEN})`, background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)' };

const styles = {
	root: { padding: '10px 12px', boxSizing: 'border-box', fontSize: 13 } as React.CSSProperties,
	head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } as React.CSSProperties,
	title: { margin: 0, fontSize: 15, wordBreak: 'break-word', outline: 'none' } as React.CSSProperties,
	subtitle: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: '2px 0 8px' } as React.CSSProperties,
	actions: { display: 'flex', flexWrap: 'wrap', gap: 4, margin: '0 0 8px' } as React.CSSProperties,
	none: { color: 'var(--rr-text-secondary)' } as React.CSSProperties,
};

/**
 * How a found path was found, in words.
 *
 * @param path - The shown path.
 * @returns A sentence.
 */
function pathHow(path: IGraphState['path']): string {
	if (!path) return '';
	return path.method === 'shortest-path'
		? 'Found with one shortestPath call (Neo4j only; FalkorDB and Apache AGE try depth 1 to N, one call each).'
		: `Found by trying depth 1 to ${path.relationships.length}, one call each (FalkorDB and Apache AGE always do; Neo4j does when shortestPath cannot answer).`;
}

/**
 * One label or type pill.
 *
 * @param props.label - The text.
 * @returns The pill.
 */
function LabelChip({ label }: { label: string }): React.ReactElement {
	return <span style={chipStyle}>{label}</span>;
}

/**
 * The inspector column.
 *
 * @param props - See {@link IInspectorPanelProps}.
 * @returns The column, or nothing when nothing is inspected and no path is shown.
 */
export const InspectorPanel: React.FC<IInspectorPanelProps> = ({ state, session, captions, announce, onNewQuery, onFindPathFrom, focusToken, schema, onClosed }) => {
	const target: IInspectTarget | null = state.inspect;
	const model = state.model;
	const heading = useRef<HTMLHeadingElement>(null);
	const captionFor = (id: string): string => {
		const n = model.nodes.get(id);
		return n ? captionOf(n, captions.get(n.labels[0] ?? '')) : id;
	};

	const view = useMemo(() => {
		if (!target) return null;
		if (target.kind === 'node') {
			const node = model.nodes.get(target.id);
			const sampled = new Map<string, readonly string[]>();
			for (const p of schema?.labels.find((l) => l.name === node?.labels[0])?.properties ?? []) sampled.set(p.name, p.types);
			return node ? { model: inspectNode(node, captionOf(node, captions.get(node.labels[0] ?? '')), sampled), node } : null;
		}
		const rel = model.relationships.get(target.id);
		return rel ? { model: inspectRelationship(rel, (id) => { const n = model.nodes.get(id); return n ? captionOf(n, captions.get(n.labels[0] ?? '')) : id; }), node: null } : null;
	}, [target, model, captions, schema]);

	const pathView = useMemo(() => (state.path && !view ? inspectPath(model, state.path, (n) => captionOf(n, captions.get(n.labels[0] ?? ''))) : null), [state.path, view, model, captions]);

	// An explicit request to inspect (Enter, the Inspect button, the menu) moves focus here; a click does not.
	const seen = useRef(focusToken);
	useEffect(() => {
		if (seen.current === focusToken) return;
		seen.current = focusToken;
		heading.current?.focus({ preventScroll: true });
	}, [focusToken, view, pathView]);

	// The JSON a blocked copy left on screen (shown only while it is still this entity's).
	const [blocked, setBlocked] = useState<string | null>(null);
	if (!view && !pathView) return null;

	const json = view ? view.model.json : (pathView as NonNullable<typeof pathView>).json;
	const copy = async (): Promise<void> => {
		const ok = await copyText(json);
		setBlocked(ok ? null : json);
		announce(ok ? 'Copied as JSON.' : 'Copying was not allowed by the browser.');
	};
	const close = (): void => {
		if (view) session.inspect(null);
		else session.clearPath();
		onClosed?.();
	};
	const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
		if (event.key === 'Escape' && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			close();
		}
	};
	const newQuery = (): void => {
		if (!target || !onNewQuery) return;
		const text = session.queryTextFor(target);
		if (text !== null) onNewQuery(text, view ? `From ${view.model.title}`.slice(0, 40) : 'From here');
	};
	const canQuery = !!(target && onNewQuery && view && session.queryTextFor(target) !== null);

	if (!view) {
		const p = pathView as NonNullable<typeof pathView>;
		return (
			<aside aria-label="Inspector" style={styles.root} onKeyDown={onKeyDown}>
				<div style={styles.head}>
					<h3 ref={heading} tabIndex={-1} style={styles.title}>Path</h3>
					<Button variant="ghost" small title="Close (Esc)" onClick={close}>Close</Button>
				</div>
				<div style={styles.subtitle}>{`${p.steps.length} nodes`}</div>
				<div style={{ ...styles.none, fontSize: 12, margin: '0 0 8px' }}>{pathHow(state.path)}</div>
				<div style={styles.actions}>
					{onNewQuery && state.path && session.queryTextFor({ kind: 'path' }) !== null && (
						<Button variant="ghost" small onClick={() => { const text = session.queryTextFor({ kind: 'path' }); if (text !== null) onNewQuery(text, 'Path'); }}>Open as query</Button>
					)}
					<Button variant="ghost" small onClick={() => session.clearPath()}>Clear path</Button>
					<Button variant="ghost" small onClick={() => void copy()}>Copy JSON</Button>
				</div>
				{blocked !== null && blocked === json && <CopyBlocked text={blocked} />}
				<Section label="Steps">
					<ol style={{ margin: 0, paddingLeft: 18 }}>
						{p.steps.map((step, i) => (
							<li key={`${i}-${step.id}`} style={{ marginBottom: 2 }}>{step.via ? `${step.via} ${step.caption}` : step.caption}</li>
						))}
					</ol>
				</Section>
			</aside>
		);
	}

	const m = view.model;
	const t = target as IInspectTarget;
	// Node and relationship ids are separate namespaces (FalkorDB numbers both from 0): each kind has its own marks.
	const targetStale = t.kind === 'node' ? state.staleIds.has(t.id) : state.staleRelationshipIds.has(t.id);
	const rels = view.node ? relationshipsOf(model, view.node.id) : [];
	const rel = t.kind === 'relationship' ? model.relationships.get(t.id) : undefined;
	const nodeBusy = state.busy !== null || state.stale || (view.node ? state.staleIds.has(view.node.id) : false);

	return (
		<aside aria-label="Inspector" style={styles.root} onKeyDown={onKeyDown}>
			<div style={styles.head}>
				<h3 ref={heading} tabIndex={-1} style={styles.title}>{m.title}</h3>
				<Button variant="ghost" small title="Close (Esc)" onClick={close}>Close</Button>
			</div>
			<div style={styles.subtitle}>{m.subtitle}</div>
			<div style={styles.actions}>
				{view.node && (
					<>
						<Button variant="ghost" small disabled={nodeBusy} onClick={() => void session.expand(view.node!.id)}>Expand</Button>
						<Button variant="ghost" small onClick={() => session.collapse(view.node!.id)}>Collapse</Button>
						<Button variant="ghost" small onClick={() => session.dismiss(view.node!.id)}>Dismiss</Button>
						{onFindPathFrom && <Button variant="ghost" small disabled={nodeBusy} onClick={() => onFindPathFrom(view.node!.id)}>Find path</Button>}
						<Button variant="ghost" small disabled={nodeBusy} onClick={() => void session.refreshInspected()}>Refresh</Button>
						{state.busy !== null && <Button variant="ghost" small title={STOP_WAITING_NOTE} onClick={() => session.stopWaiting()}>Stop waiting</Button>}
					</>
				)}
				{rel && (
					<>
						<Button variant="ghost" small disabled={!model.nodes.has(rel.start)} onClick={() => session.select(rel.start, 'only')}>Select start</Button>
						<Button variant="ghost" small disabled={!model.nodes.has(rel.end)} onClick={() => session.select(rel.end, 'only')}>Select end</Button>
					</>
				)}
				{canQuery && <Button variant="ghost" small onClick={newQuery}>New query from here</Button>}
				{state.path && <Button variant="ghost" small title="Stop showing the found path" onClick={() => session.clearPath()}>Clear path</Button>}
				<Button variant="ghost" small onClick={() => void copy()}>Copy JSON</Button>
			</div>
			{blocked !== null && blocked === json && <CopyBlocked text={blocked} />}
			{(state.stale || targetStale) && (
				<Banner variant="warning">{state.stale ? 'This copy may be out of date: a statement that can change data ran on this connection after it was drawn. It is shown as the query returned it.' : t.kind === 'node' ? STALE_ELEMENT_TEXT : STALE_RELATIONSHIP_TEXT}</Banner>
			)}
			<Section label={m.kind === 'node' ? 'Labels' : 'Type'}>
				{m.tags.length === 0 ? <span style={styles.none}>none</span> : m.tags.map((tag) => <LabelChip key={tag} label={tag} />)}
			</Section>
			<Section label="Identity">
				<LabelValue label="id" mono>{m.id}</LabelValue>
				{m.endpoints && (
					<>
						<LabelValue label="start" mono>{`${captionFor(m.endpoints.start)} (${m.endpoints.start})`}</LabelValue>
						<LabelValue label="end" mono>{`${captionFor(m.endpoints.end)} (${m.endpoints.end})`}</LabelValue>
					</>
				)}
				<div style={{ fontSize: 11.5, color: 'var(--rr-text-secondary)', marginTop: 6 }}>{m.notes[0]}</div>
			</Section>
			<Section label={`Properties (${m.fields.length})`}>
				{m.fields.length === 0 && <span style={styles.none}>none</span>}
				{m.fields.map((field, i) => (
					<LabelValue key={`${i}-${field.label}`} label={field.label} mono>
						<span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{field.value}</span>
						<span style={{ display: 'block', fontSize: 11, color: 'var(--rr-text-secondary)' }}>{field.type}</span>
					</LabelValue>
				))}
			</Section>
			{view.node && (
				<Section label={`Relationships (${rels.length} drawn)`}>
					{rels.length === 0 && <span style={styles.none}>none drawn</span>}
					{rels.map((r) => {
						const outgoing = r.start === view.node!.id;
						const other = outgoing ? r.end : r.start;
						return (
							<div key={r.id} style={{ marginBottom: 4 }}>
								<Button variant="ghost" small onClick={() => session.selectRelationship(r.id)}>
									{`${outgoing ? '→' : '←'} :${r.type} ${captionFor(other)}`}
								</Button>
							</div>
						);
					})}
				</Section>
			)}
		</aside>
	);
};

export default InspectorPanel;
