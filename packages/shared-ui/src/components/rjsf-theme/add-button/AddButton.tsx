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

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import {
	FormContextType,
	IconButtonProps,
	RJSFSchema,
	StrictRJSFSchema,
	TranslatableString,
} from '@rjsf/utils';

/**
 * Custom RJSF "Add" button template rendered below array fields.
 * Displays a full-width outlined button that allows users to append a new item
 * to an array field in a JSON Schema form. Used as the ButtonTemplates.AddButton
 * override in the RJSF theme.
 */
export default function AddButton<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
>({ uiSchema, registry, ...props }: IconButtonProps<T, S, F>) {
	const { translateString } = registry;
	return (
		<Box sx={{ mt: 1, pl: 6.2, pr: 5.4 }}>
			<Button {...props} sx={{ width: 1 }} color="primary" variant="outlined">
				{translateString(TranslatableString.AddItemButton)}
			</Button>
		</Box>
	);
}
