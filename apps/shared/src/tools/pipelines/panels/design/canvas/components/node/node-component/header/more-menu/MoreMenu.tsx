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

import React, { CSSProperties, KeyboardEvent, ReactElement, useEffect, useRef, useState } from 'react';
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

	// Popup chrome: the shell menu box (fixed, like the AnchoredPopup that
	// places it).
	popup: {
		...commonStyles.popupMenu,
		padding: 6,
		minWidth: 180,
	} as CSSProperties,

	// A focusable menu item wrapper: the ring is the only focus affordance.
	item: {
		borderRadius: 4,
		outlineOffset: -2,
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
	const menuRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);

	/** Opens the menu, stopping propagation to prevent node selection/drag. */
	const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
		event.stopPropagation();
		setOpen((prev) => !prev);
	};

	/** The enabled, focusable items in order. */
	const enabledItems = (): HTMLElement[] => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

	// Keyboard users: focus lands on the first enabled item when the menu
	// opens (after AnchoredPopup has placed it) and returns to the trigger on
	// close, so the actions are reachable without a pointer.
	const movedFocus = useRef(false);
	useEffect(() => {
		if (open) {
			const frame = requestAnimationFrame(() => {
				const first = enabledItems()[0];
				if (first) {
					first.focus();
					movedFocus.current = true;
				}
			});
			return () => cancelAnimationFrame(frame);
		}
		if (movedFocus.current) {
			movedFocus.current = false;
			anchorRef.current?.focus();
		}
		return undefined;
	}, [open]);

	/** Arrow / Home / End move between enabled items; Enter / Space activate; Tab closes. */
	const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const items = enabledItems();
		if (items.length === 0) return;
		const current = items.indexOf(document.activeElement as HTMLElement);
		const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusAt(current + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusAt(current - 1);
				break;
			case 'Home':
				event.preventDefault();
				focusAt(0);
				break;
			case 'End':
				event.preventDefault();
				focusAt(items.length - 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				(document.activeElement as HTMLElement | null)?.click();
				break;
			case 'Tab':
				setOpen(false);
				break;
			default:
				break;
		}
	};

	return (
		<>
			<button ref={anchorRef} aria-label="More options" aria-haspopup="menu" aria-expanded={open} onMouseDown={(event) => event.stopPropagation()} onClick={handleMenuClick} disabled={isDisabled} style={{ ...styles.trigger, ...buttonStyle }}>
				<MoreVertical size={18} style={{ color: 'var(--rr-text-secondary)' }} />
			</button>

			<AnchoredPopup anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="end" style={styles.popup}>
				<div ref={menuRef} role="menu" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleMenuKeyDown}>
					{options.map(({ handleClick, label, keys, disabled }, index) => {
						// "border" entries render as horizontal dividers
						if (label === 'border') {
							return <div key={index} style={styles.divider} role="separator" />;
						}

						// The wrapper is the focusable menu item; its click (pointer or
						// Enter / Space) reaches the PopupRow's handler.
						return (
							<div key={index} role="menuitem" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} style={{ ...styles.item, ...(disabled ? styles.disabled : {}) }}>
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
