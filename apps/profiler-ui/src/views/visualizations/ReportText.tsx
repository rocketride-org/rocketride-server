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
// REPORT TEXT — Raw pstats text view with copy-to-clipboard
// =============================================================================

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container. */
	container: {
		...commonStyles.columnFill,
		overflow: 'hidden',
	} as CSSProperties,

	/** Toolbar row. */
	toolbar: {
		display: 'flex',
		justifyContent: 'flex-end',
		padding: '4px 8px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Scrollable report container. */
	reportContainer: {
		flex: 1,
		overflow: 'auto',
		background: 'var(--rr-bg-surface-alt)',
		padding: 12,
	} as CSSProperties,

	/** Monospace pre-formatted text. */
	reportPre: {
		margin: 0,
		fontSize: 12,
		lineHeight: 1.5,
		fontFamily: 'var(--rr-font-mono, monospace)',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-all',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

interface ReportTextProps {
	/** Full pstats text report string. */
	report: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Fallback clipboard copy using a temporary textarea and execCommand.
 *
 * Used when the Clipboard API is unavailable (VS Code webviews,
 * non-secure HTTP contexts, older browsers).
 *
 * @param text    - The text to copy to the clipboard.
 * @param setCopied - State setter to show the "Copied!" feedback.
 */
function copyViaExecCommand(text: string, setCopied: (v: boolean) => void): void {
	try {
		// Create an off-screen textarea to hold the text
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(textarea);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	} catch (err) {
		console.log('[ReportText] Fallback clipboard copy failed:', err);
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Raw pstats text report view with copy-to-clipboard support.
 *
 * @param props.report - The full pstats text report string.
 */
const ReportText: React.FC<ReportTextProps> = ({ report }) => {
	const [copied, setCopied] = useState(false);

	/**
	 * Copy report to clipboard.
	 *
	 * Uses navigator.clipboard when available (modern browsers), falls back
	 * to the legacy execCommand('copy') approach for environments where the
	 * Clipboard API is unavailable (e.g. VS Code webviews, non-secure contexts).
	 */
	const handleCopy = useCallback(() => {
		// Try the modern Clipboard API first
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(report).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}).catch((err) => {
				console.log('[ReportText] Clipboard API failed, trying fallback:', err);
				// Fall back to execCommand for restricted environments
				copyViaExecCommand(report, setCopied);
			});
		} else {
			// Clipboard API not available — use legacy fallback
			copyViaExecCommand(report, setCopied);
		}
	}, [report]);

	return (
		<div style={styles.container}>
			<div style={styles.toolbar}>
				<button style={commonStyles.buttonSecondarySmall} onClick={handleCopy}>
					{copied ? 'Copied!' : 'Copy to Clipboard'}
				</button>
			</div>
			<div style={styles.reportContainer}>
				<pre style={styles.reportPre}>
					{report || 'No profiling report available. Start and stop a session to generate one.'}
				</pre>
			</div>
		</div>
	);
};

export default ReportText;
