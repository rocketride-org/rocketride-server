// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Floating suggestion list for `ROCKETRIDE_*` environment keys, anchored
 * under the input through the shell's AnchoredPopup (outside-click and Escape
 * dismissal come with it).
 */

import { CSSProperties, ReactElement, RefObject, useEffect, useRef } from 'react';
import { AnchoredPopup, commonStyles } from 'shell';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	// The popup box rides the shell's popup-menu chrome; AnchoredPopup owns the
	// fixed positioning, so the menu's own `position` is left to it.
	popup: {
		...commonStyles.popupMenu,
		position: undefined,
	} as CSSProperties,

	list: {
		listStyle: 'none',
		margin: 0,
		padding: 0,
		maxHeight: 220,
		overflowY: 'auto',
		minWidth: 220,
	} as CSSProperties,

	item: {
		padding: '4px 10px',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		fontSize: 12,
		borderRadius: 4,
	} as CSSProperties,

	itemHighlighted: {
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link EnvVarSuggestions}. */
export interface IEnvVarSuggestionsProps {
	/** Whether the list is visible. */
	open: boolean;
	/** The input the list anchors to. */
	anchorRef: RefObject<HTMLElement | null>;
	/** Filtered key names. */
	suggestions: string[];
	/** Highlighted index for keyboard navigation. */
	highlightedIndex: number;
	/** Fired when a suggestion is clicked. */
	onSelect: (key: string) => void;
	/** Fired when the list should close. */
	onDismiss: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the env-key suggestion list.
 *
 * @param props - {@link IEnvVarSuggestionsProps}.
 * @returns The popup, or null while closed / empty.
 */
export default function EnvVarSuggestions({ open, anchorRef, suggestions, highlightedIndex, onSelect, onDismiss }: IEnvVarSuggestionsProps): ReactElement | null {
	const listRef = useRef<HTMLUListElement>(null);

	// Keep the highlighted row in view while the user arrows through the list.
	useEffect(() => {
		if (!open || !listRef.current) return;
		const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
		item?.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex, open]);

	if (!open || suggestions.length === 0) return null;

	return (
		<AnchoredPopup anchorRef={anchorRef} open={open} onClose={onDismiss} matchAnchorWidth style={styles.popup}>
			<ul ref={listRef} style={styles.list} role="listbox" onMouseDown={(event) => event.preventDefault()}>
				{suggestions.map((key, index) => (
					<li key={key} role="option" aria-selected={index === highlightedIndex} style={{ ...styles.item, ...(index === highlightedIndex ? styles.itemHighlighted : {}) }} onClick={() => onSelect(key)}>
						{key}
					</li>
				))}
			</ul>
		</AnchoredPopup>
	);
}
