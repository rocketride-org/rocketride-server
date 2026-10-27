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
// VECTOR-UI - A DOCUMENT'S WRITE LINE (its own Move to trash, said where it was asked)
// =============================================================================
//
// A document surface confirms its own Move to trash inline. What that write
// did shows here, under the confirmation: what it is doing while it runs,
// then its result (an alert when it failed), with Write details (the whole
// sentence and the store's audit). The full app's document tab shares the
// console's controller, so it shows only the writes asked under its own
// origin (the console's line skips them); a dev-tool document frame has its
// own controller, and shows every write of it.
// =============================================================================

import React, { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { IConnectionEntry } from '../adapters/connections';
import { CONSOLE_ORIGIN } from '../vector/confirm';
import type { ConfirmOrigin } from '../vector/confirm';
import { BUSY } from '../vector/wording';
import { styles as appStyles } from '../styles';
import WriteAuditDetails from './WriteAuditDetails';

const styles = {
	line: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0' } as CSSProperties,
	text: { ...appStyles.small, flex: 1, minWidth: 0 } as CSSProperties,
};

/** Props of {@link DocumentWriteLine}. */
export interface IDocumentWriteLineProps {
	/** The connection's objects (its controller holds the write). */
	entry: Pick<IConnectionEntry, 'controller'>;
	/** The surface's origin: the writes asked under it show here. */
	origin: ConfirmOrigin;
}

/**
 * The line of the last write asked on this surface.
 *
 * @param props - {@link IDocumentWriteLineProps}.
 * @returns The line, or nothing while no write of this surface has words.
 */
export function DocumentWriteLine({ entry, origin }: IDocumentWriteLineProps): React.ReactElement | null {
	const removal = useSyncExternalStore(entry.controller.subscribe, () => entry.controller.getState().removal, () => entry.controller.getState().removal);
	if ((removal.origin ?? CONSOLE_ORIGIN) !== origin) return null;
	if (removal.status !== 'running' && removal.message === null) return null;
	return (
		<div style={styles.line} data-document-write-line="">
			{removal.status === 'error' ? (
				// Its own element, so a failure is announced as one.
				<div key="alert" role="alert" style={styles.text}>
					{removal.message}
				</div>
			) : (
				<div key="status" role="status" style={styles.text}>
					{removal.status === 'running' ? (removal.message ?? BUSY.removing) : removal.message}
				</div>
			)}
			{/* Outside the live element: opening it does not announce the line again. */}
			{(removal.status === 'done' || removal.status === 'error') && <WriteAuditDetails message={removal.message} audit={removal.audit} />}
		</div>
	);
}

export default DocumentWriteLine;
