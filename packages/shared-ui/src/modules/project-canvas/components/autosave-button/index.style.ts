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

import { keyframes } from '@mui/material';

/** Keyframes for a continuous 360-degree spin animation, used on the sync icon during save operations. */
export const spin = keyframes`
	from {
		transform: rotate(0deg);
	}
	to {
		transform: rotate(360deg);
	}
`;

/** Shared MUI sx styles for both the main save button and the dropdown trigger button. Provides a transparent, borderless look with hover feedback. */
export const commonButtonStyles = {
	textTransform: 'none' as const,
	fontWeight: 500,
	bgcolor: 'transparent',
	color: 'text.secondary',
	border: 'none',
	'&:hover': {
		bgcolor: 'action.hover',
	},
	'&.Mui-disabled': {
		bgcolor: 'transparent',
		color: 'text.secondary',
	},
};

/** MUI sx styles for the ButtonGroup wrapper. Removes shadows and internal borders between grouped buttons. */
export const buttonGroupStyles = {
	boxShadow: 'none',
	'& .MuiButtonGroup-grouped': {
		border: 'none',
		'&:not(:last-of-type)': {
			borderRight: 'none',
		},
	},
};

/** MUI sx styles for the main (left) save button, reducing right padding for tighter layout. */
export const mainButtonStyles = {
	pr: '0.25rem',
};

/** MUI sx styles for the dropdown (right) chevron button, minimizing width for a compact trigger. */
export const dropdownButtonStyles = {
	px: '0.125rem',
	minWidth: 'unset !important',
};

/**
 * Default export bundling all autosave button styles for convenient import.
 */
export default {
	spin,
	commonButtonStyles,
	buttonGroupStyles,
	mainButtonStyles,
	dropdownButtonStyles,
};
