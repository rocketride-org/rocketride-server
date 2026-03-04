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

/**
 * Common props shared by all custom SVG icon components in the shared-ui icon library.
 * Provides a consistent API for controlling the appearance and layout of icons
 * across the application, including color, dimensions, and opacity.
 *
 * @property color - Fill color applied to the SVG paths.
 * @property className - CSS class name for external styling.
 * @property height - Height of the SVG element, accepts a number or string value.
 * @property style - Inline CSS styles applied to the SVG element.
 * @property width - Width of the SVG element, accepts a number or string value.
 * @property opacity - Opacity level of the SVG element, from 0 (transparent) to 1 (opaque).
 */
export interface IIconProps {
	color?: string;
	className?: string;
	height?: number | string;
	style?: React.CSSProperties;
	width?: number | string;
	opacity?: number;
}
