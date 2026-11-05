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
// GRAPH-UI - FAILURE BANNER (the database's own words, in the banner)
// =============================================================================
//
// Replaces the shared Explorer banner in the workbench. The difference is what the
// shared one hides: here the database's text is a block in the banner itself (six
// lines visible, the rest scrolls), not behind a "Database said" toggle, because
// that text is the part that says what to fix. It also says where the failure was
// (statement, line and column), what ran and what did not, copies the lot, and
// offers to run a batch again from the statement that failed.
//
// The words are chosen in graph/failureView.ts; the position comes from
// graph/errorPosition.ts and is passed in (the workbench also marks it in the editor).
// =============================================================================

import React, { useCallback, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Banner, Button } from 'shell';
import type { IFailureState } from 'shared/explorer';
import type { IFailureNotice } from 'shared/explorer';
import { failureView } from '../graph/failureView';
import type { IPosition } from '../graph/errorPosition';
import { CopyBlocked, copyText } from './ResultViews';

/** Props. */
export interface IGraphFailureBannerProps<TNotice extends IFailureNotice> {
	/** The failure to show. */
	failure: IFailureState<TNotice>;
	/** Shown instead of the headline when the node swallowed the database's text. */
	genericText: string;
	/** Extra lines under the database's text (the hint). */
	extra?: ReactNode;
	/** How many statements the batch had; with it the banner says which were not run and offers "Run from". */
	total?: number;
	/** Where in the editor buffer the database's text put the failure, when it did. */
	position?: IPosition | null;
	/** Run the batch again from the statement at this index (offered when there is more than one statement). */
	onRunFrom?(index: number): void;
}

const styles = {
	// Six lines of the database's text; the rest scrolls inside the block.
	verbatim: {
		margin: '6px 0 0',
		padding: 8,
		maxHeight: 'calc(1.45em * 6 + 16px)',
		overflow: 'auto',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		lineHeight: 1.45,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		background: 'color-mix(in srgb, var(--rr-text-primary) 6%, transparent)',
		borderRadius: 4,
	} as CSSProperties,
	actions: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } as CSSProperties,
};

/**
 * The failure banner.
 *
 * @param props - {@link IGraphFailureBannerProps}.
 * @returns The banner element.
 */
export function GraphFailureBanner<TNotice extends IFailureNotice>({ failure, genericText, extra, total, position, onRunFrom }: IGraphFailureBannerProps<TNotice>): React.ReactElement {
	const view = failureView(failure, { genericText, ...(total !== undefined ? { total } : {}), position: position ?? null });
	// A new failure forgets the last copy.
	const [copied, setCopied] = useState<'no' | 'yes' | 'blocked'>('no');
	const [last, setLast] = useState(failure);
	if (last !== failure) {
		setLast(failure);
		setCopied('no');
	}
	const copy = useCallback(async () => setCopied((await copyText(view.copy)) ? 'yes' : 'blocked'), [view.copy]);
	return (
		<Banner variant="error">
			<div>{view.headline}</div>
			<div>
				{view.where}
				{view.prior && ` ${view.prior}`}
				{view.notRun && ` ${view.notRun}`}
			</div>
			{view.verbatim && (
				<pre style={styles.verbatim} tabIndex={0} aria-label="What the database said">{view.verbatim}</pre>
			)}
			{extra}
			<div style={styles.actions}>
				<Button variant="ghost" small onClick={() => void copy()}>{copied === 'yes' ? 'Copied' : 'Copy error'}</Button>
				{onRunFrom && view.runFrom !== null && (
					<Button variant="ghost" small onClick={() => onRunFrom(view.runFrom as number)}>{view.runFromLabel}</Button>
				)}
			</div>
			{copied === 'blocked' && <CopyBlocked text={view.copy} />}
		</Banner>
	);
}

export default GraphFailureBanner;
