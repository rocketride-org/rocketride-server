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

// =============================================================================
// VECTOR-UI - VECTOR CONNECTION CARD (one store on the Connections page)
// =============================================================================
//
// One button per store: its name, the state, a line saying what it is (store,
// collection, pipeline, and the document count once the console has it) and
// its flags, all inside the card. Which sources run is in the card's tooltip
// and in its accessible description. Clicking it opens the store's drawer.
// =============================================================================

import React, { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { StatusBadge } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { useVectorEnv } from '../envContext';
import { TONE_EDGE } from '../vector/colors';
import { vectorCardView } from '../vector/connections';
import type { IVectorCardView } from '../vector/connections';
import { VectorIcon } from '../icons';
import { FOCUS_RING, styles } from '../styles';

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

const local = {
	card: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box', padding: '12px 14px', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 8 } as CSSProperties,
	top: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } as CSSProperties,
	icon: { display: 'inline-flex', width: 20, height: 20, flexShrink: 0 } as CSSProperties,
	name: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	description: { fontSize: 12, lineHeight: 1.45, overflowWrap: 'anywhere' } as CSSProperties,
	flags: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } as CSSProperties,
	hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as CSSProperties,
};

/**
 * The sentence for which sources run, for the card's tooltip and description.
 *
 * @param view - The card's view.
 * @returns e.g. 'Sources: ingest running, chat not running, tools running'.
 */
export function sourcesSentence(view: Pick<IVectorCardView, 'roleLine'>): string {
	return `Sources: ${view.roleLine.replace(/✓/g, 'running').replace(/–/g, 'not running').replace(/ · /g, ', ')}`;
}

/** Props. */
export interface IVectorConnectionCardProps {
	endpoint: IExplorerEndpoint;
	probe: IProbeResult | undefined;
	onOpen(endpoint: IExplorerEndpoint): void;
}

/**
 * One store's card.
 *
 * @param props - {@link IVectorConnectionCardProps}.
 * @returns The card.
 */
export function VectorConnectionCard({ endpoint, probe, onOpen }: IVectorConnectionCardProps): React.ReactElement {
	// The connection's last stats, once its console has them: a store found empty and filled since drops its flag.
	const entry = useVectorEnv().existingConnection(endpoint.key);
	const stats = useSyncExternalStore(
		entry?.controller.subscribe ?? NO_SUBSCRIBE,
		() => entry?.controller.getState().stats.view ?? null,
		() => null
	);
	const view = vectorCardView(endpoint, probe, stats);
	const sources = sourcesSentence(view);
	const describedBy = `card-sources-${endpoint.nodeId}`;
	return (
		<button type="button" data-card={endpoint.nodeId} style={local.card} title={`${view.title}\n${view.description}\n${sources}`} aria-describedby={describedBy} onClick={() => onOpen(endpoint)} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
			<span style={local.top}>
				<span style={local.icon}>
					<VectorIcon />
				</span>
				<span style={local.name}>{view.title}</span>
				<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
			</span>
			<span style={local.description}>{view.description}</span>
			{(view.flags.length > 0 || view.line) && (
				<span style={local.flags}>
					{view.flags.map((flag) => (
						<span key={flag.label} style={styles.chip(TONE_EDGE[flag.variant])} title={flag.tooltip}>
							{flag.label}
						</span>
					))}
					{view.line && <span style={{ flexBasis: '100%', fontSize: 12 }}>{view.line}</span>}
				</span>
			)}
			<span id={describedBy} style={local.hidden}>
				{sources}
			</span>
		</button>
	);
}

export default VectorConnectionCard;
