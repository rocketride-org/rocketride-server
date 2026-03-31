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
 * SVG icon representing an auto-layout / tidy action.
 * Shows a hierarchical tree structure to convey automatic node arrangement.
 */
const TidyIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
			{/* Top center box */}
			<rect x="9" y="2" width="6" height="4" rx="1" fill={color} />
			{/* Bottom-left box */}
			<rect x="2" y="18" width="6" height="4" rx="1" fill={color} />
			{/* Bottom-center box */}
			<rect x="9" y="18" width="6" height="4" rx="1" fill={color} />
			{/* Bottom-right box */}
			<rect x="16" y="18" width="6" height="4" rx="1" fill={color} />
			{/* Vertical line from top box down to branch point */}
			<rect x="11.5" y="6" width="1" height="6" fill={color} />
			{/* Horizontal branch line */}
			<rect x="5" y="12" width="14" height="1" fill={color} />
			{/* Left vertical drop */}
			<rect x="5" y="12" width="1" height="6" fill={color} />
			{/* Center vertical drop */}
			<rect x="11.5" y="12" width="1" height="6" fill={color} />
			{/* Right vertical drop */}
			<rect x="18" y="12" width="1" height="6" fill={color} />
		</svg>
	);
};

export default TidyIcon;
