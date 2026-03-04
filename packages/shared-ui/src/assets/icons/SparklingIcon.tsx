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
 * Extended icon props specific to the SparklingIcon component.
 * Adds an option to adjust spacing when the icon is used as a label decorator,
 * applying a right margin so the icon visually pairs with adjacent text.
 *
 * @property isLabelDecorator - When true, adds a right margin to the icon for use alongside label text.
 */
interface SparklingIconProps extends IIconProps {
	isLabelDecorator?: boolean;
}

/**
 * SVG icon component that renders three star-burst sparkle shapes of varying sizes.
 * Used to visually indicate AI-powered or generative features, highlights,
 * or premium functionality throughout the application UI.
 *
 * @param props - SparklingIcon props including standard icon props and isLabelDecorator.
 */
const SparklingIcon: FunctionComponent<SparklingIconProps> = ({
	height = '20',
	style,
	width = '20',
	opacity = 1,
	color,
	className,
	isLabelDecorator,
}) => {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 64 64"
			height={height}
			width={width}
			style={{
				marginRight: isLabelDecorator ? '0.5rem' : 'inherit',
				...style,
			}}
			opacity={opacity}
			color={color}
			className={className}
		>
			<path
				fill={color}
				d="m24 4 5.303 9.697 9.697 5.303-9.697 5.303-5.303 9.697-5.303-9.697-9.697-5.303 9.697-5.303z"
			/>
			<path
				fill={color}
				d="m45 29 3.536 6.464 6.464 3.536-6.464 3.536-3.536 6.464-3.536-6.464-6.464-3.536 6.464-3.536z"
			/>
			<path
				fill={color}
				d="m24 50 1.768 3.232 3.232 1.768-3.232 1.768-1.768 3.232-1.768-3.232-3.232-1.768 3.232-1.768z"
			/>
		</svg>
	);
};

export default SparklingIcon;
