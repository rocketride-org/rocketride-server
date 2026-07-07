// =============================================================================
// EventList — Scrolling list of captured events
// =============================================================================

import React, { useRef, useEffect } from 'react';
import type { CapturedEvent } from '../types';
import { styles } from '../styles';
import EventRow from './EventRow';

interface Props {
	events: CapturedEvent[];
	filterType: string;
}

const EventList: React.FC<Props> = ({ events, filterType }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	const filtered = filterType === 'ALL'
		? events
		: events.filter((e) => e.eventName === filterType);

	// Track whether user is near the bottom (sticky auto-scroll)
	const handleScroll = () => {
		const el = containerRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
	};

	// Auto-scroll to bottom when new events arrive (if sticky)
	useEffect(() => {
		const el = containerRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [filtered.length]);

	return (
		<div
			ref={containerRef}
			style={styles.eventListContainer}
			onScroll={handleScroll}
		>
			{filtered.length === 0 ? (
				<div style={styles.emptyState}>
					{events.length === 0
						? 'No events captured yet. Start monitoring to see events.'
						: `No events matching filter "${filterType}".`
					}
				</div>
			) : (
				<div style={styles.eventList}>
					{filtered.map((evt) => (
						<EventRow key={evt.id} event={evt} />
					))}
				</div>
			)}
		</div>
	);
};

export default EventList;
