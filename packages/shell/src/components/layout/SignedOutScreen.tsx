// MIT License — Copyright (c) 2026 Aparavi Software AG

// =============================================================================
// SIGNED-OUT SCREEN — the ONE signed-out surface for an auth-required app
// =============================================================================
//
// Rendered full-screen wherever a signed-out session faces an app that
// requires auth and auto-login must not (or cannot) fire: the top-level
// tab's signed-out hold (ShellLayout) and the embedded preview's sign-in
// prompt (Shell). The two used to be independent hand-rolled markups that
// drifted apart; the MECHANICS still differ per host (full-page redirect vs
// the auth popup — that is the caller's onSignIn), but the presentation is
// this one component, so it cannot drift again.
//
// Branded by design: shows the APP's icon and name, never the platform
// mark — an app-locked tab is the app's surface, not RocketRide's.
// =============================================================================

import React, { type CSSProperties, type ReactNode } from 'react';
import { AppIcon } from './useSidebarFooterMenu';
import { Button } from '../button/Button';

const styles = {
	screen: {
		display: 'flex',
		height: '100vh',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 14,
		padding: 40,
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-primary)',
		backgroundColor: 'var(--rr-bg-default)',
		textAlign: 'center',
	} as CSSProperties,
	title: {
		fontSize: 18,
		fontWeight: 700,
	} as CSSProperties,
	note: {
		margin: 0,
		fontSize: 13,
		lineHeight: 1.6,
		color: 'var(--rr-text-secondary)',
		maxWidth: 420,
	} as CSSProperties,
};

/** Props for {@link SignedOutScreen}. */
export interface ISignedOutScreenProps {
	/** The app's display name ("You are signed out of <name>"). */
	appName: string;
	/** The app's manifest icon URL; absent, AppIcon renders its monogram. */
	iconUrl?: string;
	/** Starts the host's sign-in flow (redirect, popup — the caller owns it). */
	onSignIn: () => void;
	/** Optional extra line under the title — the embedded preview explains
	 *  its separate-window sign-in here; top-level tabs need nothing. */
	note?: ReactNode;
}

/** The shared full-screen signed-out surface (see the module header). */
export function SignedOutScreen({ appName, iconUrl, onSignIn, note }: ISignedOutScreenProps): React.ReactElement {
	return (
		<div style={styles.screen}>
			<AppIcon name={appName} iconUrl={iconUrl} size={56} />
			<div style={styles.title}>You are signed out of {appName}</div>
			{note != null && <p style={styles.note}>{note}</p>}
			<Button onClick={onSignIn}>Sign in</Button>
		</div>
	);
}
