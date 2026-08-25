// =============================================================================
// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
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
 * SVG icon component that renders a speaker/audio symbol.
 * Used to visually represent audio file types (e.g., MP3, WAV) in file listings,
 * classification views, and anywhere audio content needs to be indicated.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const AudioIcon: FunctionComponent<IIconProps> = ({
	height = '18',
	style,
	width = '22',
	opacity = 1,
}) => {
	return (
		<svg
			version="1.1"
			id="Layer_1"
			xmlns="http://www.w3.org/2000/svg"
			xmlnsXlink="http://www.w3.org/1999/xlink"
			x="0px"
			y="0px"
			viewBox="0 0 512 512"
			xmlSpace="preserve"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<path
					fill="#2EE6C7"
					d="M426.706,439.706c-3.839,0-7.677-1.464-10.607-4.394c-5.857-5.858-5.857-15.355,0-21.213
		C458.596,371.603,482,315.1,482,255s-23.404-116.603-65.901-159.099c-5.858-5.857-5.858-15.355,0-21.213s15.356-5.858,21.213,0
		C485.475,122.851,512,186.887,512,255s-26.525,132.149-74.688,180.312C434.383,438.241,430.544,439.706,426.706,439.706z"
				/>
				<path
					fill="#2EE6C7"
					d="M381.387,394.387c-3.839,0-7.678-1.464-10.606-4.394c-5.858-5.858-5.858-15.355,0-21.213
		C401.23,338.33,418,297.922,418,255s-16.77-83.33-47.22-113.78c-5.858-5.858-5.858-15.355,0-21.213
		c5.857-5.858,15.355-5.858,21.213,0C428.11,156.123,448,204.064,448,255s-19.89,98.877-56.007,134.993
		C389.064,392.922,385.226,394.387,381.387,394.387z"
				/>
			</g>
			<g>
				<path
					fill="#29CCB1"
					d="M370.78,368.78c-5.858,5.858-5.858,15.355,0,21.213c2.929,2.929,6.768,4.394,10.606,4.394
		s7.678-1.464,10.606-4.394C428.11,353.877,448,305.936,448,255h-30C418,297.922,401.23,338.33,370.78,368.78z"
				/>
				<path
					fill="#29CCB1"
					d="M482,255c0,60.1-23.404,116.603-65.901,159.099c-5.858,5.857-5.858,15.355,0,21.213
		c2.93,2.929,6.768,4.394,10.607,4.394c3.838,0,7.678-1.465,10.606-4.394C485.475,387.149,512,323.113,512,255H482z"
				/>
			</g>
			<polygon
				fill="#5C5F66"
				points="276,32 120,160 81.977,190.031 81.977,313.594 120,352 276,480 300.336,428.656
	300.336,60.344 "
			/>
			<g>
				<path
					fill="#7F838C"
					d="M120,352H48c-26.51,0-48-21.49-48-48v-96c0-26.51,21.49-48,48-48h72V352z"
				/>
				<path
					fill="#7F838C"
					d="M288,480h-12V32h12c26.51,0,48,21.49,48,48v352C336,458.51,314.51,480,288,480z"
				/>
			</g>
			<polygon
				fill="#53565C"
				points="93.977,256 81.977,313.594 120,352 276,480 300.336,428.656 312.336,256 "
			/>
			<g>
				<path fill="#7F8184" d="M276,256v224h12c26.508,0,48-21.5,48-48V256H276z" />
				<path fill="#7F8184" d="M0,256v48c0,26.5,21.492,48,48,48h72v-96H0z" />
			</g>
		</svg>
	);
};

export default AudioIcon;
