// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarCollapsedContext — exposes the shell sidebar's collapsed flag to
 * app-registered sidebar content.
 *
 * Collapse contract: the shell sidebar renders the app-registered sidebar
 * content ALWAYS — including while collapsed to the icon rail — and provides
 * this context around the sidebar slot. Each component inside the registered
 * content decides for itself what to do while collapsed: {@link SidebarMenu}
 * iconifies automatically; free-form app-custom content typically returns
 * null when collapsed.
 *
 * Defaults to `false` (expanded) so sidebar components rendered outside a
 * provider — tests, storybooks, hosts without a collapsible sidebar — behave
 * exactly as before the collapse contract existed.
 */

import React, { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

// =============================================================================
// CONTEXT
// =============================================================================

/** Collapsed flag context — `false` (expanded) when no provider is mounted. */
const SidebarCollapsedContext = createContext<boolean>(false);

// =============================================================================
// PROVIDER
// =============================================================================

/** Props for the {@link SidebarCollapsedProvider} component. */
export interface ISidebarCollapsedProviderProps {
	/** Whether the enclosing sidebar is currently collapsed to its icon rail. */
	value: boolean;
	/** The sidebar-slot subtree that may read the collapsed flag. */
	children: ReactNode;
}

/**
 * Provides the sidebar's collapsed flag to the registered sidebar content.
 * Mounted by the shell around the sidebar's app-content slot.
 *
 * @param props - {@link ISidebarCollapsedProviderProps}.
 * @returns The provider element.
 */
export const SidebarCollapsedProvider: React.FC<ISidebarCollapsedProviderProps> = ({ value, children }) => (
	<SidebarCollapsedContext.Provider value={value}>{children}</SidebarCollapsedContext.Provider>
);

// =============================================================================
// HOOK
// =============================================================================

/**
 * Reads whether the enclosing shell sidebar is collapsed to its icon rail.
 * Any component inside app-registered sidebar content may call this; it
 * returns `false` when no provider is mounted (expanded / non-collapsible).
 *
 * @returns True while the sidebar is collapsed.
 */
export function useSidebarCollapsed(): boolean {
	return useContext(SidebarCollapsedContext);
}

// =============================================================================
// COLLAPSED GATE
// =============================================================================

/** Props for the {@link SidebarCollapsedGate} component. */
export interface ISidebarCollapsedGateProps {
	/** The sidebar content to hide while the sidebar is collapsed. */
	children: ReactNode;
}

/**
 * Renders its children only while the sidebar is expanded.
 *
 * The shell renders registered sidebar content even while the sidebar is
 * collapsed to its icon rail. Free-form content with no icon-rail form (file
 * trees, chat explorers) wraps itself in this gate to disappear while
 * collapsed, instead of each app re-implementing the same four lines.
 *
 * @param props - {@link ISidebarCollapsedGateProps}.
 * @returns The children while expanded, or null while collapsed.
 */
export const SidebarCollapsedGate: React.FC<ISidebarCollapsedGateProps> = ({ children }) => {
	// Collapsed flag provided by the shell around the sidebar slot.
	const collapsed = useSidebarCollapsed();
	return collapsed ? null : <>{children}</>;
};
