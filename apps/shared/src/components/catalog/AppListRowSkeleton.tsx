// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP LIST ROW SKELETON — shimmer placeholder shown while the catalog loads
// =============================================================================

import React from 'react';
import type { ICatalogPalette } from './palette';

// Honor the OS "reduce motion" setting — match the landing components' idiom.
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// =============================================================================
// TYPES
// =============================================================================

interface AppListRowSkeletonProps {
	/** The colours the placeholder draws with. */
	t: ICatalogPalette;
	/** Row position — used to offset the shimmer so the rows pulse out of sync. */
	index?: number;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Placeholder row that mirrors {@link AppListRow}'s layout (40px icon + two text
 * lines + pill) with a soft pulsing shimmer. Each row's animation is delayed by
 * its index so the list breathes rather than blinking in unison.
 */
export const AppListRowSkeleton: React.FC<AppListRowSkeletonProps> = ({ t, index = 0 }) => {

	// Pulses opacity 0.14 → 0.30, alternating, staggered per row. With reduced
	// motion, render a static, faint placeholder instead of pulsing.
	const shimmer = (extraDelay = 0): React.CSSProperties => ({
		backgroundColor: t.textSec,
		...(REDUCE_MOTION
			? { opacity: 0.22 }
			: {
				animation: 'rr-placeholder-pulse 1s ease-in-out infinite alternate',
				animationDelay: `${index * 90 + extraDelay}ms`,
			}),
		borderRadius: 4,
	});

	return (
		<div
			aria-hidden
			style={{
				display: 'flex', alignItems: 'center', gap: 14,
				padding: '12px 20px',
				borderBottom: `1px solid ${t.border}`,
			}}
		>
			{/* Icon placeholder */}
			<div style={{ ...shimmer(), width: 40, height: 40, borderRadius: 4, flexShrink: 0 }} />

			{/* Name + description placeholders */}
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ ...shimmer(0), width: '32%', height: 11 }} />
				<div style={{ ...shimmer(120), width: '58%', height: 9, marginTop: 7 }} />
			</div>

			{/* CTA pill placeholder */}
			<div style={{ ...shimmer(60), width: 64, height: 26, borderRadius: 4, flexShrink: 0 }} />
		</div>
	);
};
