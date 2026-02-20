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

import { CSSProperties } from '@mui/styles';
import { NODE_WIDTH } from '../constants';
import { grey } from '@mui/material/colors';
import pxToRem from '../../../utils/pxToRem';

/** Light grey background color derived from MUI grey palette, used across canvas elements. */
const backgroundColor = grey[100];

/** Background styles applied to the ReactFlow canvas area when snap-to-grid is active. */
export const canvasBackgroundStyles: CSSProperties = {
	background: backgroundColor,
};

/**
 * Styles for child items within a pipeline node.
 * @deprecated Marked for removal -- see TODO.
 */
// @TODO: Delete later
export const nodeChildrenStyles = {
	display: 'flex',
	alignItems: 'center',
	borderRadius: '3px',
	mt: '2px',
	background: 'white',
	p: 1,
	border: '1px solid rgba(0, 0, 0, 0.12)',
	width: NODE_WIDTH,
};

/** Base CSS styles for ReactFlow node connection handles (ports). Defines the outer hit-area dimensions. */
export const handleStyles: CSSProperties = {
	width: `${pxToRem(14)}rem`,
	height: `${pxToRem(14)}rem`,
	border: 'none',
	background: 'transparent',
};

/** MUI sx styles for the toolbar panel container that sits above the canvas. */
export const toolbarContainerStyles = {
	paddingTop: 1,
	paddingBottom: 1,
	paddingLeft: 2,
	paddingRight: 2,
	background: 'white',
	display: 'flex',
	alignItems: 'center',
};

/** Placeholder styles for the toolbar status section (currently empty). */
export const toolbarStatusStyles = {};

/** Styles for the edit (pencil) icon displayed in the toolbar. */
export const toolbarEditIconStyles = {
	fontSize: 20,
	color: 'grey',
};

/** CSS styles for toolbar button icons, setting a consistent 24x24 size. */
export const toolbarButtonIconStyles: CSSProperties = {
	width: 24,
	height: 24,
};

/** CSS styles for the side actions panel container (create node, node config, etc.). */
export const actionsContainerStyles: CSSProperties = {
	height: '100%',
	width: 400,
	margin: 0,
};

/** CSS styles applied to control buttons in their active/pressed state. */
export const activeControlButtonStyles: CSSProperties = {
	backgroundColor: '#f4f4f4',
};
