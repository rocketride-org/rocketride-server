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
 * SVG icon component that renders a magnifying glass with a plus sign inside.
 * Used in the canvas toolbar to provide a zoom-in control, allowing users
 * to increase the zoom level of the viewport.
 *
 * @param props - Standard icon props for controlling color.
 */
const ZoomInIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			width="26"
			height="25"
			viewBox="0 0 26 25"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				d="M17.9924 15.7233H16.8631L16.4629 15.3373C17.8637 13.7078 18.707 11.5923 18.707 9.29102C18.707 4.15952 14.5475 0 9.41602 0C4.28452 0 0.125 4.15952 0.125 9.29102C0.125 14.4225 4.28452 18.582 9.41602 18.582C11.7173 18.582 13.8328 17.7387 15.4623 16.3379L15.8483 16.7381V17.8674L22.9952 25L25.125 22.8702L17.9924 15.7233ZM9.41602 15.7233C5.85685 15.7233 2.98378 12.8502 2.98378 9.29102C2.98378 5.73185 5.85685 2.85878 9.41602 2.85878C12.9752 2.85878 15.8483 5.73185 15.8483 9.29102C15.8483 12.8502 12.9752 15.7233 9.41602 15.7233Z"
				fill={color}
			/>
			<path
				d="M13.6237 10.6168H10.7445V13.496H9.30495V10.6168H6.42578V9.17726H9.30495V6.2981H10.7445V9.17726H13.6237V10.6168Z"
				fill={color}
			/>
		</svg>
	);
};

export default ZoomInIcon;
