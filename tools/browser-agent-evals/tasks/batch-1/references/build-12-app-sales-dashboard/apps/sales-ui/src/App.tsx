// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sales — dashboard root rendered by the RocketRide shell.
 */

import React from 'react';
import { AppLayout } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: '18px 22px', fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 17, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 16 },
	row: { display: 'flex', gap: 12, marginBottom: 16 },
	card: { flex: 1, border: '1px solid var(--rr-border)', borderRadius: 8, padding: '12px 14px', background: 'var(--rr-bg-paper)' },
	label: { fontSize: 10.5, color: 'var(--rr-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' },
	value: { fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--rr-text-primary)' },
	chart: { border: '1px solid var(--rr-border)', borderRadius: 8, background: 'var(--rr-bg-paper)', padding: 14 },
	bars: { display: 'flex', alignItems: 'flex-end', gap: 8, height: 96 },
	bar: { flex: 1, background: 'var(--rr-brand)', opacity: 0.75, borderRadius: '3px 3px 0 0' },
};

// Demo series — replace with live data from your pipelines.
const SERIES = [42, 55, 38, 64, 71, 52, 60, 78, 66, 83, 74, 90];

// =============================================================================
// COMPONENT
// =============================================================================

/** Dashboard content: three stat cards + a 12-point bar chart. */
const Content: React.FC = () => (
	<div style={styles.wrap}>
		<div style={styles.title}>Sales</div>
		<div style={styles.sub}>This month</div>
		<div style={styles.row}>
			<div style={styles.card}><div style={styles.label}>Revenue</div><div style={styles.value}>$120,400</div></div>
			<div style={styles.card}><div style={styles.label}>Orders</div><div style={styles.value}>342</div></div>
			<div style={styles.card}><div style={styles.label}>Refunds</div><div style={styles.value}>4</div></div>
		</div>
		<div style={styles.chart}>
			<div style={styles.bars}>
				{SERIES.map((h, i) => (
					<div key={i} style={{ ...styles.bar, height: `${h}%` }} />
				))}
			</div>
		</div>
	</div>
);

/**
 * Root view — AppLayout declares the frame the wizard selected; recompose
 * its props (`sidebar`, `showStatus`) to change it.
 */
const App: React.FC = () => (
	<AppLayout showStatus>
		<Content />
	</AppLayout>
);

export default App;
