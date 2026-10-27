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
// VECTOR-UI - WRITE AUDIT DETAILS (the store's audit of the last write, behind a disclosure)
// =============================================================================
//
// soft_delete, restore and delete answer with an `audit` block per batch:
// the tool, the rows it touched and who called (vector/results.ts
// readAudit; never content or vectors). The console keeps them with the
// write's result (removal.audit), and this disclosure, beside the result
// line, lists them, one line per batch (vector/confirm.ts auditLines).
// Nothing shows while the last write had none.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { auditLines } from '../vector/confirm';
import type { IWriteAudit } from '../vector/results';
import { styles as appStyles } from '../styles';

const styles = {
	details: { ...appStyles.small, display: 'inline-block', marginLeft: 8 } as CSSProperties,
	summary: { cursor: 'pointer' } as CSSProperties,
	list: { margin: '4px 0 0', paddingLeft: 18 } as CSSProperties,
};

/** Props for the {@link WriteAuditDetails} component. */
export interface IWriteAuditDetailsProps {
	/** The last write's audit blocks (IConsoleState.removal.audit). */
	audit: readonly IWriteAudit[] | undefined;
}

/**
 * The audit of the last write, behind a "Details" disclosure.
 *
 * @param props - {@link IWriteAuditDetailsProps}.
 * @returns The disclosure, or nothing without an audit.
 */
export function WriteAuditDetails({ audit }: IWriteAuditDetailsProps): React.ReactElement | null {
	if (!audit || audit.length === 0) return null;
	return (
		<details style={styles.details} data-write-audit="">
			<summary style={styles.summary}>Details</summary>
			<ul aria-label="What the store recorded for this write" style={styles.list}>
				{auditLines(audit).map((line, i) => (
					<li key={`${i}:${line}`}>{line}</li>
				))}
			</ul>
		</details>
	);
}

export default WriteAuditDetails;
