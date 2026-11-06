// MIT License
//
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
// HELLO APP — OSS landing page and app launcher
// =============================================================================
//
// The OSS landing page: top-bar chrome (logo, GitHub stars, Discord, theme
// toggle, auth button) around the SHARED desktop page (shell's DesktopView —
// greeting, rotating quote, app-card grid with the version switcher).
//
// Modes (driven by identity prop):
//   identity === null  → logged-out: shows apps + Sign In button
//   identity !== null  → logged-in: shows apps + Sign Out button
// =============================================================================

import React, { useMemo, type CSSProperties } from 'react';
import { getShellApi, AppLayout } from 'shell';
import type { ShellAppProps, AppManifestEntry, DesktopViewProps } from 'shell';
import GitHubStars from './GitHubStars';

// =============================================================================
// SHELL CONTRACT ACCESSOR
// =============================================================================
//
// Runtime shell access (hooks, connection manager, the shared desktop) flows
// through the single curated contract accessor rather than named value
// imports from shell. DesktopView postdates older shell contracts: `shell` is
// a shared module with `import: null`, so against a pre-v7 host the member is
// simply undefined — probe it guarded (an unguarded destructure of a missing
// member is the exact pattern that once took this page down in production).
const shellApi = getShellApi();
const { useWorkspace, ConnectionManager } = shellApi;
const DesktopView: React.FC<DesktopViewProps> | null =
	typeof (shellApi as { DesktopView?: unknown }).DesktopView === 'function'
		? (shellApi as unknown as { DesktopView: React.FC<DesktopViewProps> }).DesktopView
		: null;

// =============================================================================
// CONSTANTS
// =============================================================================

const DISCORD_URL = 'https://discord.gg/PMXrtenMsY';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container — full height, scrollable. */
	container: {
		height: '100%',
		overflow: 'auto',
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Top bar with logo left, badges right. */
	topBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '16px 40px 0',
		height: 68,
		flexShrink: 0,
	} as CSSProperties,

	/** Logo + brand name group in the top-left. */
	brand: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginRight: 'auto',
	} as CSSProperties,

	/** Brand name text. */
	brandName: {
		fontSize: 22,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.3,
	} as CSSProperties,

	/** Centred content area wrapping the shared desktop. */
	centre: {
		padding: '60px 40px 80px',
		minHeight: 'calc(100% - 68px)',
		boxSizing: 'border-box' as const,
	} as CSSProperties,

	/** Fallback row (pre-v7 host without DesktopView). */
	fallbackRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '10px 14px',
		borderRadius: 8,
		backgroundColor: 'var(--rr-bg-paper)',
		marginBottom: 8,
	} as CSSProperties,

	/** Fallback launch button. */
	fallbackBtn: {
		marginLeft: 'auto',
		padding: '5px 14px',
		borderRadius: 6,
		border: 'none',
		backgroundColor: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 13,
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,

	/** Sign In button. */
	authBtn: {
		padding: '7px 20px',
		borderRadius: 6,
		border: 'none',
		backgroundColor: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 14,
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,

	/** Sign Out button (secondary style). */
	signOutBtn: {
		padding: '7px 16px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		fontWeight: 500,
		cursor: 'pointer',
	} as CSSProperties,

	/** Top bar link button (Discord, etc). */
	linkBtn: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '7px 14px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontWeight: 500,
		textDecoration: 'none',
		cursor: 'pointer',
	} as CSSProperties,

	/** Sliding sun/moon theme toggle track (same control as home-ui). */
	themeToggle: {
		position: 'relative' as const,
		boxSizing: 'border-box' as const,
		width: 52,
		height: 28,
		borderRadius: 14,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		cursor: 'pointer',
		padding: 0,
		flexShrink: 0,
		transition: 'background 0.3s ease',
	} as CSSProperties,

	/** White knob that slides between the moon (left) / sun (right) positions. */
	themeKnob: {
		position: 'absolute' as const,
		top: 3,
		left: 3,
		width: 22,
		height: 22,
		borderRadius: '50%',
		backgroundColor: '#ffffff',
		boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
		transition: 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: '#475569', // slate-600 — icon on the always-white knob
	} as CSSProperties,
};

// =============================================================================
// THEME TOGGLE
// =============================================================================

/**
 * Sliding sun/moon theme toggle — the same control home-ui uses. Binary:
 * dark ('rocketride') <-> light ('rocketride-light'). Also persists the mode
 * to rr:home:theme, which the shell reads for its boot-time default theme.
 *
 * @param props.theme - The currently active theme id.
 * @param props.onSetTheme - Applies a theme id (useWorkspace().setTheme).
 */
const ThemeToggle: React.FC<{ theme: string; onSetTheme: (id: string) => void }> = ({ theme, onSetTheme }) => {
	// Any theme other than the light variants counts as dark for the toggle.
	const isDark = theme !== 'rocketride-light' && theme !== 'light';

	/** Flip between the light/dark brand themes and persist the mode. */
	const toggle = () => {
		const mode = isDark ? 'light' : 'dark';
		onSetTheme(mode === 'dark' ? 'rocketride' : 'rocketride-light');
		try { localStorage.setItem('rr:home:theme', mode); } catch { /* storage unavailable */ }
	};

	return (
		<button
			type="button"
			role="switch"
			aria-checked={!isDark}
			aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
			onClick={toggle}
			style={styles.themeToggle}
		>
			{/* Knob slides right in light mode (same geometry as home-ui: 24px travel) */}
			<span style={{ ...styles.themeKnob, transform: `translateX(${isDark ? 0 : 24}px)` }}>
				{isDark ? (
					// Moon icon
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
					</svg>
				) : (
					// Sun icon
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
					</svg>
				)}
			</span>
		</button>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * OSS landing page — top-bar chrome around the shared desktop (greeting,
 * rotating quote, app-card grid).
 *
 * @param props.identity - ConnectResult when logged in, null when not.
 */
const HomeApp: React.FC<ShellAppProps> = ({ identity }) => {
	const cm = ConnectionManager.getInstance();
	const { appManifest, prefs, setTheme } = useWorkspace();

	// The unauthenticated home owns its look (mirrors saas home-ui's
	// applyThemeMode ownership): re-assert the anonymous default — the
	// rr:home:theme mode if the visitor ever toggled, else the brand light
	// theme — so signing out doesn't leave the previous user's workspace
	// theme painted on the logged-out screen. Authenticated visits are left
	// alone: the workspace restores the account's own theme.
	React.useEffect(() => {
		if (identity) return;
		let mode: string | null = null;
		try { mode = localStorage.getItem('rr:home:theme'); } catch { /* storage unavailable */ }
		const target = mode === 'dark' ? 'rocketride' : 'rocketride-light';
		if (prefs.theme !== target) setTheme(target);
	}, [identity, prefs.theme, setTheme]);

	// The desktop rule (one rule, both editions): show what is ON THE
	// DESKTOP. OSS reports every server app onDesktop (there is no desktop
	// concept — the server inventory IS the desktop), SaaS reports the
	// user's entitlements; a probe-only entry (logged out) carries no flag
	// and stays visible as the landing grid. Self is filtered — a launcher,
	// not launchable.
	const apps = useMemo(
		() => appManifest
			.filter((a) => a.id !== 'rocketride.hello' && a.onDesktop !== false)
			.sort((a, b) => a.name.localeCompare(b.name)),
		[appManifest],
	);

	/** Launch an app by switching to it in the workspace (fallback path). */
	const handleLaunch = (app: AppManifestEntry) => {
		cm.emit('shell:switchApp', { appId: app.id });
	};

	return (
		// One-column app (no sidebar) with the status bar on.
		<AppLayout showStatus>
		<div style={styles.container}>
			{/* Top bar */}
			<div style={styles.topBar}>
				{/* Brand logo */}
				<div style={styles.brand}>
					<svg width="36" height="36" viewBox="0 0 191 192" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', flexShrink: 0 }}>
						<path d="M159.5 161.424L153.7 167.224C151.9 169.024 148.9 169.024 147 167.224L126.6 146.824C115.6 135.824 115.6 118.024 126.6 107.024C138.1 95.5245 138.1 76.9245 126.6 65.4245L125.1 63.9245C113.6 52.4245 95 52.4245 83.5 63.9245C72.5 74.9245 54.6 74.9245 43.6 63.9245L23.2 43.5245C21.4 41.7245 21.4 38.7245 23.2 36.8245L29 31.0245C37 23.0245 49.1 20.5245 59.6 24.9245L87.5 36.3245C97.3 40.1245 108.4 38.0245 116.3 31.1245L137 10.4245C138.6 8.92449 140.4 7.42449 142.5 6.22449C146.2 4.12449 150.3 3.02449 154.5 2.62449L185.4 0.0244895C188.3 -0.275511 190.8 2.22449 190.5 5.12449L187.8 36.4245C187.3 42.8245 184.5 48.8245 180.1 53.5245L160.5 73.1245C152.5 81.2245 150.1 93.3245 154.5 103.824L155.5 106.224L161.2 120.024L165.6 130.924C169.9 141.424 167.5 153.524 159.5 161.524V161.424Z" fill="currentColor" fillOpacity={0.85} />
						<path d="M0.799997 190.325C-0.200003 189.325 -0.300003 187.625 0.599997 186.425L21.1 162.024C31.1 150.024 37.9 137.725 41.3 125.325C43.6 116.625 44.6 108.525 44.1 101.225C44.1 100.325 44.4 99.4245 45.1 98.8245C45.8 98.2245 46.8 97.9245 47.7 98.1245C65 101.625 83.5 98.3245 98.5 88.9245C99.6 88.2245 101.1 88.4245 102 89.3245C102.9 90.2245 103.1 91.7245 102.4 92.8245C93 107.825 89.7 126.325 93.2 143.525C93.4 144.325 93.2 145.225 92.6 145.925C92 146.625 91 147.225 90.1 147.125C82.8 146.625 74.6 147.525 66 149.925C53.6 153.225 41.2 160.025 29.3 170.125L4.9 190.625C3.8 191.525 2.1 191.525 0.999997 190.425H0.799997V190.325Z" fill="#F93822" />
					</svg>
					<span style={styles.brandName}>RocketRide</span>
				</div>

				{/* GitHub stars */}
				<GitHubStars />

				{/* Discord */}
				<a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" style={styles.linkBtn}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
					</svg>
					Discord
				</a>

				{/* Theme toggle — sliding sun/moon pill, same control as home-ui */}
				<ThemeToggle theme={prefs.theme} onSetTheme={setTheme} />

				{/* Auth button */}
				{identity ? (
					<button
						style={styles.signOutBtn}
						onClick={() => cm.emit('shell:logoutRequest', {})}
					>
						Sign Out
					</button>
				) : (
					<button
						style={styles.authBtn}
						onClick={() => cm.emit('shell:loginRequest', {})}
					>
						Sign In
					</button>
				)}
			</div>

			{/* Content — the SHARED desktop (greeting, quote, card grid).
			    Launch, versions, remove and status are internal to the
			    component (identical calls on OSS and SaaS). */}
			<div style={styles.centre}>
				{DesktopView ? (
					<DesktopView
						apps={apps}
						greetingOverride={!identity ? 'Welcome to RocketRide' : undefined}
						showQuote={!!identity}
					/>
				) : (
					// Degraded fallback for a pre-v7 host: a minimal name+launch
					// list — never a crash.
					<div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>
						{apps.map((app) => (
							<div key={app.id} style={styles.fallbackRow}>
								<span style={{ fontWeight: 600, color: 'var(--rr-text-primary)' }}>{app.name}</span>
								<span style={{ fontSize: 13, color: 'var(--rr-text-secondary)' }}>{app.description}</span>
								<button style={styles.fallbackBtn} onClick={() => handleLaunch(app)}>Open</button>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
		</AppLayout>
	);
};

export default HomeApp;
