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

import { isInVSCode } from '../../../../../utils/vscode';

/** Whether the application is running inside VS Code; used to apply theme-aware styling. */
const inVSCode = isInVSCode();

/**
 * MUI `sx`-compatible style definitions for the generic pipeline Node component.
 * Includes styles for the node card container, header, icon, labels, and tiles.
 * Adapts colors, borders, and backgrounds for VS Code theming when the canvas
 * is embedded in the VS Code extension.
 */
export const styles = {
	flowRoot: {
		width: '11rem',
		backgroundColor: inVSCode ? 'background.paper' : '#fff',
		boxShadow: inVSCode
			? 'none'
			: '0px 2px 1px -1px rgba(0, 0, 0, 0.15), 0px 1px 1px 0px rgba(0, 0, 0, 0.1), 0px 1px 3px 0px rgba(0, 0, 0, 0.08)',
		border: inVSCode ? 'none' : '1px solid #DCDCDC',
		borderRadius: '4px',
		outline: 'none',
		padding: 0,
		overflow: 'visible',
	},
	...(inVSCode
		? {
				nodeContent: {
					position: 'relative',
					border: 'none',
				},
			}
		: {}),
	cornerCapTop: {
		position: 'relative',
		height: '4px',
		backgroundColor: 'background.paper',
		borderRadius: '3px 3px 0 0',
	},
	cornerCapBottom: {
		position: 'relative',
		height: 0,
		backgroundColor: 'background.default',
		borderRadius: '0 0 3px 3px',
	},
	root: {
		display: 'flex',
		alignItems: 'center',
	},
	boxImage: {
		display: 'flex',
		alignItems: 'center',
	},
	boxLabel: {
		overflow: 'hidden',
	},
	headerWrapper: {
		position: 'relative',
		flex: 1,
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		px: '0.6rem',
		pt: '0.4rem',
		pb: '0.4rem',
	},
	icon: {
		width: 'auto',
		height: '1rem',
		marginRight: '0.5rem',
	},
	label: {
		letterSpacing: 0,
		lineHeight: 1,
		textAlign: 'left',
		overflow: 'hidden',
		whiteSpace: 'normal',
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical',
	},
	title: {
		fontWeight: 500,
		fontSize: '0.6rem',
	},
	tile: {
		px: '0.6rem',
		py: '0.2rem',
		textAlign: 'left',
		backgroundColor: inVSCode ? 'background.paper' : '#fff',
	},
	tileLabel: {
		fontSize: '0.5rem',
		color: inVSCode ? 'text.disabled' : '#838383',
	},
};
