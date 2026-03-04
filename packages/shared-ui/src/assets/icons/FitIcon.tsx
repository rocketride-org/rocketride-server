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
 * SVG icon component that renders four corner brackets pointing outward.
 * Used in the canvas toolbar to represent a "fit to view" or "fit to screen" action,
 * allowing users to reset the viewport to show all content within the visible area.
 *
 * @param props - Standard icon props for controlling color.
 */
const FitIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="26"
			height="25"
			viewBox="0 0 26 25"
			fill="none"
		>
			<path
				d="M2.5865 24.5C2.08054 24.5 1.65614 24.3354 1.31328 24.0063C0.971615 23.6783 0.800781 23.2714 0.800781 22.7857V17.6429C0.800781 17.1571 0.971615 16.7497 1.31328 16.4206C1.65614 16.0926 2.08054 15.9286 2.5865 15.9286C3.09245 15.9286 3.51685 16.0926 3.85971 16.4206C4.20138 16.7497 4.37221 17.1571 4.37221 17.6429V21.0714H7.94364C8.44959 21.0714 8.874 21.236 9.21685 21.5651C9.55852 21.8931 9.72935 22.3 9.72935 22.7857C9.72935 23.2714 9.55852 23.6783 9.21685 24.0063C8.874 24.3354 8.44959 24.5 7.94364 24.5H2.5865ZM2.5865 9.07143C2.08054 9.07143 1.65614 8.90686 1.31328 8.57771C0.971615 8.24971 0.800781 7.84286 0.800781 7.35714V2.21429C0.800781 1.72857 0.971615 1.32114 1.31328 0.992C1.65614 0.664 2.08054 0.5 2.5865 0.5H7.94364C8.44959 0.5 8.874 0.664 9.21685 0.992C9.55852 1.32114 9.72935 1.72857 9.72935 2.21429C9.72935 2.7 9.55852 3.10743 9.21685 3.43657C8.874 3.76457 8.44959 3.92857 7.94364 3.92857H4.37221V7.35714C4.37221 7.84286 4.20138 8.24971 3.85971 8.57771C3.51685 8.90686 3.09245 9.07143 2.5865 9.07143ZM18.6579 24.5C18.152 24.5 17.7282 24.3354 17.3865 24.0063C17.0436 23.6783 16.8722 23.2714 16.8722 22.7857C16.8722 22.3 17.0436 21.8931 17.3865 21.5651C17.7282 21.236 18.152 21.0714 18.6579 21.0714H22.2294V17.6429C22.2294 17.1571 22.4008 16.7497 22.7436 16.4206C23.0853 16.0926 23.5091 15.9286 24.0151 15.9286C24.521 15.9286 24.9448 16.0926 25.2865 16.4206C25.6294 16.7497 25.8008 17.1571 25.8008 17.6429V22.7857C25.8008 23.2714 25.6294 23.6783 25.2865 24.0063C24.9448 24.3354 24.521 24.5 24.0151 24.5H18.6579ZM24.0151 9.07143C23.5091 9.07143 23.0853 8.90686 22.7436 8.57771C22.4008 8.24971 22.2294 7.84286 22.2294 7.35714V3.92857H18.6579C18.152 3.92857 17.7282 3.76457 17.3865 3.43657C17.0436 3.10743 16.8722 2.7 16.8722 2.21429C16.8722 1.72857 17.0436 1.32114 17.3865 0.992C17.7282 0.664 18.152 0.5 18.6579 0.5H24.0151C24.521 0.5 24.9448 0.664 25.2865 0.992C25.6294 1.32114 25.8008 1.72857 25.8008 2.21429V7.35714C25.8008 7.84286 25.6294 8.24971 25.2865 8.57771C24.9448 8.90686 24.521 9.07143 24.0151 9.07143Z"
				fill={color}
			/>
		</svg>
	);
};

export default FitIcon;
