// MIT License — Copyright (c) 2026 Aparavi Software AG

// =============================================================================
// LOADING SCREEN — animated mark shown during the boot/auth bootstrap
// =============================================================================
//
// Replaces the plain "Loading..." text with a gently bobbing mark, mirroring
// home-ui's AuthTransitionPage so the shell's initial load and the post-OAuth
// transition read as one continuous animation. Theme-aware via the same CSS
// custom properties the rest of the shell uses.
//
// The mark is the APP'S icon whenever the screen is holding for a known app —
// callers pass the manifest icon when they have one, and the screen itself
// falls back to the tab's locked app via its local/dev registration — so a
// dev preview or deep link boots under the app's own identity. The RocketRide
// mark remains the brandless fallback.
// =============================================================================

import React, { useState, type CSSProperties } from 'react';
import { RocketRideMark } from '../RocketRideMark';
import { tabSession } from '../../util/devGate';
import { getLocalAppEntries } from '../../util/appLoader';

const container: CSSProperties = {
	display: 'flex',
	height: '100vh',
	alignItems: 'center',
	justifyContent: 'center',
};

const logoWrapper: CSSProperties = {
	animation: 'rr-loading-float 2.4s ease-in-out infinite',
};

const appIcon: CSSProperties = {
	width: 56,
	height: 56,
	borderRadius: 12,
	objectFit: 'cover',
	display: 'block',
};

const KEYFRAMES = `@keyframes rr-loading-float {
	0%, 100% { transform: translateY(0); }
	50%       { transform: translateY(-8px); }
}`;

/** Props for {@link LoadingScreen}. */
export interface ILoadingScreenProps {
	/** Icon URL of the app this screen is holding for; omitted, the screen
	 *  resolves the tab's locked app itself (dev registration), then falls
	 *  back to the RocketRide mark. */
	iconUrl?: string;
}

/** The tab's locked app id ('' when this is not an app-locked tab). */
function lockedAppId(): string {
	try {
		return tabSession().appId;
	} catch {
		return '';
	}
}

/** The tab's locked app icon: its local/dev registration, else the identity
 *  the tab session remembered from the last signed-in manifest. */
function lockedAppIcon(appId: string): string | undefined {
	if (!appId) return undefined;
	try {
		return getLocalAppEntries().find((entry) => entry.id === appId)?.icon ?? tabSession().appIcon;
	} catch {
		return undefined;
	}
}

const LoadingScreen: React.FC<ILoadingScreenProps> = ({ iconUrl }) => {
	// Phase-anchor the float bob to a shared clock (epoch, realm-independent) so home-ui's
	// AuthTransitionPage picks up exactly where this leaves off — both use the same 2.4s
	// cycle. Computed once on mount so re-renders don't restart the animation.
	const [floatDelay] = useState(() => `${-(Date.now() % 2400)}ms`);
	const appId = lockedAppId();
	const resolvedIcon = iconUrl ?? lockedAppIcon(appId);
	// An APP-LOCKED tab never shows the platform mark: until the app's own
	// icon is resolvable, hold an empty box of the same size (no layout
	// jump, no brand flash that the icon then "replaces"). The RocketRide
	// mark is only for tabs that are not about any particular app.
	const mark = resolvedIcon
		? <img src={resolvedIcon} alt="" style={appIcon} />
		: appId
			? <div style={appIcon} />
			: <RocketRideMark size={56} color="var(--rr-text-primary)" />;
	return (
		<div style={container}>
			<style>{KEYFRAMES}</style>
			<div style={{ ...logoWrapper, animationDelay: floatDelay }}>
				{mark}
			</div>
		</div>
	);
};

export default LoadingScreen;
