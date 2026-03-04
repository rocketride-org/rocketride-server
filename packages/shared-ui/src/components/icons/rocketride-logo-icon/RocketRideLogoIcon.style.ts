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

import makeStyles from '@mui/styles/makeStyles';
import pxToRem from '../../../utils/pxToRem';

// **** Animation Timing
// Change the value of `infuseAnimationDuration`
// if you want to speed up or slow down the animation

/** Duration in ms for the infuse slide-in animation cycle. */
const infuseSlideInDuration = 3000;
/** Duration in ms for the infuse orange color-change animation cycle. */
const infuseOrangeDuration = 3000;

// ** Infuse animation
// Edit with great caution

/** Delay for the first gradient stop animation, calculated as a fraction of the slide-in duration. */
const firstStopAnimationDelay = infuseSlideInDuration * 0.1667;
/** Delay for the second gradient stop animation, slightly after the first stop. */
const secondStopAnimationDelay = firstStopAnimationDelay + 300;

// ** Plug In animation

/** Delay in ms before the plug-in rotation animation begins. */
const plugInRotateDelay = 300;
/** Duration in ms for the plug-in rotation animation. */
const plugInRotateAnimationDuration = 1000;
/** Duration in ms for the plug-in fade-out animation. */
const plugInFadeOutAnimationDuration = 1000;
/** Duration in ms for the repeating plug-in slide-and-fade-out animation cycle. */
const plugInSlideAndFadeOutRepeatDuration = 2400;

/**
 * MUI makeStyles hook for the RocketRideLogoIcon component.
 * Defines keyframe animations and CSS classes for the logo's multiple animation
 * states: infuse (puzzle-piece slides in with color change), plugIn (rotates then
 * loops), plugOut (slides and fades without rotation), and closed (static offset).
 * These animations provide visual loading/connection feedback in the application.
 */
export const useStyles = makeStyles({
	root: {
		display: 'flex',
		flexDirection: 'column',
	},
	// Infuse animation
	infuseMissingPiece: {
		animation: `$slideIn ${infuseSlideInDuration}ms cubic-bezier(0.445, 0.05, 0.55, 0.95) infinite`,
		animationPlayState: 'linear',
	},
	infuseMissingSquare: {
		'& stop:nth-of-type(2)': {
			// this is the one on top and closest to the .missingPiece
			animation: `$infuseOrange ${infuseOrangeDuration}ms infinite`,
			animationDelay: `${firstStopAnimationDelay}ms`,
		},
		'& stop:first-of-type': {
			animation: `$infuseOrange ${infuseOrangeDuration}ms infinite`,
			animationDelay: `${secondStopAnimationDelay}ms`,
		},
	},
	'@keyframes slideIn': {
		'0%, 100%': {
			transform: 'translate(0, 0)', // out
		},
		'16.67%, 66.67%': {
			transform: `translate(-${pxToRem(15)}rem, ${pxToRem(15)}rem)`, // in
		},
	},
	// Fade In Animation
	'@keyframes infuseOrange': {
		'0%, 100%': {
			stopColor: 'theme.grey.800',
		},
		'16.67%, 56%': {
			stopColor: 'theme.primary',
		},
	},
	// Plug In animation
	plugInMissingPiece: {
		transformOrigin: '96px 37px',
		animation: `$rotate ${plugInRotateAnimationDuration}ms ease-in ${plugInRotateDelay}ms forwards,
		$fadeOut ${plugInFadeOutAnimationDuration}ms cubic-bezier(0.445, 0.05, 0.55, 0.95) ${plugInRotateDelay + plugInRotateAnimationDuration}ms forwards,
		$rotateAndSlideAndFadeOutRepeat ${plugInSlideAndFadeOutRepeatDuration}ms cubic-bezier(0.445, 0.05, 0.55, 0.95) ${plugInRotateDelay + plugInFadeOutAnimationDuration + plugInRotateAnimationDuration}ms infinite`,
	},
	// Plug Out animation
	plugOutMissingPiece: {
		transformOrigin: '96px 37px',
		animation: `
		$fadeOut ${plugInFadeOutAnimationDuration}ms cubic-bezier(0.445, 0.05, 0.55, 0.95) ${plugInRotateDelay + plugInRotateAnimationDuration}ms forwards,
		$slideAndFadeOutRepeat ${plugInSlideAndFadeOutRepeatDuration}ms cubic-bezier(0.445, 0.05, 0.55, 0.95) ${plugInRotateDelay + plugInFadeOutAnimationDuration + plugInRotateAnimationDuration}ms infinite`,
	},
	// Closed state
	closed: {
		transform: 'translate(-15px, 14px)',
	},
	'@keyframes rotate': {
		'0%': {
			transform: 'rotate(0)',
		},
		'100%': {
			transform: 'rotate(-180deg)',
		},
	},
	'@keyframes fadeOut': {
		'0%': {
			opacity: 1,
		},
		'52%': {
			opacity: 1,
		},
		'100%': {
			opacity: 0,
		},
	},
	'@keyframes rotateAndSlideAndFadeOutRepeat': {
		'0%': {
			opacity: 0,
			transform: `rotate(-180deg) translate(-${pxToRem(14.45)}rem, ${pxToRem(14.45)}rem)`, // out
		},
		'30%': {
			opacity: 1,
			transform: `rotate(-180deg) translate(-${pxToRem(14.45)}rem, ${pxToRem(14.45)}rem)`, // out
		},
		'60%': {
			opacity: 1,
			transform: 'rotate(-180deg) translate(0, 0)', // in
		},
		'80%': {
			opacity: 1,
		},
		'100%': {
			opacity: 0,
			transform: 'rotate(-180deg) translate(0, 0)',
		},
	},
	'@keyframes slideAndFadeOutRepeat': {
		'0%': {
			opacity: 0,
			transform: `translate(-${pxToRem(14.45)}rem, ${pxToRem(14.45)}rem)`, // out
		},
		'30%': {
			opacity: 1,
			transform: `translate(-${pxToRem(14.45)}rem, ${pxToRem(14.45)}rem)`, // out
		},
		'60%': {
			opacity: 1,
			transform: 'translate(0, 0)', // in
		},
		'80%': {
			opacity: 1,
		},
		'100%': {
			opacity: 0,
			transform: 'translate(0, 0)',
		},
	},
});
