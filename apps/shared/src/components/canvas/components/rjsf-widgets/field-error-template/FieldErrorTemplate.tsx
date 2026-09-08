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

import ListItem from '@mui/material/ListItem';
import FormHelperText from '@mui/material/FormHelperText';
import List from '@mui/material/List';
import { errorId, FieldErrorProps, FormContextType, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';

// =============================================================================
// Component
// =============================================================================

/**
 * Custom RJSF field-level error template that renders validation errors
 * as a compact MUI List of FormHelperText items beneath individual fields.
 * Returns null when there are no errors, keeping the layout clean.
 */
export default function FieldErrorTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ errors = [], idSchema }: FieldErrorProps<T, S, F>) {
	if (errors.length === 0) {
		return null;
	}
	const id = errorId<T>(idSchema);

	return (
		<List id={id} dense={true} disablePadding={true}>
			{errors.map((error, i: number) => {
				return (
					<ListItem key={i} disableGutters={true}>
						<FormHelperText component="div" id={`${id}-${i}`}>
							{error}
						</FormHelperText>
					</ListItem>
				);
			})}
		</List>
	);
}
