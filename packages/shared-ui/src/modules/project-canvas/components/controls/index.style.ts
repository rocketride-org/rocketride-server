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

import { grey } from '@mui/material/colors';
import { isInVSCode } from '../../../../utils/vscode';

/** Whether the app is running inside VS Code, used to apply compact sizing. */
const inVSCode = isInVSCode();

/**
 * Style definitions for the canvas Controls toolbar.
 * Sizes and spacing are adjusted based on whether the app is hosted in VS Code
 * (where a more compact layout is needed) or in a full browser window.
 */
const styles = {
	/** Positioning for the root Panel element. */
	root: {
		bottom: '1rem',
	},
	/** Styles for the Paper container wrapping all control buttons. */
	paper: {
		backgroundColor: 'background.paper',
		display: 'flex',
		border: inVSCode
			? '1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.12))'
			: '1px solid #DCDCDC',
		borderRadius: '4px',
	},
	/** Base icon button styles with hover and disabled state handling. SVG sizing adapts to VS Code. */
	iconButton: {
		'&:hover': { backgroundColor: 'action.hover' },
		'&:disabled': { opacity: 0.5 },
		'& svg': {
			width: 'auto',
			height: inVSCode ? '1rem' : '1.5rem',
		},
	},
	/** Overrides for the add-node button icon to render it larger than standard icons. */
	addNodeButton: {
		'& svg': {
			width: 'auto',
			height: inVSCode ? '1.8rem !important' : '2.95rem !important',
		},
	},
	/** Removes padding from MUI IconButtons that need a tighter layout (e.g., badge buttons). */
	shrinkMuiIconButton: {
		padding: 0,
	},
	/** Styles for MUI-provided icons (e.g., MoreVert) in the controls toolbar. */
	muiIcon: {
		color: grey[700],
		width: 'auto',
		height: inVSCode ? '1.2rem' : '2rem',
	},
	/** Styles for each grouped section (Box) within the toolbar, separated by vertical borders. */
	box: {
		borderRight: '1px solid rgba(0,0,0,0.25)',
		display: 'flex',
		gap: inVSCode ? '0.4rem' : '0.75rem',
		justifyContent: 'space-evenly',
		padding: inVSCode ? '0.25rem 0.4rem' : '0.5rem 0.8rem',
	},
};

export default styles;
