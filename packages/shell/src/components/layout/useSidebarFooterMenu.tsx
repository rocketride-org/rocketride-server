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
// SIDEBAR FOOTER MENU — the platform footer items, shared across frames
// =============================================================================
//
// Extracted from Sidebar so the classic column and the workbench frames
// (vscode/cursor modes) assemble the SAME footer menu — Home, Account,
// Variables, Settings, Theme, Switch App, Log out — instead of each frame
// growing its own copy that drifts. The items are platform chrome, not app
// content: whatever frame hosts the SidebarFooter, the menu is this one.
// =============================================================================

import React, { useCallback, useMemo } from 'react';
import {
	BxCog, BxLock, BxPalette, BxUser, BxExport, BxGridAlt, BxHome,
} from '../BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import { getHomeAppId } from '../../constants';
import { useWorkspace } from '../workspace/WorkspaceContext';
import type { ShellAccountConfig } from '../workspace/types';
import type { SidebarFooterMenuItem } from '../sidebar-footer/SidebarFooter';
import { useSubscriptions } from '../../hooks/useSubscriptions';

// =============================================================================
// APP ICON
// =============================================================================

/**
 * App-switcher icon: renders the app's logo when available, otherwise a
 * two-letter monogram fallback (initials of the first two words, or the
 * first two characters of a single-word name).
 *
 * Defined at module scope so it keeps a stable component identity across
 * renders instead of being recreated inline per menu item.
 */
export const AppIcon: React.FC<{ name: string; iconUrl?: string; size?: number }> = ({ name, iconUrl, size = 16 }) => {
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

// =============================================================================
// TYPES
// =============================================================================

/** Inputs for {@link useSidebarFooterMenu} — the frame's own configuration. */
export interface ISidebarFooterMenuOptions {
	/** Account info and logout callback. */
	account: ShellAccountConfig;
	/** When true, the app switcher submenu is hidden. */
	hideAppSwitcher?: boolean;
	/** Callback to open a shell overlay (account, settings, environment). */
	onOverlay: (overlay: 'account' | 'settings' | 'environment') => void;
	/** Server-probed edition flag — gates SaaS-only items (Account overlay). */
	isSaas?: boolean;
}

/** What the hook hands back to the hosting frame. */
export interface ISidebarFooterMenu {
	/** The assembled footer menu items, ready for SidebarFooter. */
	footerMenuItems: SidebarFooterMenuItem[];
	/** The deployment's home app id ($HOME resolution for header buttons). */
	homeAppId: string;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Assembles the platform footer menu for a sidebar frame.
 *
 * Reads the workspace (theme options, app manifest, active app) and the
 * subscription gate itself; the frame only supplies its own configuration.
 *
 * @param options - See {@link ISidebarFooterMenuOptions}.
 * @returns The menu items and the resolved home app id.
 */
export function useSidebarFooterMenu({ account, hideAppSwitcher, onOverlay, isSaas }: ISidebarFooterMenuOptions): ISidebarFooterMenu {
	const { prefs, setTheme, themeOptions, activeAppId, appManifest } = useWorkspace();
	const { isOnDesktop } = useSubscriptions();

	/** Apply a theme — delegates to the context's setTheme which handles both prefs and CSS. */
	const handleThemeSelect = useCallback((themeId: string) => {
		setTheme(themeId);
	}, [setTheme]);

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
				console.log('[SidebarFooterMenu] handleSwitchApp called with appId:', appId);
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

	return { footerMenuItems, homeAppId };
}
