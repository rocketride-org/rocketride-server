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
import heroSrc from './hello-world.webp';

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
	hero: {
		width: 520,
		maxWidth: '90%',
		height: 'auto',
		borderRadius: 12,
		border: '1px solid var(--rr-border)',
		boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Hello World demo app — renders a centered greeting.
 *
 * @param props.identity - Authenticated user identity, or null.
 */
const HelloApp: React.FC<ShellAppProps> = ({ identity }) => {
	return (
		<div style={styles.container}>
			<img
				src={heroSrc}
				alt="An astronaut waving by a campfire on the moon, with Earth rising in the sky"
				style={styles.hero}
			/>
			<div style={styles.title}>Hello World!</div>
			<div style={styles.subtitle}>
				{identity
					? `Welcome, ${identity.displayName ?? 'user'}!`
					: 'Not authenticated — running as a public app.'
				}
			</div>
		</div>
	);
};

export default HelloApp;
