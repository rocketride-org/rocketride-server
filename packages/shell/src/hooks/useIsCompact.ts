/**
 * useIsCompact — is the window too narrow for a permanent sidebar?
 *
 * The shell's sidebar is an in-flow column 260px wide by default and draggable
 * to 480. On a phone that is most of the screen, and on a tablet it is a third
 * of it: an app mounted beside it gets a box no arrangement of controls
 * survives. Below the breakpoint the sidebar becomes an overlay drawer instead,
 * and this is the one place that decides when.
 *
 * ONE OWNER. `ShellLayout` calls this and hands the boolean down. Two
 * components subscribing to the same media query can disagree for a frame while
 * a window is dragged across the boundary, and a sidebar that thinks it is a
 * drawer while the layout thinks it is a column is a blank screen.
 *
 * The threshold is exported because nothing else may hardcode it — before this
 * hook there was no media query anywhere in the shell, and the way that stays
 * true is by there being one number to import.
 */

import { useEffect, useState } from 'react';

/** Below this width, in CSS pixels, the sidebar is a drawer. */
export const COMPACT_BREAKPOINT_PX = 1024;

/**
 * `1023.98`, not `1023`. A viewport can be a fractional width — browser zoom
 * and hidpi scaling both produce them — and `max-width: 1023px` leaves 1023.5
 * matching neither this query nor its `min-width: 1024px` counterpart.
 */
const COMPACT_QUERY = `(max-width: ${COMPACT_BREAKPOINT_PX - 0.02}px)`;

/**
 * Whether the viewport is narrower than a permanent sidebar deserves.
 *
 * @returns True below the breakpoint, false at or above it.
 */
export function useIsCompact(): boolean {
	const [compact, setCompact] = useState(
		() => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches,
	);

	useEffect(() => {
		if (typeof window === 'undefined') return undefined;
		const mql = window.matchMedia(COMPACT_QUERY);
		const onChange = (event: MediaQueryListEvent | MediaQueryList) => setCompact(event.matches);

		// Read once on mount as well as subscribing: a resize between the initial
		// state and this effect would otherwise be missed for good.
		onChange(mql);

		if (typeof mql.addEventListener === 'function') {
			mql.addEventListener('change', onChange);
			return () => mql.removeEventListener('change', onChange);
		}
		// Safari below 14 and any WebKit embedded in an older desktop shell.
		mql.addListener(onChange);
		return () => mql.removeListener(onChange);
	}, []);

	return compact;
}
