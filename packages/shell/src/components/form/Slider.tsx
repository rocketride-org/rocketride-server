// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Slider — a number picked from a bounded range: temperature, top-k,
 * chunk overlap. A native range input, so keyboard (arrows, Page Up/Down,
 * Home/End), touch and screen-reader support come from the browser. The
 * current value can be shown beside the track. Field-aware.
 *
 * Built on `.rr-slider` from components.css.
 */

import React from 'react';
import { useFieldControl } from '../field/Field';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Slider} component. */
export interface ISliderProps {
	/** Current value. */
	value: number;
	/** Fired with the new value while dragging and on key presses. */
	onChange: (value: number) => void;
	/** Lower bound. Defaults to 0. */
	min?: number;
	/** Upper bound. Defaults to 100. */
	max?: number;
	/** Step size. Defaults to 1. */
	step?: number;
	/** Show the value beside the track. Defaults to true. */
	showValue?: boolean;
	/** Formats the shown value and the screen-reader value text. */
	formatValue?: (value: number) => string;
	/** Disable the slider. */
	disabled?: boolean;
	/** Accessible name when not inside a Field. */
	ariaLabel?: string;
	/** Element id; a Field supplies one. */
	id?: string;
	/** Form field name. */
	name?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Position of a value along the track, as a percentage.
 *
 * @param value - The value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns 0 to 100.
 */
export function sliderPercent(value: number, min: number, max: number): number {
	if (max <= min) return 0;
	const ratio = (value - min) / (max - min);
	return Math.min(100, Math.max(0, ratio * 100));
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a themed range slider with an optional value readout.
 *
 * @param props - {@link ISliderProps}.
 * @returns The slider row.
 */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, showValue = true, formatValue, disabled, ariaLabel, id, name }: ISliderProps): React.ReactElement {
	const fieldProps = useFieldControl({ id, disabled, 'aria-describedby': undefined });

	let shown = String(value);
	if (formatValue) shown = formatValue(value);

	let valueText: string | undefined;
	if (formatValue) valueText = shown;

	const fill = { '--rr-slider-fill': `${sliderPercent(value, min, max)}%` } as React.CSSProperties;

	return (
		<div className="rr-slider-row">
			<input type="range" className="rr-slider" id={fieldProps.id} name={name} min={min} max={max} step={step} value={value} disabled={fieldProps.disabled} aria-label={ariaLabel} aria-describedby={fieldProps['aria-describedby']} aria-valuetext={valueText} style={fill} onChange={(event) => onChange(Number(event.target.value))} />
			{showValue && (
				<output htmlFor={fieldProps.id} className="rr-slider-row__value rr-text-mono" aria-hidden="true">
					{shown}
				</output>
			)}
		</div>
	);
}
