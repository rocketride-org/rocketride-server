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
// HELLO APP — minimal demo component
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'flex-start',
		paddingTop: 100,
		height: '100%',
		fontFamily: 'var(--rr-font-family)',
		backgroundColor: 'var(--rr-bg-default)',
		color: 'var(--rr-text-primary)',
		gap: 16,
	} as CSSProperties,
	title: {
		fontSize: 48,
		fontWeight: 800,
		letterSpacing: -1,
	} as CSSProperties,
	subtitle: {
		fontSize: 16,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	status: {
		fontSize: 13,
		color: 'var(--rr-text-tertiary, #888)',
		marginTop: 24,
	} as CSSProperties,
	dot: (connected: boolean): CSSProperties => ({
		display: 'inline-block',
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: connected ? 'var(--rr-color-success, #22c55e)' : 'var(--rr-color-error, #ef4444)',
		marginRight: 6,
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Hello World demo app — renders a centered greeting with connection status.
 *
 * @param props.isConnected - Whether the RocketRide WebSocket is connected.
 * @param props.identity    - Authenticated user identity, or null.
 */
const HelloApp: React.FC<ShellAppProps> = ({ isConnected, identity }) => {
	return (
		<div style={styles.container}>
			<div style={styles.title}>Hello World!</div>
			<div style={styles.subtitle}>
				{identity
					? `Welcome, ${identity.displayName ?? 'user'}!`
					: 'Not authenticated — running as a public app.'
				}
			</div>
			<div style={styles.status}>
				<span style={styles.dot(isConnected)} />
				{isConnected ? 'Connected to RocketRide' : 'Not connected'}
			</div>
		</div>
	);
};

export default HelloApp;
