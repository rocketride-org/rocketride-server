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
 * SVG icon component that renders a Microsoft PowerPoint-style presentation symbol.
 * Used to visually represent PowerPoint/presentation file types (e.g., PPT, PPTX)
 * in file listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling color, size, style, and opacity.
 */
const PowerpointIcon: FunctionComponent<IIconProps> = ({
	color = '#FF5722',
	height = '20',
	style,
	width = '18',
	opacity = 1,
}) => {
	return (
		<svg
			version="1.1"
			xmlns="http://www.w3.org/2000/svg"
			xmlnsXlink="http://www.w3.org/1999/xlink"
			x="0px"
			y="0px"
			viewBox="0 0 512 412"
			xmlSpace="preserve"
			height={height}
			width={width}
			style={style}
			opacity={opacity}
		>
			<g>
				<path
					fill={color}
					d="M373.334,117.377c-5.891,0-10.667,4.776-10.667,10.667v64c0,5.891,4.776,10.667,10.667,10.667h64
		c5.891,0,10.667-4.776,10.667-10.667C448,150.807,414.571,117.377,373.334,117.377z"
				/>
				<path
					fill={color}
					d="M373.334,224.044c-17.673,0-32-14.327-32-32v-52.245c-40.733,5.794-69.056,43.512-63.262,84.245
		c5.794,40.733,43.512,69.056,84.245,63.262c32.812-4.668,58.594-30.45,63.262-63.262H373.334z"
				/>
				<path
					fill={color}
					d="M294.656,13.014c-2.531-2.056-5.863-2.842-9.045-2.133l-277.333,64
		C3.397,76.003-0.047,80.369,0,85.377v362.667c0.002,5.263,3.843,9.739,9.045,10.539l277.333,42.667
		c5.823,0.895,11.269-3.099,12.164-8.921c0.082-0.535,0.124-1.076,0.124-1.617V21.377C298.676,18.124,297.199,15.045,294.656,13.014
		z"
				/>
				<path
					fill={color}
					d="M501.334,458.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
		h202.667V74.71H288c-5.891,0-10.667-4.776-10.667-10.667S282.109,53.377,288,53.377h213.333c5.891,0,10.667,4.776,10.667,10.667
		v384C512,453.935,507.225,458.71,501.334,458.71z"
				/>
				<path
					fill={color}
					d="M437.334,394.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
		h149.333c5.891,0,10.667,4.776,10.667,10.667C448,389.935,443.225,394.71,437.334,394.71z"
				/>
				<path
					fill={color}
					d="M437.334,330.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
		h149.333c5.891,0,10.667,4.776,10.667,10.667C448,325.935,443.225,330.71,437.334,330.71z"
				/>
			</g>
			<path
				fill="#FAFAFA"
				d="M96,352.044c-5.891,0-10.667-4.776-10.667-10.667V170.71c0-5.891,4.776-10.667,10.667-10.667h42.667
	c29.455,0,53.333,23.878,53.333,53.333v21.333c0,29.455-23.878,53.333-53.333,53.333h-32v53.333
	C106.667,347.268,101.892,352.044,96,352.044z M106.667,266.71h32c17.673,0,32-14.327,32-32v-21.333c0-17.673-14.327-32-32-32h-32
	V266.71z"
			/>
		</svg>
	);
};

export default PowerpointIcon;
