// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ToggleGroup — the platform's stock segmented control.
 *
 * A row of choices rendered as STOCK BUTTONS (user directive 2026-07-16: no
 * hand-rolled pills — the old `commonStyles.toggleButton` never set a
 * font-family, so toggles rendered in the browser's form-control font instead
 * of the app font). An active option is a small `primary` Button, the rest are
 * small `ghost` Buttons, so a ToggleGroup sitting in a card / grid header
 * matches the buttons beside it by construction.
 *
 * Two modes share one entry shape ({@link IToggleGroupOption}):
 * - SINGLE-select (default) — one active option, mutually exclusive: time
 *   ranges, view modes. Driven by `value` + `onChange`.
 * - MULTI-select (`multi`) — any subset active, each click toggles one option
 *   independently: filter/subscription sets. Driven by `values` + `onToggle`
 *   (added 2026-07-18 for events-ui's event-type subscription chips).
 * The mode is a discriminated union on `multi`, so a caller cannot mix the two
 * prop sets. `disabled` locks the whole group; `wrap` flows a long option list
 * onto multiple rows.
 */

import React, { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { Button } from '../button/Button';

// =============================================================================
// TYPES
// =============================================================================

/** A single selectable option in a {@link ToggleGroup}. */
export interface IToggleGroupOption<T extends string> {
	/** Stable value returned via the change callback and matched for the active state. */
	id: T;
	/** Visible label. */
	label: string;
}

/** Props common to both ToggleGroup modes. */
interface IToggleGroupBaseProps<T extends string> {
	/** Ordered list of options. */
	options: IToggleGroupOption<T>[];
	/**
	 * Flow options onto multiple rows when they exceed the available width
	 * (default: a single non-wrapping row). Set for long option lists such as
	 * an event-type subscription set.
	 */
	wrap?: boolean;
	/** Disable the entire group — every option renders dimmed and inert. */
	disabled?: boolean;
	/**
	 * Accepted for call-site compatibility; inert. Every ToggleGroup renders
	 * the stock SMALL Button — segmented controls are compact by definition,
	 * and one size keeps them identical to the header buttons around them.
	 *
	 * @deprecated The stock small Button is the only toggle size.
	 */
	small?: boolean;
}

/** Single-select mode (default): exactly one active option. */
export interface IToggleGroupSingleProps<T extends string> extends IToggleGroupBaseProps<T> {
	/** Single-select is the default; omit or set false. */
	multi?: false;
	/** Currently selected option id. */
	value: T;
	/** Fired with the newly selected option id. */
	onChange: (id: T) => void;
}

/** Multi-select mode: any subset of options may be active at once. */
export interface IToggleGroupMultiProps<T extends string> extends IToggleGroupBaseProps<T> {
	/** Opt into multi-select. */
	multi: true;
	/** Currently active option ids. */
	values: T[];
	/** Fired with the option id whose active state the click flips. */
	onToggle: (id: T) => void;
}

/**
 * Props for the {@link ToggleGroup} component — a discriminated union on
 * `multi` so single- and multi-select callers cannot cross their prop sets.
 */
export type IToggleGroupProps<T extends string> = IToggleGroupSingleProps<T> | IToggleGroupMultiProps<T>;

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a single- or multi-select segmented control from stock Buttons.
 *
 * @param props - {@link IToggleGroupProps}.
 * @returns The segmented control element.
 */
export function ToggleGroup<T extends string>(props: IToggleGroupProps<T>): React.ReactElement {
	const { options, wrap, disabled } = props;
	// Container: the stock toggle row, opting into wrapping when asked.
	const containerStyle: CSSProperties = wrap ? { ...commonStyles.toggleGroup, flexWrap: 'wrap' } : commonStyles.toggleGroup;
	return (
		<div style={containerStyle} role="group">
			{options.map((option) => {
				// Active state: set membership in multi mode, identity in single mode.
				const active = props.multi ? props.values.includes(option.id) : props.value === option.id;
				// Click: flip one option (multi) or switch the selection (single).
				const handleClick = props.multi ? () => props.onToggle(option.id) : () => props.onChange(option.id);
				return (
					<Button key={option.id} variant={active ? 'primary' : 'ghost'} small pressed={active} disabled={disabled} onClick={handleClick}>
						{option.label}
					</Button>
				);
			})}
		</div>
	);
}
