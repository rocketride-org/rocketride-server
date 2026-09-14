// =============================================================================
// EventStream — Live scrolling event log
// =============================================================================

import React, { useRef, useEffect } from 'react';
import type { TestEvent } from '../types';
import { styles, eventTypeColor } from '../styles';

interface Props {
	events: TestEvent[];
	filter?: 'all' | 'errors';
}

function formatEventTime(ts: number): string {
	const d = new Date(ts);
	const m = String(d.getMinutes()).padStart(2, '0');
	const s = String(d.getSeconds()).padStart(2, '0');
	const ms = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
	return `${m}:${s}.${ms}`;
}

const EventStream: React.FC<Props> = ({ events, filter = 'all' }) => {
	const containerRef = useRef<HTMLDivElement>(null);

	const filtered = filter === 'errors'
		? events.filter((e) => e.type === 'fail')
		: events;

	// Auto-scroll to top when new events arrive (they're prepended). The feed
	// is capped, so once full its length goes constant — the newest event's id
	// is the real arrival signal.
	const newestEventId = filtered[0]?.id;
	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = 0;
		}
	}, [newestEventId, filtered.length]);

	return (
		<div ref={containerRef} style={styles.eventStream}>
			{filtered.length === 0 && (
				<div style={{ padding: 24, textAlign: 'center', color: 'var(--rr-text-disabled)', fontSize: 11 }}>
					No events yet
				</div>
			)}
			{filtered.slice(0, 200).map((evt) => (
				<div key={evt.id} style={styles.eventItem}>
					<span style={styles.eventTime}>{formatEventTime(evt.time)}</span>
					<span style={{ ...styles.eventType, color: eventTypeColor(evt.type) }}>
						{evt.type.toUpperCase()}
					</span>
					<span style={styles.eventMsg} title={`[${evt.source}] ${evt.message}`}>
						{evt.source !== 'engine' && evt.source !== 'sweep' ? `${evt.source} ` : ''}{evt.message}
					</span>
				</div>
			))}
		</div>
	);
};

export default EventStream;
