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
 * SVG icon component that renders angle brackets and a slash, representing source code.
 * Used to visually represent code and script file types (e.g., JS, HTML, CSS) in file
 * listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling color, size, style, and opacity.
 */
const CodeIcon: FunctionComponent<IIconProps> = ({
	color = '#000',
	height = '18',
	style,
	width = '22',
	opacity = 1,
}) => {
	return (
		<svg
			version="1.1"
			id="Capa_1"
			xmlns="http://www.w3.org/2000/svg"
			xmlnsXlink="http://www.w3.org/1999/xlink"
			x="0px"
			y="0px"
			viewBox="0 0 511.997 411.997"
			xmlSpace="preserve"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<g>
					<path
						d="M506.76,242.828l-118.4-125.44c-7.277-7.718-19.424-8.07-27.142-0.787c-7.706,7.277-8.064,19.43-0.781,27.142
					l105.965,112.256L360.437,368.268c-7.283,7.712-6.925,19.859,0.781,27.142c3.712,3.501,8.454,5.235,13.178,5.235
					c5.101,0,10.195-2.022,13.965-6.01l118.4-125.446C513.742,261.785,513.742,250.226,506.76,242.828z"
						fill={color}
					/>
				</g>
			</g>
			<g>
				<g>
					<path
						d="M151.566,368.262L45.608,255.999l105.958-112.262c7.277-7.712,6.925-19.866-0.787-27.142
					c-7.706-7.277-19.866-6.925-27.142,0.787l-118.4,125.44c-6.982,7.398-6.982,18.963,0,26.362L123.643,394.63
					c3.776,4,8.864,6.016,13.965,6.016c4.723,0,9.466-1.741,13.171-5.242C158.498,388.127,158.843,375.974,151.566,368.262z"
						fill={color}
					/>
				</g>
			</g>
			<g>
				<g>
					<path
						d="M287.061,52.697c-10.477-1.587-20.282,5.606-21.882,16.083l-56.32,368.64c-1.6,10.483,5.6,20.282,16.083,21.882
					c0.986,0.147,1.958,0.218,2.925,0.218c9.325,0,17.504-6.803,18.957-16.301l56.32-368.64
					C304.744,64.095,297.544,54.297,287.061,52.697z"
						fill={color}
					/>
				</g>
			</g>
		</svg>
	);
};

export default CodeIcon;
