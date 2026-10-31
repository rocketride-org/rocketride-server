// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// useStaggerReveal — staggered entrance cascade for the desktop grid
// =============================================================================
//
// Copied from home-ui's hooks/useStaggerReveal (home-ui keeps its own copy for
// other surfaces), with the `rr-desktop-fade-up` keyframe self-injected so the
// hook carries no host dependency. Honors `prefers-reduced-motion`.
//
// Re-trigger model: CSS animations only fire on mount, so to replay the
// cascade when a view changes, put the returned `revealKey` on the list/grid
// CONTAINER's `key`. When `resetKey` changes, the container remounts and every
// child re-runs its entrance.

import { useEffect, useMemo, type CSSProperties } from 'react';

// =============================================================================
// CONSTANTS
// =============================================================================

const KEYFRAME_ID = 'rr-desktop-fade-up';

const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Defaults match home-ui's app-store row cascade so the "feel" is identical.
const DEFAULTS = {
	stepMs: 32,                                  // delay added per item
	maxSteps: 14,                                // cap so long lists finish ~0.45s
	durationMs: 420,
	easing: 'cubic-bezier(0.22,1,0.36,1)',
};

/** Inject the fade-up keyframe once per document. */
function injectKeyframes(): void {
	if (document.getElementById(KEYFRAME_ID)) return;
	const el = document.createElement('style');
	el.id = KEYFRAME_ID;
	el.textContent = '@keyframes rr-desktop-fade-up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}';
	document.head.appendChild(el);
}

// =============================================================================
// TYPES
// =============================================================================

export interface StaggerReveal {
	/** Place on the grid container's `key` so it remounts (replays) on view change. */
	revealKey: string;
	/** Per-index entrance style — spread onto each item's root `style`. */
	getItemStyle: (index: number) => CSSProperties;
	/** True when the OS requests reduced motion (entrance becomes a no-op). */
	reducedMotion: boolean;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Returns a container `revealKey` plus a per-item entrance-style factory for
 * a staggered fade-up cascade.
 *
 * @param resetKey - A value that changes whenever the rendered set should
 *   re-cascade (e.g. a "populated" flag). Drives the container remount.
 */
export function useStaggerReveal(resetKey: unknown): StaggerReveal {
	useEffect(() => { injectKeyframes(); }, []);

	return useMemo<StaggerReveal>(() => ({
		revealKey: String(resetKey),
		reducedMotion: REDUCE_MOTION,
		getItemStyle: (index: number): CSSProperties =>
			REDUCE_MOTION
				? {}
				: { animation: `${KEYFRAME_ID} ${DEFAULTS.durationMs}ms ${DEFAULTS.easing} ${Math.min(index, DEFAULTS.maxSteps) * DEFAULTS.stepMs}ms backwards` },
	}), [resetKey]);
}
