// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP APP CARD — one launchable app tile on the shared desktop
// =============================================================================
//
// Port of home-ui's DesktopAppCard onto shell CSS variables: 52px icon chip
// with name + category in a top row, description below, version chip bottom-
// left, hover X with a remove/unsubscribe confirm popover, past_due badge,
// dev-served accent tint, staggered-entrance support.
//
// Accessibility: the CARD is not the control — a role="button" card would
// make the version chip an interactive descendant of a button, which
// assistive technologies expose incorrectly. A transparent launch-overlay
// BUTTON covers the card instead (hello-ui's proven pattern); the chip and X
// stay SIBLING controls raised above it.

import React, { useState, useRef, useEffect, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import type { DesktopApp, DesktopAdapter, DesktopVersionRow, DesktopVersionOverride } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Honor the OS "reduce motion" setting. */
const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Category ids whose display label is not a simple capitalisation. */
const CATEGORY_LABELS: Record<string, string> = {
	ai: 'AI',
	devtool: 'Dev Tool',
};

/** Tallest the version drop list gets before it scrolls (about ten rows). */
const VERSION_LIST_MAX_HEIGHT = 360;
/** Shortest cap worth showing; below this the list scrolls in a tiny box. */
const VERSION_LIST_MIN_HEIGHT = 140;
/** Breathing room kept between the list's edge and the sticky nav or viewport. */
const VERSION_LIST_GAP = 12;

/**
 * Format a manifest category id for display.
 *
 * @param cat - Raw category id from the app manifest (e.g. "tools").
 * @returns Display label (e.g. "Tools").
 */
const formatCategory = (cat: string): string =>
	CATEGORY_LABELS[cat.toLowerCase()] ?? cat.charAt(0).toUpperCase() + cat.slice(1);

/** Where the version drop list opens and how tall it may get. */
interface VersionListPlacement {
	/** 'above' grows upward from the chip (the default); 'below' hangs under it. */
	side: 'above' | 'below';
	/** Pixel height the list may use before it scrolls. */
	maxHeight: number;
}

/**
 * Placement for the version drop list. The list grows UPWARD from the chip,
 * and with no cap a long rail climbs under the host's sticky header (higher
 * z-index, clicks never reach it) and past the top of the page's scroll area,
 * where no scrolling can bring it back: the newest rows become unclickable.
 * Cap the list to the room between the header's bottom edge and the chip so
 * it scrolls inside its box instead. When the card sits right under the
 * header and that room is too small to be usable, open downward.
 *
 * @param chip - The version chip the list anchors to (null before mount).
 * @param boundarySelector - CSS selector of the host's sticky header; absent
 *   → the viewport top is the boundary.
 * @returns Side to open on and the height cap.
 */
function measureVersionList(chip: HTMLElement | null, boundarySelector?: string): VersionListPlacement {
	if (!chip) return { side: 'above', maxHeight: VERSION_LIST_MAX_HEIGHT };
	const rect = chip.getBoundingClientRect();
	const nav = boundarySelector ? document.querySelector(boundarySelector) : null;
	const navBottom = nav ? nav.getBoundingClientRect().bottom : 0;
	const roomAbove = rect.top - navBottom - VERSION_LIST_GAP;
	if (roomAbove >= VERSION_LIST_MIN_HEIGHT) {
		return { side: 'above', maxHeight: Math.min(VERSION_LIST_MAX_HEIGHT, roomAbove) };
	}
	const roomBelow = window.innerHeight - rect.bottom - VERSION_LIST_GAP;
	return { side: 'below', maxHeight: Math.max(VERSION_LIST_MIN_HEIGHT, Math.min(VERSION_LIST_MAX_HEIGHT, roomBelow)) };
}

// =============================================================================
// TYPES
// =============================================================================

/** Props for one desktop app card. */
export interface DesktopAppCardProps {
	/** App facts to render. */
	app: DesktopApp;
	/** Called when the user activates the card. */
	onLaunch: (appId: string) => void;
	/** Server adapter (the view always supplies one). */
	adapter: DesktopAdapter;
	/** Subscription status (e.g. "subscribed", "free", "past_due"). */
	status?: string;
	/** Allow the hover X + remove/unsubscribe popover. */
	allowRemove: boolean;
	/** Theme-adaptive icon override; default is the manifest icon. */
	resolveIcon?: (app: DesktopApp) => string | undefined;
	/** CSS selector of the host's sticky header for drop-list placement. */
	popoverBoundarySelector?: string;
	/** Staggered entrance style from useStaggerReveal — spread onto the root. */
	animStyle?: CSSProperties;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * One desktop app card: click to launch; version chip bottom-left (BUTTON-
 * shaped for the app's developer org — the chip is their rail door); hover X
 * opens the remove/unsubscribe confirmation.
 */
export const DesktopAppCard: React.FC<DesktopAppCardProps> = ({
	app, onLaunch, adapter, status, allowRemove, resolveIcon, popoverBoundarySelector, animStyle,
}) => {
	const icon = resolveIcon ? resolveIcon(app) : app.icon;
	const [hover, setHover] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [iconLoaded, setIconLoaded] = useState(false);
	// Version drop list — rows load lazily on first open
	const [versionsOpen, setVersionsOpen] = useState(false);
	const [versionRows, setVersionRows] = useState<DesktopVersionRow[] | null>(null);
	// A failed version pick renders inline in the popover — a silent close
	// reads as "the click did nothing".
	const [versionError, setVersionError] = useState<string | null>(null);
	// Measured on each open: the room around the chip changes with scrolling
	const [versionList, setVersionList] = useState<VersionListPlacement>({ side: 'above', maxHeight: VERSION_LIST_MAX_HEIGHT });
	// Bumped after select/reset so the chip re-reads the session override
	const [overrideSeq, setOverrideSeq] = useState(0);
	const popoverRef = useRef<HTMLDivElement>(null);
	const versionPopoverRef = useRef<HTMLDivElement>(null);
	const versionTriggerRef = useRef<HTMLButtonElement>(null);
	const iconRef = useRef<HTMLImageElement | null>(null);

	// Both or neither: reading an override we could never clear would strand
	// the user — without the pair the version is a plain label.
	const versionOverridesSupported =
		typeof adapter.getVersionOverride === 'function' && typeof adapter.applyVersionOverride === 'function';

	// Browser-cached images may not fire onLoad; mark loaded if already complete.
	useEffect(() => {
		const el = iconRef.current;
		if (el && el.complete && el.naturalWidth > 0) setIconLoaded(true);
	}, []);

	// Close the confirm popover on outside click
	useEffect(() => {
		if (!confirmOpen) return;
		const handler = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setConfirmOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [confirmOpen]);

	// Close the version drop list on outside click
	useEffect(() => {
		if (!versionsOpen) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			// The chip is part of the widget: closing on its mousedown would
			// fight the click toggle and immediately re-open the list —
			// making the chip unable to close it.
			if (versionTriggerRef.current && versionTriggerRef.current.contains(target)) return;
			if (versionPopoverRef.current && !versionPopoverRef.current.contains(target)) {
				setVersionsOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [versionsOpen]);

	// Keep the placement honest while the list is open: a page scroll or a
	// window resize moves the chip relative to the header and the viewport.
	useEffect(() => {
		if (!versionsOpen) return;
		const remeasure = (e?: Event) => {
			// The list scrolling inside its own box does not move the chip.
			const target = e?.target;
			if (target instanceof Node && versionPopoverRef.current && versionPopoverRef.current.contains(target)) return;
			const next = measureVersionList(versionTriggerRef.current, popoverBoundarySelector);
			// Same placement as before: keep the old object so React skips the render.
			setVersionList((prev) => (prev.side === next.side && prev.maxHeight === next.maxHeight ? prev : next));
		};
		window.addEventListener('resize', remeasure);
		// Scroll events do not bubble; capture catches the page container's.
		document.addEventListener('scroll', remeasure, true);
		return () => {
			window.removeEventListener('resize', remeasure);
			document.removeEventListener('scroll', remeasure, true);
		};
	}, [versionsOpen, popoverBoundarySelector]);

	// Subscription state
	const blocked = status === 'past_due';
	const isPastDue = status === 'past_due';
	const isSubscribed = status === 'subscribed' || status === 'trialing';
	const canRemove = allowRemove && (typeof adapter.removeApp === 'function' || typeof adapter.unsubscribeApp === 'function');

	const category = app.categories?.[0] ? formatCategory(app.categories[0]) : null;

	// Effective source — an explicit session override outranks the dev
	// overlay (matching resolveServerEntry's precedence): the user picked a
	// SERVER version, so the tile presents as a normal published tile even
	// while an editor keeps a live dev registration. Only an un-overridden
	// dev registration renders the dev treatment (chip + tinted card).
	// An override shows the OVERRIDDEN version's semver plus its registry
	// number ("0.1.0 v6"); the published default shows bare semver.
	// eslint-disable-next-line react-hooks/exhaustive-deps -- overrideSeq forces the re-read after select/reset
	const override = React.useMemo<DesktopVersionOverride | null>(
		() => (versionOverridesSupported ? adapter.getVersionOverride!(app.id) : null),
		[app.id, overrideSeq],
	);
	const devServed = !!app.dev && !override;
	const versionLabel = devServed
		? 'dev'
		: override
			? `${override.appVersion ? `${override.appVersion} ` : ''}v${override.version}`
			: (app.version ?? '');

	// Developer affordance: when the app id lives inside the caller org's
	// developer namespace, the chip renders as a button and the drop list is
	// the org's rail door (the server answers the rail verb by role).
	const [developerId, setDeveloperId] = useState('');
	useEffect(() => {
		if (typeof adapter.getDeveloperId !== 'function') return;
		let alive = true;
		const resolve = () => {
			void adapter.getDeveloperId!().then((id) => { if (alive) setDeveloperId(id); });
		};
		resolve();
		const off = adapter.onDeveloperIdChanged?.(resolve);
		return () => {
			alive = false;
			off?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the adapter is stable for the view's lifetime
	}, []);
	const isDeveloper = !!developerId && app.id.startsWith(`${developerId}.`);

	/** Toggle the drop list; fetch the servable versions on first open. The
	 * rail verb answers by role — the developer org sees its FULL rail
	 * (published or not), everyone else their caller-visible versions. */
	const toggleVersions = async (e: React.SyntheticEvent) => {
		e.stopPropagation();
		if (!versionsOpen) setVersionList(measureVersionList(versionTriggerRef.current, popoverBoundarySelector));
		setVersionsOpen((v) => !v);
		setVersionError(null);
		if (versionRows !== null) return;
		try {
			const rows = adapter.listVersions ? await adapter.listVersions(app.id) : [];
			setVersionRows(rows);
		} catch {
			// No registry data (e.g. built-in app) — chip still shows the current version
			setVersionRows([]);
		}
	};

	/** Launch a specific version: apply the session override (numbers only —
	 * the load URL is constructed client-side; entitlement is enforced by
	 * the serve route at fetch time, so there is nothing to mint or await). */
	const selectVersion = (e: React.SyntheticEvent, row: DesktopVersionRow) => {
		e.stopPropagation();
		if (!adapter.applyVersionOverride) return;
		let result: string | void;
		try {
			result = adapter.applyVersionOverride(app.id, app.moduleId, {
				version: row.registryVersion,
				appVersion: row.appVersion,
			});
		} catch (err) {
			setVersionError(err instanceof Error ? err.message : 'Could not switch version');
			return;
		}
		setVersionsOpen(false);
		setOverrideSeq((n) => n + 1);
		// A loaded container cannot be repointed — reboot registers the
		// override before anything loads; otherwise launch right away.
		if (result === 'reload-required') { window.location.reload(); return; }
		if (!blocked) onLaunch(app.id);
	};

	/** Drop the session override — back to the server's default resolution. */
	const resetVersion = (e: React.SyntheticEvent) => {
		e.stopPropagation();
		if (!adapter.applyVersionOverride) return;
		const result = adapter.applyVersionOverride(app.id, app.moduleId, null);
		setVersionError(null);
		setVersionsOpen(false);
		setOverrideSeq((n) => n + 1);
		if (result === 'reload-required') window.location.reload();
	};

	const clamp2: CSSProperties = {
		display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
		overflow: 'hidden',
	};

	// Surface colors — dev-SERVED tiles (live editor registration, no
	// override) wear an accent tint so local-dev cards are unmistakable at a
	// glance; overridden/published tiles keep the plain surface.
	const restSurface = 'var(--rr-bg-paper)';
	const hoverSurface = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';
	const surface = devServed
		? `color-mix(in srgb, var(--rr-brand) ${hover ? 12 : 8}%, ${hover ? hoverSurface : restSurface})`
		: (hover ? hoverSurface : restSurface);

	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				position: 'relative',
				display: 'flex', flexDirection: 'column', gap: 14,
				padding: 20, borderRadius: 12, boxSizing: 'border-box',
				backgroundColor: surface,
				fontFamily: 'var(--rr-font-family)',
				transform: hover && !blocked && !REDUCE_MOTION ? 'translateY(-2px)' : 'none',
				transition: REDUCE_MOTION
					? 'none'
					: 'transform 0.12s ease, background-color 0.12s ease',
				...animStyle,
				// The hover transform makes the card a stacking context, so the
				// open version list's own zIndex cannot clear the cards in the
				// next grid row when it hangs below the chip. Lift the card
				// itself while the list is open.
				zIndex: versionsOpen ? 20 : undefined,
			}}
		>
			{/* Launch control — a sibling of the chip/X, not their ancestor: the
			    card itself is inert, this overlay carries the activation over
			    the card's whole area. */}
			<button
				type="button"
				aria-label={`Open ${app.name}`}
				disabled={blocked}
				onClick={() => { if (!blocked && !confirmOpen) onLaunch(app.id); }}
				style={{
					position: 'absolute', inset: 0, zIndex: 0,
					margin: 0, padding: 0, border: 'none', borderRadius: 12,
					backgroundColor: 'transparent',
					cursor: blocked ? 'default' : 'pointer',
				}}
			/>

			{/* Top row — icon chip + name/category. Borderless icon chip — the
			    surface tint alone frames the icon. */}
			<div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }}>
				<div style={{
					width: 52, height: 52, flexShrink: 0, borderRadius: 12, overflow: 'hidden',
					backgroundColor: 'var(--rr-bg-surface-alt)',
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					color: 'var(--rr-brand)', fontSize: 22, fontWeight: 800,
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
						fontSize: 16, fontWeight: 700, color: 'var(--rr-text-primary)',
						whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
					}}>
						{app.name}
					</div>
					{category && (
						<div style={{
							fontSize: 13, color: 'var(--rr-text-secondary)', marginTop: 2,
							whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
						}}>
							{category}
						</div>
					)}
				</div>

				{/* Payment blocked badge */}
				{isPastDue && (
					<span style={{
						flexShrink: 0,
						padding: '4px 10px', borderRadius: 4,
						fontSize: 12, fontWeight: 600,
						backgroundColor: 'rgba(234,179,8,0.15)', color: '#eab308',
					}}>
						Payment Required
					</span>
				)}
			</div>

			{/* Description — full width below */}
			<div style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--rr-text-secondary)', ...clamp2 }}>
				{app.description || 'No description'}
			</div>

			{/* Version chip — bottom-left, faint; opens the drop list. Raised
			    above the launch overlay so the chip takes its own clicks. */}
			{versionLabel && (
				<div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto', position: 'relative', zIndex: 1 }}>
					{!versionOverridesSupported ? (
						// No override API: the version is a plain label, and the
						// drop list it would open cannot do anything.
						<span style={{
							fontSize: 11, fontWeight: 500,
							color: 'var(--rr-text-secondary)', opacity: 0.65,
						}}>
							{versionLabel}
						</span>
					) : (
						<button
							type="button"
							ref={versionTriggerRef}
							title="Switch version"
							aria-haspopup="listbox"
							aria-expanded={versionsOpen}
							style={{
								display: 'inline-flex', alignItems: 'center', gap: 4,
								fontSize: 11, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
								// Developers get a BUTTON-shaped chip: the version line is
								// their rail door, not just a label.
								...(isDeveloper
									? {
										padding: '3px 9px', borderRadius: 6,
										border: '1px solid var(--rr-border)',
										backgroundColor: 'transparent', color: 'var(--rr-text-secondary)', opacity: 1,
									}
									: {
										padding: 0, border: 'none',
										backgroundColor: 'transparent', color: 'var(--rr-text-secondary)', opacity: 0.65,
									}),
							}}
							onClick={toggleVersions}
							onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
						>
							{versionLabel}
						</button>
					)}
				</div>
			)}

			{/* Version drop list */}
			{versionsOpen && (
				<div
					ref={versionPopoverRef}
					role="listbox"
					style={{
						position: 'absolute', left: 16, zIndex: 10,
						// Above the chip by default; under it when the card sits
						// right below the host's header. 16px from the card's bottom
						// edge is just under the chip (20px padding minus a 4px gap).
						...(versionList.side === 'above' ? { bottom: 44 } : { top: 'calc(100% - 16px)' }),
						minWidth: 230, padding: '6px 0', borderRadius: 10,
						// Long rails scroll inside the box instead of climbing
						// under the header; see measureVersionList. Reaching the end
						// of the list must not scroll the page out from under it.
						maxHeight: versionList.maxHeight, overflowY: 'auto', overscrollBehavior: 'contain',
						backgroundColor: 'var(--rr-bg-paper)',
						border: '1px solid var(--rr-border)',
						boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{versionError && (
						<div style={{ padding: '7px 14px 4px', fontSize: 11, color: 'var(--rr-color-error)' }}>{versionError}</div>
					)}
					{versionRows === null && (
						<div style={{ padding: '7px 14px 4px', fontSize: 11, color: 'var(--rr-text-secondary)' }}>Loading versions…</div>
					)}
					{versionRows !== null && versionRows.length === 0 && (
						<div style={{ padding: '7px 14px 4px', fontSize: 11, color: 'var(--rr-text-secondary)' }}>No other versions available</div>
					)}
					{versionRows !== null && versionRows.map((row) => {
						// Match on the registry version (the wire identity), never
						// the display semver — two registry records can share one
						// appVersion, which would light both rows as current. The
						// manifest carries the resolved default's registry number,
						// so the current row is knowable with or without an override.
						const isCurrent = row.registryVersion === (override?.version ?? app.registryVersion);
						return (
							<button
								key={row.registryVersion}
								type="button"
								role="option"
								aria-selected={isCurrent}
								style={{
									display: 'flex', alignItems: 'baseline', gap: 8, width: '100%',
									padding: '7px 14px', border: 'none', backgroundColor: 'transparent',
									color: 'var(--rr-text-primary)', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
									textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
								}}
								onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
								onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
								onClick={(e) => selectVersion(e, row)}
							>
								{row.appVersion ? `${row.appVersion} ` : ''}v{row.registryVersion}
								<span style={{ fontSize: 11, fontWeight: 400, color: 'var(--rr-text-secondary)' }}>{row.handles.join(' · ')}</span>
								{isCurrent && (
									<span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--rr-brand)' }}>
										current
									</span>
								)}
							</button>
						);
					})}
					{override && (
						<button
							type="button"
							style={{
								display: 'flex', width: '100%', padding: '7px 14px', border: 'none',
								backgroundColor: 'transparent', color: 'var(--rr-text-primary)', fontSize: 12.5,
								fontWeight: 600, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer',
								boxSizing: 'border-box',
							}}
							onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
							onClick={resetVersion}
						>
							Reset to default
						</button>
					)}
					{versionRows !== null && versionRows.length > 0 && (
						<div style={{ padding: '7px 14px 4px', fontSize: 11, color: 'var(--rr-text-secondary)' }}>
							Session only — clears when this tab closes
						</div>
					)}
				</div>
			)}

			{/* X button — visible on hover (needs a remove/unsubscribe action) */}
			{canRemove && hover && !confirmOpen && (
				<button
					style={{
						position: 'absolute', top: 8, right: 8, zIndex: 1,
						width: 24, height: 24, borderRadius: '50%',
						border: 'none', backgroundColor: 'var(--rr-bg-surface-alt)',
						color: 'var(--rr-text-secondary)', cursor: 'pointer',
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						padding: 0, transition: 'color 0.1s ease',
					}}
					onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
					onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--rr-text-secondary)'; }}
					onClick={(e) => { e.stopPropagation(); setConfirmOpen(true); }}
					title="Remove from desktop"
				>
					<X size={13} />
				</button>
			)}

			{/* Confirmation popover */}
			{confirmOpen && (
				<div
					ref={popoverRef}
					style={{
						position: 'absolute', top: -4, right: -4,
						zIndex: 10,
						backgroundColor: 'var(--rr-bg-paper)',
						border: '1px solid var(--rr-border)',
						borderRadius: 8,
						boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
						padding: '10px 4px',
						display: 'flex', flexDirection: 'column', gap: 2,
						minWidth: 170,
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{/* Remove from desktop — hidden for past_due (must cancel instead) */}
					{!isPastDue && typeof adapter.removeApp === 'function' && (
						<button
							style={{
								display: 'block', width: '100%', textAlign: 'left',
								padding: '7px 14px', border: 'none', borderRadius: 4,
								backgroundColor: 'transparent', color: 'var(--rr-text-primary)',
								fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
							}}
							onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
							onClick={() => { setConfirmOpen(false); adapter.removeApp!(app.id); }}
						>
							Remove from Desktop
						</button>
					)}

					{/* Cancel subscription — for subscribed, trialing, or past_due */}
					{(isSubscribed || isPastDue) && typeof adapter.unsubscribeApp === 'function' && (
						<button
							style={{
								display: 'block', width: '100%', textAlign: 'left',
								padding: '7px 14px', border: 'none', borderRadius: 4,
								backgroundColor: 'transparent', color: '#ef4444',
								fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
							}}
							onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.08)'; }}
							onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
							onClick={() => { setConfirmOpen(false); adapter.unsubscribeApp!(app.id); }}
						>
							Cancel Subscription
						</button>
					)}
				</div>
			)}
		</div>
	);
};
