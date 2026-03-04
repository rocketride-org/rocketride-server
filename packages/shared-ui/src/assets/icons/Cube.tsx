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
 * SVG icon component that renders a 3D cube using an embedded bitmap image pattern.
 * Used as a visual indicator for generic object or package representations within
 * the canvas and node-based UI elements of the application.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const CubeIcon: FunctionComponent<IIconProps> = ({
	height = 50,
	style,
	width = 50,
	opacity = 1,
}) => {
	return (
		<svg
			style={style}
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			xmlnsXlink="http://www.w3.org/1999/xlink"
			opacity={opacity}
		>
			<rect width={width} height={height} fill="url(#pattern0_602_541)" />
			<defs>
				<pattern
					id="pattern0_602_541"
					patternContentUnits="objectBoundingBox"
					width="1"
					height="1"
				>
					<use xlinkHref="#image0_602_541" transform="scale(0.0104167)" />
				</pattern>
				<image
					id="image0_602_541"
					width="102"
					height="102"
					xlinkHref="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAABtElEQVR4nO3cQU7DQBBE0ToIW3wANuHKSOFoQJILNLLkNRKynaqe+U+afc98PBGyEgkAAAAAAAD42yLpU9JDUjVfj20v655aWAf9Dji4Onj9SLqogWvAYdVJ69Yhwj3goGrmCO4DqidFeFco9+HU7BHcB1OzR3AfSs0eYYhNSHqT9NVx/mH+ktQ0wlCPsxpGGO5OVbMIQ36wqVGEIwLYN9E5wlEBigj+AEUEf4AaYD31OnJvtoLfJzzlpY57oxW81nclBJAvwPquhADyPgUEEAHsd3HxBPgPoriCQu/Qnezzt/8Q28k+PwFEACeeADMCmBHAjABmBDAjgBkBzAhgRgAzApgRwIwAZgQwI4AZAcwIYEYAMwKYEcCMAGYEMCOAGQHMCDB7gLN/Jy6dff71B+4IIF+AZftCGk+AfE/wf75RzhXULEK6qPnPiJAubv6jI6SLnP/ICOli5z8qQrro+Y+IkC5+/r0R0rWYf0+EdG3mP/OftQpeUWaMEGe2CJFmihDrsv22Wg28bgo3eoSrGric/D6hTGu9Yl/VxLL9tdwDDm7vWvfwIenFfagAAAAAAABQtF+xGHXxQ5F0hQAAAABJRU5ErkJggg=="
				/>
			</defs>
		</svg>
	);
};

export default CubeIcon;
