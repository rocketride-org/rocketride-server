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
 * Extended icon props specific to the Excel icon component.
 * Adds a secondary color option to support the two-tone styling of the
 * Microsoft Excel brand icon.
 *
 * @property secondaryColor - Secondary fill color used for the sidebar/overlay portion of the icon.
 */
interface IExcelIconProps extends IIconProps {
	secondaryColor?: string;
}

/**
 * SVG icon component that renders a Microsoft Excel-style spreadsheet symbol.
 * Used to visually represent Excel/spreadsheet file types (e.g., XLS, XLSX, CSV)
 * in file listings and classification views throughout the application.
 *
 * @param props - Excel icon props including color, secondaryColor, size, style, and opacity.
 */
const ExcelIcon: FunctionComponent<IExcelIconProps> = ({
	color = '#388E3C',
	secondaryColor = '#2E7D32',
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
			<path
				fill="#ECEFF1"
				d="M496,432.011H272c-8.832,0-16-7.168-16-16s0-311.168,0-320s7.168-16,16-16h224
	c8.832,0,16,7.168,16,16v320C512,424.843,504.832,432.011,496,432.011z"
			/>
			<g>
				<path
					fill={color}
					d="M336,176.011h-64c-8.832,0-16-7.168-16-16s7.168-16,16-16h64c8.832,0,16,7.168,16,16
		S344.832,176.011,336,176.011z"
				/>
				<path
					fill={color}
					d="M336,240.011h-64c-8.832,0-16-7.168-16-16s7.168-16,16-16h64c8.832,0,16,7.168,16,16
		S344.832,240.011,336,240.011z"
				/>
				<path
					fill={color}
					d="M336,304.011h-64c-8.832,0-16-7.168-16-16s7.168-16,16-16h64c8.832,0,16,7.168,16,16
		S344.832,304.011,336,304.011z"
				/>
				<path
					fill={color}
					d="M336,368.011h-64c-8.832,0-16-7.168-16-16s7.168-16,16-16h64c8.832,0,16,7.168,16,16
		S344.832,368.011,336,368.011z"
				/>
				<path
					fill={color}
					d="M432,176.011h-32c-8.832,0-16-7.168-16-16s7.168-16,16-16h32c8.832,0,16,7.168,16,16
		S440.832,176.011,432,176.011z"
				/>
				<path
					fill={color}
					d="M432,240.011h-32c-8.832,0-16-7.168-16-16s7.168-16,16-16h32c8.832,0,16,7.168,16,16
		S440.832,240.011,432,240.011z"
				/>
				<path
					fill={color}
					d="M432,304.011h-32c-8.832,0-16-7.168-16-16s7.168-16,16-16h32c8.832,0,16,7.168,16,16
		S440.832,304.011,432,304.011z"
				/>
				<path
					fill={color}
					d="M432,368.011h-32c-8.832,0-16-7.168-16-16s7.168-16,16-16h32c8.832,0,16,7.168,16,16
		S440.832,368.011,432,368.011z"
				/>
			</g>
			<path
				fill={secondaryColor}
				d="M282.208,19.691c-3.648-3.04-8.544-4.352-13.152-3.392l-256,48C5.472,65.707,0,72.299,0,80.011v352
	c0,7.68,5.472,14.304,13.056,15.712l256,48c0.96,0.192,1.952,0.288,2.944,0.288c3.712,0,7.328-1.28,10.208-3.68
	c3.68-3.04,5.792-7.584,5.792-12.32v-448C288,27.243,285.888,22.731,282.208,19.691z"
			/>
			<path
				fill="#FAFAFA"
				d="M220.032,309.483l-50.592-57.824l51.168-65.792c5.44-6.976,4.16-17.024-2.784-22.464
	c-6.944-5.44-16.992-4.16-22.464,2.784l-47.392,60.928l-39.936-45.632c-5.856-6.72-15.968-7.328-22.56-1.504
	c-6.656,5.824-7.328,15.936-1.504,22.56l44,50.304L83.36,310.187c-5.44,6.976-4.16,17.024,2.784,22.464
	c2.944,2.272,6.432,3.36,9.856,3.36c4.768,0,9.472-2.112,12.64-6.176l40.8-52.48l46.528,53.152
	c3.168,3.648,7.584,5.504,12.032,5.504c3.744,0,7.488-1.312,10.528-3.968C225.184,326.219,225.856,316.107,220.032,309.483z"
			/>
		</svg>
	);
};

export default ExcelIcon;
