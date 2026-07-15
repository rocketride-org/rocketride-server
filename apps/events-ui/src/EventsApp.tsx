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

const EventsApp: React.FC<ShellAppProps> = (_props) => {
	const client = useClient();

	// Event storage: mutable ref + tick counter to trigger re-renders
	const eventsRef = useRef<CapturedEvent[]>([]);
	const [tick, setTick] = useState(0);
	const rafRef = useRef<number | null>(null);
	const nextIdRef = useRef(1);

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

	// Cancel pending rAF on unmount
	useEffect(() => {
		return () => {
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, []);

	// Handle incoming shell events.
	// useShellEvent already stores the handler in a ref and calls the latest
	// version on every event, so useCallback is unnecessary here.
	useShellEvent('shell:event', ({ event }) => {
		if (!config.active) return;

		// Only capture DAP events
		if (event.type !== 'event') return;

		// Token filter: if config.token is not '*', check it matches
		if (config.token !== '*' && event.token !== config.token) return;

		const captured: CapturedEvent = {
			id: nextIdRef.current++,
			time: Date.now(),
			eventName: event.event ?? 'unknown',
			body: (event.body ?? {}) as Record<string, unknown>,
			token: (event.token ?? '') as string,
			seq: event.seq ?? 0,
		};

		eventsRef.current.push(captured);
		totalRef.current++;
		rateWindowRef.current.push(Date.now());

		// Cap memory — trim in batches to amortize the cost
		if (eventsRef.current.length > MAX_EVENTS * 1.2) {
			eventsRef.current = eventsRef.current.slice(-MAX_EVENTS);
		}

		scheduleUpdate();
	});

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

		client.addMonitor(key, config.types).catch((err) => {
			console.error('[events-ui] addMonitor failed', err);
			setConfig((c) => ({ ...c, active: false }));
		});

		return () => {
			client.removeMonitor(key, config.types).catch((err) => {
				console.error('[events-ui] removeMonitor failed', err);
			});
		};
	}, [client, config.active, config.token, config.types]);

	const handleToggle = () => {
		setConfig((c) => ({ ...c, active: !c.active }));
	};

	const handleClear = () => {
		eventsRef.current = [];
		totalRef.current = 0;
		rateWindowRef.current = [];
		nextIdRef.current = 1;
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
				<span style={styles.statusItem}>
					<span
						style={config.active ? commonStyles.indicatorSuccess : commonStyles.indicatorMuted}
					/>
					{config.active ? 'Monitoring' : 'Stopped'}
				</span>
				{!client && (
					<span style={styles.statusItem}>
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
