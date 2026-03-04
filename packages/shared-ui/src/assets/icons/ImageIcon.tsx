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
 * SVG icon component that renders an image/photo file symbol with landscape and sun motifs.
 * Used to visually represent image file types (e.g., PNG, JPG, GIF, BMP) in file
 * listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const ImageIcon: FunctionComponent<IIconProps> = ({
	height = '20',
	style,
	width = '20',
	opacity = 1,
}) => {
	return (
		<svg
			viewBox="0 0 512 512"
			xmlns="http://www.w3.org/2000/svg"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<path
					d="m467.873 0h-426.666c-22.758 0-41.207 18.449-41.207 41.207v429.586c0 22.758 18.449 41.207 41.207 41.207h364.134l6.198-9.118 72.285-72.285 25.256-22.335v-2.92-364.135c0-22.758-18.449-41.207-41.207-41.207z"
					fill="#e7ecf6"
				/>
				<path
					d="m470.793 446.548v-384.737c0-11.379-9.225-20.604-20.604-20.604h-388.378c-11.379 0-20.604 9.225-20.604 20.604v388.378c0 11.379 9.225 20.604 20.604 20.604h384.738z"
					fill="#bed8fb"
				/>
				<path
					d="m470.793 320.696-82.661-118.265c-11.071-15.84-34.525-15.84-45.596 0l-106.605 152.519h234.861v-34.254z"
					fill="#365e7d"
				/>
				<circle cx="294.632" cy="112.385" fill="#ffc344" r="32.205" />
				<path
					d="m160.197 150.456-118.99 170.24v15.659l143.251 18.596h164.267l-142.932-204.495c-11.071-15.841-34.525-15.841-45.596 0z"
					fill="#407093"
				/>
				<path
					d="m470.793 446.548v-110.194h-429.586v113.835c0 11.379 9.225 20.604 20.604 20.604h384.738z"
					fill="#b3e59f"
				/>
				<path
					d="m405.341 512 106.659-106.659h-65.452c-22.758 0-41.207 18.449-41.207 41.207z"
					fill="#acacac"
				/>
				<path
					d="m470.793 0h-29.202c22.758 0 41.207 18.449 41.207 41.207v364.134 29.202l29.202-29.202v-364.134c0-22.758-18.449-41.207-41.207-41.207z"
					fill="#d8e2f1"
				/>
				<path
					d="m405.341 512 106.659-106.659h-65.452c-22.758 0-41.207 18.449-41.207 41.207z"
					fill="#80b4fb"
				/>
			</g>
		</svg>
	);
};

export default ImageIcon;
