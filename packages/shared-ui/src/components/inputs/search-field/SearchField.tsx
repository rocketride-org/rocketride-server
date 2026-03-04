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

import { ReactNode, ChangeEvent } from 'react';
import { TextField, InputAdornment, SxProps } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

/**
 * Props for the {@link SearchField} component.
 * Provides configuration for the search input's value, styling, and change handling.
 */
export interface IProps {
	/** The current search query string (controlled input value). */
	value: string;
	/** Callback invoked on every keystroke in the search input. */
	onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
	/** MUI sx prop applied to the outer TextField wrapper. */
	sx?: SxProps;
	/** Whether the input should expand to fill its container's width. */
	fullWidth?: boolean;
	/** MUI sx prop applied to the inner Input element for fine-grained styling. */
	inputSx?: SxProps;
	/** Placeholder text displayed when the input is empty. */
	placeholder?: string;
}

/**
 * Renders a search input field with a leading magnifying-glass icon.
 * Used across the application for filtering lists, searching nodes on the canvas,
 * and other text-based search interactions. The input has autocomplete disabled
 * to prevent browser suggestion interference.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns An MUI TextField configured as a small outlined search input with an icon adornment.
 */
export default function SearchField({
	value,
	placeholder,
	sx,
	fullWidth,
	inputSx,
	onChange,
}: IProps): ReactNode {
	// Render a single controlled TextField with a search icon adornment.
	// autoComplete is disabled to avoid browser suggestion overlays
	// interfering with the application's own search results.
	return (
		<TextField
			variant="outlined"
			placeholder={placeholder}
			size="small"
			fullWidth={fullWidth}
			value={value}
			onChange={onChange}
			sx={sx}
			autoComplete="off"
			slotProps={{
				input: {
					sx: inputSx,
					startAdornment: (
						<InputAdornment position="start">
							<SearchIcon />
						</InputAdornment>
					),
				},
			}}
		/>
	);
}
