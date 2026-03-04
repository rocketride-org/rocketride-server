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
 * SVG icon component that renders a sticky note or annotation symbol with overlapping pages.
 * Used in the canvas UI to represent annotation nodes or note-taking elements,
 * allowing users to identify comment and note features at a glance.
 *
 * @param props - Standard icon props for controlling color.
 */
const NoteIcon: FunctionComponent<IIconProps> = ({ color }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="86"
			height="86"
			viewBox="5 5 86 86"
			fill="none"
		>
			<path
				d="M28.001 80.0001V35.9001C28.001 33.7001 28.801 31.8334 30.401 30.3001C32.001 28.7667 33.901 28.0001 36.101 28.0001H80.001C82.201 28.0001 84.0844 28.7834 85.651 30.3501C87.2177 31.9167 88.001 33.8001 88.001 36.0001V68.0001L68.001 88.0001H36.001C33.801 88.0001 31.9177 87.2167 30.351 85.6501C28.7844 84.0834 28.001 82.2001 28.001 80.0001ZM8.10103 25.0001C7.70103 22.8001 8.13436 20.8167 9.40103 19.0501C10.6677 17.2834 12.401 16.2001 14.601 15.8001L58.001 8.10005C60.201 7.70005 62.1844 8.13339 63.951 9.40005C65.7177 10.6667 66.801 12.4001 67.201 14.6001L68.201 20.0001H60.001L59.301 16.0001L16.001 23.7001L20.001 46.3001V74.2001C18.9344 73.6001 18.0177 72.8001 17.251 71.8001C16.4844 70.8001 16.001 69.6667 15.801 68.4001L8.10103 25.0001ZM36.001 36.0001V80.0001H64.001V64.0001H80.001V36.0001H36.001Z"
				fill={color}
			/>
		</svg>
	);
};

export default NoteIcon;
