// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Unit Converter — kilometers to miles and back.
 */

import React, { useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 },
	input: { width: 140, padding: '6px 8px', border: '1px solid var(--rr-border)', borderRadius: 6 },
	result: { marginTop: 16, fontSize: 18, color: 'var(--rr-text-primary)' },
};

/** Kilometers in one mile. */
const KM_PER_MILE = 1.609344;

// =============================================================================
// COMPONENT
// =============================================================================

/** Client-area content: the value, the direction and the result. */
const Content: React.FC<ShellAppProps> = () => {
	const [value, setValue] = useState('10');
	const [toMiles, setToMiles] = useState(true);

	const n = Number(value);
	const result = Number.isFinite(n) ? (toMiles ? n / KM_PER_MILE : n * KM_PER_MILE) : NaN;

	return (
		<div style={styles.wrap}>
			<h1 style={styles.title}>Unit Converter</h1>
			<div style={styles.row}>
				<input style={styles.input} value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} />
				<span>{toMiles ? 'km' : 'mi'}</span>
				<button onClick={() => setToMiles((v) => !v)}>Swap</button>
			</div>
			<div style={styles.result}>{Number.isFinite(result) ? `${result.toFixed(2)} ${toMiles ? 'mi' : 'km'}` : 'Enter a number'}</div>
		</div>
	);
};

/** Root view: the template's frame around the converter. */
const App: React.FC<ShellAppProps> = (props) => (
	<AppLayout showStatus>
		<Content {...props} />
	</AppLayout>
);

export default App;
