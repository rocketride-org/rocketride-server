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

import { alpha } from '@mui/material';

import theme, { brandOrange } from '../../../../theme';
import { isInVSCode } from '../../../../utils/vscode';

const accentColor = isInVSCode() ? 'var(--vscode-button-background)' : brandOrange;

/**
 * MUI `sx`-compatible style definitions for the RunButton component.
 * Provides styles for the sliding button wrapper, the icon button itself,
 * the play/stop icon, and the label that appears on hover. The button
 * slides out from the left edge of the node and changes color on hover
 * (orange for play, red for stop).
 */
export const styles = {
	buttonWrapper: {
		zIndex: -1,
		position: 'absolute',
		backgroundColor: 'background.paper',
		left: 'calc(-2rem - 1px)',
		top: '0.75rem',
		margin: 'auto',
		width: '2rem',
		height: '1.75rem',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		cursor: 'pointer',
		borderRadius: '1rem 0 0 1rem',
		boxShadow:
			'0px 2px 1px -1px rgba(0, 0, 0, 0.15), 0px 1px 1px 0px rgba(0, 0, 0, 0.1), 0px 1px 3px 0px rgba(0, 0, 0, 0.08)',
		border: 'none',
		outline: '1px solid',
		outlineColor: 'divider',
		transition: 'left 0.2s, width 0.2s, background-color 0.2s',
		'&:hover': {
			left: 'calc(-3rem - 1px)', // Slide to the left on hover
			width: '3rem',
			'&': {
				backgroundColor: accentColor,
			},
			'&.stop-button': {
				backgroundColor: theme.palette.error.main,
			},
			'& .run-btn-label': {
				opacity: 1,
				color: theme.palette.common.white,
				width: 'auto',
			},
			'& svg': {
				fill: theme.palette.common.white,
			},
		},
	},
	button: {
		padding: '0.13rem',
		pointerEvents: 'none',
		'&.Mui-disabled': {
			backgroundColor: alpha(theme.palette.action.disabledBackground, 0.9),
			'& svg': {
				fill: theme.palette.action.disabled,
			},
		},
	},
	icon: {
		width: '1rem',
		height: '1rem',
	},
	label: {
		opacity: 0,
		transition: 'width 0.2s',
		pointerEvents: 'none',
		whiteSpace: 'nowrap',
		fontSize: '0.65rem',
		width: '0',
	},
};
