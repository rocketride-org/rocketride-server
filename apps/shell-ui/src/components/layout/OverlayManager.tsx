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
import { commonStyles } from 'shared/themes/styles';
import { ConnectionManager } from '../../connection/connection';
import AccountPage from '../../views/account/AccountPage';
import SettingsPage from '../../views/settings/SettingsPage';
import EnvironmentPage from '../../views/environment/EnvironmentPage';

// =============================================================================
// TYPES
// =============================================================================

/** Shell overlay pages that render as modal dialogs over the client area. */
export type ShellOverlay = 'account' | 'settings' | 'environment' | null;

/** Opaque overlay ids a guest app is allowed to request via `shell:openOverlay`. */
const OPENABLE_OVERLAYS = ['account', 'settings', 'environment'] as const;

/** Type guard: is `id` a valid openable overlay id (not null/unknown)? */
const isOpenableOverlay = (id: unknown): id is Exclude<ShellOverlay, null> =>
	typeof id === 'string' && (OPENABLE_OVERLAYS as readonly string[]).includes(id);

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
	dialogClose: {
		...commonStyles.buttonSecondary,
		position: 'absolute',
		top: 12,
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
	const [overlay, setOverlay] = useState<ShellOverlay>(null);

	/** Closes the currently open overlay. */
	const closeOverlay = useCallback(() => setOverlay(null), []);

	// --- Open-overlay requests from guest apps -------------------------------
	// Guest apps (e.g. home-ui's profile menu) can't reach `setOverlay`
	// directly, so they emit `shell:openOverlay` over the event bus and the
	// shell routes it into the same overlay state the sidebar uses.
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:openOverlay', ({ id }: { id: ShellOverlay }) => {
			// Gate to the contracted ids so a stray runtime value can't open a
			// blank modal shell with no page content.
			if (isOpenableOverlay(id)) setOverlay(id);
		});
	}, []);

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

			{/* Shell-owned overlays render as modal dialogs over client area */}
			{overlay !== null && (
				<div style={styles.backdrop} onClick={closeOverlay}>
					<div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
						<button style={styles.dialogClose} onClick={closeOverlay}>✕</button>
						{overlay === 'account' && <AccountPage />}
						{overlay === 'settings' && <SettingsPage />}
						{overlay === 'environment' && <EnvironmentPage />}
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
