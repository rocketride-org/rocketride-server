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
// GRAPH-UI - INSPECTOR (a node or relationship, in full)
// =============================================================================
//
// Shows labels or type, the id (flagged as a live handle), every property with the
// user's own key names and exact values, and - for a node - the relationships that
// are drawn for it, each of which opens its own inspector. That list is also the
// keyboard and screen-reader route to relationships, which are not focusable on
// the canvas. Copy JSON copies the wire form of the entity.
// =============================================================================

import React, { useMemo, useState } from 'react';
import { Banner, Button, DetailPanel, LabelValue, Section } from 'shell';
import { CHIP_TEXT_TOKEN } from '../canvas/tokens';
import { captionOf } from '../graph/captions';
import type { IGraphSession, IGraphState, IInspectTarget } from '../graph/graphSession';
import { STALE_ELEMENT_TEXT, STALE_RELATIONSHIP_TEXT } from '../graph/identity';
import { inspectNode, inspectRelationship } from '../graph/inspector';
import { relationshipsOf } from '../graph/model';
import { STOP_WAITING_NOTE } from '../graph/wording';
import { CopyBlocked, copyText } from './ResultViews';
import { GraphIcon } from '../icons';

/** Props. */
export interface IInspectorPanelProps {
	state: IGraphState;
	session: IGraphSession;
	captions: ReadonlyMap<string, string>;
	announce(text: string): void;
}

/** A label or type, as a small pill. Its text is the primary text colour: the shell's chip draws its text in the info colour, which is 3.5:1 on this panel in RocketRide Light. */
const chipStyle: React.CSSProperties = { display: 'inline-block', margin: '0 6px 4px 0', padding: '1px 9px', borderRadius: 11, fontSize: 12, lineHeight: '18px', color: `var(${CHIP_TEXT_TOKEN})`, background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)' };

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
 * The inspector drawer.
 *
 * @param props - See {@link IInspectorPanelProps}.
 * @returns The drawer, or nothing when nothing is inspected.
 */
export const InspectorPanel: React.FC<IInspectorPanelProps> = ({ state, session, captions, announce }) => {
	const target: IInspectTarget | null = state.inspect;
	const model = state.model;
	const captionFor = (id: string): string => {
		const n = model.nodes.get(id);
		return n ? captionOf(n, captions.get(n.labels[0] ?? '')) : id;
	};

	const view = useMemo(() => {
		if (!target) return null;
		if (target.kind === 'node') {
			const node = model.nodes.get(target.id);
			return node ? { model: inspectNode(node, captionOf(node, captions.get(node.labels[0] ?? ''))), node } : null;
		}
		const rel = model.relationships.get(target.id);
		return rel ? { model: inspectRelationship(rel, (id) => { const n = model.nodes.get(id); return n ? captionOf(n, captions.get(n.labels[0] ?? '')) : id; }), node: null } : null;
	}, [target, model, captions]);

	// The JSON a blocked copy left on screen (shown only while it is still this entity's).
	const [blocked, setBlocked] = useState<string | null>(null);
	if (!target || !view) return null;
	const m = view.model;
	// Node and relationship ids are separate namespaces (FalkorDB numbers both from 0): each kind has its own marks.
	const targetStale = target.kind === 'node' ? state.staleIds.has(target.id) : state.staleRelationshipIds.has(target.id);
	const rels = view.node ? relationshipsOf(model, view.node.id) : [];

	const copy = async (): Promise<void> => {
		const ok = await copyText(m.json);
		setBlocked(ok ? null : m.json);
		announce(ok ? 'Copied as JSON.' : 'Copying was not allowed by the browser.');
	};

	return (
		<DetailPanel
			open
			onClose={() => session.inspect(null)}
			avatar={<GraphIcon />}
			title={m.title}
			subtitle={m.subtitle}
			footer={
				<>
					<Button variant="ghost" onClick={() => void copy()}>Copy JSON</Button>
					{view.node && (
						<>
							<Button variant="ghost" disabled={state.busy !== null || state.stale || state.staleIds.has(view.node.id)} onClick={() => void session.refreshInspected()}>Refresh</Button>
							{state.busy !== null && <Button variant="ghost" title={STOP_WAITING_NOTE} onClick={() => session.stopWaiting()}>Stop waiting</Button>}
							<Button variant="ghost" disabled={state.busy !== null || state.stale || state.staleIds.has(view.node.id)} onClick={() => void session.expand(view.node!.id)}>Expand</Button>
							<Button variant="ghost" onClick={() => session.dismiss(view.node!.id)}>Dismiss</Button>
						</>
					)}
				</>
			}
		>
			{blocked !== null && blocked === m.json && <CopyBlocked text={blocked} />}
			{(state.stale || targetStale) && (
				<Banner variant="warning">{state.stale ? 'This copy may be out of date: a statement that can change data ran on this connection after it was drawn. It is shown as the query returned it.' : target.kind === 'node' ? STALE_ELEMENT_TEXT : STALE_RELATIONSHIP_TEXT}</Banner>
			)}
			{state.notice && state.busy === null && target.kind === 'node' && <Banner variant={state.notice.variant}>{state.notice.text}</Banner>}
			<Section label={m.kind === 'node' ? 'Labels' : 'Type'}>
				{m.tags.length === 0 ? <span style={{ color: 'var(--rr-text-secondary)' }}>none</span> : m.tags.map((tag) => <LabelChip key={tag} label={tag} />)}
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
				{m.fields.length === 0 && <span style={{ color: 'var(--rr-text-secondary)' }}>none</span>}
				{m.fields.map((field, i) => (
					<LabelValue key={`${i}-${field.label}`} label={field.label} mono>
						<span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{field.value}</span>
					</LabelValue>
				))}
			</Section>
			{view.node && (
				<Section label={`Relationships on the canvas (${rels.length})`}>
					{rels.length === 0 && <span style={{ color: 'var(--rr-text-secondary)' }}>none drawn</span>}
					{rels.map((rel) => {
						const outgoing = rel.start === view.node!.id;
						const other = outgoing ? rel.end : rel.start;
						return (
							<div key={rel.id} style={{ marginBottom: 4 }}>
								<Button variant="ghost" small onClick={() => session.inspect({ kind: 'relationship', id: rel.id })}>
									{`${outgoing ? '→' : '←'} :${rel.type} ${captionFor(other)}`}
								</Button>
							</div>
						);
					})}
				</Section>
			)}
		</DetailPanel>
	);
};

export default InspectorPanel;
