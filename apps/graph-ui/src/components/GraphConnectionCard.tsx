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
// GRAPH-UI - CONNECTION CARD (the full app's landing)
// =============================================================================
//
// The shell's ConnectionCard takes no chips, so Graph Explorer draws its own in
// the same shape (a running node's border and icon in the measured focus
// colour, never the brand colour, which is too faint on the light themes): the node's name, its address (provider, engine and version
// once the node answered, pipeline), the state badge, and the chips: the
// counts, when the connection's schema was read in this session (no card asks
// for one), "Empty graph", and "Writes allowed" or "Read-only". The whole card
// is one button that opens the drawer (Enter or Space as well as a click).
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { StatusBadge } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { useSchemaView } from '../env';
import { connectionChips, connectionView, countsText } from '../graph/connections';
import { GraphIcon } from '../icons';

const styles = {
	card: (connected: boolean, hovered: boolean): CSSProperties => ({
		position: 'relative',
		padding: 18,
		borderRadius: 10,
		background: hovered ? 'var(--rr-bg-list-hover)' : 'var(--rr-bg-paper)',
		border: `1px solid ${connected ? 'var(--rr-border-focus)' : 'var(--rr-border)'}`,
		cursor: 'pointer',
		textAlign: 'left',
	}),
	icon: (connected: boolean): CSSProperties => ({ display: 'inline-flex', width: 30, height: 30, marginBottom: 14, color: connected ? 'var(--rr-border-focus)' : 'var(--rr-text-secondary)' }),
	name: { fontSize: 15, fontWeight: 700, color: 'var(--rr-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	address: { fontSize: 12.5, color: 'var(--rr-text-secondary)', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 } as CSSProperties,
};

/** Props. */
export interface IGraphConnectionCardProps {
	endpoint: IExplorerEndpoint;
	probe: IProbeResult | undefined;
	/** Open the connection's drawer. */
	onOpen(): void;
}

/**
 * One connection's card.
 *
 * @param props - See {@link IGraphConnectionCardProps}.
 * @returns The card.
 */
export const GraphConnectionCard: React.FC<IGraphConnectionCardProps> = ({ endpoint, probe, onOpen }) => {
	const [hovered, setHovered] = useState(false);
	const schema = useSchemaView(endpoint.key);
	const view = connectionView(endpoint, probe);
	// "Supported (Cypher)" is the drawer's: every card that can be opened is one.
	const chips = connectionChips(endpoint, probe, schema).filter((chip) => chip.id !== 'supported');
	const counts = countsText(schema);
	const connected = endpoint.state === 'ready';
	const said = [view.badge.label, counts, ...chips.map((chip) => chip.label)].filter(Boolean).join(', ');
	return (
		<div
			role="button"
			tabIndex={0}
			aria-label={`${view.title}: ${said}. Details`}
			style={styles.card(connected, hovered)}
			onClick={onOpen}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					onOpen();
				}
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<span style={styles.icon(connected)} aria-hidden="true">
				<GraphIcon />
			</span>
			<div style={styles.name}>{view.title}</div>
			<div style={styles.address} title={view.address}>
				{view.address}
			</div>
			<div style={styles.chips}>
				<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
				{counts && <StatusBadge variant="info">{counts}</StatusBadge>}
				{chips.map((chip) => (
					<StatusBadge key={chip.id} variant={chip.variant}>
						{chip.label}
					</StatusBadge>
				))}
			</div>
		</div>
	);
};

export default GraphConnectionCard;
