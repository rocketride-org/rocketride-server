// MIT License -- Copyright (c) 2026 Aparavi Software AG

// =============================================================================
// LOADING SCREEN -- animated loading indicator during boot/auth bootstrap
// =============================================================================
//
// Two modes:
//   1. Default: RocketRide rocket mark bobbing gently (no deep link).
//   2. App-branded: shows the target app's icon and name when deep-linking
//      via ?appId= so the user sees the app they requested, not RocketRide.
//
// Theme-aware via the same CSS custom properties the rest of the shell uses.
// =============================================================================

import React, { useState, type CSSProperties } from 'react';
import RocketRideMark from '../../icons/RocketRideMark';

// =============================================================================
// STYLES
// =============================================================================

const container: CSSProperties = {
	display: 'flex',
	height: '100vh',
	alignItems: 'center',
	justifyContent: 'center',
	flexDirection: 'column',
	gap: 16,
	fontFamily: 'var(--rr-font-family)',
};

const logoWrapper: CSSProperties = {
	animation: 'rr-loading-float 2.4s ease-in-out infinite',
};

const appIconStyle: CSSProperties = {
	width: 56,
	height: 56,
	borderRadius: 12,
	objectFit: 'contain',
};

const appNameStyle: CSSProperties = {
	fontSize: 16,
	fontWeight: 600,
	color: 'var(--rr-text-primary)',
	margin: 0,
};

const spinnerStyle: CSSProperties = {
	width: 20,
	height: 20,
	border: '2px solid var(--rr-border)',
	borderTopColor: 'var(--rr-text-secondary)',
	borderRadius: '50%',
	animation: 'rr-loading-spin 0.8s linear infinite',
};

const KEYFRAMES = `
@keyframes rr-loading-float {
	0%, 100% { transform: translateY(0); }
	50%       { transform: translateY(-8px); }
}
@keyframes rr-loading-spin {
	to { transform: rotate(360deg); }
}`;

// =============================================================================
// PROPS
// =============================================================================

interface LoadingScreenProps {
	/** Optional app info for branded loading (deep-link mode). */
	appInfo?: { name?: string; icon?: string } | null;
	/** When true, a deep link is pending — show spinner, never the rocket. */
	isDeepLink?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

const LoadingScreen: React.FC<LoadingScreenProps> = ({ appInfo, isDeepLink }) => {
	// Phase-anchor the float bob to a shared clock so home-ui's
	// AuthTransitionPage picks up exactly where this leaves off.
	const [floatDelay] = useState(() => `${-(Date.now() % 2400)}ms`);

	return (
		<div style={container}>
			<style>{KEYFRAMES}</style>
			{appInfo?.icon || appInfo?.name ? (
				<>
					{/* App-branded loading: show the target app's icon + name */}
					{appInfo.icon && (
						<img src={appInfo.icon} alt="" style={appIconStyle} />
					)}
					{appInfo.name && (
						<p style={appNameStyle}>{appInfo.name}</p>
					)}
					<div style={spinnerStyle} />
				</>
			) : isDeepLink ? (
				/* Deep link pending but app info not yet fetched — spinner only */
				<div style={spinnerStyle} />
			) : (
				/* Default: RocketRide rocket mark */
				<div style={{ ...logoWrapper, animationDelay: floatDelay }}>
					<RocketRideMark size={56} color="var(--rr-text-primary)" />
				</div>
			)}
		</div>
	);
};

export default LoadingScreen;
