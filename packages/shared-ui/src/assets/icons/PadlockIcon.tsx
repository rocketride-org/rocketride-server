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
 * Two-tone filled padlock icon. Yellow body with dark shackle and keyhole.
 * Used to indicate a subscription-locked feature.
 *
 * @param props - Standard icon props for controlling size.
 */
const PadlockIcon: FunctionComponent<IIconProps> = ({ size }) => {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width={size ?? 24} height={size ?? 24} viewBox="0 0 93.63 122.88">
			<path fill="#fbd734" fillRule="evenodd" d="M6,47.51H87.64a6,6,0,0,1,6,6v63.38a6,6,0,0,1-6,6H6a6,6,0,0,1-6-6V53.5a6,6,0,0,1,6-6Z" />
			<path fill="#36464e" fillRule="evenodd" d="M41.89,89.26l-6.47,16.95H58.21L52.21,89a11.79,11.79,0,1,0-10.32.24Z" />
			<path fill="#36464e" fillRule="evenodd" d="M83.57,47.51H72.22V38.09a27.32,27.32,0,0,0-7.54-19,24.4,24.4,0,0,0-35.73,0,27.32,27.32,0,0,0-7.54,19v9.42H10.06V38.09A38.73,38.73,0,0,1,20.78,11.28a35.69,35.69,0,0,1,52.07,0A38.67,38.67,0,0,1,83.57,38.09v9.42Z" />
		</svg>
	);
};

export default PadlockIcon;
