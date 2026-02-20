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
import { grey } from '@mui/material/colors';

/**
 * SVG icon component that renders a curved arrow pointing to the left (undo arrow).
 * Used in the canvas toolbar and UI controls to represent undo actions or
 * backward navigation within the application workflow.
 *
 * @param props - Standard icon props for controlling color and style.
 */
const CurveArrowIcon: FunctionComponent<IIconProps> = ({ color = grey[500], style }) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="22"
			height="19"
			viewBox="0 0 22 19"
			fill="none"
			style={style}
		>
			<path
				d="M5.6171 19C5.23508 19 4.91463 18.8749 4.65575 18.6246C4.39777 18.3751 4.26878 18.0658 4.26878 17.6964C4.26878 17.327 4.39777 17.0177 4.65575 16.7682C4.91463 16.5179 5.23508 16.3928 5.6171 16.3928H13.8418C15.2575 16.3928 16.4877 15.9583 17.5322 15.0892C18.5775 14.2201 19.1002 13.1338 19.1002 11.8302C19.1002 10.5266 18.5775 9.44025 17.5322 8.57118C16.4877 7.70212 15.2575 7.26758 13.8418 7.26758H5.34744L7.90923 9.74442C8.15643 9.98342 8.28002 10.2876 8.28002 10.6569C8.28002 11.0263 8.15643 11.3305 7.90923 11.5695C7.66204 11.8085 7.34744 11.928 6.96541 11.928C6.58339 11.928 6.26879 11.8085 6.02159 11.5695L1.16766 6.8765C1.03283 6.74614 0.937099 6.60492 0.88047 6.45283C0.82474 6.30074 0.796875 6.13779 0.796875 5.96398C0.796875 5.79017 0.82474 5.62722 0.88047 5.47513C0.937099 5.32304 1.03283 5.18182 1.16766 5.05146L6.02159 0.35849C6.26879 0.119496 6.58339 0 6.96541 0C7.34744 0 7.66204 0.119496 7.90923 0.35849C8.15643 0.597484 8.28002 0.901658 8.28002 1.27101C8.28002 1.64037 8.15643 1.94454 7.90923 2.18353L5.34744 4.66038H13.8418C16.0216 4.66038 17.8926 5.34477 19.4549 6.71355C21.0162 8.08233 21.7969 9.78788 21.7969 11.8302C21.7969 13.8725 21.0162 15.578 19.4549 16.9468C17.8926 18.3156 16.0216 19 13.8418 19H5.6171Z"
				fill={color}
			/>
		</svg>
	);
};

export default CurveArrowIcon;
