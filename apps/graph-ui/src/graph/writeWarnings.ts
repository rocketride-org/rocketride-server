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
// GRAPH - MARKS ON STATEMENTS THE READ WORKBENCH WOULD REFUSE (pure)
// =============================================================================
//
// Computed from the text as it is typed: each statement the local text check
// (cypher/classify.ts, the verdict `refuseNonReads` acts on before anything is
// sent) would refuse in the read workbench gets one warning, at its first
// finding. It is the same lexical check, so it is a courtesy and not a database
// safeguard, and it knows nothing the database would only say after a run.
// =============================================================================

import { classifyStatement } from '../cypher/classify';
import type { IFinding } from '../cypher/classify';
import { splitStatements } from '../cypher/split';
import type { IEditorMarker } from '../components/completionProvider';

/** Buffers longer than this are not scanned while typing (the run still checks them). */
export const WARNING_SCAN_LIMIT = 200_000;

/**
 * The sentence for a finding.
 *
 * @param finding - The statement's first finding.
 * @returns What to say beside the mark.
 */
function messageFor(finding: IFinding): string {
	switch (finding.reason) {
		case 'call':
			return 'This procedure is not on the read-only list; Run will refuse it.';
		case 'unrecognized-start':
			return 'This does not start like a read; Run will refuse it.';
		case 'malformed':
			return 'This statement is not closed (a string, name or comment is open); Run will refuse it.';
		default:
			return 'This looks like a write; Run will refuse it.';
	}
}

/**
 * Warnings for the statements of a buffer the read workbench would refuse.
 *
 * @param buffer - The editor text.
 * @returns One warning per refused statement, in buffer offsets.
 */
export function readRefusalMarkers(buffer: string): IEditorMarker[] {
	if (buffer.length > WARNING_SCAN_LIMIT) return [];
	const out: IEditorMarker[] = [];
	for (const statement of splitStatements(buffer)) {
		const { kind, findings } = classifyStatement(statement.text);
		if (kind !== 'write' || findings.length === 0) continue;
		const first = findings.slice().sort((a, b) => a.start - b.start)[0];
		out.push({ start: statement.start + first.start, end: statement.start + first.end, message: messageFor(first), severity: 'warning' });
	}
	return out;
}
