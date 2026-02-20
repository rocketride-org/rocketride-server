// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { ReactElement, useState } from 'react';
import { Grid, TextField } from '@mui/material';

/**
 * Props for the {@link NumberRange} component.
 * Defines the controlled value, labels, and change callback for a numeric range input.
 */
interface IProps {
	/** Two-element string array representing the [from, to] numeric range values. */
	value?: string[];
	/** Label displayed on the "from" number input. */
	labelFrom?: string;
	/** Label displayed on the "to" number input. */
	labelTo?: string;
	/** Callback invoked when either number changes, providing the updated [from, to] array. */
	onChange: (value: string[]) => void;
}

/**
 * Renders a numeric range input consisting of two side-by-side number TextFields.
 * Used in query builders and filter panels where the user needs to specify
 * a minimum and maximum numeric value. Each input independently updates its
 * half of the range and emits the full [from, to] pair.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A Grid row containing "from" and "to" number TextField controls.
 */
export function NumberRange({ value, labelFrom, labelTo, onChange }: IProps): ReactElement {
	// Local state tracks each half of the range independently so either
	// input can update without losing the other value
	const [valueFrom, setValueFrom] = useState<string>('');
	const [valueTo, setValueTo] = useState<string>('');

	const onChangeFrom = (_value: string) => {
		setValueFrom(_value);
		// Always emit the full [from, to] pair so the parent stays in sync
		onChange([_value, valueTo]);
	};

	const onChangeTo = (_value: string) => {
		setValueTo(_value);
		onChange([valueFrom, _value]);
	};

	// Extract the individual range bounds from the controlled prop for display
	const _valueFrom = value?.[0];
	const _valueTo = value?.[1];

	return (
		<Grid container direction="row">
			<Grid item xs sx={{ mr: 1 }}>
				<TextField
					required
					variant="outlined"
					type="number"
					size="small"
					value={_valueFrom}
					onChange={(e) => onChangeFrom(e.target.value)}
					label={labelFrom}
				/>
			</Grid>
			<Grid item xs>
				<TextField
					required
					variant="outlined"
					type="number"
					size="small"
					value={_valueTo}
					onChange={(e) => onChangeTo(e.target.value)}
					label={labelTo}
				/>
			</Grid>
		</Grid>
	);
}
