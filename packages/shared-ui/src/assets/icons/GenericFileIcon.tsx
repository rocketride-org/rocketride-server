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
 * SVG icon component that renders a generic document with text lines.
 * Used as a fallback icon to represent file types that do not have a specific
 * dedicated icon, providing a universal file visual in listings and classification views.
 *
 * @param props - Standard icon props for controlling size, style, and opacity.
 */
const GenericFileIcon: FunctionComponent<IIconProps> = ({
	height = '20',
	style,
	width = '20',
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
			<path
				d="m404.714 512h-297.428c-23.466 0-42.49-19.023-42.49-42.49v-427.02c.001-23.467 19.024-42.49 42.49-42.49h195.003c10.862 0 21.311 4.16 29.201 11.624l102.424 96.899c8.483 8.025 13.289 19.188 13.289 30.866v330.121c0 23.467-19.023 42.49-42.489 42.49z"
				fill="#9ABCF8"
			/>
			<path
				d="m433.914 108.523-102.424-96.899c-7.89-7.465-18.339-11.624-29.201-11.624h-46.289v512h148.714c23.466 0 42.49-19.023 42.49-42.49v-330.121c-.001-11.678-4.807-22.84-13.29-30.866z"
				fill="#9ABCF8"
			/>
			<path
				d="m334.606 127.469h110.878c-2.094-7.161-6.046-13.72-11.569-18.946l-102.425-96.899c-5.15-4.873-11.395-8.326-18.129-10.144v104.744c0 11.733 9.512 21.245 21.245 21.245z"
				fill="#607caf"
			/>
			<g fill="#fff">
				<path d="m380.4 230h-248.8c-8.616 0-15.6-6.716-15.6-15s6.984-15 15.6-15h248.8c8.616 0 15.6 6.716 15.6 15s-6.984 15-15.6 15z" />
				<path d="m380.4 310h-248.8c-8.616 0-15.6-6.716-15.6-15s6.984-15 15.6-15h248.8c8.616 0 15.6 6.716 15.6 15s-6.984 15-15.6 15z" />
				<path d="m217.229 390h-85.629c-8.616 0-15.6-6.716-15.6-15s6.984-15 15.6-15h85.629c8.616 0 15.6 6.716 15.6 15s-6.985 15-15.6 15z" />
			</g>
			<path
				d="m396 215c0-8.284-6.984-15-15.6-15h-124.4v30h124.4c8.616 0 15.6-6.716 15.6-15z"
				fill="#fff"
			/>
			<path
				d="m380.4 280h-124.4v30h124.4c8.616 0 15.6-6.716 15.6-15s-6.984-15-15.6-15z"
				fill="#fff"
			/>
		</svg>
	);
};

export default GenericFileIcon;
