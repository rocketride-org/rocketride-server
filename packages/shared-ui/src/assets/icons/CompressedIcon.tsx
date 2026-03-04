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
 * SVG icon component that renders a compressed/zipped file symbol with a zipper motif.
 * Used to visually represent compressed archive file types (e.g., ZIP, RAR, 7z) in file
 * listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const CompressedIcon: FunctionComponent<IIconProps> = ({
	height = '20',
	style,
	width = '22',
	opacity = 1,
}) => {
	return (
		<svg
			id="Layer_1"
			enableBackground="new 0 0 512 512"
			viewBox="0 0 512 512"
			xmlns="http://www.w3.org/2000/svg"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<path
					d="m321.2 2h-232.4c-16.1 0-29.1 13-29.1 29.1v449.8c0 16.1 13 29.1 29.1 29.1h334.4c16.1 0 29.1-13 29.1-29.1v-347.8z"
					fill="#9ABCF8"
				/>
				<path d="m321.2 104c0 16.1 13 29.1 29.1 29.1h102l-131.1-131.1z" fill="#607caf" />
				<g>
					<path d="m190.1 2h57.7v289.8h-57.7z" fill="#445c6c" />
					<g fill="#dbdfe0">
						<path d="m225.9 276.2s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 275.4s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 244s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 243.2s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 211.8s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 211s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 179.5s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 178.7s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 147.3s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 146.5s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 115.1s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 114.3s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 82.9s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 82.1s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 50.6s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 49.8s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
						<path d="m225.9 18.4s-1.2 3.4-3.8 3.4c-2.3 0-4.1-2.9-6.1-2.9-1.7 0-3.7 2.2-3.7 7.3s1.9 7.3 3.7 7.3c2 0 3.9-2.9 6.1-2.9 2.6 0 3.8 3.4 3.8 3.4h14.2v-15.6z" />
						<path d="m212 17.6s1.2-3.4 3.8-3.4c2.3 0 4.1 2.9 6.1 2.9 1.7 0 3.7-2.2 3.7-7.3s-1.9-7.3-3.7-7.3c-2 0-3.9 2.9-6.1 2.9-2.6 0-3.8-3.4-3.8-3.4h-14.2v15.6z" />
					</g>
					<g>
						<path
							d="m265.2 376.8-14.2-43.6v-38.8c0-4.9-4-8.9-8.9-8.9h-46.7c-4.9 0-8.9 4-8.9 8.9v38.8l-14.3 43.7c-2 6-2.9 12.5-2.4 19.3 1.8 24.2 21.6 43.7 45.8 45.1 28.5 1.7 52.1-20.8 52.1-48.9.1-5.5-.8-10.7-2.5-15.6zm-46.4 47.8c-17.8 0-32.2-14.4-32.2-32.2s14.4-32.2 32.2-32.2 32.2 14.4 32.2 32.2-14.4 32.2-32.2 32.2z"
							fill="#fbd984"
						/>
						<path
							d="m218.8 285.6c-5 0-9 4-9 9v29.1c0 5 4 9 9 9s9-4 9-9v-29.1c0-5-4.1-9-9-9z"
							fill="#e39a61"
						/>
					</g>
				</g>
			</g>
		</svg>
	);
};

export default CompressedIcon;
