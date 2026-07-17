// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ToggleGroup — the platform's stock segmented control.
 *
 * A single-select row for time ranges, view modes, and similar mutually-
 * exclusive choices, rendered as STOCK BUTTONS (user directive 2026-07-16:
 * no hand-rolled pills — the old `commonStyles.toggleButton` never set a
 * font-family, so toggles rendered in the browser's form-control font
 * instead of the app font). The selected option is a small `primary`
 * Button, the rest are small `ghost` Buttons, so a ToggleGroup sitting in
 * a card / grid header matches the buttons beside it by construction.
 */

import React from 'react';
import { commonStyles } from '../../themes/styles';
import { Button } from '../button/Button';

// =============================================================================
// TYPES
// =============================================================================

/** A single selectable option in a {@link ToggleGroup}. */
export interface IToggleGroupOption<T extends string> {
	/** Stable value returned via `onChange` and matched against `value`. */
	id: T;
	/** Visible label. */
	label: string;
}

/** Props for the {@link ToggleGroup} component. */
export interface IToggleGroupProps<T extends string> {
	/** Ordered list of options. */
	options: IToggleGroupOption<T>[];
	/** Currently selected option id. */
	value: T;
	/** Fired with the newly selected option id. */
	onChange: (id: T) => void;
	/**
	 * Accepted for call-site compatibility; inert. Every ToggleGroup renders
	 * the stock SMALL Button — segmented controls are compact by definition,
	 * and one size keeps them identical to the header buttons around them.
	 *
	 * @deprecated The stock small Button is the only toggle size.
	 */
	small?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a single-select segmented control from stock Buttons.
 *
 * @param props - {@link IToggleGroupProps}.
 * @returns The segmented control element.
 */
export function ToggleGroup<T extends string>({ options, value, onChange }: IToggleGroupProps<T>): React.ReactElement {
	return (
		<div style={commonStyles.toggleGroup}>
			{options.map((option) => {
				// The selected option renders filled (primary); the rest quiet.
				const active = option.id === value;
				return (
					<Button key={option.id} variant={active ? 'primary' : 'ghost'} small pressed={active} onClick={() => onChange(option.id)}>
						{option.label}
					</Button>
				);
			})}
		</div>
	);
}
