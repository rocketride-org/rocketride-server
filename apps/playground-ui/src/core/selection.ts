// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * What is open on the right, shared by the browser app and the dev tool:
 * the connection, the conversation (null = a new one), and a counter that
 * makes every New conversation a fresh pane. Plus the view choice (Simple /
 * Advanced), kept per surface in the shell's app state.
 */

import { useCallback, useState } from 'react';
import { useAppState } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** What the right side shows. */
export interface Selection {
	/** The open connection, or null for the picker. */
	connectionId: string | null;
	/** The conversation to open, or null for a new one. */
	sessionId: string | null;
	/** Bumped by New conversation, so the pane starts fresh. */
	fresh: number;
}

/** The app-state key holding the view choice. */
const VIEW_KEY = 'playground.view';

// =============================================================================
// HOOKS
// =============================================================================

/**
 * The Simple / Advanced choice for this surface.
 *
 * @param fallback - The surface's default ('simple' in the browser, 'advanced' in the dev tool).
 * @returns Whether Simple is on, and its toggle.
 */
export function useViewChoice(fallback: 'simple' | 'advanced'): { simple: boolean; toggle: () => void } {
	const appState = useAppState();
	const [view, setView] = useState<'simple' | 'advanced'>(() => {
		const stored = appState.getAppState(VIEW_KEY);
		return stored === 'simple' || stored === 'advanced' ? stored : fallback;
	});
	const toggle = useCallback(() => {
		setView((cur) => {
			const next = cur === 'simple' ? 'advanced' : 'simple';
			appState.setAppState(VIEW_KEY, next);
			return next;
		});
	}, [appState]);
	return { simple: view === 'simple', toggle };
}

/**
 * The selection and its moves.
 *
 * @param initial - The connection to open first (a deep link), if any.
 * @returns The selection and its setters.
 */
export function useSelection(initial: string | null): {
	selection: Selection;
	open: (connectionId: string | null, sessionId: string | null) => void;
	startNew: (connectionId: string) => void;
} {
	const [selection, setSelection] = useState<Selection>({ connectionId: initial, sessionId: null, fresh: 0 });
	const open = useCallback((connectionId: string | null, sessionId: string | null) => setSelection((cur) => ({ connectionId, sessionId, fresh: cur.fresh })), []);
	const startNew = useCallback((connectionId: string) => setSelection((cur) => ({ connectionId, sessionId: null, fresh: cur.fresh + 1 })), []);
	return { selection, open, startNew };
}
