// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CompactNavContext — the drawer's state, shared inside the shell only.
 *
 * Below `COMPACT_BREAKPOINT_PX` the sidebar stops being a column and becomes a
 * drawer over the client area. Three things have to agree about that: the
 * layout that stops reserving width, the sidebar that changes shape, and the
 * hamburger that opens it.
 *
 * **A context rather than props, and that is the whole point.** `SidebarProps`
 * is part of the frozen app-facing contract
 * (`packages/shell-api/versions/v0.d.ts`), which is generated and must not be
 * edited by hand. Adding three fields to it — even optional ones — would drift
 * that surface for a concern no app can see or use. A context passes the same
 * three values without appearing in any exported type.
 *
 * Not exported from `src/index.ts`. Nothing outside the shell may read it, and
 * an app that needs the drawer closed emits `shell:sidebarCollapsing`, which
 * already exists.
 */

import React, { createContext, useContext } from 'react';

export interface CompactNav {
	/** The window is too narrow for a permanent column. */
	isCompact: boolean;
	/** Whether the drawer is showing. Meaningless unless `isCompact`. */
	drawerOpen: boolean;
	/** Put the drawer away: the scrim, the close button, a destination tap. */
	requestClose: () => void;
}

/** Desktop, with no drawer, is what a component outside the provider sees. */
const FALLBACK: CompactNav = { isCompact: false, drawerOpen: false, requestClose: () => {} };

const CompactNavContext = createContext<CompactNav>(FALLBACK);

/**
 * Share the drawer's state with the sidebar and the chrome bar.
 *
 * @param props.value - The current state, owned by `ShellLayout`.
 * @param props.children - The shell.
 * @returns The provider.
 */
export const CompactNavProvider: React.FC<{ value: CompactNav; children: React.ReactNode }> = ({
	value,
	children,
}) => <CompactNavContext.Provider value={value}>{children}</CompactNavContext.Provider>;

/** The drawer's state. Desktop defaults outside the provider. */
export function useCompactNav(): CompactNav {
	return useContext(CompactNavContext);
}
