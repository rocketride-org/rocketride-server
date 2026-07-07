// =============================================================================
// EVENTS-UI — Main App Component
// =============================================================================

import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useClient, useShellEvent } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import type { CapturedEvent, MonitorConfig } from './types';
import { MAX_EVENTS } from './types';
import { styles } from './styles';
import Toolbar from './components/Toolbar';
import EventList from './components/EventList';

let nextId = 1;

const EventsApp: React.FC<ShellAppProps> = (_props) => {
	const client = useClient();

	// Event storage: mutable ref + tick counter to trigger re-renders
	const eventsRef = useRef<CapturedEvent[]>([]);
	const [tick, setTick] = useState(0);
	const rafRef = useRef<number | null>(null);

	// Monitor configuration
	const [config, setConfig] = useState<MonitorConfig>({
		token: '*',
		types: ['SUMMARY', 'TASK', 'FLOW'],
		active: false,
	});

	// Display filter (separate from subscription types)
	const [filterType, setFilterType] = useState('ALL');

	// Stats
	const totalRef = useRef(0);
	const rateWindowRef = useRef<number[]>([]);

	// Schedule a re-render via rAF (throttled to ~60fps)
	const scheduleUpdate = useCallback(() => {
		if (rafRef.current !== null) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			setTick((t) => t + 1);
		});
	}, []);

	// Handle incoming shell events
	useShellEvent('shell:event', useCallback(({ event }) => {
		if (!config.active) return;

		// Only capture DAP events
		if (event.type !== 'event') return;

		// Token filter: if config.token is not '*', check it matches
		if (config.token !== '*' && event.token !== config.token) return;

		const captured: CapturedEvent = {
			id: nextId++,
			time: Date.now(),
			eventName: event.event ?? 'unknown',
			body: (event.body ?? {}) as Record<string, unknown>,
			token: (event.token ?? '') as string,
			seq: event.seq ?? 0,
		};

		eventsRef.current.push(captured);
		totalRef.current++;
		rateWindowRef.current.push(Date.now());

		// Cap memory
		if (eventsRef.current.length > MAX_EVENTS) {
			eventsRef.current = eventsRef.current.slice(-MAX_EVENTS);
		}

		scheduleUpdate();
	}, [config.active, config.token, scheduleUpdate]));

	// Clean up rate window periodically
	useEffect(() => {
		const interval = setInterval(() => {
			const now = Date.now();
			rateWindowRef.current = rateWindowRef.current.filter((t) => now - t < 1000);
		}, 500);
		return () => clearInterval(interval);
	}, []);

	// Subscribe/unsubscribe when monitoring starts/stops
	useEffect(() => {
		if (!client) return;
		if (!config.active) return;

		const key = { token: config.token };

		client.addMonitor(key, config.types).catch(() => {
			// Subscription failed — stop monitoring
			setConfig((c) => ({ ...c, active: false }));
		});

		return () => {
			client.removeMonitor(key, config.types).catch(() => {});
		};
	}, [client, config.active, config.token, config.types]);

	const handleToggle = () => {
		setConfig((c) => ({ ...c, active: !c.active }));
	};

	const handleClear = () => {
		eventsRef.current = [];
		totalRef.current = 0;
		rateWindowRef.current = [];
		setTick((t) => t + 1);
	};

	const events = eventsRef.current;
	const eventsPerSec = rateWindowRef.current.filter((t) => Date.now() - t < 1000).length;

	// Force lint to see tick is used (it drives re-renders)
	void tick;

	return (
		<div style={styles.root}>
			<Toolbar
				config={config}
				onConfigChange={setConfig}
				onToggle={handleToggle}
				onClear={handleClear}
				events={events}
				filterType={filterType}
				onFilterChange={setFilterType}
			/>

			{/* Stats bar */}
			<div style={styles.statsBar}>
				<span>
					Total: <span style={styles.statValue}>{totalRef.current.toLocaleString()}</span>
				</span>
				<span>
					In memory: <span style={styles.statValue}>{events.length.toLocaleString()}</span>
				</span>
				<span>
					Rate: <span style={styles.statValue}>{eventsPerSec}/s</span>
				</span>
				<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<span
						style={config.active ? commonStyles.indicatorSuccess : commonStyles.indicatorMuted}
					/>
					{config.active ? 'Monitoring' : 'Stopped'}
				</span>
				{!client && (
					<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
						<span style={commonStyles.indicatorError} />
						Not connected
					</span>
				)}
			</div>

			<EventList events={events} filterType={filterType} />
		</div>
	);
};

export default EventsApp;
