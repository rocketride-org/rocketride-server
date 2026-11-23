// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP LIST ROW — compact row for the app store browse list (Apple-style)
// =============================================================================

import React, { useState, useRef, useEffect, type CSSProperties } from 'react';
import type { AppManifestEntry } from 'shell';
import type { ICatalogPalette } from './palette';
import { iconOf } from './palette';

// =============================================================================
// CONSTANTS
// =============================================================================


// Honor the OS "reduce motion" setting — same idiom as the landing components.
// The cascade now replays on every view change, so respecting this matters more.
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// =============================================================================
// TYPES
// =============================================================================

interface AppListRowProps {
	/** The colours the row draws with. */
	t: ICatalogPalette;
	/** App manifest entry. */
	app: AppManifestEntry;
	/** Called when the row is clicked (opens detail). */
	onClick: (app: AppManifestEntry) => void;
	/** Label for the action button ("Get", "Open", "Subscribe"). */
	ctaLabel?: string;
	/** Called when the action button is clicked. */
	onCta?: (app: AppManifestEntry) => void;
	/** Staggered entrance style from useStaggerReveal — spread onto the root. */
	animStyle?: CSSProperties;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Compact list row for the app store browse view.
 * 40px icon + name + description + action pill button.
 */
export const AppListRow: React.FC<AppListRowProps> = ({ app, t, onClick, ctaLabel = 'Get', onCta, animStyle }) => {
	const [hover, setHover] = useState(false);
	const [iconLoaded, setIconLoaded] = useState(false);
	const iconRef = useRef<HTMLImageElement | null>(null);
	const icon = iconOf(t, app);

	// Browser-cached images may not fire onLoad; mark loaded if already complete.
	useEffect(() => {
		const el = iconRef.current;
		if (el && el.complete && el.naturalWidth > 0) setIconLoaded(true);
	}, []);

	return (
		<div
			style={{
				display: 'flex', alignItems: 'center', gap: 14,
				padding: '12px 20px',
				borderBottom: `1px solid ${t.border}`,
				backgroundColor: hover ? t.bgSurfaceHover : 'transparent',
				cursor: 'pointer',
				fontFamily: t.font,
				transition: 'background-color 0.1s ease',
				// Staggered entrance cascade (driven by useStaggerReveal in the parent).
				...animStyle,
			}}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			onClick={() => onClick(app)}
		>
			{/* App icon */}
			<div style={{
				width: 40, height: 40, borderRadius: 4, flexShrink: 0,
				backgroundColor: t.bgSurface,
				border: `1px solid ${t.border}`,
				display: 'flex', alignItems: 'center', justifyContent: 'center',
				color: t.accent, fontSize: 18, fontWeight: 800,
				overflow: 'hidden',
			}}>
				{icon
					? <img
						ref={iconRef}
						src={icon}
						alt=""
						loading="eager"
						decoding="async"
						onLoad={() => setIconLoaded(true)}
						onError={() => setIconLoaded(true)}
						style={{
							width: 40, height: 40, objectFit: 'cover',
							opacity: iconLoaded ? 1 : 0,
							transition: REDUCE_MOTION ? 'none' : 'opacity 0.3s ease',
						}}
					/>
					: app.name[0]}
			</div>

			{/* Name + description */}
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ fontSize: 14, fontWeight: 600, color: t.textPri, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
					{app.name}
				</div>
				<div style={{ fontSize: 12, color: t.textSec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
					{app.description}
				</div>
			</div>

			{/* Action pill button */}
			<button
				style={{
					padding: '5px 18px', borderRadius: 4, flexShrink: 0,
					border: ctaLabel === 'Open' ? 'none' : `1px solid ${t.accent}`,
					backgroundColor: ctaLabel === 'Open' ? t.accent : 'transparent',
					color: ctaLabel === 'Open' ? '#fff' : t.accent,
					fontSize: 12, fontWeight: 600, cursor: 'pointer',
					fontFamily: t.font, letterSpacing: 0.2,
					transition: 'background-color 0.1s ease',
				}}
				onClick={(e) => { e.stopPropagation(); onCta?.(app); }}
			>
				{ctaLabel}
			</button>
		</div>
	);
};
