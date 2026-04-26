// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarFooter — unified footer for both cloud-ui and VS Code sidebars.
 *
 * Renders (top to bottom):
 *   1. Documentation button (optional, driven by onOpenDocs)
 *   2. Avatar trigger row (when userName is provided) OR gear icon fallback
 *      (when no userName but menuItems exist) — both open the popup menu
 *   3. Connection status row (optional, driven by connection prop)
 *
 * The popup menu supports arbitrarily nested submenus via the `submenu`
 * field on SidebarFooterMenuItem.  A stack-based navigation model lets the
 * user drill into Cloud → team lists, Theme options, etc. and navigate back.
 *
 * Three distinct footer states (driven by host):
 *   - Anonymous + engine:   gear icon trigger, Settings + Development Mode
 *   - Cloud identity + engine: avatar trigger, full menu
 *   - Cloud-UI (always cloud):  avatar trigger, Theme/Account/Billing/etc.
 */

import React, { CSSProperties, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { commonStyles } from '../../themes/styles';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useFixedPopupPosition } from '../../hooks/useFixedPopupPosition';
import { PopupRow } from '../PopupRow';
import { BxBookOpen, BxCog, BxChevronRight, BxChevronLeft, BxCheck } from '../BoxIcon';
import type { IconComponent } from '../BoxIcon';
import type { ConnectionInfo } from '../../modules/sidebar/types';

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
	/** Render a horizontal divider before this item. */
	dividerBefore?: boolean;
}

export interface SidebarFooterProps {
	/** Whether the sidebar is in collapsed (icon-only) mode. */
	collapsed: boolean;

	// ── User identity ───────────────────────────────────────────────────────
	/** User display name (e.g. "RodC"). Drives the avatar initials. */
	userName?: string;
	/** User email (shown below name). */
	userEmail?: string;

	// ── Connection (always visible in footer) ───────────────────────────────
	/** Connection state + toggle callback. Omit to hide the connection row. */
	connection?: ConnectionInfo & { onToggle: () => void };

	// ── Fixed footer buttons ────────────────────────────────────────────────
	/** Show a Documentation link. */
	onOpenDocs?: () => void;

	// ── Popup menu items ────────────────────────────────────────────────────
	/** Host-specific menu items shown in the avatar popup. */
	menuItems?: SidebarFooterMenuItem[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MODE_LABELS: Record<string, string> = {
	cloud: 'Cloud',
	docker: 'Docker',
	service: 'Service',
	local: 'Local',
	remote: 'Remote',
};

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

	// ── Connection row ──────────────────────────────────────────────────────
	connectionRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '3px 10px',
		cursor: 'pointer',
		borderRadius: 8,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,

	connectionDot: (connected: boolean): CSSProperties => ({
		width: 10,
		height: 10,
		borderRadius: '50%',
		backgroundColor: connected ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
		flexShrink: 0,
		margin: '0 3px',
	}),

	// ── Popup divider ───────────────────────────────────────────────────────
	divider: {
		height: 1,
		background: 'var(--rr-border)',
		margin: '4px 0',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export const SidebarFooter: React.FC<SidebarFooterProps> = ({ collapsed, userName, userEmail, connection, onOpenDocs, menuItems }) => {
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
	const [menuStack, setMenuStack] = useState<{ label: string; items: SidebarFooterMenuItem[] }[]>([]);
	const [hovered, setHovered] = useState(false);
	const [connHovered, setConnHovered] = useState(false);
	const [docsHovered, setDocsHovered] = useState(false);
	const triggerRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const [triggerWidth, setTriggerWidth] = useState(200);
	const menuPos = useFixedPopupPosition(triggerRef, menuOpen, 'above');

	const handleClose = useCallback(() => {
		setMenuOpen(false);
		setMenuStack([]);
	}, []);

	useClickOutside(popupRef, handleClose);

	useEffect(() => {
		if (menuOpen && triggerRef.current) {
			setTriggerWidth(triggerRef.current.getBoundingClientRect().width);
		}
	}, [menuOpen]);

	// ── Determine what items to show in the popup ───────────────────────────
	const visibleItems = menuStack.length > 0 ? menuStack[menuStack.length - 1].items : (menuItems ?? []);

	const pushSubmenu = useCallback((label: string, items: SidebarFooterMenuItem[]) => {
		setMenuStack((prev) => [...prev, { label, items }]);
	}, []);

	const popSubmenu = useCallback(() => {
		setMenuStack((prev) => prev.slice(0, -1));
	}, []);

	// ── Connection state helpers ────────────────────────────────────────────
	const isConnected = connection?.state === 'connected';
	const isConnecting = connection?.state === 'connecting';

	const connectionLabel = useMemo(() => {
		if (isConnecting) return 'Connecting...';
		if (isConnected) {
			const modeLabel = MODE_LABELS[connection?.mode ?? ''] ?? connection?.mode ?? '';
			return modeLabel ? `Connected (${modeLabel})` : 'Connected';
		}
		return 'Disconnected';
	}, [isConnecting, isConnected, connection?.mode]);

	// ── Render ──────────────────────────────────────────────────────────────

	return (
		<div style={S.wrapper}>
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

			{/* ── Gear trigger fallback (no identity, but menu items exist) */}
			{!userName && menuItems && menuItems.length > 0 && (
				<button ref={triggerRef as React.RefObject<HTMLButtonElement>} style={S.gearTrigger(hovered, menuOpen, collapsed)} onClick={() => setMenuOpen((v) => !v)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
					<BxCog size={20} />
					{!collapsed && <span>Settings</span>}
				</button>
			)}

			{/* ── Connection status row ────────────────────────────────── */}
			{connection && (
				<button style={{ ...S.connectionRow, background: connHovered ? 'var(--rr-bg-surface-alt)' : 'none' }} onMouseEnter={() => setConnHovered(true)} onMouseLeave={() => setConnHovered(false)} onClick={connection.onToggle} title={isConnected ? 'Click to disconnect' : 'Click to connect'}>
					<div style={S.connectionDot(isConnected)} />
					{!collapsed && <span>{connectionLabel}</span>}
				</button>
			)}

			{/* ── Popup menu ───────────────────────────────────────────── */}
			{menuOpen && menuPos && (
				<div
					ref={popupRef}
					style={{
						...commonStyles.popupMenu,
						position: 'fixed',
						top: menuPos.top,
						left: menuPos.left,
						transform: 'translateY(-100%)',
						marginTop: -8,
						width: triggerWidth,
						minWidth: 200,
					}}
				>
					{/* Back button when inside a submenu */}
					{menuStack.length > 0 && (
						<>
							<PopupRow onClick={popSubmenu}>
								<BxChevronLeft size={16} />
								<span style={{ fontWeight: 600 }}>{menuStack[menuStack.length - 1].label}</span>
							</PopupRow>
							<div style={S.divider} />
						</>
					)}

					{/* Menu items */}
					{visibleItems.map((item) => (
						<React.Fragment key={item.id}>
							{item.dividerBefore && <div style={S.divider} />}
							<PopupRow
								onClick={() => {
									if (item.submenu) {
										pushSubmenu(item.label, item.submenu);
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
						</React.Fragment>
					))}
				</div>
			)}
		</div>
	);
};
