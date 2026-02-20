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

import { ReactElement } from 'react';
import { Typography, Chip } from '@mui/material';
import pxToRem from '../../../utils/pxToRem';

/**
 * Props for the KeyboardChip component.
 * Describes the key label text and optional visual shape.
 */
interface IProps {
	/** The keyboard key label to display (e.g., "Ctrl", "S", "+", ","). */
	text: string;
	/** Visual shape of the chip. 'round' uses default border-radius; 'square' removes it. */
	shape?: 'round' | 'square';
}

/**
 * Renders a single keyboard key as a styled chip, used within keyboard shortcut displays.
 * Special characters '+' and ',' are rendered as plain text separators rather than chips,
 * since they serve as visual delimiters between key combinations.
 *
 * @param props - The key label text and optional shape variant.
 * @returns A Chip element for regular keys, or a Typography element for separator characters.
 */
export default function KeyboardChip({ text, shape = 'round' }: IProps): ReactElement {
	if (text === '+') {
		return (
			<Typography variant="caption" sx={{ mr: 0.25 }}>
				+
			</Typography>
		);
	}
	if (text === ',') {
		return (
			<Typography variant="caption" sx={{ mr: 0.25 }}>
				,
			</Typography>
		);
	}
	return (
		<Chip
			label={text}
			sx={{
				height: `${pxToRem(20)}rem`,
				fontSize: '0.7rem',
				backgroundColor: 'grey.300',
				color: 'common.black',
				mr: 0.25,
				...(shape === 'square' && { borderRadius: 0 }),
			}}
			size="small"
		/>
	);
}
