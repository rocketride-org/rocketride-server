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


import { forwardRef, Ref } from 'react';
import clsx from 'clsx';
import { Typography } from '@mui/material';

import { useStyles } from './RocketRideLogoIcon.style';
import theme from '../../../theme';

/**
 * Enumeration of available animation modes for the RocketRide logo icon.
 * Each mode triggers a distinct CSS animation defined in the companion style file,
 * providing visual feedback for different application states (loading, connecting, idle).
 */
// eslint-disable-next-line react-refresh/only-export-components
export enum ICON_ANIMATION {
	/** Puzzle piece slides in and the logo gradient transitions to orange. */
	infuse = 'infuse',
	/** Puzzle piece rotates 180 degrees, fades out, then loops a slide-in animation. */
	plugIn = 'plugIn',
	/** Puzzle piece fades out and loops a slide-in animation without the initial rotation. */
	plugOut = 'plugOut',
	/** No animation; the logo is rendered in its default static state. */
	none = 'none',
}

/**
 * Props for the {@link RocketRideLogoIcon} component.
 * Controls the animation mode, dimensions, optional loading text, and click behaviour.
 */
interface RocketRideLogoLoadingIconProps {
	/** Which animation to play on the logo icon. Defaults to 'none'. */
	animation?: ICON_ANIMATION;
	/** Additional CSS class name(s) to apply to the root wrapper div. */
	className?: string;
	/** Width of the SVG element. Accepts CSS units or a number (pixels). */
	width?: number | string;
	/** Height of the SVG element. Accepts CSS units or a number (pixels). */
	height?: number | string;
	/** Optional text displayed below the icon, typically used for loading status messages. */
	loadingMessage?: string;
	/** Click handler for the icon. When provided, the icon shows a pointer cursor. */
	onClick?: () => void;
}

/** Default SVG viewBox value for the RocketRide logo, providing padding around the paths. */
const defaultViewBox = '-13 -13 145 145';

/**
 * Animated RocketRide logo icon component with forwarded ref support.
 * Renders the brand logo as an inline SVG with configurable animation states
 * (infuse, plugIn, plugOut, none). Used as a loading indicator, splash graphic,
 * and branding element throughout the application. An optional loading message
 * is displayed beneath the icon when provided.
 */
const RocketRideLogoIcon = forwardRef(
	(
		{
			animation = ICON_ANIMATION.none,
			className,
			width,
			height,
			loadingMessage,
			onClick,
			...props
		}: RocketRideLogoLoadingIconProps,
		ref: Ref<HTMLDivElement>
	) => {
		const classes = useStyles();

		// Resolve the CSS animation class names and SVG viewBox for the requested animation type.
		// Each animation mode applies different keyframe classes to the "missing piece" and
		// "missing square" SVG paths; the default fallback uses the "closed" state.
		const setAnimationStyles = (animationType: ICON_ANIMATION) => {
			switch (animationType) {
				case ICON_ANIMATION.plugIn:
					// Rotate-and-slide animation for the puzzle piece; no square animation
					return {
						missingPiece: classes.plugInMissingPiece,
						missingSquare: undefined,
						viewBox: defaultViewBox,
					};
				case ICON_ANIMATION.plugOut:
					// Fade-out-and-loop animation for the puzzle piece
					return {
						missingPiece: classes.plugOutMissingPiece,
						missingSquare: undefined,
						viewBox: defaultViewBox,
					};
				case ICON_ANIMATION.infuse:
					// Both the puzzle piece and the gradient square animate during infuse
					return {
						missingPiece: classes.infuseMissingPiece,
						missingSquare: classes.infuseMissingSquare,
						viewBox: defaultViewBox,
					};
				case ICON_ANIMATION.none:
					// Static state -- no animation classes applied
					return {
						missingPiece: undefined,
						missingSquare: undefined,
						viewBox: defaultViewBox,
					};
				default:
					// Unknown animation type falls back to the "closed" static class
					return {
						missingPiece: classes.closed,
						missingSquare: undefined,
						viewBox: defaultViewBox,
					};
			}
		};

		const animationStyles = setAnimationStyles(animation);

		return (
			<div
				{...props}
				className={clsx(classes.root, className)}
				ref={ref}
				onClick={onClick}
				style={onClick ? { cursor: 'pointer' } : {}}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width={width ?? '2.2rem'}
					height={height ?? '2.2rem'}
					viewBox={animationStyles.viewBox}
					version="1.1"
				>
					<linearGradient
						className={animationStyles.missingSquare}
						id="orangeGradient"
						x1="0.03"
						y1="0.68"
						x2="0.97"
						y2="0.32"
					>
						<stop offset="0%" stopColor={theme.palette.grey['800']} />
						<stop offset="50%" stopColor={theme.palette.grey['800']} />
					</linearGradient>
					<path
						d="M 5.763 15.565 C -0.042 18.715 0 18.298 0 73 C 0 115.825 0.22 123.525 1.517 126.033 C 4.635 132.062 4.035 132 59.046 132 C 104.21 132 109.474 131.833 112.035 130.32 C 117.787 126.922 118.132 124.989 118 98 L 118 73 L 110 73 L 101 72.919 L 101 93.96 L 101 115 L 59 115 L 17 115 L 17 73.02 L 17 31.041 L 38 31 L 59 31 L 59 22 L 59.081 14 L 33.79 14.04 C 13.373 14.072 7.973 14.366 5.763 15.565"
						fill="url(#orangeGradient)"
					/>
					<path
						d="M 74 7 L 74 16 L 95 15.7 L 116 15.7 L 116 36 L 116 59 L 124 59 L 132.8 59 L 132.8 34 C 132.8 22 133 10 131.96 7.795 C 131.394 5.758 129.761 3.171 128.331 2.045 C 126 -1 125 -1 100 -1 L 74 -1 L 74 7"
						stroke="none"
						fill="#f58d1c"
						fillRule="evenodd"
						className={animationStyles.missingPiece}
					/>
				</svg>
				{loadingMessage && (
					<Typography variant="body2" sx={{ mt: '2rem' }}>
						{loadingMessage}
					</Typography>
				)}
			</div>
		);
	}
);

export default RocketRideLogoIcon;
