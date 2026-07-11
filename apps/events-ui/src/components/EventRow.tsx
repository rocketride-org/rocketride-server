// =============================================================================
// EventRow — Single event entry with expandable JSON body
// =============================================================================

import React, { useState } from 'react';
import type { CapturedEvent } from '../types';
import { styles, eventColor } from '../styles';
import JsonTree from './JsonTree';

interface Props {
	event: CapturedEvent;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, '0');
	const m = String(d.getMinutes()).padStart(2, '0');
	const s = String(d.getSeconds()).padStart(2, '0');
	const ms = String(d.getMilliseconds()).padStart(3, '0');
	return `${h}:${m}:${s}.${ms}`;
}

function summarize(body: Record<string, unknown>): string {
	const keys = Object.keys(body);
	if (keys.length === 0) return '{}';

	// Try to show action/state/status/name if present
	for (const hint of ['action', 'state', 'status', 'name', 'op']) {
		if (body[hint] !== undefined && body[hint] !== null) {
			return `${hint}=${JSON.stringify(body[hint])}`;
		}
	}

	// Fallback: show first few keys
	const preview = keys.slice(0, 4).join(', ');
	return keys.length > 4 ? `{${preview}, ...}` : `{${preview}}`;
}

const EventRow: React.FC<Props> = ({ event }) => {
	const [expanded, setExpanded] = useState(false);
	const [hovered, setHovered] = useState(false);

	const headerStyle = {
		...styles.eventRowHeader,
		...(hovered ? styles.eventRowHeaderHover : {}),
	};

	return (
		<div style={styles.eventRow}>
			<div
				style={headerStyle}
				onClick={() => setExpanded(!expanded)}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
			>
				<span style={styles.expandArrow}>{expanded ? '\u25bc' : '\u25b6'}</span>
				<span style={styles.eventIndex}>#{event.id}</span>
				<span style={styles.eventTime}>{formatTime(event.time)}</span>
				<span style={{ ...styles.eventType, color: eventColor(event.eventName) }}>
					{event.eventName}
				</span>
				{event.token && (
					<span style={styles.eventToken} title={event.token}>
						{event.token.length > 8 ? event.token.slice(0, 8) + '...' : event.token}
					</span>
				)}
				<span style={styles.eventSummary}>{summarize(event.body)}</span>
			</div>
			{expanded && (
				<div style={styles.jsonPanel}>
					<JsonTree data={event.body} />
				</div>
			)}
		</div>
	);
};

export default EventRow;
