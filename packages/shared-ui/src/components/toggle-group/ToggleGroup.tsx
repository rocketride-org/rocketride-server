// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ToggleGroup — the platform's stock segmented control.
 *
 * A single-select row of pill buttons for time ranges, view modes, and similar
 * mutually-exclusive choices. Wraps `commonStyles.toggleGroup` /
 * `commonStyles.toggleButton(active)`; the optional `small` variant shrinks each
 * pill for card-header time-range pickers.
 */

import React, { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';

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
	/** Render the compact size (card-header time-range pickers). */
	small?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Compact size modifier layered over commonStyles.toggleButton.
	smallButton: {
		height: 22,
		fontSize: 11,
		padding: '0 9px',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a single-select segmented control.
 *
 * @param props - {@link IToggleGroupProps}.
 * @returns The segmented control element.
 */
export function ToggleGroup<T extends string>({ options, value, onChange, small }: IToggleGroupProps<T>): React.ReactElement {
	return (
		<div style={commonStyles.toggleGroup}>
			{options.map((option) => {
				// Highlight the pill matching the current value.
				const active = option.id === value;
				return (
					<button
						key={option.id}
						type="button"
						style={{ ...commonStyles.toggleButton(active), ...(small ? styles.smallButton : null) }}
						onClick={() => onChange(option.id)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
