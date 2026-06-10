// MIT License — Copyright (c) 2026 Aparavi Software AG

// =============================================================================
// LOADING SCREEN — animated rocket mark shown during the boot/auth bootstrap
// =============================================================================
//
// Replaces the plain "Loading..." text with the brand rocket mark gently
// bobbing up and down, mirroring home-ui's AuthTransitionPage so the shell's
// initial load and the post-OAuth transition read as one continuous animation.
// Theme-aware via the same CSS custom properties the rest of the shell uses.
// =============================================================================

import React, { type CSSProperties } from 'react';
import RocketRideMark from '../../icons/RocketRideMark';

const container: CSSProperties = {
	display: 'flex',
	height: '100vh',
	alignItems: 'center',
	justifyContent: 'center',
};

const logoWrapper: CSSProperties = {
	animation: 'rr-loading-float 2.4s ease-in-out infinite',
};

const KEYFRAMES = `@keyframes rr-loading-float {
	0%, 100% { transform: translateY(0); }
	50%       { transform: translateY(-8px); }
}`;

const LoadingScreen: React.FC = () => (
	<div style={container}>
		<style>{KEYFRAMES}</style>
		<div style={logoWrapper}>
			<RocketRideMark size={56} color="var(--rr-text-primary)" />
		</div>
	</div>
);

export default LoadingScreen;
