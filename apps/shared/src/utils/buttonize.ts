// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * buttonize — keyboard parity for clickable non-button nodes.
 *
 * Some affordances render as `div`/`span` because a stock Button would fight
 * the layout (version cards, where-live rows, pills, option rows). Spreading
 * `{...buttonize(activate)}` onto such a node gives it the same semantics the
 * stock Card applies to its interactive form: `role="button"`, a tab stop,
 * and Enter/Space activation (Space's default page scroll suppressed).
 *
 * The activate callback receives the originating event so nested affordances
 * can `stopPropagation()` once and cover the click AND keyboard paths.
 */

import type React from 'react';

// =============================================================================
// BUTTONIZE
// =============================================================================

/** The prop bundle {@link buttonize} spreads onto a clickable node. */
export interface IButtonizeProps {
	role: 'button';
	tabIndex: number;
	'aria-disabled': boolean;
	onClick: (e: React.MouseEvent<HTMLElement>) => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * Builds button semantics for a clickable `div`/`span`.
 *
 * @param onActivate - Fired on click, Enter, and Space (receives the event so
 *   callers can stop propagation for nested affordances).
 * @param enabled - When false the node reports `aria-disabled`, leaves the tab
 *   order, and never activates. Defaults to true.
 * @returns Props to spread onto the node.
 */
export function buttonize(onActivate: (e: React.SyntheticEvent<HTMLElement>) => void, enabled = true): IButtonizeProps {
	return {
		role: 'button',
		tabIndex: enabled ? 0 : -1,
		'aria-disabled': !enabled,
		// Pointer path — same gate as the keyboard path.
		onClick: (e) => {
			if (enabled) onActivate(e);
		},
		// Keyboard path — Enter/Space activate, matching native button keys.
		onKeyDown: (e) => {
			if (!enabled) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				onActivate(e);
			}
		},
	};
}
