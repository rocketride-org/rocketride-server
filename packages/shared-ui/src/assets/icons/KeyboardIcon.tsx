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

import { FunctionComponent } from 'react';
import { IIconProps } from './types';

/**
 * SVG icon component that renders a keyboard symbol with key outlines.
 * Used in the canvas UI to represent keyboard shortcuts or keyboard-related
 * actions, such as the keyboard shortcuts display panel.
 *
 * @param props - Standard icon props for controlling color.
 */
const KeyboardIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			width="88"
			height="68"
			viewBox="0 0 88 68"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				d="M80 0H8C3.6 0 0 3.6 0 8V60C0 64.4 3.6 68 8 68H80C84.4 68 88 64.4 88 60V8C88 3.6 84.4 0 80 0ZM80 60H8V8H80V60ZM32 16H40V24H32V16ZM16 16H24V24H16V16ZM28 48H60V52H28V48ZM48 16H56V24H48V16ZM32 32H40V40H32V32ZM16 32H24V40H16V32ZM48 32H56V40H48V32ZM64 16H72V24H64V16ZM64 32H72V40H64V32Z"
				fill={color}
			/>
		</svg>
	);
};

export default KeyboardIcon;
