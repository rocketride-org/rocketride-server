// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarDensityContext — the row size the active app asked for, handed to the
 * menus in its sidebar.
 *
 * The app declares it once through `branding.sidebarDensity`; the shell
 * sidebar provides it around the app's sidebar slot, and {@link SidebarMenu}
 * reads it. Shell-internal: an app never imports this, so it adds nothing to
 * the frozen contract beyond the branding field itself.
 *
 * Defaults to 'compact' so a SidebarMenu outside a provider — tests, the
 * VS Code host, any other host — draws exactly as it always has.
 */

import React, { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ShellSidebarDensity } from '../workspace/types';

/** Row size of a sidebar menu. */
export type SidebarDensity = ShellSidebarDensity;

/** Density context — 'compact' when no provider is mounted. */
const SidebarDensityContext = createContext<SidebarDensity>('compact');

/** Props for the {@link SidebarDensityProvider} component. */
export interface ISidebarDensityProviderProps {
	/** The row size the active app asked for. */
	value: SidebarDensity;
	/** The sidebar-slot subtree whose menus read it. */
	children: ReactNode;
}

/**
 * Provides the row size to the menus in the sidebar slot.
 *
 * @param props - {@link ISidebarDensityProviderProps}.
 * @returns The provider element.
 */
export const SidebarDensityProvider: React.FC<ISidebarDensityProviderProps> = ({ value, children }) => <SidebarDensityContext.Provider value={value}>{children}</SidebarDensityContext.Provider>;

/**
 * Reads the row size of the enclosing sidebar.
 *
 * @returns 'comfortable' when the active app asked for it, else 'compact'.
 */
export function useSidebarDensity(): SidebarDensity {
	return useContext(SidebarDensityContext);
}
