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
 * SVG icon component that renders a magnifying glass with a minus sign inside.
 * Used in the canvas toolbar to provide a zoom-out control, allowing users
 * to decrease the zoom level of the viewport.
 *
 * @param props - Standard icon props for controlling color.
 */
const ZoomOutIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			width="26"
			height="25"
			viewBox="0 0 26 25"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				d="M18.2697 15.5943H17.1405L16.7403 15.2238C18.1411 13.6595 18.9844 11.6286 18.9844 9.41938C18.9844 4.49314 14.8249 0.5 9.69337 0.5C4.56186 0.5 0.402344 4.49314 0.402344 9.41938C0.402344 14.3456 4.56186 18.3388 9.69337 18.3388C11.9947 18.3388 14.1102 17.5292 15.7397 16.1844L16.1256 16.5686V17.6527L23.2726 24.5L25.4023 22.4554L18.2697 15.5943ZM9.69337 15.5943C6.13419 15.5943 3.26112 12.8362 3.26112 9.41938C3.26112 6.00257 6.13419 3.24443 9.69337 3.24443C13.2525 3.24443 16.1256 6.00257 16.1256 9.41938C16.1256 12.8362 13.2525 15.5943 9.69337 15.5943ZM6.1199 8.73328H13.2668V10.1055H6.1199V8.73328Z"
				fill={color}
			/>
		</svg>
	);
};

export default ZoomOutIcon;
