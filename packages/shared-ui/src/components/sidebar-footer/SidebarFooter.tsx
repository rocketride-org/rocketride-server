// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarFooter — unified footer for both shell-ui and VS Code sidebars.
 *
 * Renders (top to bottom):
 *   1. Documentation button (optional, driven by onOpenDocs)
 *   2. Avatar trigger row (when userName is provided) OR gear icon fallback
 *      (when no userName but menuItems exist) — both open the popup menu
 *   3. Connection status row (optional, driven by connection prop)
 *
 * Popup menu:
 *   - Main popup is 2/3 of sidebar width, inset by POPUP_MARGIN on each side.
 *   - Items with a `submenu` field show a chevron; clicking opens a flyout
 *     shifted 1/3 right so it peeks past the main popup while staying within
 *     the VS Code webview bounds (popups cannot escape the webview iframe).
 *   - Selecting a flyout item closes only the flyout, keeping the main popup.
 *   - Click-outside dismisses everything (no hover timers).
 *
 * Three distinct footer states (driven by host):
 *   - Anonymous + engine:   gear icon trigger, Settings + Development Mode
 *   - Cloud identity + engine: avatar trigger, full menu
 *   - Cloud-UI (always cloud):  avatar trigger, Theme/Account/Billing/etc.
 */

import React, { CSSProperties, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { commonStyles } from '../../themes/styles';
import { useFixedPopupPosition } from '../../hooks/useFixedPopupPosition';
import { PopupRow } from '../PopupRow';
import { BxBookOpen, BxCog, BxChevronRight, BxCheck, BxLock } from '../BoxIcon';
import type { IconComponent } from '../BoxIcon';

// =============================================================================
// TYPES
// =============================================================================

/** A single item in the popup menu (or a submenu). */
export interface SidebarFooterMenuItem {
	/** Unique key for React list rendering. */
	id: string;
	/** Display label. */
	label: string;
	/** Optional icon rendered before the label. */
	icon?: IconComponent;
	/** Click handler (leaf items). */
	onClick?: () => void;
	/** If provided, clicking opens a nested submenu with these items. */
	submenu?: SidebarFooterMenuItem[];
	/** Show a checkmark next to this item (for radio-style selections). */
	checked?: boolean;
	/** Secondary status line rendered below the label (e.g. "Connected", "Downloading..."). */
	statusText?: string;
	/** Connection state — drives the colored dot next to statusText. */
	statusState?: 'connected' | 'connecting' | 'disconnected';
	/** Render a horizontal divider before this item. */
	dividerBefore?: boolean;
	/** If true, render as a non-clickable section header (bold label, no hover). */
	header?: boolean;
}

export interface SidebarFooterProps {
	/** Whether the sidebar is in collapsed (icon-only) mode. */
	collapsed: boolean;

	// ── User identity ───────────────────────────────────────────────────────
	/** User display name (e.g. "RodC"). Drives the avatar initials. */
	userName?: string;
	/** User email (shown below name). */
	userEmail?: string;

	// ── Fixed footer buttons ────────────────────────────────────────────────
	/** Show a Documentation link. */
	onOpenDocs?: () => void;
	/** Opens the Environment page (shown in flat mode when connected). */
	onEnvironmentClick?: () => void;
	/** Opens the Settings page directly (used in both flat and popup modes). */
	onSettingsClick?: () => void;

	// ── Inline connection status (flat mode) ────────────────────────────────
	/**
	 * When provided, the footer renders in "flat" mode: Documentation,
	 * Settings, and connection status are shown directly — no popup.
	 */
	connectionStatus?: {
		state: 'connected' | 'connecting' | 'disconnected';
		text: string;
		message?: string;
	};

	// ── Popup menu items ────────────────────────────────────────────────────
	/** Host-specific menu items shown in the avatar popup. */
	menuItems?: SidebarFooterMenuItem[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const POPUP_MARGIN = 10;

// =============================================================================
// STYLES
// =============================================================================

const S = {
	wrapper: {
		flexShrink: 0,
		padding: '8px 8px',
	} as CSSProperties,

	docsBtn: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 10px',
		cursor: 'pointer',
		borderRadius: 8,
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,

	// ── Avatar trigger ──────────────────────────────────────────────────────
	avatarRow: (hovered: boolean, menuOpen: boolean, collapsed: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: collapsed ? '4px 0' : '4px 10px',
		justifyContent: collapsed ? 'center' : 'flex-start',
		borderRadius: 8,
		cursor: 'pointer',
		background: hovered || menuOpen ? 'var(--rr-bg-surface-alt)' : 'transparent',
		transition: 'background 100ms ease',
	}),

	avatarCircle: {
		width: 32,
		height: 32,
		borderRadius: '50%',
		background: 'var(--rr-text-secondary)',
		color: '#ffffff',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 13,
		fontWeight: 600,
		flexShrink: 0,
	} as CSSProperties,

	nameBlock: {
		overflow: 'hidden',
		minWidth: 0,
	} as CSSProperties,

	nameText: {
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.3,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	emailText: {
		fontSize: 11,
		color: 'var(--rr-brand)',
		lineHeight: 1.3,
	} as CSSProperties,

	// ── Gear trigger (fallback when no user identity) ────────────────────────
	gearTrigger: (hovered: boolean, menuOpen: boolean, collapsed: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: collapsed ? '4px 0' : '6px 10px',
		justifyContent: collapsed ? 'center' : 'flex-start',
		borderRadius: 8,
		cursor: 'pointer',
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		border: 'none',
		background: hovered || menuOpen ? 'var(--rr-bg-surface-alt)' : 'transparent',
		transition: 'background 100ms ease',
		width: '100%',
		textAlign: 'left' as const,
	}),

	// ── Popup divider ───────────────────────────────────────────────────────
	divider: commonStyles.divider,

	// ── Full-width divider (bleeds past wrapper padding) ────────────────────
	fullDivider: {
		...commonStyles.divider,
		marginLeft: -8,
		marginRight: -8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export const SidebarFooter: React.FC<SidebarFooterProps> = ({ collapsed, userName, userEmail, onOpenDocs, onEnvironmentClick, onSettingsClick, connectionStatus, menuItems }) => {
	// ── Avatar initials ─────────────────────────────────────────────────────
	const initials = useMemo(() => {
		if (!userName) return 'U';
		return userName
			.split(' ')
			.filter(Boolean)
			.map((n) => n[0])
			.join('')
			.slice(0, 2)
			.toUpperCase();
	}, [userName]);

	// ── Popup state ─────────────────────────────────────────────────────────
	const [menuOpen, setMenuOpen] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [docsHovered, setDocsHovered] = useState(false);
	const [envHovered, setEnvHovered] = useState(false);
	const triggerRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const [triggerWidth, setTriggerWidth] = useState(200);
	const menuPos = useFixedPopupPosition(triggerRef, menuOpen, 'above');

	// ── Flyout submenu state ────────────────────────────────────────────────
	// Click-to-open model: clicking a submenu row opens the flyout; clicking
	// outside (handled by the mousedown listener below) closes everything.
	const [flyoutId, setFlyoutId] = useState<string | null>(null);
	const [flyoutItems, setFlyoutItems] = useState<SidebarFooterMenuItem[]>([]);
	const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
	const flyoutRef = useRef<HTMLDivElement>(null);

	// ── Portal container for popups (escapes overflow:hidden ancestors) ─────
	// The host (VS Code webview entry, shell-ui shell) must create a
	// <div id="rr-popup-portal"> on document.body before React mounts.
	// Looked up on every render (not cached) because React 18 concurrent
	// mode can re-invoke the component in contexts where a cached ref
	// becomes stale.
	const portalContainer = typeof document !== 'undefined' ? document.getElementById('rr-popup-portal') : null;

	const handleClose = useCallback(() => {
		setMenuOpen(false);
		setFlyoutId(null);
	}, []);

	// ── Dismiss-on-leave: close popup when mouse leaves all menu elements ──
	const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelLeaveTimer = () => {
		if (leaveTimer.current) {
			clearTimeout(leaveTimer.current);
			leaveTimer.current = null;
		}
	};
	const startLeaveTimer = () => {
		cancelLeaveTimer();
		leaveTimer.current = setTimeout(handleClose, 150);
	};

	/**
	 * Opens a flyout submenu shifted 1/3 right of the main popup.
	 *
	 * Layout (within sidebar webview bounds):
	 *   |--margin--|--main popup (2/3)--|
	 *              |--flyout (2/3)------|--margin--|
	 *
	 * The flyout overlaps the right portion of the main popup and its
	 * right edge aligns with (triggerWidth - POPUP_MARGIN).
	 */
	const openFlyout = useCallback(
		(itemId: string, items: SidebarFooterMenuItem[], rowEl: HTMLElement) => {
			const rect = rowEl.getBoundingClientRect();
			const available = triggerWidth - 2 * POPUP_MARGIN;
			const sidebarLeft = (popupRef.current?.getBoundingClientRect().left ?? rect.left) - POPUP_MARGIN;
			const flyoutLeft = sidebarLeft + POPUP_MARGIN + Math.round(available / 3);
			setFlyoutId(itemId);
			setFlyoutItems(items);
			setFlyoutPos({ top: rect.top, left: flyoutLeft });
		},
		[triggerWidth]
	);

	// Close menu + flyout when clicking outside all three elements
	// (trigger, main popup, flyout). This is the only dismiss mechanism —
	// there are no hover-based close timers.
	useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (popupRef.current?.contains(target)) return;
			if (flyoutRef.current?.contains(target)) return;
			if (triggerRef.current?.contains(target)) return;
			handleClose();
		};
		document.addEventListener('mousedown', handler);
		return () => {
			document.removeEventListener('mousedown', handler);
			cancelLeaveTimer();
		};
	}, [menuOpen, handleClose]);

	// Snapshot trigger width when popup opens (used for popup/flyout sizing)
	useEffect(() => {
		if (menuOpen && triggerRef.current) {
			setTriggerWidth(triggerRef.current.getBoundingClientRect().width);
		}
	}, [menuOpen]);

	const topLevelItems = menuItems ?? [];
	const flatMode = !!connectionStatus;

	// ── Announcements ticker (flat mode) ────────────────────────────────────
	const announcements: { title: string; body: string; linkText: string; linkUrl: string }[] = useMemo(
		() => [
			{ title: 'Join us in SF', body: 'Hack-with-the-Bay, Tue June 25–26.', linkText: 'Details & RSVP', linkUrl: 'https://rocketride.dev/events/sf-hack' },
			{ title: 'RocketRide 2.4 is live', body: 'Streaming pipelines, token tracing, new connectors.', linkText: 'See what\'s new', linkUrl: 'https://rocketride.dev/changelog' },
			{ title: 'NYC Meetup', body: 'AI Pipeline Workshop, Thu July 10.', linkText: 'Register now', linkUrl: 'https://rocketride.dev/events/nyc-workshop' },
			{ title: 'New RAG template', body: 'Pinecone + OpenAI in 3 nodes — ready to go.', linkText: 'Try it out', linkUrl: 'https://rocketride.dev/templates/rag-pinecone' },
			{ title: 'Community spotlight', body: '1,200+ pipelines built this month.', linkText: 'Join Discord', linkUrl: 'https://discord.gg/rocketride' },
		],
		[]
	);
	const [tickerIndex, setTickerIndex] = useState(0);
	const [tickerFade, setTickerFade] = useState(true);

	useEffect(() => {
		if (announcements.length === 0) return;
		const interval = setInterval(() => {
			setTickerFade(false);
			setTimeout(() => {
				setTickerIndex((i) => (i + 1) % announcements.length);
				setTickerFade(true);
			}, 300);
		}, 7000);
		return () => clearInterval(interval);
	}, [announcements.length]);

	// ── Render ──────────────────────────────────────────────────────────────

	// ── Flat mode: no popup, render items directly in the footer ────────
	if (flatMode) {
		const current = announcements[tickerIndex];
		return (
			<div style={S.wrapper}>
				{/* Separator above announcements */}
				<div style={S.fullDivider} />
				{/* Announcements ticker */}
				<div style={{ padding: '10px 12px', overflow: 'hidden' }}>
					<div
						style={{
							opacity: tickerFade ? 1 : 0,
							transition: 'opacity 300ms ease',
						}}
					>
						<div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)', marginBottom: 4 }}>{current.title}</div>
						<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.4, marginBottom: 6 }}>{current.body}</div>
						<a href={current.linkUrl} style={{ fontSize: 11, color: 'var(--rr-brand)', textDecoration: 'none', cursor: 'pointer' }}>{current.linkText} &rarr;</a>
					</div>
				</div>
				{onOpenDocs && (
					<button style={{ ...S.docsBtn, background: docsHovered ? 'var(--rr-bg-surface-alt)' : 'none' }} onMouseEnter={() => setDocsHovered(true)} onMouseLeave={() => setDocsHovered(false)} onClick={onOpenDocs}>
						<BxBookOpen size={16} />
						{!collapsed && 'Documentation'}
					</button>
				)}
				{onEnvironmentClick && (
					<button style={{ ...S.docsBtn, background: envHovered ? 'var(--rr-bg-surface-alt)' : 'none' }} onMouseEnter={() => setEnvHovered(true)} onMouseLeave={() => setEnvHovered(false)} onClick={onEnvironmentClick}>
						<BxLock size={16} />
						{!collapsed && 'Variables'}
					</button>
				)}
				{onSettingsClick && (
					<button style={S.gearTrigger(hovered, false, collapsed)} onClick={onSettingsClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
						<BxCog size={20} />
						{!collapsed && <span>Settings</span>}
					</button>
				)}
				{/* Separator under Settings, above connection info */}
				<div style={S.fullDivider} />
				{!collapsed && (
					<div style={{ padding: '4px 15px', fontSize: 11, color: 'var(--rr-text-secondary)' }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
							<span
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									flexShrink: 0,
									backgroundColor: connectionStatus.state === 'connected' ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
								}}
							/>
							<span>{connectionStatus.text}</span>
						</div>
						{connectionStatus.message && <div style={{ paddingLeft: 13, marginTop: 2, fontSize: 11, color: 'var(--rr-text-secondary)' }}>{connectionStatus.message}</div>}
					</div>
				)}
			</div>
		);
	}

	// ── Popup mode ──────────────────────────────────────────────────────

	return (
		<div style={S.wrapper}>
			{/* ── Announcements ticker (popup mode) ────────────────────── */}
			{!collapsed && announcements.length > 0 && (
				<>
					<div style={S.fullDivider} />
					<div style={{ padding: '10px 12px', overflow: 'hidden' }}>
						<div style={{ opacity: tickerFade ? 1 : 0, transition: 'opacity 300ms ease' }}>
							<div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)', marginBottom: 4 }}>{announcements[tickerIndex].title}</div>
							<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.4, marginBottom: 6 }}>{announcements[tickerIndex].body}</div>
							<a href={announcements[tickerIndex].linkUrl} style={{ fontSize: 11, color: 'var(--rr-brand)', textDecoration: 'none', cursor: 'pointer' }}>{announcements[tickerIndex].linkText} &rarr;</a>
						</div>
					</div>
				</>
			)}

			{/* ── Documentation button ──────────────────────────────────── */}
			{onOpenDocs && (
				<button style={{ ...S.docsBtn, background: docsHovered ? 'var(--rr-bg-surface-alt)' : 'none' }} onMouseEnter={() => setDocsHovered(true)} onMouseLeave={() => setDocsHovered(false)} onClick={onOpenDocs}>
					<BxBookOpen size={16} />
					{!collapsed && 'Documentation'}
				</button>
			)}

			{/* ── Avatar trigger row (when user identity is available) ── */}
			{userName && (
				<div ref={triggerRef} style={S.avatarRow(hovered, menuOpen, collapsed)} onClick={() => setMenuOpen((v) => !v)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
					<div style={S.avatarCircle}>{initials}</div>
					{!collapsed && (
						<div style={S.nameBlock}>
							<div style={S.nameText}>{userName}</div>
							{userEmail && <div style={S.emailText}>{userEmail}</div>}
						</div>
					)}
				</div>
			)}

			{/* ── Gear trigger fallback (no identity, popup mode) ──────── */}
			{!userName && menuItems && menuItems.length > 0 && (
				<button ref={triggerRef as React.RefObject<HTMLButtonElement>} style={S.gearTrigger(hovered, menuOpen, collapsed)} onClick={() => setMenuOpen((v) => !v)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
					<BxCog size={20} />
					{!collapsed && <span>Settings</span>}
				</button>
			)}

			{/* ── Popup menu (portalled to document.body to escape overflow:hidden) */}
			{menuOpen &&
				menuPos &&
				portalContainer &&
				createPortal(
					<div
						ref={popupRef}
						onMouseEnter={cancelLeaveTimer}
						onMouseLeave={startLeaveTimer}
						style={{
							...commonStyles.popupMenu,
							position: 'fixed',
							top: menuPos.top,
							left: menuPos.left + POPUP_MARGIN,
							transform: 'translateY(-100%)',
							marginTop: -8,
							width: Math.round(((triggerWidth - 2 * POPUP_MARGIN) * 2) / 3),
							minWidth: 160,
							zIndex: 10000,
						}}
					>
						{/* Top-level menu items */}
						{topLevelItems.map((item) => (
							<React.Fragment key={item.id}>
								{item.dividerBefore && <div style={S.divider} />}

								{/* Section header — bold label + status line */}
								{item.header ? (
									<div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--rr-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
										<div style={{ display: 'flex', alignItems: 'center' }}>
											<span style={{ flex: 1 }}>{item.label}</span>
										</div>
										{/* Status lines (e.g. "Connected (Local)" + "Team: Dev") */}
										{item.statusText &&
											item.statusText.split('\n').map((line, i) => {
												// Last line with a submenu → clickable to open team flyout
												const isTeamLine = i > 0 && item.submenu;
												return (
													<div
														key={i}
														onClick={isTeamLine ? (e) => openFlyout(item.id, item.submenu!, (e.currentTarget.parentElement ?? e.currentTarget) as HTMLElement) : undefined}
														style={{
															paddingLeft: 10,
															fontSize: 11,
															fontWeight: 400,
															textTransform: 'none',
															letterSpacing: 'normal',
															color: 'var(--rr-text-secondary)',
															marginTop: i === 0 ? 2 : 0,
															cursor: isTeamLine ? 'pointer' : 'default',
															display: 'flex',
															alignItems: 'center',
														}}
													>
														{/* Green/gray dot on the connection status line */}
														{i === 0 && item.statusState && (
															<span
																style={{
																	width: 8,
																	height: 8,
																	borderRadius: '50%',
																	flexShrink: 0,
																	marginRight: 5,
																	backgroundColor: item.statusState === 'connected' ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
																}}
															/>
														)}
														<span style={{ flex: 1 }}>{line}</span>
														{isTeamLine && <BxChevronRight size={12} />}
													</div>
												);
											})}
									</div>
								) : (
									<div style={{ paddingLeft: 10 }}>
										<PopupRow
											onClick={(e) => {
												if (item.submenu) {
													openFlyout(item.id, item.submenu, e.currentTarget.parentElement!);
												} else if (item.onClick) {
													item.onClick();
													handleClose();
												}
											}}
										>
											{/* Checkmark slot (for radio-style items) */}
											{item.checked !== undefined && <span style={{ width: 16, display: 'inline-flex' }}>{item.checked && <BxCheck size={16} color="var(--rr-brand)" />}</span>}
											{/* Icon */}
											{item.icon && <item.icon size={16} />}
											{/* Label */}
											<span style={{ flex: 1 }}>{item.label}</span>
											{/* Submenu chevron */}
											{item.submenu && <BxChevronRight size={16} />}
										</PopupRow>
									</div>
								)}
							</React.Fragment>
						))}
					</div>,
					portalContainer
				)}

			{/* ── Flyout submenu (separate portal — must NOT be inside the
			     transformed popup div, or position:fixed becomes relative
			     to the transform instead of the viewport) */}
			{menuOpen &&
				flyoutId &&
				flyoutItems.length > 0 &&
				portalContainer &&
				createPortal(
					<div
						ref={flyoutRef}
						onMouseEnter={cancelLeaveTimer}
						onMouseLeave={startLeaveTimer}
						style={{
							...commonStyles.popupMenu,
							position: 'fixed',
							top: flyoutPos.top,
							left: flyoutPos.left,
							width: Math.round(((triggerWidth - 2 * POPUP_MARGIN) * 2) / 3),
							minWidth: 140,
							maxHeight: `calc(100vh - ${flyoutPos.top + 8}px)`,
							overflowY: 'auto',
							scrollbarWidth: 'thin',
							scrollbarColor: 'var(--rr-bg-scrollbar-thumb) transparent',
							zIndex: 10001,
						}}
					>
						{flyoutItems.map((sub) => (
							<PopupRow
								key={sub.id}
								onClick={() => {
									if (sub.onClick) {
										sub.onClick();
										setFlyoutId(null);
									}
								}}
							>
								{sub.checked !== undefined && <span style={{ width: 16, display: 'inline-flex' }}>{sub.checked && <BxCheck size={16} color="var(--rr-brand)" />}</span>}
								{sub.icon && <sub.icon size={16} />}
								<span style={{ flex: 1 }}>{sub.label}</span>
							</PopupRow>
						))}
					</div>,
					portalContainer
				)}
		</div>
	);
};
