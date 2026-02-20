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

import { brandOrange } from '../../../../theme';

/**
 * Style definitions for the FloatingGroupButton component.
 *
 * Contains layout and visual styling for the absolutely-positioned container,
 * the elevated paper-like button surface, and hover interaction states.
 */
const styles = {
	root: {
		position: 'absolute',
		margin: 'auto',
		zIndex: 5,
		display: 'flex',
		background: 'transparent',
		justifyContent: 'center',
		gap: '1rem',
		top: '2rem',
		left: '26rem',
	},
	paper: {
		height: '3rem',
		alignItems: 'center',
		justifyContent: 'center',
		display: 'flex',
		paddingLeft: '0.75rem',
		paddingRight: '0.75rem',
		color: brandOrange,
		borderColor: 'transparent',
		backgroundColor: 'background.paper',
		boxShadow:
			'0px 2px 4px -1px rgba(0, 0, 0, 0.2), 0px 4px 5px 0px rgba(0, 0, 0, 0.14), 0px 1px 10px 0px rgba(0, 0, 0, 0.12)',
		transition: 'box-shadow 300ms cubic-bezier(0.4, 0, 0.2, 1) 0ms',
	},
	button: {
		'&:hover': {
			backgroundColor: 'action.hover',
		},
	},
};

export default styles;
