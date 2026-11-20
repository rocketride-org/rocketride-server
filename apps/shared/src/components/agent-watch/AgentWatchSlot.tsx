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
// AGENT WATCH SLOT — where the agent's copy of an app shows while it works
// =============================================================================

/**
 * One component for both places that show the agent's copy: over the Design preview ('cover') and at the
 * top of the chat ('strip'). It renders only while its place is watching something. Its stage element is
 * lent to the host, which draws the copy over it. The copy takes no clicks, so the stage takes them all,
 * and nothing underneath (the user's own preview, the chat thread) is driven from here.
 *
 * It knows nothing about iframes, scale or z-order: the host (rocket-ui/src/agent/watch.ts) owns those.
 */

import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import type { AgentWatchPlace } from '../../tools/appdev/types';

/** What the slot says. */
const WATCH_TEXT = {
	cover: (app: string): string => `Rocket is using its own copy of ${app}. It closes when Rocket finishes.`,
	back: 'Back to your preview',
	strip: (app: string): string => `Rocket's copy of ${app}`,
	larger: 'Larger',
	smaller: 'Smaller',
} as const;

/** The stage's height in the chat, smaller and larger, in pixels. */
const STRIP_HEIGHT = { smaller: 180, larger: 480 } as const;

const styles: Record<string, CSSProperties> = {
	// Fills previewScreen (position:relative) above the Hand overlay (zIndex 20).
	cover: {
		position: 'absolute',
		inset: 0,
		zIndex: 30,
		display: 'flex',
		flexDirection: 'column',
		background: 'var(--rr-bg-widget)',
	},
	strip: {
		flexShrink: 0,
		display: 'flex',
		flexDirection: 'column',
		background: 'var(--rr-bg-widget)',
		borderBottom: '1px solid var(--rr-border)',
	},
	bar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		padding: '4px 10px',
		minHeight: 34,
		boxSizing: 'border-box',
		background: 'var(--rr-bg-paper)',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	},
	label: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	stage: {
		flex: 1,
		minHeight: 0,
	},
};

export interface AgentWatchSlotProps {
	/** The place this slot is: what it shows, and where it lends its stage. */
	readonly place: AgentWatchPlace;
	/**
	 * cover: fills its positioned parent (DesignView's previewScreen) with a banner and "Back to your
	 * preview". strip: an in-flow block with a label and a Larger/Smaller toggle.
	 */
	readonly variant: 'cover' | 'strip';
}

/** Shows the agent's copy of an app in one place while the agent uses it; renders nothing otherwise. */
export const AgentWatchSlot: React.FC<AgentWatchSlotProps> = ({ place, variant }) => {
	const watching = useSyncExternalStore(place.subscribe, place.watching);
	const [larger, setLarger] = useState(false);
	const unregister = useRef<(() => void) | null>(null);
	// step: the stage is lent while it is mounted; a callback ref, so a remount lends the new element
	const stageRef = useCallback(
		(el: HTMLDivElement | null) => {
			unregister.current?.();
			unregister.current = el ? place.register(el) : null;
		},
		[place]
	);
	if (!watching) return null;

	if (variant === 'cover') {
		return (
			<div style={styles.cover}>
				<div style={styles.bar}>
					<span style={styles.label}>{WATCH_TEXT.cover(watching.appName)}</span>
					<Button variant="secondary" small onClick={place.dismiss}>
						{WATCH_TEXT.back}
					</Button>
				</div>
				<div ref={stageRef} style={styles.stage} />
			</div>
		);
	}
	return (
		<div style={styles.strip}>
			<div style={styles.bar}>
				<span style={styles.label}>{WATCH_TEXT.strip(watching.appName)}</span>
				<Button variant="ghost" small onClick={() => setLarger(!larger)}>
					{larger ? WATCH_TEXT.smaller : WATCH_TEXT.larger}
				</Button>
			</div>
			<div ref={stageRef} style={{ height: STRIP_HEIGHT[larger ? 'larger' : 'smaller'] }} />
		</div>
	);
};
