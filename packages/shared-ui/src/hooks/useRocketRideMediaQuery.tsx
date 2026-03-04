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

import { useMediaQuery } from '@mui/material';
import theme from '../theme';

/**
 * Hook that provides pre-configured Material UI media query breakpoints for responsive layouts.
 * Wraps MUI's `useMediaQuery` with the application's theme breakpoints so components
 * can adapt their layout without manually referencing breakpoint values.
 *
 * @returns An object with boolean flags indicating current viewport size relative to standard breakpoints.
 */
export function useRocketRideMediaQuery() {
	// Evaluate each breakpoint against the app theme; these are live CSS media query subscriptions
	// that re-render the consuming component when the viewport crosses a threshold.
	const belowMediumBreakpoint = useMediaQuery(theme.breakpoints.down('md'));
	const aboveMediumBreakpoint = useMediaQuery(theme.breakpoints.up('md'));
	const belowLargeBreakpoint = useMediaQuery(theme.breakpoints.down('lg'));
	const aboveLargeBreakpoint = useMediaQuery(theme.breakpoints.up('lg'));
	const belowXLargeBreakpoint = useMediaQuery(theme.breakpoints.down('xl'));

	// Expose named booleans so consumers don't need to know the raw pixel values
	return {
		screenIsBelowMedium: belowMediumBreakpoint, // Below 'md' breakpoint (900px)
		screenIsAboveMedium: aboveMediumBreakpoint, // Above 'md' breakpoint (900px)
		screenIsBelowLarge: belowLargeBreakpoint, // Below 'lg' breakpoint (1200px)
		screenIsAboveLarge: aboveLargeBreakpoint, // Above 'lg' breakpoint (1200px)
		screenIsBelowXLarge: belowXLargeBreakpoint, // Below 'xl' breakpoint (1536px)
	};
}
