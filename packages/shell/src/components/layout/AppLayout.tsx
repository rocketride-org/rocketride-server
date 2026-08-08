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
// APP LAYOUT — the one app-root layout component
// =============================================================================
//
// Every app renders this as the root of its single `app` mount and declares
// its layout with props:
//
//   <AppLayout>                                  one column, full client area
//   <AppLayout sidebar={<Nav/>}>                 two columns (sidebar + client)
//   <AppLayout sidebar={<Nav/>} showStatus>      + status bar
//
// The sidebar prop is the SCROLLING PORTION of the sidebar column — the fixed
// chrome around it (app-switcher header, account/connection footer) is the
// platform's guaranteed navigation and is rendered by the layout machinery,
// never by apps. The status bar's connection identity is likewise stock;
// `status` adds app content to its middle slot.
//
// Because the sidebar and status nodes are ordinary children of the app's own
// tree, the app is ONE program: state, module singletons, and callbacks are
// shared naturally between sidebar and client area.
//
// TODAY this bridges the nodes into the shell's chrome slots. When apps move
// to owning the full screen (one frame per app), this same component renders
// the chrome in place — app code written against it does not change.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { useSidebarContent, useStatusBarContent } from './HostChromeContext';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The app's client-area root: fill the space the shell grants, clip
	// overflow, and give children a proper flex column to lay out in.
	screen: {
		width: '100%',
		height: '100%',
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link AppLayout}. */
export interface AppLayoutProps {
	/** The scrolling portion of the sidebar column. Present = two-column app;
	    absent = one-column app spanning the full client area. Components
	    inside read `useSidebarCollapsed()` to choose their collapsed
	    (icon-rail) form. */
	sidebar?: ReactNode;
	/** Show the status bar (stock connection identity). Defaults to false. */
	showStatus?: boolean;
	/** App content for the status bar's middle slot. Providing it implies
	    `showStatus`. */
	status?: ReactNode;
	/** The app's client-area content. */
	children: ReactNode;
}

// =============================================================================
// APP LAYOUT
// =============================================================================

/**
 * The app-root layout. See the file header for the three layouts and the
 * sidebar/status contracts.
 *
 * @param props - See {@link AppLayoutProps}.
 */
export const AppLayout: React.FC<AppLayoutProps> = ({ sidebar, showStatus, status, children }) => {
	// Bridge the declared chrome nodes into the shell slots. A non-null
	// status registration is what summons the bar, so a bare `showStatus`
	// registers an empty fragment (stock identity only).
	useSidebarContent(sidebar ?? null);
	useStatusBarContent(status ?? (showStatus ? <></> : null));
	return <div style={styles.screen}>{children}</div>;
};
