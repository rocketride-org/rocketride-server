/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { ReactElement, useEffect, useRef } from 'react';
import Popper from '@mui/material/Popper';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	list: {
		margin: 0,
		padding: '4px 0',
		listStyle: 'none',
		maxHeight: 200,
		overflowY: 'auto' as const,
		backgroundColor: 'var(--rr-bg-widget)',
		color: 'var(--rr-fg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
		fontSize: 'var(--rr-font-size-widget, 13px)',
		fontFamily: 'var(--rr-font-family-widget)',
		minWidth: 220,
	},
	item: {
		padding: '4px 10px',
		cursor: 'pointer',
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	itemHighlighted: {
		backgroundColor: 'var(--rr-bg-button)',
		color: 'var(--rr-fg-button)',
	},
};

// =============================================================================
// Props
// =============================================================================

interface EnvVarSuggestionsProps {
	/** Whether the popover is visible. */
	open: boolean;
	/** Element to anchor the popover to (the input field). */
	anchorEl: HTMLElement | null;
	/** Filtered list of env key names to show. */
	suggestions: string[];
	/** Currently highlighted index for keyboard nav. */
	highlightedIndex: number;
	/** Called when the user clicks a suggestion. */
	onSelect: (key: string) => void;
	/** Called when the popover should close. */
	onDismiss: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Floating suggestion list for ROCKETRIDE_* environment variable keys.
 *
 * Anchored below the input field via MUI Popper. Supports mouse selection
 * and keyboard navigation (handled by the parent via the hook).
 */
export default function EnvVarSuggestions({ open, anchorEl, suggestions, highlightedIndex, onSelect, onDismiss: _onDismiss }: EnvVarSuggestionsProps): ReactElement | null {
	const listRef = useRef<HTMLUListElement>(null);

	// Scroll the highlighted item into view
	useEffect(() => {
		if (!open || !listRef.current) return;
		const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
		item?.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex, open]);

	if (!open || !anchorEl || suggestions.length === 0) return null;

	return (
		<Popper open={open} anchorEl={anchorEl} placement="bottom-start" style={{ zIndex: 50 }} modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}>
			<ul ref={listRef} style={styles.list} onMouseDown={(e) => e.preventDefault()}>
				{suggestions.map((key, i) => (
					<li key={key} style={{ ...styles.item, ...(i === highlightedIndex ? styles.itemHighlighted : {}) }} onClick={() => onSelect(key)} onMouseEnter={() => {}} role="option" aria-selected={i === highlightedIndex}>
						{key}
					</li>
				))}
			</ul>
		</Popper>
	);
}
