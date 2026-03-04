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
 * SVG icon component that renders a pair of gear/cog symbols representing configuration.
 * Used to visually represent configuration file types (e.g., INI, YAML, TOML) in file
 * listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling color, size, style, and opacity.
 */
const ConfigIcon: FunctionComponent<IIconProps> = ({
	color = '#c0c1ca',
	height = '20',
	style,
	width = '18',
	opacity = 1,
}) => {
	return (
		<svg
			clipRule="evenodd"
			fillRule="evenodd"
			imageRendering="optimizeQuality"
			shapeRendering="geometricPrecision"
			textRendering="geometricPrecision"
			viewBox="0 0 512 512"
			xmlns="http://www.w3.org/2000/svg"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<path
					d="m204 355h-38c-4 0-7-2-7-5l-12-48c-8-3-16-6-24-11l-40 25c-3 2-6 2-9-1l-27-27c-3-2-3-6-2-9l26-42c-3-8-7-16-9-25l-46-10c-3-1-5-4-5-7v-39c0-3 2-6 5-7l49-12c3-8 6-16 10-23l-25-41c-2-3-1-6 1-9l28-27c2-3 6-4 9-2l43 26c8-3 16-7 24-9l11-46c1-3 3-6 7-6h38c4 0 7 3 8 6l11 48c8 3 16 6 24 11l40-25c2-2 6-2 9 1l27 27c3 3 3 7 1 9l-25 43c3 7 7 15 9 24l45 11c4 1 6 4 6 7v38c0 4-2 6-5 7l-49 12c-3 9-6 17-11 24l25 40c2 3 2 7-1 9l-27 27c-2 3-6 3-9 1l-43-26c-7 4-16 7-24 9l-11 47c0 3-3 5-7 5z"
					fill={color}
				/>
				<path
					d="m188 242c-35 0-64-29-64-64 0-36 29-64 64-64 36 0 64 28 64 64 0 35-28 64-64 64z"
					fill="#fff"
				/>
				<path
					d="m400 512h-24c-4 0-6-3-7-6l-7-28c-4-1-9-3-12-5l-24 14c-3 2-6 2-9-1l-16-17c-3-2-3-5-1-8l15-25c-2-4-4-9-5-13l-27-6c-3-1-6-4-6-7v-24c0-3 3-6 6-7l28-7c1-4 3-8 5-12l-14-23c-2-3-1-7 1-9l16-17c3-2 6-3 9-1l25 15c4-2 8-3 12-5l7-27c0-3 3-5 7-5h23c4 0 7 2 8 5l6 28c4 2 9 4 12 6l24-15c2-1 6-1 9 1l16 17c3 2 3 6 2 9l-16 24c2 5 4 9 5 13l28 7c3 1 5 4 5 7v24c0 3-2 6-5 7l-28 7c-2 4-4 8-6 12l15 23c2 3 1 7-1 9l-17 17c-2 2-6 3-9 1l-24-15c-4 2-9 4-13 5l-6 26c-1 3-4 6-7 6z"
					fill={color}
				/>
				<path
					d="m389 442c-23 0-42-19-42-42 0-24 19-43 42-43s43 19 43 43c0 23-20 42-43 42z"
					fill="#fff"
				/>
			</g>
		</svg>
	);
};

export default ConfigIcon;
