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

/**
 * Props for the SavedIcon component.
 * Defines the visual customization options for the saved state indicator icon,
 * including color, dimensions, inline styles, and opacity.
 *
 * @property color - Fill color for the floppy disk portion of the icon.
 * @property height - Height of the SVG element as a string value.
 * @property width - Width of the SVG element as a string value.
 * @property style - Inline CSS styles applied to the SVG element.
 * @property opacity - Opacity level of the SVG element, from 0 to 1.
 */
interface ISavedIconProps {
	color?: string;
	height?: string;
	width?: string;
	style?: React.CSSProperties;
	opacity?: number;
}

/**
 * SVG icon component that renders a floppy disk with a green checkmark badge.
 * Used in the canvas toolbar and autosave UI to indicate that the current
 * project or pipeline state has been successfully saved.
 *
 * @param props - SavedIcon props for controlling color, size, style, and opacity.
 */
const SavedIcon: FunctionComponent<ISavedIconProps> = ({
	color = '#757575',
	height = '21',
	width = '24',
	style,
	opacity = 1,
}) => {
	return (
		<svg
			width={width}
			height={height}
			viewBox="0 0 24 21"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			style={style}
			opacity={opacity}
		>
			<path
				d="M18.1538 0C19.0128 8.31398e-05 19.8145 0.384789 20.3521 1.05664L23.3833 4.84766L23.5239 5.03906C23.8324 5.501 23.9995 6.04886 23.9995 6.60547V17.1514C23.9994 18.7046 22.7373 19.9668 21.1841 19.9668H12.5552C12.9397 19.4991 13.2685 18.9841 13.5317 18.4316H18.3687V13.0557C18.3685 12.3503 17.7947 11.7766 17.0894 11.7764H13.4194C13.1311 11.2199 12.7758 10.7042 12.3628 10.2402H17.0903C18.6434 10.2404 19.9057 11.5026 19.9058 13.0557V18.4316H21.1851C21.8906 18.4316 22.4652 17.8579 22.4653 17.1523V6.60645C22.4653 6.3166 22.3664 6.03314 22.1851 5.80664L19.1528 2.01562C18.9081 1.71056 18.5434 1.53618 18.1528 1.53613H17.8569V4.86426C17.8569 5.85298 17.0527 6.65612 16.0649 6.65625H9.92041C8.93176 6.65607 8.12843 5.85197 8.12842 4.86426V1.53613H6.84912C6.14358 1.53613 5.56894 2.10991 5.56885 2.81543V7.82324C5.03567 7.90914 4.52193 8.05291 4.03271 8.24512V2.81543C4.03284 1.26227 5.29593 0 6.84912 0H18.1538ZM9.66455 4.86426C9.66456 5.00624 9.77943 5.11996 9.92041 5.12012H16.0649C16.2069 5.11996 16.3208 5.00528 16.3208 4.86426V1.53613H9.66455V4.86426Z"
				fill={color}
			/>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M12.8822 14.8235C12.8822 11.4124 10.1169 8.64706 6.70577 8.64706C3.29464 8.64706 0.529297 11.4124 0.529297 14.8235C0.529297 18.2347 3.29464 21 6.70577 21C10.1169 21 12.8822 18.2347 12.8822 14.8235ZM9.42374 14.319C9.73836 14.0044 9.73836 13.4944 9.42374 13.1797C9.10911 12.8651 8.5991 12.8651 8.28447 13.1797L6.3586 15.1056C6.25365 15.2104 6.08372 15.2104 5.97877 15.1056L5.12706 14.2539C4.81244 13.9393 4.30242 13.9393 3.9878 14.2539C3.67317 14.5685 3.67317 15.0785 3.9878 15.3932L4.83951 16.2449C5.57359 16.979 6.76377 16.979 7.49786 16.2449L9.42374 14.319Z"
				fill="#00ab06ff"
			/>
		</svg>
	);
};

export default SavedIcon;
