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

/**
 * Props for the UnsavedIcon component.
 * Defines the visual customization options for the unsaved state indicator icon,
 * including color, dimensions, inline styles, and opacity.
 *
 * @property color - Fill color for the icon, defaults to an orange warning tone.
 * @property height - Height of the SVG element as a string value.
 * @property width - Width of the SVG element as a string value.
 * @property style - Inline CSS styles applied to the SVG element.
 * @property opacity - Opacity level of the SVG element, from 0 to 1.
 */
interface IUnsavedIconProps {
	color?: string;
	height?: string;
	width?: string;
	style?: React.CSSProperties;
	opacity?: number;
}

/**
 * SVG icon component that renders a floppy disk in an orange/warning color.
 * Used in the canvas toolbar and autosave UI to indicate that the current
 * project or pipeline state has unsaved changes that need to be persisted.
 *
 * @param props - UnsavedIcon props for controlling color, size, style, and opacity.
 */
const UnsavedIcon: FunctionComponent<IUnsavedIconProps> = ({
	color = '#FF9200',
	height = '20',
	width = '20',
	style,
	opacity = 1,
}) => {
	return (
		<svg
			width={width}
			height={height}
			viewBox="0 0 20 20"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			style={style}
			opacity={opacity}
		>
			<path
				d="M19.3827 4.85607L16.346 1.05871C15.8075 0.385594 15.0046 0 14.144 0H2.82032C1.26448 0 0 1.26448 0 2.82032V17.1797C0 18.7355 1.26448 20 2.82032 20H17.1797C18.7355 20 20 18.7355 20 17.1797V6.61669C20 5.97917 19.7808 5.35317 19.3817 4.8541L19.3827 4.85607ZM12.3084 1.53849V4.87231C12.3084 5.01367 12.1939 5.12907 12.0516 5.12907H5.89747C5.75612 5.12907 5.64072 5.01464 5.64072 4.87231V1.53849H12.3084ZM14.3594 18.4624H5.64171V13.0775C5.64171 12.3708 6.21673 11.7957 6.92349 11.7957H13.0776C13.7844 11.7957 14.3594 12.3708 14.3594 13.0775V18.4624Z"
				fill={color}
			/>
		</svg>
	);
};

export default UnsavedIcon;
