// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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
import moment from 'moment';
import { Grid } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';

/**
 * Props for the {@link DateRangePicker} component.
 * Defines the controlled value, labels, and change callback for a date range input.
 */
interface IProps {
	/** Two-element array of ISO date strings representing the [from, to] range. */
	value?: string[];
	/** Label displayed on the "from" date picker. */
	labelFrom?: string;
	/** Label displayed on the "to" date picker. */
	labelTo?: string;
	/** Callback invoked when either date changes, providing the updated [from, to] array. */
	onChange: (value: string[]) => void;
}

/**
 * Renders a date range input consisting of two side-by-side MUI DatePickers.
 * Used in query builders and filter panels where the user needs to specify
 * a start and end date. Values are managed as ISO date strings and converted
 * to/from Moment objects for the underlying DatePicker components.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A Grid row containing "from" and "to" DatePicker controls.
 */
export function DateRangePicker({ value, labelFrom, labelTo, onChange }: IProps): ReactElement {
	// Local state tracks each half of the range independently so either
	// picker can update without losing the other value
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

	// Convert the controlled ISO string values into Moment objects for the DatePicker,
	// falling back to null when the slot is empty
	const _valueFrom = value?.[0] ? moment(value?.[0]) : null;
	const _valueTo = value?.[1] ? moment(value?.[1]) : null;

	// Cast to `any` to satisfy MUI DatePicker's generic value type without
	// importing its internal Moment adapter types
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fromValue = _valueFrom as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const toValue = _valueTo as any;
	// Convert the Moment value back to an ISO string before propagating upstream
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handleFromChange = (value: any) => onChangeFrom((value as moment.Moment | null)?.toISOString() ?? '');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handleToChange = (value: any) => onChangeTo((value as moment.Moment | null)?.toISOString() ?? '');

	return (
		<Grid container direction="row">
			<Grid item xs sx={{ mr: 1 }}>
				<DatePicker
					value={fromValue}
					onChange={handleFromChange}
					label={labelFrom}
					slotProps={{
						textField: { fullWidth: true, size: 'small' },
					}}
				/>
			</Grid>
			<Grid item xs>
				<DatePicker
					value={toValue}
					onChange={handleToChange}
					label={labelTo}
					slotProps={{
						textField: { fullWidth: true, size: 'small' },
					}}
				/>
			</Grid>
		</Grid>
	);
}
