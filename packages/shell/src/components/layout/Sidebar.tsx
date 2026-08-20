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
//   App Sidebar Content slot (the app's AppLayout `sidebar` declaration)
//   Footer (SidebarFooter — shared component with popup menu)
// =============================================================================

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ShellIdentityContext } from '../../hooks/useAuthUser';
import {
	BxCog, BxLock, BxPalette, BxUser, BxExport, BxGridAlt, BxDockLeft, BxHome, BxX,
} from '../BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import { getHomeAppId } from '../../constants';
import type { IconComponent } from '../BoxIcon';
import { useWorkspace } from '../workspace/WorkspaceContext';
import type { ShellThemeConfig, ShellAccountConfig } from '../workspace/types';
import { SidebarFooter } from '../sidebar-footer/SidebarFooter';
import type { SidebarFooterMenuItem } from '../sidebar-footer/SidebarFooter';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { RocketRideMark } from '../RocketRideMark';
import { SidebarCollapsedProvider } from '../sidebar-menu/SidebarCollapsedContext';
import RocketRideWordmark from '../../assets/icons/RocketRideWordmark';
import { useHostChromeState } from './HostChromeContext';
import { useCompactNav } from './CompactNavContext';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 56;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const SNAP_THRESHOLD = 100;
const TRANSITION_MS = 150;

/**
 * The drawer, below `COMPACT_BREAKPOINT_PX`.
 *
 * 320 is the widest a nav should be on a phone that is 360-430 wide: enough for
 * a chat title, little enough that the scrim behind it still reads as "the page
 * is still there". `86vw` keeps a strip of that page visible on the narrowest
 * device rather than covering it completely.
 */
const DRAWER_WIDTH = 'min(320px, 86vw)';
const DRAWER_TRANSITION_MS = 220;

/**
 * Above every app, below every shell dialog.
 *
 * The overlay manager's backdrop is 200, the load-failure modal 1200, and a
 * `DetailPanel` 1500. Sitting at 100/101 means opening Settings covers the nav
 * — which is right, it is a modal — and the nav can never trap one.
 */
const SCRIM_Z = 100;
const DRAWER_Z = 101;
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
	/**
	 * Server-probed edition flag (the 'saas' capability from the bootstrap
	 * probe). Gates SaaS-only footer items — the Account overlay has no
	 * backend on OSS/local servers, so the item is hidden there. NOTE: the
	 * connection mode is NOT a valid signal here (it defaults to 'cloud'
	 * regardless of the server edition).
	 */
	isSaas?: boolean;
}

/**
 * Whether the sidebar frame has anything to hold.
 *
 * The shell renders NO sidebar for an app that registers neither a legacy
 * `components.Sidebar` nor content through `useSidebarContent` — home-ui, for
 * one. Exported because the compact chrome bar has to reach the same verdict:
 * a hamburger that opens an empty drawer is worse than no hamburger, and two
 * copies of this expression would eventually disagree.
 *
 * @returns Whether to show a sidebar, or a way to open one.
 */
export function useHasSidebarContent(): boolean {
	const { activeAppId, loadedApps } = useWorkspace();
	const { sidebarContent } = useHostChromeState();
	return !!loadedApps[activeAppId]?.components?.Sidebar || sidebarContent != null;
}

// =============================================================================
// NAV BUTTON
// =============================================================================

/**
 * Props for the NavButton component.
 */
export interface NavButtonProps {
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
				// Active rows use the theme's standard list highlight
				// (--rr-bg-list-active / --rr-fg-list-active): every theme maps it
				// to its brand color + alternate foreground.
				color: isActive ? 'var(--rr-fg-list-active)' : iconColor ?? 'var(--rr-text-secondary)',
				background: isActive
					? 'var(--rr-bg-list-active)'
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
const Sidebar: React.FC<SidebarProps> = ({ themeConfig: _themeConfig, account, hideAppSwitcher, onOverlay, isSaas }) => {
	// Not props: `SidebarProps` is part of the frozen app-facing contract, and
	// the drawer is a shell-internal concern no app can see. See
	// `CompactNavContext`.
	const { isCompact, drawerOpen, requestClose } = useCompactNav();
	const identity = useContext(ShellIdentityContext);
	const { prefs, updatePrefs: _updatePrefs, setTheme, themeOptions, activeAppId, appManifest } = useWorkspace();
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

	// --- Host-chrome slot content ---------------------------------------------
	// `sidebarContent` is the app-declared node for the scrolling slot — the
	// AppLayout `sidebar` prop, registered through the host-chrome context.
	const { sidebarContent } = useHostChromeState();

	// Whether the scrolling slot has anything to show. Drives self-hiding so the
	// shell renders NO sidebar (and the client area spans full width) when an
	// app declares no sidebar (a one-column AppLayout).
	// The exported hook, not a second copy of the expression: the compact chrome
	// bar asks the same question, and two copies would eventually answer
	// differently — a hamburger opening an empty drawer, or none where there is
	// content.
	const hasSlotContent = useHasSidebarContent();

	// A drawer is never "collapsed". The rail is a desktop affordance for
	// trading width against legibility; a drawer has the width it has, and an
	// app that draws nothing while collapsed (several return null) would render
	// an empty drawer. `collapsed` and `width` below are left untouched by the
	// responsive path, so crossing back to desktop restores exactly the rail the
	// user had.
	const effectiveCollapsed = isCompact ? false : collapsed;

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

	/**
	 * Close the drawer when something inside it takes you somewhere.
	 *
	 * CAPTURE PHASE, so it still fires for an app that stops propagation on its
	 * own handlers — several do. It is a heuristic and it is deliberately a
	 * conservative one: a control that opens more UI inside the drawer (a
	 * submenu, a theme picker — anything carrying `aria-haspopup` or
	 * `aria-expanded`) is not a destination, and neither is anything an app has
	 * marked `data-rr-drawer="keep"`, which is how a row's rename and delete
	 * buttons say "this leaves you where you are".
	 *
	 * A DOM convention rather than an API on purpose: nothing here reaches the
	 * frozen shell contract, and an app that adopts it needs no new import.
	 *
	 * @param event - The click, caught on its way down.
	 */
	const onSlotClickCapture = useCallback((event: React.MouseEvent) => {
		if (!isCompact || !drawerOpen) return;
		const target = event.target as Element | null;
		const control = target?.closest?.('a[href], button, [role="menuitem"], [role="tab"], [role="option"]');
		if (!control) return;
		if (control.closest('[data-rr-drawer="keep"]')) return;
		if (control.hasAttribute('aria-haspopup') || control.hasAttribute('aria-expanded')) return;
		requestClose();
	}, [isCompact, drawerOpen, requestClose]);

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

	// "Home" destination depends on deployment mode: SaaS lands on
	// rocketride.home, OSS on rocketride.hello (must match Shell's defaultAppId).
	const homeAppId = getHomeAppId(!!isSaas);

	const footerMenuItems: SidebarFooterMenuItem[] = useMemo(() => {
		const items: SidebarFooterMenuItem[] = [
			{ id: 'home', label: 'Home', icon: BxHome, onClick: () => ConnectionManager.getInstance().emit('shell:switchApp', { appId: homeAppId }) },
			...(isSaas ? [{ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => onOverlay('account') } satisfies SidebarFooterMenuItem] : []),
			{ id: 'environment', label: 'Variables', icon: BxLock, dividerBefore: !isSaas, onClick: () => onOverlay('environment') },
			// Settings is a global workspace view (shell "General" plus any installed app's
			// settings), so it's always available. Per-app gating lives in SettingsProvider.
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
	}, [themeOptions, prefs.theme, showAppSwitcher, appManifest, activeAppId, isOnDesktop, account, handleThemeSelect, onOverlay, isSaas, homeAppId]);

	// --- Don't render sidebar when not authenticated -------------------------

	if (!identity) return null;

	// --- Don't render sidebar when the frame has no content to hold ----------
	// A one-column app (no AppLayout sidebar) gets no sidebar chrome and the
	// client area spans full width.
	if (!hasSlotContent) return null;

	const sidebarWidth = collapsed ? COLLAPSED_WIDTH : width;

	// --- Render --------------------------------------------------------------

	// In flow on a desktop; out of flow, over a scrim, on anything narrower. The
	// node itself stays exactly where it is in the tree either way: moving it
	// across the breakpoint would remount the app's registered content and throw
	// away whatever state it was holding — a rename in progress, a scroll
	// position — every time a window crossed 1024.
	const frame: CSSProperties = isCompact
		? {
			position: 'fixed', top: 0, left: 0, height: '100%',
			width: DRAWER_WIDTH, minWidth: 0, zIndex: DRAWER_Z,
			display: 'flex', flexDirection: 'column',
			background: 'var(--rr-bg-paper)', borderRight: '1px solid var(--rr-border)',
			boxShadow: drawerOpen ? '0 0 40px rgba(0, 0, 0, 0.35)' : 'none',
			overflow: 'hidden',
			transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)',
			transition: `transform ${DRAWER_TRANSITION_MS}ms ease, visibility ${DRAWER_TRANSITION_MS}ms`,
			// Not just off-screen: a closed drawer must not be reachable by Tab,
			// and `transform` alone leaves every button in it focusable.
			visibility: drawerOpen ? 'visible' : 'hidden',
		}
		: {
			width: sidebarWidth, minWidth: sidebarWidth, height: '100%',
			display: 'flex', flexDirection: 'column',
			background: 'var(--rr-bg-paper)', borderRight: '1px solid var(--rr-border)',
			position: 'relative', overflow: 'hidden',
			transition: isResizing ? 'none' : `width ${TRANSITION_MS}ms ease, min-width ${TRANSITION_MS}ms ease`,
		};

	return (
		<>
		{/* The page behind the drawer, dimmed and tappable. Rendered even when
		    closed so it can fade rather than blink, and inert while it is. */}
		{isCompact && (
			<div
				aria-hidden="true"
				onPointerDown={requestClose}
				style={{
					position: 'fixed', inset: 0, zIndex: SCRIM_Z,
					background: 'rgba(0, 0, 0, 0.45)',
					opacity: drawerOpen ? 1 : 0,
					pointerEvents: drawerOpen ? 'auto' : 'none',
					transition: `opacity ${DRAWER_TRANSITION_MS}ms ease`,
				}}
			/>
		)}
		<div
			id="rr-shell-sidebar"
			role={isCompact ? 'dialog' : undefined}
			aria-modal={isCompact ? true : undefined}
			aria-label={isCompact ? 'Navigation' : undefined}
			style={frame}
		>
			{/* ================================================================
			    HEADER — AppSwitcherButton + collapse toggle
			    ================================================================ */}
			<div
				style={{ display: 'flex', alignItems: 'center', justifyContent: effectiveCollapsed ? 'center' : undefined, height: 52, padding: effectiveCollapsed ? '8px 8px 0' : '8px 12px 0', flexShrink: 0, marginBottom: 10 }}
				onMouseEnter={() => setHeaderHover(true)}
				onMouseLeave={() => setHeaderHover(false)}
			>
				{effectiveCollapsed ? (
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
						{headerHover ? <BxDockLeft size={20} /> : <AppSwitcherButton collapsed={effectiveCollapsed} />}
					</button>
				) : (
					<>
						<button
							title="Go to home"
							aria-label="Go to home"
							onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: homeAppId })}
							onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
							style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', padding: '2px 4px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', transition: 'background 120ms ease' }}
						>
							<AppSwitcherButton collapsed={effectiveCollapsed} />
						</button>
						<button
							title={isCompact ? 'Close navigation' : 'Collapse sidebar'}
							aria-label={isCompact ? 'Close navigation' : 'Collapse sidebar'}
							onClick={isCompact ? requestClose : toggleCollapse}
							onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
							/* 28px suits a mouse in the desktop header; the same button in the
							   drawer is the one a thumb reaches for, and 28 is well under
							   the 44 the rest of the compact chrome keeps to. */
							style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: isCompact ? 44 : 28, height: isCompact ? 44 : 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--rr-text-secondary)', flexShrink: 0, transition: 'background 120ms ease' }}
						>
							{isCompact ? <BxX size={20} /> : <BxDockLeft size={18} />}
						</button>
					</>
				)}
			</div>

			{/* ================================================================
			    APP SIDEBAR CONTENT SLOT — scrolls between fixed header/footer
			    ================================================================ */}
			<div
				onClickCapture={onSlotClickCapture}
				style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 }}
			>
				{/* App-declared sidebar content — rendered ALWAYS, including
				    while collapsed to the icon rail. The provider exposes the
				    collapsed flag; each component inside decides its collapsed form
				    (SidebarMenu iconifies, free-form content returns null; the
				    legacy bridge reads it back into the `collapsed` prop). */}
				<SidebarCollapsedProvider value={effectiveCollapsed}>
					{sidebarContent}
				</SidebarCollapsedProvider>
			</div>

			{/* ================================================================
			    FOOTER — hidden when logged out
			    ================================================================ */}
			{identity && (
				<SidebarFooter
					collapsed={effectiveCollapsed}
					userName={account.userName}
					userEmail={account.userEmail}
					menuItems={footerMenuItems}
				/>
			)}

			{/* ================================================================
			    RESIZE HANDLE — desktop only. A drawer has one width, and dragging
			    it would write the DESKTOP width the user set before they got here.
			    ================================================================ */}
			{!isCompact && (
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
			)}
		</div>
		</>
	);
};

export default Sidebar;
