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
// "YOU ARE LOOKING AT AN OLD VERSION" — said where it cannot be missed
// =============================================================================
// Version pins live in sessionStorage and outlive every reload; a version
// picked once from a store tile keeps serving that snapshot for the life of the
// tab. Bytes are immutable per version, so the pinned app works perfectly — it
// is simply the app as it was, and no error, no failed request and no rebuild
// says otherwise. Days of "my change is not showing" come from this, and the
// only cure is telling the person, on screen, which version they are running.
//
// A chip rather than a banner: it must survive alongside whatever the app draws
// (the bar in the bottom bar exists only when an app declares one), stay out of
// the way, and still be the first thing found when something looks wrong. One
// click clears the pin and reloads onto the server's own answer.

import React, { CSSProperties } from 'react';

import { getStalePin } from '../../util/appLoader';
import { clearAppVersionOverride } from '../../util/versionOverride';

const styles = {
	chip: {
		position: 'fixed',
		right: 12,
		bottom: 10,
		zIndex: 2147483000,
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		maxWidth: 'min(92vw, 420px)',
		padding: '6px 10px',
		borderRadius: 999,
		border: '1px solid var(--rr-color-warning)',
		background: 'color-mix(in srgb, var(--rr-color-warning) 10%, var(--rr-bg-paper))',
		color: 'var(--rr-text-primary)',
		fontSize: 12,
		lineHeight: 1.3,
		boxShadow: '0 2px 10px rgba(0, 0, 0, 0.18)',
	} as CSSProperties,
	text: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	button: {
		appearance: 'none',
		flexShrink: 0,
		border: '1px solid var(--rr-color-warning)',
		borderRadius: 999,
		background: 'transparent',
		color: 'var(--rr-color-warning)',
		cursor: 'pointer',
		fontSize: 12,
		fontWeight: 600,
		padding: '2px 10px',
	} as CSSProperties,
};

/**
 * The pinned-version chip for the app on screen.
 *
 * @param props.appId - The active app, or null when none is mounted.
 * @returns The chip, or null when this app loads the server's own version.
 */
const VersionPinNotice: React.FC<{ appId: string | null }> = ({ appId }) => {
	const pin = appId ? getStalePin(appId) : null;
	if (!pin) return null;

	// Clear and RELOAD rather than repoint: a container that has already
	// loaded is committed to its version for the life of the document (the MF
	// one-document-one-version rule that repointRemote enforces), and the app
	// whose chip this is has by definition loaded.
	const useLatest = () => {
		clearAppVersionOverride(pin.appId);
		window.location.reload();
	};

	return (
		<div style={styles.chip} role="status">
			<span style={styles.text}>
				{pin.name} is pinned to v{pin.pinned} — v{pin.latest} is current
			</span>
			<button type="button" style={styles.button} onClick={useLatest}>
				Use v{pin.latest}
			</button>
		</div>
	);
};

export default VersionPinNotice;
