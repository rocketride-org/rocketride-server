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
// EVENTS-UI — EVENT DETAIL PANEL (record slide-over)
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { DetailPanel, LabelValue, Section } from 'shared';
// The shared token-themed JSON tree (deep import, matching this app's existing
// `shared/themes/styles` import) — the one JSON viewer, not a per-app copy.
import { JsonTree } from 'shared/components/trace/JsonTree';
import type { EventRow } from '../types';
import { eventColor } from '../styles';
import { formatTime } from '../format';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Depth the event body auto-expands to on open. */
const BODY_EXPAND_DEPTH = 2;

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link EventDetailPanel} component. */
export interface IEventDetailPanelProps {
	/** The event to inspect, or null when the panel is closed. */
	event: EventRow | null;
	/** Fired when the drawer is dismissed. */
	onClose: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Colored disc in the header avatar slot conveying the event kind's color.
	dot: (color: string): CSSProperties => ({
		width: 14,
		height: 14,
		borderRadius: '50%',
		background: color,
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Read-only record slide-over for one captured event: an EntityHeader with the
 * event name (color-cued by an avatar dot), a metadata Section, and the full
 * DAP body rendered by the shared {@link JsonTree}. Pure inspect — no footer
 * verbs; the header close glyph and Escape dismiss it.
 *
 * @param props - {@link IEventDetailPanelProps}.
 * @returns The detail drawer (renders nothing while closed).
 */
export const EventDetailPanel: React.FC<IEventDetailPanelProps> = ({ event, onClose }) => {
	// Closed state: DetailPanel renders nothing when `open` is false. Guard the
	// body derivations too, since `event` is null while closed.
	if (!event) {
		return <DetailPanel open={false} onClose={onClose} title="" children={null} />;
	}

	return (
		<DetailPanel
			persistKey="panelDetailEventWidth"
			open
			onClose={onClose}
			avatar={<span style={styles.dot(eventColor(event.eventName))} />}
			title={event.eventName}
			subtitle={`#${event.id} · ${formatTime(event.time)}`}
		>
			{/* Metadata: the scalar fields, monospace where they are identifiers. */}
			<Section label="Event">
				<LabelValue label="Name" mono>
					{event.eventName}
				</LabelValue>
				<LabelValue label="Token" mono>
					{event.token || '—'}
				</LabelValue>
				<LabelValue label="Sequence" mono>
					{event.seq}
				</LabelValue>
				<LabelValue label="Captured" mono>
					{formatTime(event.time)}
				</LabelValue>
			</Section>

			{/* Full DAP payload via the shared JSON tree. */}
			<Section label="Body">
				<JsonTree data={event.body} defaultExpanded={BODY_EXPAND_DEPTH} />
			</Section>
		</DetailPanel>
	);
};
