// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Menu — an anchored list of actions (row "more" menus, toolbar overflow,
 * context menus). MenuButton wires a trigger button to one.
 *
 * Follows the WAI-ARIA menu pattern: focus moves onto the items (roving),
 * Arrow Up/Down move and wrap, Home/End jump, typing jumps to the next item
 * starting with that text, Enter/Space activate, Escape closes and returns
 * focus to the trigger, Tab closes. Disabled items are skipped. Selecting an
 * item calls `onSelect(id)` and then `onClose()`.
 *
 * Built on `.rr-popover.rr-menu` and `.rr-menu__*` from components.css.
 */

import React, { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Popover } from './Popover';
import { findTypeaheadIndex, getFirstIndex, getLastIndex, getNextIndex } from './listNavigation';
import { isTypeaheadKey, useTypeahead } from './overlayHooks';
import type { OverlayPlacement } from './placement';
import type { ButtonVariant } from '../button/Button';

// =============================================================================
// TYPES
// =============================================================================

/** A selectable menu row. */
export interface IMenuAction {
	/** Discriminator; may be omitted for actions. */
	type?: 'action';
	/** Stable id passed to `onSelect`. */
	id: string;
	/** Row text. Also used for typeahead. */
	label: string;
	/** Optional leading icon. */
	icon?: ReactNode;
	/** Optional right-aligned shortcut hint, e.g. `'⌘D'`. */
	shortcut?: string;
	/** Render dimmed and skip during navigation. */
	disabled?: boolean;
	/** Destructive styling (red text). */
	danger?: boolean;
	/** Render as a checkable row (`menuitemcheckbox`) with this state. */
	checked?: boolean;
}

/** A non-interactive separator line. */
export interface IMenuDivider {
	type: 'divider';
	/** Optional key; defaults to the row index. */
	id?: string;
}

/** A non-interactive group heading. */
export interface IMenuLabel {
	type: 'label';
	label: string;
	/** Optional key; defaults to the row index. */
	id?: string;
}

/** One row of a {@link Menu}. */
export type MenuEntry = IMenuAction | IMenuDivider | IMenuLabel;

/** Props for the {@link Menu} component. */
export interface IMenuProps {
	/** Whether the menu is open. */
	open: boolean;
	/** The element the menu is attached to. */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** Called when the menu asks to close. */
	onClose: () => void;
	/** Rows, in order. */
	items: MenuEntry[];
	/** Called with the chosen action's id, before `onClose`. */
	onSelect: (id: string) => void;
	/** Placement relative to the anchor. Defaults to `'bottom-start'`. */
	placement?: OverlayPlacement;
	/** Which item gets focus on open. Defaults to `'first'`. */
	initialFocus?: 'first' | 'last';
	/** Accessible name for the menu. */
	ariaLabel?: string;
	/** Element id, for `aria-controls` on the trigger. */
	id?: string;
}

/** Props for the {@link MenuButton} component. */
export interface IMenuButtonProps {
	/** Button text. Omit for an icon-only trigger (then set `ariaLabel`). */
	label?: ReactNode;
	/** Leading icon (or the only content when `label` is omitted). */
	icon?: ReactNode;
	/** Rows of the menu. */
	items: MenuEntry[];
	/** Called with the chosen action's id. */
	onSelect: (id: string) => void;
	/** Button variant when a label is shown. Defaults to `'ghost'`. */
	variant?: ButtonVariant;
	/** Compact (26px) trigger. */
	small?: boolean;
	/** Disable the trigger. */
	disabled?: boolean;
	/** Accessible name; required for icon-only triggers. */
	ariaLabel?: string;
	/** Native tooltip on the trigger. */
	title?: string;
	/** Menu placement. Defaults to `'bottom-start'`. */
	placement?: OverlayPlacement;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Whether a row is a selectable action. */
function isAction(entry: MenuEntry): entry is IMenuAction {
	return entry.type === undefined || entry.type === 'action';
}

/** Navigation view of the rows: non-actions count as disabled. */
function toNavigable(items: MenuEntry[]): { disabled: boolean }[] {
	return items.map((entry) => {
		if (!isAction(entry)) return { disabled: true };
		return { disabled: Boolean(entry.disabled) };
	});
}

/** Typeahead labels: non-actions contribute an empty label. */
function toLabels(items: MenuEntry[]): string[] {
	return items.map((entry) => {
		if (isAction(entry)) return entry.label;
		return '';
	});
}

// =============================================================================
// MENU
// =============================================================================

/**
 * Renders an anchored action menu.
 *
 * @param props - {@link IMenuProps}.
 * @returns The portaled menu while open, otherwise nothing.
 */
export function Menu({ open, anchorRef, onClose, items, onSelect, placement = 'bottom-start', initialFocus = 'first', ariaLabel, id }: IMenuProps): React.ReactElement | null {
	const [activeIndex, setActiveIndex] = useState(-1);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const typeahead = useTypeahead();
	const navigable = toNavigable(items);

	// On open, activate the first (or last) enabled action.
	useEffect(() => {
		if (!open) {
			setActiveIndex(-1);
			return;
		}
		if (initialFocus === 'last') {
			setActiveIndex(getLastIndex(toNavigable(items)));
			return;
		}
		setActiveIndex(getFirstIndex(toNavigable(items)));
		// Items are read once per open; a menu rebuilt while open keeps its row.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, initialFocus]);

	// Real focus follows the active row (roving focus).
	useEffect(() => {
		if (!open || activeIndex < 0) return;
		itemRefs.current[activeIndex]?.focus({ preventScroll: false });
	}, [open, activeIndex]);

	/** Activates an action: report it, then close. */
	function choose(entry: IMenuAction): void {
		if (entry.disabled) return;
		onSelect(entry.id);
		onClose();
	}

	/** Arrow / Home / End / Tab / typeahead handling on the menu. */
	function handleKeyDown(event: React.KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveIndex(getNextIndex(navigable, activeIndex, 1));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveIndex(getNextIndex(navigable, activeIndex, -1));
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			setActiveIndex(getFirstIndex(navigable));
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			setActiveIndex(getLastIndex(navigable));
			return;
		}
		if (event.key === 'Tab') {
			onClose();
			return;
		}
		if (isTypeaheadKey(event)) {
			const match = findTypeaheadIndex(toLabels(items), navigable, typeahead(event.key), activeIndex);
			if (match >= 0) setActiveIndex(match);
		}
	}

	return (
		<Popover open={open} anchorRef={anchorRef} onClose={onClose} placement={placement} role="menu" ariaLabel={ariaLabel} id={id} autoFocus={false} className="rr-menu">
			<div onKeyDown={handleKeyDown} style={{ display: 'contents' }}>
				{items.map((entry, index) => {
					if (entry.type === 'divider') {
						return <div key={entry.id ?? `divider-${index}`} role="separator" className="rr-menu__divider" />;
					}
					if (entry.type === 'label') {
						return (
							<div key={entry.id ?? `label-${index}`} role="presentation" className="rr-menu__label rr-text-label">
								{entry.label}
							</div>
						);
					}

					let rowClassName = 'rr-menu__item';
					if (entry.danger) rowClassName = 'rr-menu__item rr-menu__item--danger';
					let role = 'menuitem';
					if (entry.checked !== undefined) role = 'menuitemcheckbox';

					return (
						<button
							key={entry.id}
							ref={(element) => {
								itemRefs.current[index] = element;
							}}
							type="button"
							role={role}
							aria-checked={entry.checked}
							aria-disabled={entry.disabled || undefined}
							tabIndex={index === activeIndex ? 0 : -1}
							data-active={index === activeIndex || undefined}
							className={rowClassName}
							onMouseMove={() => {
								if (!entry.disabled && index !== activeIndex) setActiveIndex(index);
							}}
							onClick={() => choose(entry)}
						>
							{entry.icon}
							<span className="rr-truncate">{entry.label}</span>
							{entry.shortcut && <span className="rr-menu__shortcut">{entry.shortcut}</span>}
						</button>
					);
				})}
			</div>
		</Popover>
	);
}

// =============================================================================
// MENU BUTTON
// =============================================================================

/**
 * Renders a trigger button that opens a {@link Menu}. Enter, Space and
 * Arrow Down open it on the first item; Arrow Up opens it on the last.
 *
 * @param props - {@link IMenuButtonProps}.
 * @returns The trigger and its menu.
 */
export function MenuButton({ label, icon, items, onSelect, variant = 'ghost', small, disabled, ariaLabel, title, placement }: IMenuButtonProps): React.ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first');
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuId = useId();

	/** Opens on the given end of the list. */
	function openAt(end: 'first' | 'last'): void {
		setInitialFocus(end);
		setIsOpen(true);
	}

	/** Arrow keys open the menu from the trigger. */
	function handleKeyDown(event: React.KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			openAt('first');
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			openAt('last');
		}
	}

	const isIconOnly = label === undefined || label === null;
	let triggerClassName = `rr-btn rr-btn--${variant}`;
	if (small) triggerClassName += ' rr-btn--sm';
	if (isIconOnly) {
		triggerClassName = 'rr-icon-btn';
		if (small) triggerClassName += ' rr-icon-btn--sm';
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={triggerClassName}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				aria-controls={isOpen ? menuId : undefined}
				aria-label={ariaLabel}
				title={title}
				disabled={disabled}
				onClick={() => {
					if (isOpen) {
						setIsOpen(false);
						return;
					}
					openAt('first');
				}}
				onKeyDown={handleKeyDown}
			>
				{icon}
				{label}
			</button>
			<Menu id={menuId} open={isOpen} anchorRef={triggerRef} onClose={() => setIsOpen(false)} items={items} onSelect={onSelect} placement={placement} initialFocus={initialFocus} ariaLabel={ariaLabel} />
		</>
	);
}
