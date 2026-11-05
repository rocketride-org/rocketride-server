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
// EXPLORER — FAILURE BANNER (a headline, where it happened, and what the database said)
// =============================================================================
//
// The shared banner every Explorer shows when a statement fails: the headline
// (what the node or the database reported), which statement of the batch it was
// and what is true of the ones before it, and — collapsed — the verbatim text
// under "Database said", which is the text that gets pasted into a bug report.
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Banner, Button } from 'shell';
import type { IFailureNotice, IFailureState } from '../runner/types';

/** Title of the collapsible block holding the verbatim driver text. */
export const DATABASE_SAID_LABEL = 'Database said';

/** Props for the {@link FailureBanner} component. */
export interface IFailureBannerProps<TNotice extends IFailureNotice> {
	/** The failure to show. */
	failure: IFailureState<TNotice>;
	/** Shown instead of the headline when the node swallowed the driver's text. */
	genericText: string;
	/** Extra lines under the headline (e.g. the node's own row-cap hint). */
	extra?: ReactNode;
	/** The toggle's label (default {@link DATABASE_SAID_LABEL}). */
	saidLabel?: string;
}

const styles = {
	// Verbatim driver text inside the error banner.
	verbatim: {
		margin: '6px 0 0',
		padding: 8,
		maxHeight: 180,
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,
};

/**
 * The failure banner. An assertive live region already (Banner), so a failure
 * is never also announced through the polite channel.
 *
 * @param props - {@link IFailureBannerProps}.
 * @returns The banner element.
 */
export function FailureBanner<TNotice extends IFailureNotice>({ failure, genericText, extra, saidLabel = DATABASE_SAID_LABEL }: IFailureBannerProps<TNotice>): React.ReactElement {
	const [showVerbatim, setShowVerbatim] = useState(false);
	// A new failure starts collapsed.
	useEffect(() => { setShowVerbatim(false); }, [failure]);
	const { notice } = failure;
	return (
		<Banner variant="error">
			<div>{notice.generic ? genericText : notice.headline}</div>
			<div>
				{`Statement ${failure.index + 1}${failure.lines ? ` (${failure.lines})` : ''}.`}
				{failure.prior && ` ${failure.prior}`}
			</div>
			{extra}
			{!notice.generic && notice.verbatim && (
				<>
					<Button variant="ghost" small ariaExpanded={showVerbatim} onClick={() => setShowVerbatim((open) => !open)}>
						{showVerbatim ? `Hide “${saidLabel}”` : saidLabel}
					</Button>
					{showVerbatim && <pre style={styles.verbatim}>{notice.verbatim}</pre>}
				</>
			)}
		</Banner>
	);
}

export default FailureBanner;
