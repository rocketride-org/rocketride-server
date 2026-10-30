// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// APP TRAIL — which app the user came from, so the sidebar can lead back
//
// One app can open another (a console's "Files" entry switches the shell to
// the Files app). The new app draws its own sidebar, so nothing on screen
// leads back to where the user started; the logo goes Home, which is a
// different place. The trail remembers the apps visited in order, and the
// sidebar offers "Back to <previous app>" while there is one.
//
// Pure functions: the Sidebar owns the state, these decide what it becomes.
// =============================================================================

/** Apps visited in order, oldest first. The last entry is the active app. */
export type AppTrail = readonly string[];

/** Long enough for any real path, short enough that it never grows unbounded. */
const MAX_TRAIL_LENGTH = 20;

/**
 * Records that an app became active.
 *
 * Arriving at Home starts over: Home is the way out of everything, so there
 * is nothing to go back to from it. Arriving at the app one step back is the
 * user going back, so that step is dropped rather than pushed; otherwise
 * "Back" would bounce between the same two apps forever.
 *
 * @param trail - The trail so far.
 * @param appId - The app that just became active.
 * @param homeAppId - This deployment's Home app.
 * @returns The new trail. The same array when nothing changed.
 */
export function recordAppVisit(trail: AppTrail, appId: string, homeAppId: string): AppTrail {
	if (!appId) {
		return trail;
	}
	if (appId === homeAppId) {
		return [appId];
	}

	const lastIndex = trail.length - 1;
	if (trail[lastIndex] === appId) {
		return trail;
	}
	if (trail[lastIndex - 1] === appId) {
		return trail.slice(0, lastIndex);
	}

	const next = [...trail, appId];
	if (next.length > MAX_TRAIL_LENGTH) {
		return next.slice(next.length - MAX_TRAIL_LENGTH);
	}
	return next;
}

/**
 * The app "Back" leads to, if any.
 *
 * Never Home: the logo and the footer already go there, and a second button
 * to the same place would only compete with them.
 *
 * @param trail - The trail so far.
 * @param homeAppId - This deployment's Home app.
 * @returns The previous app's id, or null when there is nowhere to go back to.
 */
export function getReturnAppId(trail: AppTrail, homeAppId: string): string | null {
	if (trail.length < 2) {
		return null;
	}
	const previous = trail[trail.length - 2];
	if (previous === homeAppId) {
		return null;
	}
	return previous;
}
