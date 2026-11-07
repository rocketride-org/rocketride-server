// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Notes — root component rendered by the RocketRide shell.
 */

import React from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Client-area content — replace with your app. */
const Content: React.FC<ShellAppProps> = ({ isConnected, identity }) => (
	<div style={styles.wrap}>
		<h1 style={styles.title}>Notes</h1>
		<p style={styles.sub}>Edit src/App.tsx and save — the preview reloads automatically.</p>
		<p style={styles.sub}>Connected: {isConnected ? 'yes' : 'no'} · User: {identity?.displayName ?? 'not signed in'}</p>
	</div>
);

/**
 * Root view — AppLayout declares the frame the wizard selected; recompose
 * its props (`sidebar`, `showStatus`) to change it.
 */
const App: React.FC<ShellAppProps> = (props) => (
	<AppLayout showStatus>
		<Content {...props} />
	</AppLayout>
);

export default App;
