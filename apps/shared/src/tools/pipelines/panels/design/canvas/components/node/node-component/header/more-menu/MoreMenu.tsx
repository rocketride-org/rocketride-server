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
 * Generic "more options" overflow menu (vertical dots icon button).
 *
 * Used in node headers and other canvas elements to surface contextual
 * actions such as open, duplicate, delete, and documentation links.
 * Each menu item can display a label, optional keyboard shortcut chips,
 * and a disabled state. Special "border" label entries render as dividers.
 * The popup is the shell's AnchoredPopup (outside-click / Escape dismissal,
 * flip when out of room) over PopupRow items.
 */

import React, { CSSProperties, ReactElement, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { AnchoredPopup, PopupRow, commonStyles } from 'shell';

import { Option } from 'shared/types/ui';
import KeyboardChip from '../KeyboardChip';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	trigger: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: 0,
		display: 'inline-flex',
		alignItems: 'center',
	} as CSSProperties,

	// Popup chrome: the shell menu box; AnchoredPopup owns the positioning.
	popup: {
		...commonStyles.popupMenu,
		position: undefined,
		padding: 6,
		minWidth: 180,
	} as CSSProperties,

	divider: {
		...commonStyles.divider,
		margin: '4px 0',
	} as CSSProperties,

	row: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: 16,
		width: '100%',
	} as CSSProperties,

	label: {
		fontWeight: 800,
		fontSize: '0.75rem',
	} as CSSProperties,

	keys: {
		fontSize: '0.725rem',
	} as CSSProperties,

	disabled: {
		opacity: 0.45,
		pointerEvents: 'none',
	} as CSSProperties,
};

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the MoreMenu component.
 */
interface IMoreMenuProps {
	/** Menu option definitions including labels, click handlers, keyboard shortcuts, and disabled state. */
	options: Option[];
	/** When true the trigger icon button is disabled. */
	isDisabled?: boolean;
	/** Optional style overrides applied to the trigger button. */
	buttonStyle?: CSSProperties;
}

// =============================================================================
// Component
// =============================================================================

export default function MoreMenu({ options, isDisabled, buttonStyle }: IMoreMenuProps): ReactElement {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);

	/** Opens the menu, stopping propagation to prevent node selection/drag. */
	const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
		event.stopPropagation();
		setOpen((prev) => !prev);
	};

	return (
		<>
			<button ref={anchorRef} aria-label="More options" aria-haspopup="menu" aria-expanded={open} onMouseDown={(event) => event.stopPropagation()} onClick={handleMenuClick} disabled={isDisabled} style={{ ...styles.trigger, ...buttonStyle }}>
				<MoreVertical size={18} style={{ color: 'var(--rr-text-secondary)' }} />
			</button>

			<AnchoredPopup anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="end" style={styles.popup}>
				<div role="menu" onMouseDown={(event) => event.stopPropagation()}>
					{options.map(({ handleClick, label, keys, disabled }, index) => {
						// "border" entries render as horizontal dividers
						if (label === 'border') {
							return <div key={index} style={styles.divider} role="separator" />;
						}

						return (
							<div key={index} role="menuitem" aria-disabled={disabled || undefined} style={disabled ? styles.disabled : undefined}>
								<PopupRow
									onClick={(event) => {
										event.stopPropagation();
										if (!handleClick || disabled) return;
										handleClick(event);
										setOpen(false);
									}}
								>
									<span style={styles.row}>
										<span style={styles.label}>{label}</span>
										<span style={styles.keys}>{keys?.length ? keys.map((value: string, i: number) => <KeyboardChip key={i} text={value} />) : null}</span>
									</span>
								</PopupRow>
							</div>
						);
					})}
				</div>
			</AnchoredPopup>
		</>
	);
}
