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
// STATUS BAR — bottom shell bar: connection identity + app slot + status
// =============================================================================

import React, { CSSProperties } from 'react';
import type { ReactNode } from 'react';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	bar: {
		height: '32px',
		flexShrink: 0,
		backgroundColor: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-secondary)',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '0 12px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
	left: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	// App-declared content region — flexible middle, clipped, never pushes the
	// shell-owned identity (left) or status (right) sections out of the bar.
	app: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, overflow: 'hidden', padding: '0 12px' } as CSSProperties,
	right: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	dot: (state: ConnectionState): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: DOT_TOKENS[state],
		display: 'inline-block',
	}),
	readyLabel: (connected: boolean): CSSProperties => ({
		color: connected ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		fontWeight: 600,
	}),
};

// =============================================================================
// Types
// =============================================================================

/** The identity section's three states: a signed-in session with a live
 *  socket, a session with no identity at all, and a signed-in session whose
 *  socket is down. */
type ConnectionState = 'connected' | 'signedOut' | 'disconnected';

/** Dot color per state: green / yellow / red. */
const DOT_TOKENS: Record<ConnectionState, string> = {
	connected: 'var(--rr-color-success)',
	signedOut: 'var(--rr-color-warning)',
	disconnected: 'var(--rr-color-error)',
};

/** Identity label per state. */
const STATE_LABELS: Record<ConnectionState, string> = {
	connected: 'Connected',
	signedOut: 'Not signed in',
	disconnected: 'Not connected',
};

interface StatusBarProps {
	appName: string;
	isConnected: boolean;
	/** Whether the session has a signed-in identity — picks the identity
	 *  section's state together with isConnected. */
	isAuthenticated: boolean;
	statusMessage: string | null;
	onToggleBottomPanel: () => void;
	/** App-declared content (via useStatusBarContent), mounted between the
	    connection identity and the shell status message. */
	appContent?: ReactNode | null;
}

// =============================================================================
// Component
// =============================================================================

/**
 * The shell's bottom status bar: connection identity on the left, the active
 * app's registered content in the flexible middle, shell status on the right.
 *
 * @param props - See {@link StatusBarProps}.
 */
const StatusBar: React.FC<StatusBarProps> = ({ appName, isConnected, isAuthenticated, statusMessage, onToggleBottomPanel, appContent }) => {
	// The identity section always renders — a hidden indicator reads as a bug
	// and silently masks the anonymous-session state. Signed-out wins over
	// disconnected: an anonymous session has no socket to be "down".
	const state: ConnectionState = !isAuthenticated ? 'signedOut' : isConnected ? 'connected' : 'disconnected';
	return (
		<div style={styles.bar}>
			<div style={styles.left}>
				<span style={{ cursor: 'pointer' }} onClick={onToggleBottomPanel}>{appName}</span>
				<span style={styles.dot(state)} />
				<span>{STATE_LABELS[state]}</span>
			</div>
			{/* App slot — present only when the active app registered content. */}
			{appContent != null && <div style={styles.app}>{appContent}</div>}
			<div style={styles.right}>
				{isAuthenticated && (
					<>
						{statusMessage && <span>{statusMessage}</span>}
						<span style={styles.readyLabel(isConnected)}>
							{isConnected ? 'Ready' : 'Offline'}
						</span>
					</>
				)}
			</div>
		</div>
	);
};

export default StatusBar;
