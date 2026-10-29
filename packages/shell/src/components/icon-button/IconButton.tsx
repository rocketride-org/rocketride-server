// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * IconButton — a square, icon-only button for toolbars, row actions and
 * panel chrome. `label` is required: it is the button's accessible name and,
 * unless `tooltip={false}`, also the hover/focus tooltip, so every icon
 * button explains itself to sighted and screen-reader users alike.
 *
 * Use `pressed` for toggle buttons (bold, italic, pin). Use Button when the
 * action deserves a text label.
 *
 * Built on `.rr-icon-btn` from components.css.
 */

import React, { forwardRef, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import { Tooltip } from '../overlay/Tooltip';
import type { OverlayPlacement } from '../overlay/placement';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link IconButton} component. */
export interface IIconButtonProps {
	/** Accessible name; also the tooltip text. */
	label: string;
	/** The icon. */
	children: ReactNode;
	/** Click handler. */
	onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	/** Compact 26px size. */
	small?: boolean;
	/** Toggle state; renders `aria-pressed`. */
	pressed?: boolean;
	/** Disclosure state for buttons that open a panel; renders `aria-expanded`. */
	ariaExpanded?: boolean;
	/** Id of the panel this button controls; renders `aria-controls`. */
	ariaControls?: string;
	/** Disable the button. */
	disabled?: boolean;
	/** Show `label` as a tooltip. Defaults to true. */
	tooltip?: boolean;
	/** Tooltip placement. Defaults to `'top'`. */
	tooltipPlacement?: OverlayPlacement;
	/** Native button type. Defaults to `'button'`. */
	type?: 'button' | 'submit' | 'reset';
	/** Extra class names. */
	className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders an icon-only button with an accessible name and tooltip.
 *
 * @param props - {@link IIconButtonProps}.
 * @returns The button, wrapped in a Tooltip unless disabled.
 */
export const IconButton: ForwardRefExoticComponent<IIconButtonProps & RefAttributes<HTMLButtonElement>> = forwardRef<HTMLButtonElement, IIconButtonProps>(function IconButton({ label, children, onClick, small = false, pressed, ariaExpanded, ariaControls, disabled, tooltip = true, tooltipPlacement = 'top', type = 'button', className }, ref) {
	let classes = 'rr-icon-btn';
	if (small) classes += ' rr-icon-btn--sm';
	if (className) classes += ` ${className}`;

	const button = (
		<button ref={ref} type={type} className={classes} aria-label={label} aria-pressed={pressed} aria-expanded={ariaExpanded} aria-controls={ariaControls} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);

	return (
		<Tooltip content={label} placement={tooltipPlacement} disabled={!tooltip || disabled}>
			{button}
		</Tooltip>
	);
});
