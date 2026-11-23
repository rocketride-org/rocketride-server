// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP CARD — minimal connectors-style tile for the app store grid
// =============================================================================

import React, { useState, useRef, useEffect, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import type { AppManifestEntry } from 'shell';
import type { ICatalogPalette } from './palette';
import { entryLabel } from './agentEntry';
import { iconOf } from './palette';

// =============================================================================
// CONSTANTS
// =============================================================================


// Honor the OS "reduce motion" setting — same idiom as the landing components.
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// =============================================================================
// TYPES
// =============================================================================

interface AppCardProps {
	/** App manifest entry. */
	app: AppManifestEntry;
	/** Theme tokens for the active theme. */
	t: ICatalogPalette;
	/** Called when the card is clicked — opens the detail drawer. */
	onOpen: (app: AppManifestEntry) => void;
	/** Top-right status pill (defaults to "Included" for built-in apps). */
	badge?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connectors-style app card: a small contained logo chip (top-aligned) on the
 * left, with the name + a 2-line muted description to its right, and a subtle
 * check on the right edge for apps that are already on the desktop. The whole
 * card is the click target (no inline CTA) — clicking, or pressing Enter/Space,
 * opens the detail drawer via onOpen.
 */
export const AppCard: React.FC<AppCardProps> = ({ app, t, onOpen, badge = 'Get App' }) => {
	// The host's palette decides which icon variant an entry shows.
	const icon = iconOf(t, app);
	const [hover, setHover] = useState(false);
	const [iconLoaded, setIconLoaded] = useState(false);
	const iconRef = useRef<HTMLImageElement | null>(null);

	// Browser-cached images may not fire onLoad; mark loaded if already complete.
	useEffect(() => {
		const el = iconRef.current;
		if (el && el.complete && el.naturalWidth > 0) setIconLoaded(true);
	}, []);

	const clamp2: CSSProperties = {
		display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
		overflow: 'hidden',
	};

	// An agent (a published pipeline) reads "Agent" whatever its categories say.
	const category = entryLabel(app);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onOpen(app)}
			onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(app); } }}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				position: 'relative',
				display: 'flex', flexDirection: 'column', gap: 14,
				padding: 20, borderRadius: 12, boxSizing: 'border-box',
				backgroundColor: hover ? t.bgSurfaceHover : t.bgSurface,
				cursor: 'pointer', fontFamily: t.font,
				transform: hover && !REDUCE_MOTION ? 'translateY(-2px)' : 'none',
				transition: REDUCE_MOTION
					? 'none'
					: 'transform 0.12s ease, background-color 0.12s ease',
			}}
		>
			{/* Top row — logo chip + name/category, with the status badge pinned right */}
			<div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
				{/* Borderless icon chip — the surface tint alone frames the icon */}
				<div style={{
					width: 52, height: 52, flexShrink: 0, borderRadius: 12, overflow: 'hidden',
					backgroundColor: t.bgSurfaceHover,
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					color: t.accent, fontSize: 22, fontWeight: 800,
				}}>
					{icon
						? <img
							ref={iconRef}
							src={icon}
							alt=""
							loading="lazy"
							decoding="async"
							onLoad={() => setIconLoaded(true)}
							onError={() => setIconLoaded(true)}
							style={{
								width: '100%', height: '100%', objectFit: 'cover',
								opacity: iconLoaded ? 1 : 0,
								transition: REDUCE_MOTION ? 'none' : 'opacity 0.3s ease',
							}}
						/>
						: app.name[0]}
				</div>

				{/* Name + category sublabel */}
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{
						fontSize: 16, fontWeight: 700, color: t.textPri,
						whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
					}}>
						{app.name}
					</div>
					{category && (
						<div style={{
							fontSize: 13, color: t.textTri, marginTop: 2,
							whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
						}}>
							{category}
						</div>
					)}
				</div>

				{/* Status badge — top-right. "Open" gets an accent-tinted "installed" look. */}
				{badge && (() => {
					const installed = badge === 'Open';
					return (
						<span style={{
							flexShrink: 0,
							display: 'inline-flex', alignItems: 'center', gap: 4,
							padding: '4px 10px', borderRadius: 4,
							fontSize: 12, fontWeight: 600,
							color: installed ? t.accent : t.textTri,
							border: `1px solid ${installed ? t.accent : t.border}`,
							backgroundColor: installed ? t.accentSoft : t.bg,
							transition: REDUCE_MOTION
								? 'none'
								: 'color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease',
						}}>
							{installed && <Check size={12} />}
							{badge}
						</span>
					);
				})()}
			</div>

			{/* Description — full width below */}
			<div style={{ fontSize: 14, lineHeight: 1.45, color: t.textSec, ...clamp2 }}>
				{app.description}
			</div>
		</div>
	);
};
