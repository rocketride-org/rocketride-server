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

import { brandOrange } from '../../../../../theme';

/**
 * MUI `sx`-compatible style definitions for the custom edge component.
 *
 * Provides styling for the delete button that appears on hover/selection of an edge,
 * including background, border, and icon sizing to keep it compact and unobtrusive.
 */
export const styles = {
	button: {
		backgroundColor: 'background.paper',
		padding: '0.2rem',
		border: '1px solid',
		borderColor: 'divider',
		'&:hover': {
			backgroundColor: 'background.paper',
			borderColor: brandOrange,
		},
		'& > svg': {
			fontSize: '1rem',
		},
	},
};
