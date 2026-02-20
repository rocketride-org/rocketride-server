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
 * SVG icon component that renders a Microsoft Word-style document symbol.
 * Used to visually represent Word/document file types (e.g., DOC, DOCX)
 * in file listings and classification views throughout the application.
 *
 * @param props - Standard icon props for controlling color, size, style, and opacity.
 */
const WordIcon: FunctionComponent<IIconProps> = ({
	color = '#1565C0',
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
					style={{ fill: color }}
					d="M294.656,13.014c-2.531-2.056-5.863-2.842-9.045-2.133l-277.333,64
   C3.397,76.003-0.047,80.369,0,85.377v362.667c0.002,5.263,3.843,9.739,9.045,10.539l277.333,42.667
   c5.823,0.895,11.269-3.099,12.164-8.921c0.082-0.535,0.124-1.076,0.124-1.617V21.377C298.676,18.124,297.199,15.045,294.656,13.014
   z"
				/>
				<path
					style={{ fill: color }}
					d="M501.334,458.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
   h202.667V74.71H288c-5.891,0-10.667-4.776-10.667-10.667S282.109,53.377,288,53.377h213.333c5.891,0,10.667,4.776,10.667,10.667
   v384C512,453.935,507.225,458.71,501.334,458.71z"
				/>
			</g>
			<path
				style={{ fill: '#FAFAFA' }}
				d="M181.334,352.044c-4.753-0.005-8.928-3.155-10.24-7.723L138.667,230.87L106.24,344.321
c-2.342,5.661-8.83,8.352-14.492,6.01c-2.722-1.126-4.884-3.288-6.01-6.01L43.072,194.988c-1.786-5.614,1.318-11.612,6.932-13.398
c5.614-1.786,11.612,1.318,13.398,6.932c0.063,0.198,0.12,0.398,0.172,0.599L96,302.55L128.427,189.1
c2.342-5.661,8.83-8.352,14.492-6.01c2.722,1.126,4.884,3.288,6.01,6.01l32.405,113.451l32.427-113.429
c1.535-5.614,7.331-8.921,12.945-7.386c0.08,0.022,0.159,0.045,0.239,0.068c5.66,1.622,8.935,7.523,7.317,13.184l-42.667,149.333
C190.281,348.897,186.094,352.048,181.334,352.044z"
			/>
			<g>
				<path
					style={{ fill: color }}
					d="M458.667,138.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
   h170.667c5.891,0,10.667,4.776,10.667,10.667C469.334,133.935,464.558,138.71,458.667,138.71z"
				/>
				<path
					style={{ fill: color }}
					d="M458.667,202.71H288c-5.891,0-10.667-4.776-10.667-10.667s4.776-10.667,10.667-10.667h170.667
   c5.891,0,10.667,4.776,10.667,10.667S464.558,202.71,458.667,202.71z"
				/>
				<path
					style={{ fill: color }}
					d="M458.667,266.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
   h170.667c5.891,0,10.667,4.776,10.667,10.667C469.334,261.935,464.558,266.71,458.667,266.71z"
				/>
				<path
					style={{ fill: color }}
					d="M458.667,330.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
   h170.667c5.891,0,10.667,4.776,10.667,10.667C469.334,325.935,464.558,330.71,458.667,330.71z"
				/>
				<path
					style={{ fill: color }}
					d="M458.667,394.71H288c-5.891,0-10.667-4.776-10.667-10.667c0-5.891,4.776-10.667,10.667-10.667
   h170.667c5.891,0,10.667,4.776,10.667,10.667C469.334,389.935,464.558,394.71,458.667,394.71z"
				/>
			</g>
		</svg>
	);
};

export default WordIcon;
