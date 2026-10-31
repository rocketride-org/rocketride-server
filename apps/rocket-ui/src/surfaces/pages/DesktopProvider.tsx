// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP PROVIDER — the shared desktop page as a document tab
// =============================================================================
//
// Opened as a static document with URI 'desktop' from the sidebar's Apps tab.
// Renders shell's shared DesktopView (greeting + rotating quote + app-card
// grid); launch, version switching, remove and subscription status are all
// internal to the component. rocket-ui runs inside the shell runtime, so the
// component's built-in server adapter applies — this provider only supplies
// the app list and a scrollable document body.
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { getShellApi } from 'shell';
import type { DesktopViewProps } from 'shell';

// DesktopView postdates older shell contracts: `shell` is a shared module
// with `import: null`, so against a host whose shell predates the member
// it is simply undefined — probe it guarded rather than crash the tab.
const shellApi = getShellApi();
const { useSubscriptions } = shellApi;
const DesktopView: React.FC<DesktopViewProps> | null =
	typeof (shellApi as { DesktopView?: unknown }).DesktopView === 'function'
		? (shellApi as unknown as { DesktopView: React.FC<DesktopViewProps> }).DesktopView
		: null;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		flex: 1,
		overflowY: 'auto',
		backgroundColor: 'var(--rr-bg-default)',
		padding: '48px 40px 64px',
		boxSizing: 'border-box',
	},
	unavailable: {
		padding: 24,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Desktop document tab: the shared desktop over the user's desktop apps
 * (self and the home app filtered out — they are launchers, not launchable).
 */
const DesktopProvider: React.FC = () => {
	const { desktopApps } = useSubscriptions();

	const apps = useMemo(
		() => desktopApps
			.filter((a) => a.id !== 'rocketride.home' && a.id !== 'rocketride.hello' && a.id !== 'rocketride.pipeBuilder')
			.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
		[desktopApps],
	);

	if (!DesktopView) {
		return <div style={styles.unavailable}>The desktop requires a newer shell.</div>;
	}

	return (
		<div style={styles.container}>
			<DesktopView apps={apps} />
		</div>
	);
};

export default DesktopProvider;
