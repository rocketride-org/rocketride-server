// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SIDEBAR — collapsible/resizable shell sidebar
//
// Layout (top to bottom):
//   Header (AppSwitcherButton + dock toggle)
//   App Sidebar Content slot (from active app's components.Sidebar)
//   Footer (SidebarFooter — shared component with popup menu)
// =============================================================================

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ShellIdentityContext } from '../../hooks/useAuthUser';
import {
	BxCog, BxLock, BxPalette, BxUser, BxExport, BxGridAlt, BxDockLeft, BxHome,
} from '../../icons/BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import type { IconComponent } from '../../icons/BoxIcon';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import type { ShellThemeConfig, ShellAccountConfig } from '../../workspace/types';
import { SidebarFooter } from 'shared/components/sidebar-footer/SidebarFooter';
import type { SidebarFooterMenuItem } from 'shared/components/sidebar-footer/SidebarFooter';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import RocketRideMark from '../../icons/RocketRideMark';
import RocketRideWordmark from '../../icons/RocketRideWordmark';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 56;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const SNAP_THRESHOLD = 100;
const TRANSITION_MS = 150;
const ICON_SIZE = 20;
const COLLAPSED_BTN = 40;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the Sidebar component.
 */
export interface SidebarProps {
	/** Theme picker configuration. */
	themeConfig: ShellThemeConfig;
	/** Account info and logout callback. */
	account: ShellAccountConfig;
	/** When true, the app switcher submenu in the footer is hidden. */
	hideAppSwitcher?: boolean;
	/** Callback to open a shell overlay (account, settings, environment). */
	onOverlay: (overlay: 'account' | 'settings' | 'environment') => void;
}

// =============================================================================
// NAV BUTTON
// =============================================================================

/**
 * Props for the NavButton component.
 */
interface NavButtonProps {
	/** Icon component to render. */
	icon: IconComponent;
	/** Text label shown when the sidebar is expanded. */
	label: string;
	/** Whether this button represents the currently active item. */
	isActive?: boolean;
	/** Whether the sidebar is in collapsed mode. */
	collapsed: boolean;
	/** Optional override for the icon colour. */
	iconColor?: string;
	/** Click handler. */
	onClick?: () => void;
	/** Tooltip override. Falls back to `label` if not provided. */
	title?: string;
}

/**
 * A single navigation button in the sidebar.
 *
 * Renders as an icon-only button when the sidebar is collapsed, or as an
 * icon-plus-label row when expanded.
 */
export const NavButton: React.FC<NavButtonProps> = ({ icon: Icon, label, isActive = false, collapsed, iconColor, onClick, title }) => {
	const [hovered, setHovered] = useState(false);
	return (
		<button
			title={title ?? label}
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start',
				gap: 10, width: collapsed ? COLLAPSED_BTN : '100%', height: collapsed ? COLLAPSED_BTN : 30,
				padding: collapsed ? 0 : '0 10px', margin: collapsed ? '0 auto' : 0,
				borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13,
				fontWeight: isActive ? 600 : 400,
				color: isActive ? 'var(--rr-brand)' : iconColor ?? 'var(--rr-text-secondary)',
				background: isActive
					? 'color-mix(in srgb, var(--rr-brand) 20%, transparent)'
					: hovered ? 'var(--rr-bg-surface-alt)' : 'transparent',
				transition: 'background 100ms ease, color 100ms ease', overflow: 'hidden',
			}}
		>
			<Icon size={ICON_SIZE} />
			{!collapsed && (
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
			)}
		</button>
	);
};

// =============================================================================
// APP SWITCHER BUTTON
// =============================================================================

/**
 * Reads --rr-palette-mode from :root and re-reads on theme changes.
 * Returns 'dark' or 'light'.
 */
const usePaletteMode = (): 'dark' | 'light' => {
	const read = () => getComputedStyle(document.documentElement).getPropertyValue('--rr-palette-mode').trim() as 'dark' | 'light' || 'light';
	const [mode, setMode] = useState(read);
	useEffect(() => {
		// Re-read whenever the shell applies a new theme (CSS vars change)
		const obs = new MutationObserver(() => setMode(read()));
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
		return () => obs.disconnect();
	}, []);
	return mode;
};

/**
 * Resolves the best icon to display for the active app.
 *
 * Priority: branding.iconDark/iconLight (theme-aware) → branding.icon →
 * manifest icon (URL) → 2-letter monogram fallback.
 */
const AppSwitcherButton: React.FC<{ collapsed: boolean }> = ({ collapsed }) => {
	const { activeAppId, appManifest, loadedApps } = useWorkspace();
	const paletteMode = usePaletteMode();
	const isHome = activeAppId === 'rocketride.home';
	const activeManifest = appManifest.find((a) => a.id === activeAppId) ?? null;
	const branding = loadedApps[activeAppId]?.branding;
	const showHeader = activeManifest?.showHeader !== false;

	// Resolve icon: branding theme-aware → branding generic → manifest URL → RocketRide mark
	const resolveIcon = (size: number): React.ReactNode => {
		// Step 1: branding iconDark / iconLight
		const themed = paletteMode === 'dark' ? branding?.iconDark : branding?.iconLight;
		if (themed) return <div style={{ width: size, height: size, flexShrink: 0 }}>{themed}</div>;

		// Step 2: branding generic icon
		if (branding?.icon) return <div style={{ width: size, height: size, flexShrink: 0 }}>{branding.icon}</div>;

		// Step 3: manifest icon URL
		if (!isHome && activeManifest?.icon) return <img src={activeManifest.icon} alt="" style={{ width: size, height: size, flexShrink: 0 }} />;

		// Step 4: RocketRide mark
		return <RocketRideMark size={size} color="var(--rr-brand)" />;
	};

	// Collapsed: show the same icon as the expanded state, centered
	if (collapsed) {
		return (
			<div style={{
				width: COLLAPSED_BTN, height: COLLAPSED_BTN, margin: '0 auto',
				display: 'flex', alignItems: 'center', justifyContent: 'center',
			}}>
				{resolveIcon(20)}
			</div>
		);
	}

	// Expanded but showHeader is false: app owns its own header, render nothing
	if (!showHeader) return null;

	// App name for display
	const appLabel = isHome ? 'ROCKETRIDE CLOUD' : (activeManifest?.name.toUpperCase() ?? '');

	return (
		<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1, padding: '4px 4px 2px' }}>
			<RocketRideWordmark height={22} color={paletteMode === 'dark' ? '#FAFBF8' : '#1E1A34'} />
			<span style={{
				fontSize: 9, fontWeight: 800, letterSpacing: '0.12em',
				color: 'var(--rr-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				textAlign: 'center', maxWidth: '100%',
			}}>
				{appLabel}
			</span>
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * App-switcher icon: renders the app's logo when available, otherwise a
 * two-letter monogram fallback (initials of the first two words, or the
 * first two characters of a single-word name).
 *
 * Defined at module scope so it keeps a stable component identity across
 * renders instead of being recreated inline per menu item.
 */
const AppIcon: React.FC<{ name: string; iconUrl?: string; size?: number }> = ({ name, iconUrl, size = 16 }) => {
	if (iconUrl) {
		return (
			<img
				src={iconUrl}
				alt=""
				width={size}
				height={size}
				style={{ borderRadius: 4, objectFit: 'cover', flexShrink: 0, display: 'block' }}
			/>
		);
	}

	const words = name.trim().split(/\s+/).filter(Boolean);
	const monogram = (words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join('') : name.slice(0, 2)).toUpperCase();

	return (
		<span
			style={{
				width: size,
				height: size,
				flexShrink: 0,
				borderRadius: 4,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'var(--rr-bg-surface-alt)',
				color: 'var(--rr-text-secondary)',
				fontSize: Math.round(size * 0.5),
				fontWeight: 700,
				lineHeight: 1,
			}}
		>
			{monogram}
		</span>
	);
};

/**
 * Collapsible, resizable sidebar that renders the active app's sidebar
 * component and a footer with theme picker, account/billing nav, app
 * switcher, and logout.
 *
 * @param props - Sidebar configuration and callbacks.
 */
const Sidebar: React.FC<SidebarProps> = ({ themeConfig, account, hideAppSwitcher, onOverlay }) => {
	const identity = useContext(ShellIdentityContext);
	const { prefs, updatePrefs, setTheme, themeOptions, activeAppId, loadedApps, appManifest } = useWorkspace();
	const { isOnDesktop } = useSubscriptions();

	// --- Collapse / resize state ---------------------------------------------

	const [collapsed, setCollapsed] = useState(false);
	const [width, setWidth] = useState(EXPANDED_WIDTH);
	const [isResizing, setIsResizing] = useState(false);
	const [handleHover, setHandleHover] = useState(false);
	const [headerHover, setHeaderHover] = useState(false);

	const isResizingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(EXPANDED_WIDTH);

	// --- App's Sidebar component from loaded descriptor ----------------------

	const AppSidebar = loadedApps[activeAppId]?.components?.Sidebar;

	// --- Collapse toggle -----------------------------------------------------

	/**
	 * Toggles the sidebar between collapsed and expanded states.
	 * Emits `shell:sidebarCollapsing` when collapsing so dependent UI can react.
	 */
	const toggleCollapse = useCallback(() => {
		if (collapsed) {
			setCollapsed(false);
			if (width < MIN_WIDTH) setWidth(EXPANDED_WIDTH);
		} else {
			ConnectionManager.getInstance().emit('shell:sidebarCollapsing', {});
			setCollapsed(true);
		}
	}, [collapsed, width]);

	// --- Resize handler ------------------------------------------------------

	/**
	 * Initiates a sidebar resize drag operation.
	 * Snaps to collapsed when dragged below the threshold.
	 *
	 * @param e - The mouse event from the resize handle.
	 */
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		isResizingRef.current = true;
		startXRef.current = e.clientX;
		startWidthRef.current = collapsed ? COLLAPSED_WIDTH : width;
		setIsResizing(true);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		document.querySelectorAll('iframe').forEach((f) => { (f as HTMLIFrameElement).style.pointerEvents = 'none'; });

		const cleanup = () => {
			isResizingRef.current = false;
			setIsResizing(false);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.querySelectorAll('iframe').forEach((f) => { (f as HTMLIFrameElement).style.pointerEvents = ''; });
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', cleanup);
		};

		let snapped = false;
		const onMouseMove = (ev: MouseEvent) => {
			if (!isResizingRef.current) return;
			const delta = ev.clientX - startXRef.current;
			const newWidth = startWidthRef.current + delta;
			if (newWidth < SNAP_THRESHOLD) {
				if (!snapped) { ConnectionManager.getInstance().emit('shell:sidebarCollapsing', {}); snapped = true; }
				setCollapsed(true); setWidth(COLLAPSED_WIDTH);
			} else {
				snapped = false;
				setCollapsed(false); setWidth(Math.min(Math.max(newWidth, MIN_WIDTH), MAX_WIDTH));
			}
		};

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', cleanup);
	}, [collapsed, width]);

	// --- Theme selection -----------------------------------------------------

	/**
	 * Applies a new theme via workspace prefs and the theme config callback.
	 *
	 * @param themeId - The ID of the theme to apply.
	 */
	/** Apply a theme — delegates to the context's setTheme which handles both prefs and CSS. */
	const handleThemeSelect = useCallback((themeId: string) => {
		setTheme(themeId);
	}, [setTheme]);

	// --- Footer menu items ---------------------------------------------------

	const showAppSwitcher = !hideAppSwitcher && appManifest.length > 1;

	const footerMenuItems: SidebarFooterMenuItem[] = useMemo(() => {
		const items: SidebarFooterMenuItem[] = [
			{ id: 'home', label: 'Home', icon: BxHome, onClick: () => ConnectionManager.getInstance().emit('shell:switchApp', { appId: 'rocketride.home' }) },
			{ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => onOverlay('account') },
			{ id: 'environment', label: 'Variables', icon: BxLock, onClick: () => onOverlay('environment') },
			// Settings is a global workspace view (shell "General" plus any installed app's
			// settings), so it's always available. Per-app gating lives in SettingsPage.
			{ id: 'settings', label: 'Settings', icon: BxCog, onClick: () => onOverlay('settings') },
			{
				id: 'theme', label: 'Theme', icon: BxPalette, dividerBefore: true,
				submenu: themeOptions.map((t) => ({
					id: t.id, label: t.name, checked: prefs.theme === t.id,
					onClick: () => handleThemeSelect(t.id),
				})),
			},
		];

		if (showAppSwitcher) {
			/**
			 * Handles app switching with subscription gating.
			 * If the target app is paid and the user is not subscribed,
			 * navigates to home and triggers the subscribe flow.
			 */
			const handleSwitchApp = (appId: string) => {
				console.log('[Sidebar] handleSwitchApp called with appId:', appId);
				ConnectionManager.getInstance().emit('shell:switchApp', { appId });
			};

			items.push({
				id: 'apps', label: 'Switch App', icon: BxGridAlt,
				submenu: appManifest
					.filter((a) => a.id !== 'rocketride.home' && a.id !== 'rocketride.hello')
					.filter((a) => isOnDesktop(a.id))
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((app) => ({
						id: app.id, label: app.name, checked: activeAppId === app.id,
						icon: ({ size }: { size?: number }) => <AppIcon name={app.name} iconUrl={app.icon} size={size} />,
						onClick: () => handleSwitchApp(app.id),
					})),
			});
		}

		items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: true, onClick: () => account.onLogout?.() });

		return items;
	}, [themeOptions, prefs.theme, showAppSwitcher, appManifest, activeAppId, isOnDesktop, account, handleThemeSelect, onOverlay]);

	// --- Don't render sidebar when not authenticated -------------------------

	if (!identity) return null;

	const sidebarWidth = collapsed ? COLLAPSED_WIDTH : width;

	// --- Render --------------------------------------------------------------

	return (
		<div style={{
			width: sidebarWidth, minWidth: sidebarWidth, height: '100%',
			display: 'flex', flexDirection: 'column',
			background: 'var(--rr-bg-paper)', borderRight: '1px solid var(--rr-border)',
			position: 'relative', overflow: 'hidden',
			transition: isResizing ? 'none' : `width ${TRANSITION_MS}ms ease, min-width ${TRANSITION_MS}ms ease`,
		}}>
			{/* ================================================================
			    HEADER — AppSwitcherButton + collapse toggle
			    ================================================================ */}
			<div
				style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : undefined, height: 52, padding: collapsed ? '8px 8px 0' : '8px 12px 0', flexShrink: 0 }}
				onMouseEnter={() => setHeaderHover(true)}
				onMouseLeave={() => setHeaderHover(false)}
			>
				{collapsed ? (
					// Collapsed: a single always-rendered, focusable button toggles
					// expansion. It shows the brand mark by default and swaps to the
					// collapse-sidebar icon on hover/focus (same 40×40 box, so no layout
					// shift). Always mounted — and focus-reveals the icon — so keyboard
					// and touch users can expand without hovering.
					<button
						title="Expand sidebar"
						aria-label="Expand sidebar"
						onClick={toggleCollapse}
						onFocus={() => setHeaderHover(true)}
						onBlur={() => setHeaderHover(false)}
						style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: COLLAPSED_BTN, height: COLLAPSED_BTN, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--rr-text-secondary)', flexShrink: 0, padding: 0 }}
					>
						{headerHover ? <BxDockLeft size={20} /> : <AppSwitcherButton collapsed={collapsed} />}
					</button>
				) : (
					<>
						<button
							title="Go to home"
							aria-label="Go to home"
							onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: 'rocketride.home' })}
							onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
							style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', padding: '2px 4px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', transition: 'background 120ms ease' }}
						>
							<AppSwitcherButton collapsed={collapsed} />
						</button>
						<button
							title="Collapse sidebar"
							aria-label="Collapse sidebar"
							onClick={toggleCollapse}
							onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
							style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--rr-text-secondary)', flexShrink: 0, transition: 'background 120ms ease' }}
						>
							<BxDockLeft size={18} />
						</button>
					</>
				)}
			</div>

			{/* ================================================================
			    APP SIDEBAR CONTENT SLOT
			    ================================================================ */}
			<div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
				{AppSidebar && <AppSidebar collapsed={collapsed} />}
			</div>

			{/* ================================================================
			    FOOTER — hidden when logged out
			    ================================================================ */}
			{identity && (
				<SidebarFooter
					collapsed={collapsed}
					userName={account.userName}
					userEmail={account.userEmail}
					menuItems={footerMenuItems}
				/>
			)}

			{/* ================================================================
			    RESIZE HANDLE
			    ================================================================ */}
			<div
				style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 10 }}
				onMouseDown={handleMouseDown}
				onMouseEnter={() => setHandleHover(true)}
				onMouseLeave={() => setHandleHover(false)}
			>
				{(handleHover || isResizing) && (
					<div style={{ position: 'absolute', right: 0, top: 0, width: 2, height: '100%', background: 'var(--rr-brand)' }} />
				)}
			</div>
		</div>
	);
};

export default Sidebar;
