// =============================================================================
// MIT License
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
// SQL-UI — LIVE REGION (one polite announcer for the whole app)
// =============================================================================

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { getAnnouncement, subscribeAnnouncements } from '../a11y/announce';

// =============================================================================
// TIMING
// =============================================================================

/**
 * How long the region stays empty before the new sentence is put back.
 *
 * The clear and the restore must land in DIFFERENT tasks: a removal and an
 * insertion inside one commit can be coalesced into "no change" by the time
 * assistive technology reads the accessibility tree, which is exactly how a
 * repeated sentence goes unspoken.
 */
const RESTORE_DELAY_MS = 50;

// =============================================================================
// STYLES
// =============================================================================

/**
 * Visually hidden but readable: clipped to a 1px box rather than
 * `display: none` or `visibility: hidden`, both of which remove the element
 * from the accessibility tree and would silence it.
 */
const hidden: CSSProperties = {
	position: 'absolute',
	width: 1,
	height: 1,
	margin: -1,
	padding: 0,
	border: 0,
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	clipPath: 'inset(50%)',
	whiteSpace: 'nowrap',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The app's single polite live region. Mounted once by `SqlApp`; every
 * `announce()` call anywhere in the app lands here.
 *
 * Every announcement — including a REPEAT of the sentence already showing —
 * empties the region and puts the text back a task later. Replacing the node
 * in one commit (by keying it on the revision) is not enough: the removal and
 * the insertion can be coalesced before the accessibility tree is read, and a
 * repeated sentence then goes unspoken. A newer announcement cancels a
 * restore still pending for the previous one, so only the latest is voiced.
 *
 * @returns The live region element.
 */
export const LiveRegion: React.FC = () => {
	const announcement = useSyncExternalStore(subscribeAnnouncements, getAnnouncement, getAnnouncement);
	const [spoken, setSpoken] = useState('');
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		// Empty first, in this commit; the text returns in a later task.
		setSpoken('');
		if (announcement.text === '') return undefined;
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			setSpoken(announcement.text);
		}, RESTORE_DELAY_MS);
		// Runs before the next announcement's setup, which is how a pending
		// restore is cancelled.
		return () => {
			if (timerRef.current === null) return;
			clearTimeout(timerRef.current);
			timerRef.current = null;
		};
	}, [announcement.revision, announcement.text]);

	return (
		<div style={hidden} aria-live="polite" aria-atomic="true" role="status">
			<span>{spoken}</span>
		</div>
	);
};

export default LiveRegion;
