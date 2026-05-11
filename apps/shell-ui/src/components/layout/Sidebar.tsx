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
	BxCog, BxPalette, BxUser, BxExport, BxGridAlt, BxHome,
} from '../../icons/BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import type { IconComponent } from '../../icons/BoxIcon';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import type { ShellThemeConfig, ShellAccountConfig } from '../../workspace/types';
import { SidebarFooter } from 'shared/components/sidebar-footer/SidebarFooter';
import type { SidebarFooterMenuItem } from 'shared/components/sidebar-footer/SidebarFooter';
import { useSubscriptions } from '../../hooks/useSubscriptions';

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
	/** Callback to open a shell overlay (account, billing, settings). */
	onOverlay: (overlay: 'account' | 'settings') => void;
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

	// Resolve icon: branding theme-aware → branding generic → manifest URL → monogram
	const resolveIcon = (size: number): React.ReactNode => {
		// Step 1: branding iconDark / iconLight
		const themed = paletteMode === 'dark' ? branding?.iconDark : branding?.iconLight;
		if (themed) return <div style={{ width: size, height: size, flexShrink: 0 }}>{themed}</div>;

		// Step 2: branding generic icon
		if (branding?.icon) return <div style={{ width: size, height: size, flexShrink: 0 }}>{branding.icon}</div>;

		// Step 3: manifest icon URL
		if (!isHome && activeManifest?.icon) return <img src={activeManifest.icon} alt="" style={{ width: size, height: size, flexShrink: 0 }} />;

		// Step 4: monogram fallback
		return (
			<span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.04em', color: 'var(--rr-brand)' }}>
				{isHome ? 'RC' : (activeManifest?.name.slice(0, 2).toUpperCase() ?? '??')}
			</span>
		);
	};

	// Collapsed: always show icon regardless of showHeader
	if (collapsed) {
		return (
			<div style={{
				width: COLLAPSED_BTN, height: COLLAPSED_BTN, margin: '0 auto',
				display: 'flex', alignItems: 'center', justifyContent: 'center',
				color: 'var(--rr-brand)',
			}}>
				{resolveIcon(20)}
			</div>
		);
	}

	// Expanded but showHeader is false: app owns its own header, render nothing
	if (!showHeader) return null;

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, padding: '2px 4px' }}>
			{resolveIcon(16)}
			<span style={{
				fontSize: 14, fontWeight: 800, letterSpacing: '0.06em',
				color: 'var(--rr-brand)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
			}}>
				{isHome ? 'ROCKETRIDE CLOUD' : (activeManifest?.name.toUpperCase() ?? '')}
			</span>
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

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
	const { subscribedAppIds } = useSubscriptions();

	// --- Collapse / resize state ---------------------------------------------

	const [collapsed, setCollapsed] = useState(false);
	const [width, setWidth] = useState(EXPANDED_WIDTH);
	const [isResizing, setIsResizing] = useState(false);
	const [handleHover, setHandleHover] = useState(false);

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
			{
				id: 'theme', label: 'Theme', icon: BxPalette,
				submenu: themeOptions.map((t) => ({
					id: t.id, label: t.name, checked: prefs.theme === t.id,
					onClick: () => handleThemeSelect(t.id),
				})),
			},
			{ id: 'account', label: 'Account', icon: BxUser, onClick: () => onOverlay('account') },
			{ id: 'settings', label: 'Settings', icon: BxCog, onClick: () => onOverlay('settings') },
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
				id: 'apps', label: 'Switch App', icon: BxGridAlt, dividerBefore: true,
				submenu: appManifest
					.filter((a) => a.id !== 'rocketride.home' && a.id !== 'rocketride.hello')
					.filter((a) => subscribedAppIds.has(a.id) || !a.categories?.includes('paid'))
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((app) => ({
						id: app.id, label: app.name, checked: activeAppId === app.id,
						onClick: () => handleSwitchApp(app.id),
					})),
			});
		}

		items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: !showAppSwitcher, onClick: () => account.onLogout?.() });

		return items;
	}, [themeOptions, prefs.theme, showAppSwitcher, appManifest, activeAppId, subscribedAppIds, account, handleThemeSelect, onOverlay]);

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
			<div style={{ display: 'flex', alignItems: 'center', height: 52, padding: collapsed ? '0 8px' : '0 12px', flexShrink: 0 }}>
				<button
					title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
					onClick={toggleCollapse}
					style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', flex: 1 }}
				>
					<AppSwitcherButton collapsed={collapsed} />
				</button>
				{showAppSwitcher && !collapsed && (
					<button
						title="Home"
						onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: '$HOME' })}
						style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--rr-text-secondary)', flexShrink: 0 }}
					>
						<BxHome size={18} />
					</button>
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
