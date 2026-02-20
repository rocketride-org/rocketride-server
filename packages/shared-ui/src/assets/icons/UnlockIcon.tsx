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

import { FunctionComponent } from 'react';
import { IIconProps } from './types';

/**
 * SVG icon component that renders an open padlock symbol.
 * Used to indicate an unlocked or accessible state within the UI, such as
 * unlocked canvas elements, editable resources, or open access indicators.
 *
 * @param props - Standard icon props for controlling color.
 */
const UnockIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			width="64"
			height="84"
			viewBox="0 0 64 84"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				d="M56 28H52V20C52 8.96 43.04 0 32 0C20.96 0 12 8.96 12 20H20C20 13.36 25.36 8 32 8C38.64 8 44 13.36 44 20V28H8C3.6 28 0 31.6 0 36V76C0 80.4 3.6 84 8 84H56C60.4 84 64 80.4 64 76V36C64 31.6 60.4 28 56 28ZM56 76H8V36H56V76ZM32 64C36.4 64 40 60.4 40 56C40 51.6 36.4 48 32 48C27.6 48 24 51.6 24 56C24 60.4 27.6 64 32 64Z"
				fill={color}
			/>
		</svg>
	);
};

export default UnockIcon;
