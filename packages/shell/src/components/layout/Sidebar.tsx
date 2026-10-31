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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BxDockLeft, BxX } from '../BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import type { IconComponent } from '../BoxIcon';
import { useWorkspace } from '../workspace/WorkspaceContext';
import type { ShellThemeConfig, ShellAccountConfig } from '../workspace/types';
import { SidebarFooter, openPlatformDocs } from '../sidebar-footer/SidebarFooter';
import { useSidebarFooterMenu } from './useSidebarFooterMenu';
import { RocketRideMark } from '../RocketRideMark';
import { SidebarCollapsedProvider } from '../sidebar-menu/SidebarCollapsedContext';
import { SidebarActiveViewProvider } from '../sidebar-menu/SidebarActiveViewContext';
import type { SidebarActiveView } from '../sidebar-menu/SidebarActiveViewContext';
import { SidebarViewStrip, resolveActiveView, viewTitleStyle } from './SidebarViewStrip';
import { realmPrefsHub, typedPrefs, usePref } from '../workspace/prefsStore';
import type { SidebarPrefsMap } from '../../workspace/devToolPins';
import { appPartition } from '../../workspace/workspaceStore';
import { TabPanel } from '../tab-panel/TabPanel';
import type { ITabPanelPanel } from '../tab-panel/TabPanel';
import { useHostChromeState } from './HostChromeContext';
import { useCompactNav } from './CompactNavContext';
import { FOCUSABLE_SELECTOR, trapFocus } from '../modal/Modal';
import type { SidebarViewContainer } from '../../types/sidebarChrome';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 56;

/** Where an app's answered sidebar preference is kept, by app id. */
const MEMORY_KEY = 'rr.shell.sidebar';

/**
 * Whether this app asked for the rail closed, last time it was here.
 *
 * Read during the first render, so the answer costs nothing and arrives before
 * the first paint. Storage can throw — a locked-down profile, private mode in
 * some browsers — and a sidebar is not worth failing a boot over, so anything
 * unreadable means "no answer" and the rail opens as it always did.
 *
 * @param appId - The app about to be shown.
 * @returns True when it asked to be collapsed.
 */
function remembered(appId: string): boolean {
	if (!appId) return false;
	try {
		return window.localStorage.getItem(`${MEMORY_KEY}:${appId}`) === 'collapsed';
	} catch {
		return false;
	}
}

/**
 * Remember what an app asked for.
 *
 * The APP's preference, not the person's: expanding the rail by hand is a
 * decision about this visit, and writing it here would quietly turn "opens
 * closed" into "opens however you left it".
 *
 * @param appId - The app that asked.
 * @param collapsed - What it asked for.
 */
function remember(appId: string, collapsed: boolean): void {
	if (!appId) return;
	try {
		window.localStorage.setItem(`${MEMORY_KEY}:${appId}`, collapsed ? 'collapsed' : 'expanded');
	} catch {
		// Nothing to do and nothing worth saying: the rail still works, it just
		// collapses on the way in each time rather than arriving collapsed.
	}
}
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
 * Auth state is deliberately NOT consulted (design decision 2026-10-12):
 * the sidebar is the app's chrome, not a session privilege — it renders
 * signed out too, with the footer in its anonymous form.
 *
 * @returns Whether to show a sidebar, or a way to open one.
 */
export function useHasSidebarContent(): boolean {
	const { activeAppId, loadedApps } = useWorkspace();
	const { sidebarContent, sidebarViews } = useHostChromeState();
	return !!loadedApps[activeAppId]?.components?.Sidebar || sidebarContent != null || (sidebarViews?.length ?? 0) > 0;
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
 * Reads --rr-rail-mode from :root and re-reads on theme changes.
 *
 * Rail polarity is a THEME FACT, not a law: most themes keep the activity
 * rail inverted (dark), but a theme may declare `--rr-rail-mode: light`
 * (rocketride-light sets the rail to its paper color). Everything that
 * adapts icons to the rail's ground — the dark-variant preference, the
 * legibility plate — reads this instead of assuming darkness. Absent
 * declaration = 'dark', matching the rail tokens' built-in fallbacks.
 */
export const useRailMode = (): 'dark' | 'light' => {
	const read = () => (getComputedStyle(document.documentElement).getPropertyValue('--rr-rail-mode').trim() as 'dark' | 'light') || 'dark';
	const [mode, setMode] = useState(read);
	useEffect(() => {
		const obs = new MutationObserver(() => setMode(read()));
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
		return () => obs.disconnect();
	}, []);
	return mode;
};

/**
 * The active app's display identity — name, branding, and an icon renderer.
 *
 * Icon priority: branding.iconDark/iconLight (theme-aware) → branding.icon →
 * manifest icon (URL) → RocketRide mark fallback.
 *
 * Exported (shell-internal, not on the api.ts surface) so every chrome that
 * speaks for the app — the classic lockup, the workbench panel header, the
 * synthetic rail view for legacy single-node sidebars — resolves identity
 * through ONE path.
 */
export function useActiveAppIdentity(): {
	isHome: boolean;
	/** Display name — the manifest name; the platform name only as last resort. */
	name: string;
	/** App-supplied whole-header lockup, when any (branding.logo). */
	logo: React.ReactNode | undefined;
	/**
	 * Renders the resolved icon at a given square size. `surface` picks the
	 * theme variant by the GROUND the icon sits on: 'panel' (default) follows
	 * the page palette; 'rail' follows the theme's declared rail polarity
	 * (`--rr-rail-mode`, default dark). On a DARK rail, a manifest icon —
	 * full-color store art designed for light ground — renders on a small
	 * constant-light plate so it stays legible; branding icons are never
	 * plated (the author designed them for the chrome and owns them).
	 */
	renderIcon: (size: number, surface?: 'panel' | 'rail') => React.ReactNode;
} {
	const { activeAppId, appManifest, loadedApps } = useWorkspace();
	const paletteMode = usePaletteMode();
	const railMode = useRailMode();
	const isHome = activeAppId === 'rocketride.home';
	const activeManifest = appManifest.find((a) => a.id === activeAppId) ?? null;
	const branding = loadedApps[activeAppId]?.branding;

	const renderIcon = (size: number, surface: 'panel' | 'rail' = 'panel'): React.ReactNode => {
		// Step 1: branding iconDark / iconLight — picked by the GROUND, not
		// only the page palette: the rail's polarity is the theme's call
		// (--rr-rail-mode), so a dark rail takes the dark-ground variant
		// regardless of the light/dark page setting.
		const wantDark = surface === 'rail' ? railMode === 'dark' : paletteMode === 'dark';
		const themed = wantDark ? branding?.iconDark : branding?.iconLight;
		if (themed) return <div style={{ width: size, height: size, flexShrink: 0 }}>{themed}</div>;

		// Step 2: branding generic icon
		if (branding?.icon) return <div style={{ width: size, height: size, flexShrink: 0 }}>{branding.icon}</div>;

		// Step 3: manifest icon URL. On a dark rail it sits on a constant-light
		// plate: the asset's canonical home is a light surface (MY APPS, the
		// store tiles), and nobody designed it for inverted chrome. A light
		// rail IS that surface, so no plate there.
		if (!isHome && activeManifest?.icon) {
			const img = <img src={activeManifest.icon} alt="" style={{ width: size, height: size, flexShrink: 0 }} />;
			if (surface === 'rail' && railMode === 'dark') {
				return (
					<div style={{
						width: size + 8, height: size + 8, borderRadius: 6, flexShrink: 0,
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						// OPAQUE by design — a translucent plate reads as a smudge on
					// the dark rail (design feedback 2026-10-12).
					background: 'var(--rr-bg-rail-plate, #ffffff)',
					}}>
						{img}
					</div>
				);
			}
			return img;
		}

		// Step 4: RocketRide mark
		return <RocketRideMark size={size} color="var(--rr-brand)" />;
	};

	return { isHome, name: activeManifest?.name ?? 'RocketRide', logo: branding?.logo, renderIcon };
}

/**
 * The sidebar header lockup: THE APP'S identity — its icon beside its name.
 *
 * Design decision (sidebar refactor): the header speaks for the app, not the
 * platform — no RocketRide wordmark, no uppercase micro-label. The platform's
 * identity lives in the footer (account menu) and on the home app, whose own
 * manifest identity renders here like any other app's. `branding.logo` still
 * replaces the whole lockup for apps that bring their own.
 */
export const AppSwitcherButton: React.FC<{
	collapsed: boolean;
	/** Omit the icon from the expanded row — for frames whose rail ALREADY
	    shows the app's icon right beside this header (the single-view
	    workbench), where repeating it reads as a stutter: the rail icon and
	    this name then compose as one lockup. */
	hideIcon?: boolean;
}> = ({ collapsed, hideIcon = false }) => {
	const { name, logo, renderIcon } = useActiveAppIdentity();

	// Collapsed: show the same icon as the expanded state, centered
	if (collapsed) {
		return (
			<div style={{
				width: COLLAPSED_BTN, height: COLLAPSED_BTN, margin: '0 auto',
				display: 'flex', alignItems: 'center', justifyContent: 'center',
			}}>
				{renderIcon(20)}
			</div>
		);
	}

	// An app may bring its own header lockup — it owns the whole row.
	if (logo) {
		return (
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '4px 4px 2px', minWidth: 0 }}>
				{logo}
			</div>
		);
	}

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, padding: '2px 2px' }}>
			{!hideIcon && renderIcon(20)}
			<span style={{
				fontSize: 13, fontWeight: 600, letterSpacing: '0.1px',
				color: 'var(--rr-text-primary)',
				overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				minWidth: 0,
			}}>
				{name}
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
const Sidebar: React.FC<SidebarProps> = ({ themeConfig: _themeConfig, account, hideAppSwitcher, onOverlay, isSaas }) => {
	// Not props: `SidebarProps` is part of the frozen app-facing contract, and
	// the drawer is a shell-internal concern no app can see. See
	// `CompactNavContext`.
	const { isCompact, drawerOpen, requestClose } = useCompactNav();
	const { activeAppId, loadedApps } = useWorkspace();

	// --- Collapse / resize state ---------------------------------------------

	// Closed on the FIRST FRAME for an app already known to want it closed.
	//
	// The preference itself arrives with the app's descriptor, which is loaded
	// after the shell has painted — so honouring it only from there means the
	// rail opens and then shuts on every visit, and means nothing at all if the
	// descriptor is slow or never lands. Remembering the answer turns that into
	// a one-time event: the first ever visit to an app collapses on the way in,
	// every visit after renders closed.
	const [collapsed, setCollapsed] = useState(() => remembered(activeAppId));
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
	const { sidebarContent, sidebarViews } = useHostChromeState();

	// --- Drawer view switcher (compact + declared containers) ------------------
	// Below the breakpoint ShellLayout renders THIS frame even for apps that
	// declared `sidebarViews` — a rail-plus-panel makes no sense on a phone.
	// The declaration still applies: the drawer renders the SAME containers as
	// the workbench, as the SAME icon strip (SidebarViewStrip), sharing the
	// SAME remembered per-app selection — a rendering switch on the compact
	// media query, never a different sidebar with its own switcher.
	const views: SidebarViewContainer[] = (sidebarViews ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	// The APP's own partition — same store the workbench frame reads, so the
	// two chromes cannot disagree about which container is selected.
	const drawerPrefs = useMemo(
		() => typedPrefs<SidebarPrefsMap>(realmPrefsHub(ConnectionManager.getInstance()).partition(appPartition(activeAppId))),
		[activeAppId],
	);
	const drawerViewId = usePref(drawerPrefs, 'sidebarActiveView') ?? '';
	// No per-app re-read: the selection is ONE pref the store notifies on, so
	// this frame and the workbench cannot drift apart or go stale.
	const activeDrawerView = resolveActiveView(views, drawerViewId);
	/** Activate a container — the same pref the workbench reads/writes. */
	const selectDrawerView = useCallback((id: string) => {
		drawerPrefs.set('sidebarActiveView', id);
	}, [drawerPrefs]);
	const drawerViewHandle = useMemo<SidebarActiveView>(() => ({
		activeViewId: activeDrawerView?.id ?? '',
		setActiveView: selectDrawerView,
	}), [activeDrawerView?.id, selectDrawerView]);
	const drawerHasViews = isCompact && views.length > 0;

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

	// --- The active app's own preference -------------------------------------

	/**
	 * Open the way the app being opened asks to be opened.
	 *
	 * Keyed on the app id, so it fires when an app becomes active and not on
	 * every render: inside an app the person's own toggle wins, and it keeps
	 * winning until they leave and come back.
	 *
	 * An app that declares NOTHING is not an app that declares 'expanded' — it
	 * leaves the sidebar alone. Treating silence as a preference would mean
	 * every app switch overrode a rail the person had deliberately collapsed.
	 */
	const wanted = loadedApps[activeAppId]?.sidebar;

	/**
	 * Take a preference, and remember it for next time.
	 *
	 * Below the breakpoint the sidebar is a drawer, and a drawer is never
	 * collapsed — see `effectiveCollapsed` above. The answer is still REMEMBERED
	 * there, so a phone that later becomes a wide window opens the way the app
	 * asked; only the flag is left alone.
	 */
	const prefer = useCallback((next: boolean) => {
		remember(activeAppId, next);
		if (isCompact) return;
		setCollapsed(next);
	}, [activeAppId, isCompact]);

	// Read through a ref, and keyed on the APP rather than on `prefer`.
	//
	// `prefer` changes identity with `isCompact`, so depending on it re-ran this
	// on every breakpoint crossing and re-applied the app's preference over a
	// rail the person had opened by hand: declare `sidebar: 'collapsed'`, expand
	// it, narrow the window under 1024 and widen it again, and the rail shut
	// itself. That contradicts both invariants above — the person's own toggle
	// wins inside an app, and crossing back restores the rail they had.
	const preferRef = useRef(prefer);
	preferRef.current = prefer;
	useEffect(() => {
		if (!wanted) return;
		preferRef.current(wanted === 'collapsed');
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see above: keyed on the app, not on `prefer`
	}, [wanted, activeAppId]);

	// The same preference, asked for directly.
	//
	// An app can reach this on its own first render, which is earlier and more
	// certain than its descriptor reaching the shell's `loadedApps` map — and it
	// is the path that works when that map does not have what it wants.
	//
	// A LAYOUT effect, because the event is not replayed. An app emitting from
	// its own layout effect runs before every passive effect in the commit, so a
	// passive subscription here would miss it on first mount — and on an app
	// switch the stale listener, still bound to the previous app's id, would
	// catch it and file the answer under the wrong app. The sidebar precedes the
	// client area in the tree, so its layout effects run first.
	useLayoutEffect(() => (
		ConnectionManager.getInstance().on(
			'shell:setSidebarCollapsed',
			({ collapsed: next }: { collapsed: boolean }) => prefer(next),
		)
	), [prefer]);

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

	// --- The drawer is a dialog: focus goes in, stays in, and comes back ------
	//
	// `aria-modal` tells assistive tech nothing behind the scrim is reachable.
	// Without this Tab walks straight out of the drawer into the dimmed page,
	// and closing it strands focus on a button that is no longer visible.
	//
	// The trap listens on the drawer, not the document: it acts only while focus
	// is inside, so a dialog or DetailPanel opened from the drawer keeps its own
	// Tab and Escape, and the shared overlay stack is left exactly as it was.
	const frameRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!isCompact || !drawerOpen) return undefined;
		const drawer = frameRef.current;
		if (!drawer) return undefined;
		const opener = document.activeElement;
		(drawer.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? drawer).focus();
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Tab') trapFocus(event, drawer);
		};
		drawer.addEventListener('keydown', onKeyDown);
		return () => {
			drawer.removeEventListener('keydown', onKeyDown);
			// Back to the hamburger — unless something the drawer opened (an
			// overlay, a panel) has already taken focus somewhere else. Safari
			// does not focus a tapped button, so the opener may be the body; the
			// trigger is found by the drawer it controls.
			const active = document.activeElement;
			if (active && active !== document.body && !drawer.contains(active)) return;
			const trigger =
				opener instanceof HTMLElement && opener !== document.body && opener.isConnected
					? opener
					: document.querySelector<HTMLElement>('[aria-controls="rr-shell-sidebar"]');
			trigger?.focus();
		};
	}, [isCompact, drawerOpen]);

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

	// --- Footer menu items ---------------------------------------------------
	// The platform footer menu is assembled by the shared hook so this frame
	// and the workbench frames (vscode/cursor) can never drift apart.
	const { footerMenuItems, homeAppId } = useSidebarFooterMenu({ account, hideAppSwitcher, onOverlay, isSaas });

	// NOTE: auth state deliberately does NOT gate the frame (design decision
	// 2026-10-12) — the sidebar is the app's chrome, not a session privilege.

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
			// Visible AT ONCE on the way in, so the focus move below lands on
			// something focusable; held visible to the end on the way out, so
			// the slide stays on screen.
			transition: drawerOpen
				? `transform ${DRAWER_TRANSITION_MS}ms ease`
				: `transform ${DRAWER_TRANSITION_MS}ms ease, visibility ${DRAWER_TRANSITION_MS}ms`,
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
			ref={frameRef}
			tabIndex={isCompact ? -1 : undefined}
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
			    DRAWER VIEW SWITCHER — the workbench's strip, drawer-rendered
			    ================================================================ */}
			{/* OUTSIDE the slot's close-on-click capture (and above its scroll):
			    switching views opens more UI inside the drawer, so the tap must
			    not close it — the same reasoning as data-rr-drawer="keep". */}
			{drawerHasViews && (
				<>
					<SidebarViewStrip views={views} activeId={activeDrawerView?.id ?? ''} onSelect={selectDrawerView} />
					{activeDrawerView && views.length > 1 && <div style={viewTitleStyle}>{activeDrawerView.title}</div>}
				</>
			)}

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
					{drawerHasViews ? (
						// Containers with their own content switch through the stock
						// TabPanel (all bodies stay mounted — tree/scroll state
						// survives switches); containers without content share the
						// registered `sidebar` node, which learns the selection
						// through the active-view context. The SAME structure as the
						// workbench's panel body, under the drawer's chrome.
						<SidebarActiveViewProvider value={drawerViewHandle}>
							<div style={{ display: activeDrawerView?.content != null ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
								{sidebarContent}
							</div>
							{views.some((v) => v.content != null) && (
								<div style={{ display: activeDrawerView?.content != null ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
									<TabPanel
										activeId={activeDrawerView?.content != null ? activeDrawerView.id : views.find((v) => v.content != null)!.id}
										panels={views.reduce<Record<string, ITabPanelPanel>>((acc, v) => {
											if (v.content != null) acc[v.id] = { content: v.content };
											return acc;
										}, {})}
									/>
								</div>
							)}
						</SidebarActiveViewProvider>
					) : (
						sidebarContent
					)}
				</SidebarCollapsedProvider>
			</div>

			{/* ================================================================
			    FOOTER — anonymous form when logged out
			    ================================================================ */}
			<SidebarFooter
				collapsed={effectiveCollapsed}
				userName={account.userName}
				userEmail={account.userEmail}
				menuItems={footerMenuItems}
				onOpenDocs={openPlatformDocs}
			/>

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
