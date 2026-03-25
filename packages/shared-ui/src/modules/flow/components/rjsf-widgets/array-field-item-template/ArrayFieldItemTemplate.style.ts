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

/**
 * MUI `sx` style definitions for the ArrayFieldItemTemplate component.
 * Contains layout styles for the sortable array item container (root)
 * and the drag handle grip icon used for reordering items.
 */
export const styles = {
	root: {
		display: 'flex',
		flexGrow: 1,
		alignItems: 'start',
		my: '2px',
		listStyle: 'none',
		color: 'var(--rr-text-primary)',
		fontWeight: 400,
		fontSize: 'var(--rr-font-size, 13px)',
		fontFamily: 'var(--rr-font-family, sans-serif)',
		borderRadius: '3px',
	},
	dragHandle: {
		display: 'flex',
		width: '12px',
		padding: '6px 4px',
		mt: '2px',
		alignItems: 'center',
		justifyContent: 'center',
		flex: '0 0 auto',
		touchAction: 'none',
		cursor: 'var(--cursor, pointer)',
		borderRadius: '3px',
		border: 'none',
		outline: 'none',
		appearance: 'none',
		backgroundColor: 'transparent',
		WebkitTapHighlightColor: 'transparent',
		'&:hover': {
			backgroundColor: 'var(--rr-bg-widget-hover, rgba(0, 0, 0, 0.05))',
		},
		'&:focus-visible': {
			boxShadow: '0 0 0 2px var(--rr-border-focus)',
		},
		'& svg': {
			flex: '0 0 auto',
			margin: 'auto',
			height: '100%',
			overflow: 'visible',
			fill: 'var(--rr-text-disabled, #919eab)',
		},
	},
};
