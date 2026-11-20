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
// GRAPH - WRITE CONSOLE CONFIRMATION (what the user is asked before anything is sent)
// =============================================================================
//
// The write console only exists on a node that reports `allow_execute`, and it
// confirms BEFORE sending: one dialog for the whole batch, listing every statement
// the text check marks as mutating or risky (and how many are plain reads), with the
// sentence "This is a text check, not a database safeguard." A batch with any such
// statement is not sent until the user confirms; a batch the check does not flag is
// sent when Execute is pressed, with no dialog (the banner and the Run again
// announcement say so). There is no "stop asking" option, and no write is ever
// retried by the app. The text check can miss a write and can flag a read: the
// node's own permissions are the boundary, and the dialog says so.
//
// Each statement is sent as its OWN request (`execute` with shape 'graph'), in
// order, stopping at the first failure; the confirmation says nothing is rolled back.
// =============================================================================

import { patternCheck } from '../cypher/classify';
import { targetsToRun } from '../cypher/targets';
import type { IRunTarget } from 'shared/explorer';

/** The sentence every confirmation carries, word for word. */
export const TEXT_CHECK_SENTENCE = 'This is a text check, not a database safeguard.';

/**
 * The confirmation's dismiss button, which is also how its button is found for focus. The confirmation opens right
 * after a Run keystroke and the shell's dialog focuses its confirm button, so a second Enter would execute; the
 * console moves focus to this button instead, so the default answer sends nothing.
 */
export const WRITE_CANCEL_LABEL = 'Cancel';

/**
 * What the write console says about itself, always visible. Only statements the text check flags are confirmed
 * (see {@link describeWrites}); the rest are sent when Execute is pressed, so the banner does not claim more.
 */
export const WRITE_CONSOLE_BANNER = `Statements here run against the live database and can change or delete data. Statements that look like they change data are listed for you to confirm before anything is sent; anything else is sent when you press Execute. Each statement is its own request: if a batch stops, the statements before it have already run and nothing is rolled back. ${TEXT_CHECK_SENTENCE}`;

/** One statement the confirmation lists. */
export interface IMutatingStatement {
	/** One-based position in the batch. */
	position: number;
	/** The first lines of the statement. */
	excerpt: string;
	/** What the text check saw. */
	finding: string;
	/** Line range in the editor, when it has one. */
	lines: string;
}

/** What the confirmation is about. */
export interface IWriteConfirmation {
	/** Statements that need confirming. */
	mutating: IMutatingStatement[];
	/** Statements in the batch that look like plain reads. */
	reads: number;
	/** Total statements. */
	total: number;
	/** True when nothing needs confirming. */
	needed: boolean;
}

/**
 * Work out what to confirm for a batch.
 *
 * @param targets - The statements about to be sent, in order.
 * @returns The confirmation content.
 */
export function describeWrites(targets: readonly IRunTarget[]): IWriteConfirmation {
	const mutating: IMutatingStatement[] = [];
	let reads = 0;
	targets.forEach((target, index) => {
		const finding = patternCheck(target.text);
		if (finding === null) {
			reads += 1;
			return;
		}
		const lines = target.startLine === undefined ? '' : target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}–${target.endLine}`;
		mutating.push({ position: index + 1, excerpt: target.text.split('\n').slice(0, 3).join('\n'), finding: finding.kind, lines });
	});
	return { mutating, reads, total: targets.length, needed: mutating.length > 0 };
}

/**
 * The sentences under the list in the confirmation dialog.
 *
 * @param c - The confirmation content.
 * @returns Paragraphs, in order.
 */
export function confirmationParagraphs(c: IWriteConfirmation): string[] {
	const out: string[] = [];
	out.push(`${c.mutating.length} of ${c.total} ${c.total === 1 ? 'statement' : 'statements'} ${c.mutating.length === 1 ? 'looks' : 'look'} like ${c.mutating.length === 1 ? 'it changes' : 'they change'} data or run${c.mutating.length === 1 ? 's' : ''} a command${c.reads > 0 ? ` (${c.reads} ${c.reads === 1 ? 'is a read' : 'are reads'})` : ''}.`);
	out.push(TEXT_CHECK_SENTENCE);
	out.push('Each statement is sent as its own request, in order, and the batch stops at the first error. A statement that has run is not undone if a later one fails.');
	return out;
}

/**
 * What the write console announces when History's "Run again" puts a statement in the editor. Only a statement the
 * text check flags is confirmed before it is sent, so the sentence says which will happen when Execute is pressed.
 *
 * @param text - The statement text loaded into the editor.
 * @returns The sentence for the live region.
 */
export function rerunAnnouncement(text: string): string {
	return describeWrites(targetsToRun(text, { start: 0, end: 0 }, 0, true)).needed
		? 'The statement is in the editor. Press Execute to run it; you will be asked to confirm first.'
		: 'The statement is in the editor. The text check does not take it for a change to data, so Execute sends it without asking first.';
}
