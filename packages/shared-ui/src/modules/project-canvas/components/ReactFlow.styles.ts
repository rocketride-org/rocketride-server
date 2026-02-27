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

import pxToRem from '../../../utils/pxToRem';
import { brandOrange } from '../../../theme';
import { isInVSCode } from '../../../utils/vscode';

/**
 * Generates global CSS overrides for ReactFlow elements within the canvas.
 * Customizes the selection/focus outlines on nodes, resize control handles and lines,
 * control button sizing (adjusted for VS Code), and panel margins.
 * These styles use the RocketRide brand orange for visual consistency.
 *
 * @returns An object containing a `@global` key with CSS class overrides for ReactFlow.
 */
export const reactFlowStyles = () => {
	const accent = isInVSCode() ? 'var(--vscode-button-background)' : brandOrange;
	const accentFaded = isInVSCode() ? 'var(--vscode-button-background)' : 'rgba(247, 144, 31, 0.5)';

	return {
		'@global': {
			// Target selected and focus state of the react flow nodes (pipelines)
			'.react-flow__node.selected:not(.react-flow__node-operator):not(.react-flow__node-annotation)': {
				outline: `1px solid ${accent} !important`,
			},
			'.react-flow__node:focus:not(.react-flow__node-operator):not(.react-flow__node-annotation)': {
				outline: `1px solid ${accent} !important`,
			},
			'.react-flow__node': {
				borderRadius: '4px',
			},
			'.react-flow__node-resizer': {
				border: 'none',
			},
			'.react-flow__node-remote-group': {
				zIndex: '-1 !important',
			},
			'.react-flow__resize-control.handle': {
				background: accent,
				border: `3px solid ${accentFaded}`,
				width: '8px',
				height: '8px',
			},
			'.react-flow__resize-control.line': {
				background: accent,
				borderColor: accent,
				zIndex: 10,
			},
			'.react-flow__resize-control.top.line': {
				borderTopWidth: '3px',
			},
			'.react-flow__resize-control.bottom.line': {
				borderBottomWidth: '3px',
			},
			'.react-flow__resize-control.right.line': {
				borderRightWidth: '3px',
			},
			'.react-flow__resize-control.left.line': {
				borderLeftWidth: '3px',
			},
			'.react-flow__controls-button': {
				width: isInVSCode() ? '28px' : '42px',
				height: isInVSCode() ? '28px' : '42px',
			},
			'.react-flow__panel': {
				margin: `${pxToRem(15)}rem`,
			},
		},
	};
};
