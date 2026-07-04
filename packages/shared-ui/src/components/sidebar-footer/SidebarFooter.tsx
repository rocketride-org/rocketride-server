// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarFooter — unified footer for both shell-ui and VS Code sidebars.
 *
 * Renders (top to bottom):
 *   1. Announcements ticker (when expanded and announcements are available)
 *   2. Documentation button (optional, driven by onOpenDocs)
 *   3. Trigger row — always present, whole row opens the popup menu:
 *      - When userName is provided: avatar circle + name/email
 *      - When anonymous: rocket icon + "RocketRide" branding
 *   4. Connection status line(s) below the trigger row (optional):
 *      - If one connection or both identical: single line
 *      - If two different connections: two labelled lines
 *
 * Popup menu:
 *   - Main popup is 2/3 of sidebar width, inset by POPUP_MARGIN on each side.
 *   - Items with a `submenu` field show a chevron; clicking opens a flyout
 *     shifted 1/3 right so it peeks past the main popup while staying within
 *     the VS Code webview bounds (popups cannot escape the webview iframe).
 *   - Selecting a flyout item closes only the flyout, keeping the main popup.
 *   - Click-outside dismisses everything (no hover timers).
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { commonStyles } from '../../themes/styles';
import { useFixedPopupPosition } from '../../hooks/useFixedPopupPosition';
import { useAnnouncements } from '../../hooks/useAnnouncements';
import { PopupRow } from '../PopupRow';
import { BxBookOpen, BxChevronRight, BxCheck, BxCog } from '../BoxIcon';
import type { IconComponent } from '../BoxIcon';

// =============================================================================
// ANNOUNCEMENT MARKDOWN
// =============================================================================

/** Custom component overrides for announcement markdown — compact sizing. */
const annMarkdownComponents = {
	img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
		<img {...props} style={{ maxWidth: 12, maxHeight: 12, display: 'inline-block', verticalAlign: 'middle' }} />
	),
	p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
		<span {...props} style={{ display: 'block', margin: 0, fontSize: 10 }} />
	),
};

// =============================================================================
// ROCKETRIDE MARK — branded rocket icon for anonymous trigger row
// =============================================================================

/** RocketRide rocket mark (icon only, no logotype). */
const RocketRideMark: React.FC<{ size?: number }> = ({ size = 16 }) => (
	<svg width={size} height={size} viewBox="0 0 211 211" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path d="M159.501 180.6L153.701 186.4C151.901 188.2 148.901 188.2 147.001 186.4L126.601 166C115.601 155 115.601 137.2 126.601 126.2C138.101 114.7 138.101 96.1 126.601 84.6L125.101 83.1C113.601 71.6 95.0006 71.6 83.5006 83.1C72.5006 94.1 54.6006 94.1 43.6006 83.1L23.2006 62.7C21.4006 60.9 21.4006 57.9 23.2006 56L29.0006 50.2C37.0006 42.2 49.1006 39.7 59.6006 44.1L87.5006 55.5C97.3006 59.3 108.401 57.2 116.301 50.3L137.001 29.6C138.601 28.1 140.401 26.6 142.501 25.4C146.201 23.3 150.301 22.2 154.501 21.8L185.401 19.2C188.301 18.9 190.801 21.4 190.501 24.3L187.801 55.6C187.301 62 184.501 68 180.101 72.7L160.501 92.3C152.501 100.4 150.101 112.5 154.501 123L155.501 125.4L161.201 139.2L165.601 150.1C169.901 160.6 167.501 172.7 159.501 180.7V180.6Z" fill="currentColor"/>
		<path d="M0.800333 209.5C-0.199667 208.5 -0.299667 206.8 0.600333 205.6L21.1003 181.2C31.1003 169.2 37.9003 156.9 41.3003 144.5C43.6003 135.8 44.6003 127.7 44.1003 120.4C44.1003 119.5 44.4003 118.6 45.1003 118C45.8003 117.4 46.8003 117.1 47.7003 117.3C65.0003 120.8 83.5003 117.5 98.5003 108.1C99.6003 107.4 101.1 107.6 102 108.5C102.9 109.4 103.1 110.9 102.4 112C93.0003 127 89.7003 145.5 93.2003 162.7C93.4003 163.5 93.2003 164.4 92.6003 165.1C92.0003 165.8 91.0003 166.4 90.1003 166.3C82.8003 165.8 74.6003 166.7 66.0003 169.1C53.6003 172.4 41.2003 179.2 29.3003 189.3L4.90033 209.8C3.80033 210.7 2.10033 210.7 1.00033 209.6H0.800333V209.5Z" fill="#F93822"/>
	</svg>
);

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

	// ── Popup menu items ────────────────────────────────────────────────────
	/** Host-specific menu items shown in the popup. */
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

	// ── Rocket icon circle (anonymous trigger) ──────────────────────────────
	rocketCircle: {
		width: 32,
		height: 32,
		borderRadius: '50%',
		background: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		flexShrink: 0,
	} as CSSProperties,

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

export const SidebarFooter: React.FC<SidebarFooterProps> = ({ collapsed, userName, userEmail, onOpenDocs, menuItems }) => {
	// ── Avatar initials ─────────────────────────────────────────────────────
	const initials = useMemo(() => {
		if (!userName) return '';
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

	// ── Announcements ticker ────────────────────────────────────────────────
	const announcements = useAnnouncements();
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

	return (
		<div style={S.wrapper}>
			{/* ── Announcements ticker (popup mode) ────────────────────── */}
			{!collapsed && announcements.length > 0 && (() => {
				const current = announcements[tickerIndex % announcements.length];
				return (
					<>
						<div style={S.fullDivider} />
						<div style={{ padding: '10px 12px', overflow: 'hidden' }}>
							<div style={{ opacity: tickerFade ? 1 : 0, transition: 'opacity 300ms ease' }}>
								<div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)', marginBottom: 4 }}>
									<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={annMarkdownComponents}>{current.title}</ReactMarkdown>
								</div>
								<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.4, marginBottom: 6 }}>
									<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={annMarkdownComponents}>{current.body}</ReactMarkdown>
								</div>
								<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
									{current.link && /^https?:\/\//i.test(current.link) ? (
										<a href={current.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--rr-brand)', textDecoration: 'none', cursor: 'pointer' }}>Learn more &rarr;</a>
									) : <span />}
									{announcements.length > 1 && (
										<div style={{ display: 'flex', gap: 2 }}>
											<button type="button" aria-label="Previous announcement" onClick={() => { setTickerFade(false); setTimeout(() => { setTickerIndex((i) => (i - 1 + announcements.length) % announcements.length); setTickerFade(true); }, 150); }} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--rr-text-secondary)', lineHeight: 1 }}>&lsaquo;</button>
											<button type="button" aria-label="Next announcement" onClick={() => { setTickerFade(false); setTimeout(() => { setTickerIndex((i) => (i + 1) % announcements.length); setTickerFade(true); }, 150); }} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--rr-text-secondary)', lineHeight: 1 }}>&rsaquo;</button>
										</div>
									)}
								</div>
							</div>
						</div>
					</>
				);
			})()}

			{/* ── Documentation button ──────────────────────────────────── */}
			{onOpenDocs && (
				<button style={{ ...S.docsBtn, background: docsHovered ? 'var(--rr-bg-surface-alt)' : 'none' }} onMouseEnter={() => setDocsHovered(true)} onMouseLeave={() => setDocsHovered(false)} onClick={onOpenDocs}>
					<BxBookOpen size={16} />
					{!collapsed && 'Documentation'}
				</button>
			)}

			{/* ── Trigger row — avatar (signed in) or rocket branding (anonymous) */}
			<div ref={triggerRef} role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={menuOpen} style={S.avatarRow(hovered, menuOpen, collapsed)} onClick={() => { if (menuOpen) handleClose(); else setMenuOpen(true); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menuOpen) handleClose(); else setMenuOpen(true); } }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
				{userName ? (
					<>
						<div style={S.avatarCircle}>{initials}</div>
						{!collapsed && (
							<div style={{ ...S.nameBlock, flex: 1 }}>
								<div style={S.nameText}>{userName}</div>
								{userEmail && <div style={S.emailText}>{userEmail}</div>}
							</div>
						)}
					</>
				) : (
					<>
						<div style={S.rocketCircle}><RocketRideMark size={18} /></div>
						{!collapsed && (
							<div style={{ ...S.nameBlock, flex: 1 }}>
								<div style={S.nameText}>RocketRide</div>
							</div>
						)}
					</>
				)}
				{!collapsed && <BxCog size={16} color="var(--rr-text-secondary)" />}
			</div>

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
												// Line 0 = connection status, line 1 with submenu = team selector,
												// remaining lines = engine progress log (truncated with hover tooltip)
												const isTeamLine = i > 0 && item.submenu && line.startsWith('Team:');
												const isProgressLine = i > 0 && !isTeamLine;
												return (
													<div
														key={i}
														title={isProgressLine ? line : undefined}
														role={isTeamLine ? 'button' : undefined}
														tabIndex={isTeamLine ? 0 : undefined}
														onClick={isTeamLine ? (e) => openFlyout(item.id, item.submenu!, e.currentTarget as HTMLElement) : undefined}
														onKeyDown={isTeamLine ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFlyout(item.id, item.submenu!, e.currentTarget as HTMLElement); } } : undefined}
														style={{
															paddingLeft: 10,
															fontSize: isProgressLine ? 10 : 11,
															fontWeight: 400,
															textTransform: 'none',
															letterSpacing: 'normal',
															color: 'var(--rr-text-secondary)',
															marginTop: i === 0 ? 2 : 0,
															cursor: isTeamLine ? 'pointer' : 'default',
															display: 'flex',
															alignItems: 'center',
															overflow: 'hidden',
															textOverflow: 'ellipsis',
															whiteSpace: 'nowrap',
														}}
													>
														{/* Colored dot on the connection status line */}
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
														<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line}</span>
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
							// Content-driven width so long app names + logos aren't cramped. Grows
							// to fit the widest row, floored at 160px and capped to the viewport
							// (the flyout opens rightward from flyoutPos.left, so cap on the right edge).
							width: 'max-content',
							minWidth: 160,
							maxWidth: `calc(100vw - ${flyoutPos.left + 8}px)`,
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
