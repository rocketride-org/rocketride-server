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

import pxToRem from '../../utils/pxToRem';

/**
 * Style definitions for the CollectionItem component.
 * Provides layout, positioning, and hover-reveal behaviour for collection
 * cards used in grid views (e.g., toolchain or project listings). The action
 * buttons are hidden by default and revealed on hover for a cleaner visual.
 */
const styles = {
	root: {
		padding: '0.5rem',
		position: 'relative',
		'&:hover button': {
			opacity: 1,
		},
	},
	content: {
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
		height: '10rem',
		boxSizing: 'content-box',
	},
	actionsWrapper: {
		position: 'absolute',
		top: '0.25rem',
		right: '0.25rem',
		zIndex: 1,
		margin: '0 0 1rem',
	},
	iconButton: {
		cursor: 'pointer',
		opacity: 0,
		transition: 'opacity 0.2s ease-in-out, visibility 0.2s ease-in-out',
		padding: `${pxToRem(10)}rem`,
	},
	deleteButton: {
		'&:hover > svg': {
			color: 'red',
		},
	},
	runningButton: {
		position: 'absolute',
		zIndex: 1,
		'&:hover > svg': {
			color: 'red',
		},
	},
	image: {
		position: 'absolute',
		right: '-1.071rem',
		width: '5.357rem',
		height: '5.357rem',
		transform: 'translateY(-50%)',
		top: '50%',
	},
};

export default styles;
