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

import ErrorIcon from '@mui/icons-material/Error';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { ErrorListProps, FormContextType, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';

/**
 * Custom RJSF error list template that renders form-level validation errors
 * as a MUI List with error icons. Displayed at the top of the form when
 * submission fails validation, giving users a summary of all issues.
 */
export default function ErrorList<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ errors }: ErrorListProps<T, S, F>) {
	return (
		<Box mb={2}>
			<List dense={true}>
				{errors.map((error, i: number) => {
					return (
						<ListItem key={i} sx={{ m: 0, p: 0 }}>
							<ListItemIcon>
								<ErrorIcon color="error" />
							</ListItemIcon>
							<ListItemText primary={error.stack} />
						</ListItem>
					);
				})}
			</List>
		</Box>
	);
}
