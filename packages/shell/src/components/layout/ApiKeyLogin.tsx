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
// API KEY LOGIN — credential form for OSS mode
// =============================================================================
//
// Rendered when server capabilities do NOT include 'saas' — OSS servers have
// no Zitadel; the shell connects directly with the server's ROCKETRIDE_APIKEY.
// Built from the stock library (InputField / Button / Banner / RocketRideMark):
// masked key input with a reveal toggle, an explicit blank-key affordance (the
// primary button says so), the target server for context, and an error banner
// on a failed connect.
// =============================================================================

import { useState, useCallback, KeyboardEvent, CSSProperties } from 'react';
import { Banner } from '../banner/Banner';
import { Button } from '../button/Button';
import { InputField } from '../input-field/InputField';
import { RocketRideMark } from '../RocketRideMark';
import { BxShow, BxHide } from '../BoxIcon';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container — full viewport, centered. */
	container: {
		display: 'flex',
		height: '100vh',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		fontFamily: 'var(--rr-font-family)',
		background: 'var(--rr-bg-default)',
	} as CSSProperties,

	/** The centered card panel holding the form. */
	panel: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 14,
		width: 380,
		padding: '36px 36px 28px',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		background: 'var(--rr-bg-secondary)',
	} as CSSProperties,

	/** Product mark above the title. */
	mark: {
		width: 44,
		height: 44,
	} as CSSProperties,

	title: {
		margin: 0,
		fontSize: 20,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** The server this form will connect to — context, not decoration. */
	server: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family-mono, monospace)',
		padding: '3px 10px',
		border: '1px solid var(--rr-border)',
		borderRadius: 999,
		background: 'var(--rr-bg-default)',
	} as CSSProperties,

	/** Form column — input, hint, actions. */
	form: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		width: '100%',
		marginTop: 8,
	} as CSSProperties,

	/** Wrapper positioning the reveal toggle inside the input. */
	inputWrap: {
		position: 'relative',
		width: '100%',
	} as CSSProperties,

	/** The key input — monospace, with room for the reveal toggle. */
	input: {
		width: '100%',
		boxSizing: 'border-box',
		paddingRight: 38,
		fontFamily: 'var(--rr-font-family-mono, monospace)',
	} as CSSProperties,

	/** Reveal / mask toggle riding inside the input's right edge. */
	reveal: {
		position: 'absolute',
		right: 6,
		top: '50%',
		transform: 'translateY(-50%)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 26,
		height: 26,
		padding: 0,
		border: 'none',
		background: 'none',
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Helper line under the input — the blank-key rule, spelled out. */
	hint: {
		fontSize: 12,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Action row — primary grows, Cancel stays natural width. */
	actions: {
		display: 'flex',
		gap: 8,
		marginTop: 4,
	} as CSSProperties,

	/** Grow wrapper for the primary button (stock Button has no width prop). */
	grow: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
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
 * API key login form for OSS mode.
 *
 * A centered card with the product mark, the target server, a masked key
 * input with a reveal toggle, and a primary action whose label makes the
 * optional-key rule explicit ("Connect without a key" while the field is
 * blank). On submit, calls `onSubmit` with the trimmed key; a failed connect
 * renders a stock error Banner.
 *
 * @param props - {@link ApiKeyLoginProps}.
 * @returns The login screen element.
 */
export function ApiKeyLogin({ onSubmit, onCancel, appName = 'RocketRide', initialError = null }: ApiKeyLoginProps) {
	// Local state: the key text, reveal toggle, in-flight flag, error message.
	const [apiKey, setApiKey] = useState('');
	const [revealed, setRevealed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(initialError);

	// Blank submits are valid — the primary label says exactly what will happen.
	const trimmedKey = apiKey.trim();
	const primaryLabel = loading ? 'Connecting...' : trimmedKey ? 'Connect' : 'Connect without a key';

	/** Connect with the entered (possibly blank) key. */
	const handleSubmit = useCallback(async () => {
		if (loading) return;
		setLoading(true);
		setError(null);
		try {
			await onSubmit(apiKey.trim());
		} catch (err) {
			// Show the server's message, or a generic fallback.
			setError(err instanceof Error ? err.message : 'Connection failed');
			setLoading(false);
		}
		// On success the shell unmounts this screen — no state to reset.
	}, [apiKey, loading, onSubmit]);

	// Enter submits (the stock Button renders type="button", so the implicit
	// form submission path does not apply here).
	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div style={styles.container}>
			<div style={styles.panel}>
				{/* Product mark + name. */}
				<RocketRideMark bodyColor="var(--rr-text-primary)" style={styles.mark} />
				<h1 style={styles.title}>{appName}</h1>

				{/* The server this form connects to — so a wrong-port/wrong-host
				    mistake is visible before typing anything. */}
				<div style={styles.server}>{window.location.host}</div>

				<div style={styles.form}>
					{/* Key input with reveal toggle. */}
					<div style={styles.inputWrap}>
						<InputField
							type={revealed ? 'text' : 'password'}
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="API key"
							aria-label="API key"
							style={styles.input}
							autoFocus
							disabled={loading}
							spellCheck={false}
							autoComplete="off"
						/>
						<button
							type="button"
							style={styles.reveal}
							onClick={() => setRevealed((v) => !v)}
							disabled={loading}
							// State exposed for assistive tech; the icon shows the ACTION
							// (eye = reveal, slashed eye = mask again).
							aria-label={revealed ? 'Hide API key' : 'Show API key'}
							aria-pressed={revealed}
							title={revealed ? 'Hide API key' : 'Show API key'}
						>
							{revealed ? <BxHide size={17} /> : <BxShow size={17} />}
						</button>
					</div>

					{/* The blank-key rule, spelled out next to the field it governs. */}
					<div style={styles.hint}>
						The key is whatever the server&apos;s <code>ROCKETRIDE_APIKEY</code> setting holds.
						If the server does not require one, leave the field blank.
					</div>

					{/* Failed connect — stock error banner (announced via its live region). */}
					{error && <Banner variant="error">{error}</Banner>}

					{/* Actions: primary connect (label reflects the blank-key rule) + Cancel. */}
					<div style={styles.actions}>
						<div style={styles.grow}>
							<Button variant="primary" disabled={loading} onClick={handleSubmit}>
								{primaryLabel}
							</Button>
						</div>
						{onCancel && (
							<Button variant="secondary" disabled={loading} onClick={onCancel}>
								Cancel
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
