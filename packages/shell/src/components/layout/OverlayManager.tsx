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
// OVERLAY MANAGER — shell-owned modal dialogs (Account, Settings)
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { ConnectionManager } from '../../connection/connection';
import SettingsProvider from '../../providers/SettingsProvider';

// =============================================================================
// TYPES
// =============================================================================

/** Shell overlay pages that render as modal dialogs over the client area.
 *  'environment' is LEGACY: Environment Variables is a Settings section now,
 *  so the id stays accepted (frozen `shell:openOverlay` vocabulary) but maps
 *  to the settings overlay at that section. */
export type ShellOverlay = 'account' | 'settings' | 'environment' | null;

/** Opaque overlay ids a guest app is allowed to request via `shell:openOverlay`. */
const OPENABLE_OVERLAYS = ['account', 'settings', 'environment'] as const;

/** Type guard: is `id` a valid openable overlay id (not null/unknown)? */
const isOpenableOverlay = (id: unknown): id is Exclude<ShellOverlay, null> => typeof id === 'string' && (OPENABLE_OVERLAYS as readonly string[]).includes(id);

/** The Settings section id the legacy 'environment' overlay maps to. */
const ENVIRONMENT_SECTION_ID = 'environment';

/** The Settings section id the legacy 'account' overlay maps to. */
const ACCOUNT_SECTION_ID = 'account:profile';

/** sessionStorage flag the Profile workspace picker sets before committing a
 *  switch: a freshly (re)mounted OverlayManager that finds it opens Settings
 *  at the Profile section — continuity for the person who initiated the
 *  switch there. sessionStorage, not state: the in-process rescope remounts
 *  this component, and the rescope's reload FALLBACK replaces the page. */
export const WORKSPACE_SWITCH_LAND_KEY = 'rr:workspace-switch-land';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	backdrop: {
		position: 'absolute',
		inset: 0,
		zIndex: 200,
		backgroundColor: 'rgba(0, 0, 0, 0.45)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
	dialog: {
		position: 'relative',
		width: 'min(940px, 90vw)',
		height: 'min(85vh, 900px)',
		backgroundColor: 'var(--rr-bg-default)',
		borderRadius: 8,
		boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	} as CSSProperties,
	// Close floats over the dialog's top-right corner. Shared views draw their
	// own 38px TabControl strip at the top of the dialog, so the button is
	// vertically centered within that band ((38 - ~24px button) / 2 = 7) and
	// reads as the strip row's trailing control. Strip entries are left-aligned,
	// so they never reach the button at standard dialog widths.
	dialogClose: {
		...commonStyles.buttonSecondary,
		position: 'absolute',
		top: 7,
		right: 14,
		zIndex: 10,
		fontFamily: 'var(--rr-font-family)',
		lineHeight: 1,
		padding: '4px 10px',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Props for the OverlayManager component.
 */
export interface OverlayManagerProps {
	/** Children (the client area content rendered behind the overlay). */
	children: React.ReactNode;
}

/**
 * Manages shell-owned overlay dialogs (Account, Settings) that render
 * as modal dialogs over the client area.
 *
 * Provides the overlay state and `onOverlay` callback to child components
 * via the exported `useOverlay` hook.
 */
export const OverlayManager: React.FC<OverlayManagerProps> = ({ children }) => {
	// --- Overlay state -------------------------------------------------------
	const [overlay, setOverlayState] = useState<ShellOverlay>(null);
	/** Settings deep link: the nav section the NEXT settings open lands on. */
	const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);

	/** Overlay setter with the legacy mappings: 'environment' and 'account'
	 *  open Settings at their sections (their own modals are gone). */
	const setOverlay = useCallback((id: ShellOverlay) => {
		if (id === 'environment') {
			setOverlayState('settings');
			setSettingsSection(ENVIRONMENT_SECTION_ID);
		} else if (id === 'account') {
			setOverlayState('settings');
			setSettingsSection(ACCOUNT_SECTION_ID);
		} else {
			// Clear any stale deep link; the openOverlay listener re-sets it
			// right after when the request carries a section.
			setSettingsSection(undefined);
			setOverlayState(id);
		}
	}, []);

	/** Closes the currently open overlay. */
	const closeOverlay = useCallback(() => {
		setOverlayState(null);
		setSettingsSection(undefined);
	}, []);

	// --- Post-switch landing ---------------------------------------------------
	// A workspace switch initiated from the Profile picker remounts this
	// component (in-process rescope) or reloads the page (fallback); either
	// way the picker's sessionStorage flag survives into this fresh mount and
	// reopens Settings at Profile, so the person lands where they left off.
	useEffect(() => {
		try {
			if (window.sessionStorage.getItem(WORKSPACE_SWITCH_LAND_KEY) !== '1') return;
			window.sessionStorage.removeItem(WORKSPACE_SWITCH_LAND_KEY);
		} catch {
			return; // storage unavailable — land on the workbench
		}
		setOverlayState('settings');
		setSettingsSection(ACCOUNT_SECTION_ID);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the flag is consumed once per (re)mount
	}, []);

	// --- Open-overlay requests from guest apps -------------------------------
	// Guest apps (e.g. home-ui's profile menu) can't reach `setOverlay`
	// directly, so they emit `shell:openOverlay` over the event bus and the
	// shell routes it into the same overlay state the sidebar uses.
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:openOverlay', ({ id, section }: { id: ShellOverlay; section?: string }) => {
			// Gate to the contracted ids so a stray runtime value can't open a
			// blank modal shell with no page content.
			if (isOpenableOverlay(id)) {
				setOverlay(id);
				if (id === 'settings') setSettingsSection(section);
			}
		});
	}, [setOverlay]);

	// --- Escape key handler --------------------------------------------------
	useEffect(() => {
		/** Closes the Account or Settings overlay when Escape is pressed. */
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && overlay !== null) {
				e.preventDefault();
				closeOverlay();
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, [overlay, closeOverlay]);

	return (
		<OverlayContext.Provider value={setOverlay}>
			{children}

			{/* Shell-owned overlays render as modal dialogs over client area.
			    Pages render directly; views with sub-views draw their own
			    TabControl strip at the top of the dialog. Dismissal is
			    deliberate only (design-owner decision 2026-07-08): the ✕ button
			    or Escape — clicking the backdrop must NOT close the dialog. */}
			{overlay !== null && (
				<div style={styles.backdrop}>
					{/* aria-label carries the overlay id (account/settings/…): the
					    dialog itself has no visible heading to reference.
					    data-rr-overlay-root: the dialog IS the owning surface for
					    every `contained` DetailPanel opened inside it — record
					    drawers slide over (and dim) the whole dialog, chrome and
					    nav included. */}
					<div style={styles.dialog} role="dialog" aria-modal="true" aria-label={overlay} data-rr-overlay-root="1">
						<button style={styles.dialogClose} onClick={closeOverlay} aria-label="Close" title="Close">
							✕
						</button>
						{overlay === 'settings' && <SettingsProvider initialSectionId={settingsSection} />}
					</div>
				</div>
			)}
		</OverlayContext.Provider>
	);
};

// =============================================================================
// CONTEXT — allows Sidebar to trigger overlays
// =============================================================================

const OverlayContext = React.createContext<(overlay: ShellOverlay) => void>(() => {});

/**
 * Hook to get the overlay setter from the OverlayManager context.
 * Used by the Sidebar to open Account/Settings overlays.
 */
export function useOverlay(): (overlay: ShellOverlay) => void {
	return React.useContext(OverlayContext);
}
