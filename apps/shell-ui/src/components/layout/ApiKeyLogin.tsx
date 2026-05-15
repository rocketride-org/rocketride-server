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
// API KEY LOGIN — simple credential form for OSS mode
// =============================================================================
//
// Rendered when server capabilities include 'oss' instead of the Zitadel
// OAuth2 flow used in SaaS mode. The user enters their ROCKETRIDE_APIKEY
// and the shell connects directly.
// =============================================================================

import React, { useState, useCallback, type CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container — full viewport, centered. */
	container: {
		display: 'flex',
		height: '100vh',
		flexDirection: 'column' as const,
		alignItems: 'center',
		justifyContent: 'center',
		gap: 16,
		fontFamily: 'var(--rr-font-family)',
	},
	/** Title text. */
	title: {
		fontSize: 18,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	/** Subtitle / instructions. */
	subtitle: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		maxWidth: 320,
		textAlign: 'center' as const,
	},
	/** Form wrapper — column layout with gap. */
	form: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 12,
		width: 300,
	},
	/** Text input field. */
	input: {
		padding: '8px 12px',
		fontSize: 14,
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		backgroundColor: 'var(--rr-bg-secondary)',
		color: 'var(--rr-text-primary)',
		outline: 'none',
		fontFamily: 'var(--rr-font-family-mono, monospace)',
	},
	/** Submit button. */
	button: {
		padding: '8px 16px',
		fontSize: 14,
		fontWeight: 500,
		border: 'none',
		borderRadius: 4,
		backgroundColor: 'var(--rr-accent)',
		color: '#fff',
		cursor: 'pointer',
	},
	/** Error message. */
	error: {
		fontSize: 13,
		color: 'var(--rr-color-error, #e53e3e)',
		textAlign: 'center' as const,
	},
};

// =============================================================================
// PROPS
// =============================================================================

export interface ApiKeyLoginProps {
	/** Called when the user submits the API key. */
	onSubmit: (apiKey: string) => Promise<void>;
	/** Called when the user cancels — returns to the shell without auth. */
	onCancel?: () => void;
	/** Application name shown in the title. */
	appName?: string;
	/** Initial error message (e.g. from a failed auto-reconnect). */
	initialError?: string | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Simple API key login form for OSS mode.
 *
 * Renders a centered card with a text input for the ROCKETRIDE_APIKEY
 * and a Connect button. On submit, calls `onSubmit` with the entered key.
 * Shows an error message if connection fails.
 *
 * @param props - Component props.
 */
export function ApiKeyLogin({ onSubmit, onCancel, appName = 'RocketRide', initialError = null }: ApiKeyLoginProps) {
	// Local state for the input value, loading indicator, and error message
	const [apiKey, setApiKey] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(initialError);

	/** Handle form submission — connect with the entered API key. */
	const handleSubmit = useCallback(async (e: React.FormEvent) => {
		e.preventDefault();

		// Trim whitespace — empty string is valid (server may allow open access)
		const key = apiKey.trim();

		setLoading(true);
		setError(null);

		try {
			await onSubmit(key);
		} catch (err) {
			// Show the error message from the server or a generic fallback
			const message = err instanceof Error ? err.message : 'Connection failed';
			setError(message);
		} finally {
			setLoading(false);
		}
	}, [apiKey, onSubmit]);

	return (
		<div style={styles.container}>
			<div style={styles.title}>{appName}</div>
			<div style={styles.subtitle}>
				Enter your API key to connect, or leave blank if the
				server does not require one.
			</div>

			<form onSubmit={handleSubmit} style={styles.form}>
				<input
					type="password"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder="API Key (optional)"
					style={styles.input}
					autoFocus
					disabled={loading}
				/>
				<div style={{ display: 'flex', gap: 8 }}>
					<button type="submit" style={{ ...styles.button, flex: 1 }} disabled={loading}>
						{loading ? 'Connecting...' : 'Connect'}
					</button>
					{onCancel && (
						<button type="button" onClick={onCancel} disabled={loading}
							style={{ ...styles.button, flex: 0, backgroundColor: 'var(--rr-bg-tertiary, #666)', color: 'var(--rr-text-primary)' }}>
							Cancel
						</button>
					)}
				</div>
			</form>

			{error && <div style={styles.error}>{error}</div>}
		</div>
	);
}
