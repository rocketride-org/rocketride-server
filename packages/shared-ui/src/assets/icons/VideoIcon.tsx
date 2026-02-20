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
 * SVG icon component that renders a film reel / video camera symbol with a play button.
 * Used to visually represent video file types (e.g., MP4, AVI, MOV) in file
 * listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const VideoIcon: FunctionComponent<IIconProps> = ({
	height = '18',
	style,
	width = '18',
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
					d="m285 31c-38.39 0-71.686 20.94-90 51.78-18.314-30.84-51.61-51.78-90-51.78-57.891 0-105 47.109-105 105s47.109 105 105 105c38.39 0 71.686-20.94 90-51.78 18.314 30.84 51.61 51.78 90 51.78 57.891 0 105-47.109 105-105s-47.109-105-105-105z"
					fill="#3a4d4d"
				/>
				<path
					d="m285 241c57.891 0 105-47.109 105-105s-47.109-105-105-105c-38.39 0-71.686 20.94-90 51.78v106.44c18.314 30.84 51.61 51.78 90 51.78z"
					fill="#3a4d4d"
				/>
				<g>
					<g>
						<g>
							<g>
								<path d="m512 460.272-152-75v-78.545l152-75z" fill="#3a4d4d" />
							</g>
						</g>
					</g>
				</g>
				<g>
					<g>
						<g>
							<g>
								<path d="m390 481h-390v-270h390z" fill="#3a4d4d" />
							</g>
						</g>
					</g>
				</g>
				<g id="Video_2_">
					<g>
						<path
							d="m105 181c-24.814 0-45-20.186-45-45s20.186-45 45-45 45 20.186 45 45-20.186 45-45 45z"
							fill="#f3f5f9"
						/>
					</g>
					<g>
						<path
							d="m285 181c-24.814 0-45-20.186-45-45s20.186-45 45-45 45 20.186 45 45-20.186 45-45 45z"
							fill="#e1e6f0"
						/>
					</g>
				</g>
				<path d="m195 211h195v270h-195z" fill="#3a4d4d" />
				<g>
					<path d="m150 434.022v-176.044l132.041 88.022z" fill="#ffe566" />
				</g>
				<path d="m195 404.024 87.041-58.024-87.041-58.024z" fill="#ffe566" />
			</g>
		</svg>
	);
};

export default VideoIcon;
