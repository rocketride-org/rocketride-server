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
// GRAPH-UI - ASK BAR (a question in words; the answer is Cypher to review)
// =============================================================================
//
// Asks the node's language model (`get_query`). Cypher that comes back opens in a
// NEW query tab as a draft, not run: the user reads it and presses Run, and the
// text in every other tab stays as it was. A question may be answered in prose
// (shown here as an answer, not an error). A pipeline without a language model
// gets an "unavailable" note instead of an error banner. "Stop waiting" stops this
// bar from waiting; a late answer is then dropped.
//
// The workbench shows the bar on demand (Ask in the run bar) and keeps it mounted
// while it is hidden, so a question already sent still opens its tab. A question
// goes through the workbench's request gate like any of its requests (on Apache
// AGE the node checks the drafted Cypher with EXPLAIN through the same small
// pool): while another request holds it, Ask is not sent and says why.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BxX, Banner, Button, InputField, commonStyles } from 'shell';
import type { IPatternFinding } from '../cypher/classify';
import type { IExplorerEndpoint } from 'shared/explorer';
import { TOOL, announcer } from '../adapters/explorer';
import { useGraphEnv } from '../env';
import { ASK_MAX_CHARS, askQuestion } from '../graph/ask';
import type { AskOutcome } from '../graph/ask';
import { isGateRefusal } from '../graph/requestGate';
import type { IRequestGate } from '../graph/requestGate';
import { ASK_UNAVAILABLE } from '../graph/wording';

/** The headline of the banner on a tab Ask opened. */
export const ASK_DRAFT_HEADLINE = 'Draft from Ask, not run.';

/** The most characters of a question the draft banner quotes (so the banner's line stays under 160). */
const QUOTED_QUESTION_CHARS = 100;

/**
 * What the banner on a tab Ask opened says after its headline.
 *
 * @param question - The question asked.
 * @returns The quoted question and what to do.
 */
export function askDraftText(question: string): string {
	const line = question.replace(/\s+/g, ' ').trim();
	const quoted = line.length <= QUOTED_QUESTION_CHARS ? line : `${line.slice(0, QUOTED_QUESTION_CHARS - 1).trimEnd()}\u2026`;
	return `\u201c${quoted}\u201d Check the Cypher, then Run.`;
}

/**
 * What the text check says about a draft, behind the banner's Details, or null for a read.
 *
 * @param finding - What the text check found in the draft, or null.
 * @returns The sentences, or null.
 */
export function askCheckText(finding: IPatternFinding | null): string | null {
	return finding ? `The text check found ${finding.kind}; query tabs only read, so Run will refuse it. This is a text check, not a database safeguard.` : null;
}

/**
 * The line under the draft banner: the tab the question was asked from is unchanged.
 *
 * @param from - That tab's title.
 * @returns The sentence.
 */
export function askKeptText(from: string): string {
	return `Ask always opens a new tab, so your draft and results in ${from} stay as they were.`;
}

/** What the bar says while it waits. */
// A question counts in the workbench's request gate until the node answers, even after Stop waiting: Ask's budget is
// 120 s (DEFAULT_TOOL_TIMEOUTS.get_query, a retry included), a few seconds more through a dev-tool frame.
export const ASK_STOP_NOTE = 'Stop waiting stops this bar from waiting. The node may still be working on the question; until it answers (about two minutes at most), Run waits in every tab.';

/** What is said when the bar stops waiting. */
export const ASK_STOPPED_TEXT = 'Stopped waiting. The node may still be working on the question; until it answers (about two minutes at most), Run waits in every tab.';

/** Props. */
export interface IAskBarProps {
	endpoint: IExplorerEndpoint;
	/**
	 * Hand the drafted Cypher to the workbench, which opens it in a new query tab, not run (or drops it when the tab it
	 * was asked from is gone), and says so. False when no tab could be opened: the draft then waits here.
	 */
	onDraft(cypher: string, question: string): boolean;
	/** Told when a question is sent (the workbench notes which tab it was asked from). */
	onAsked?(): void;
	/** Hide the bar (its close button, or Escape in the question). */
	onClose?(): void;
	/** Move the focus to the question (the bar was just shown). */
	focusSeq?: number;
	/** The workbench's request gate: a question is one request like any other. */
	gate?: IRequestGate;
}

const styles = {
	root: { padding: '4px 24px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	row: { display: 'flex', gap: 8, alignItems: 'center' } as CSSProperties,
	input: { flex: 1, minWidth: 0 } as CSSProperties,
	close: commonStyles.paneHeaderButton,
};

/**
 * The Ask bar.
 *
 * @param props - See {@link IAskBarProps}.
 * @returns The bar.
 */
export const AskBar: React.FC<IAskBarProps> = ({ endpoint, onDraft, onAsked, onClose, focusSeq = 0, gate }) => {
	const env = useGraphEnv();
	const isConnected = env.ready;
	const [question, setQuestion] = useState('');
	const [pending, setPending] = useState(false);
	const [outcome, setOutcome] = useState<AskOutcome | null>(null);
	const ticket = useRef(0);
	// The question the last answer was for (the text box may have changed since).
	const asked = useRef('');
	// The shell's InputField takes no ref, so the question is found inside its row.
	const row = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (focusSeq > 0) row.current?.querySelector('input')?.focus();
	}, [focusSeq]);
	// An answer that arrives after the bar is gone (its document closed) is dropped, as after Stop waiting.
	useEffect(
		() => () => {
			ticket.current += 1;
		},
		[]
	);

	const ask = useCallback(async () => {
		const session = env.session(endpoint);
		if (!session || pending) return;
		// Another request of this workbench is still on the database: nothing is sent, and the bar says why.
		const busy = gate?.busy() ?? null;
		if (busy !== null) {
			setOutcome({ kind: 'refused', text: busy });
			announcer.announce(busy);
			return;
		}
		const mine = ++ticket.current;
		asked.current = question;
		setPending(true);
		setOutcome(null);
		onAsked?.();
		announcer.announce('Asking the node. This can take a while.');
		// The same rules as adapters/actions.ts askConnection, over this mount's session (a remote one in a dev-tool frame).
		// A refusal by the gate (taken between the check above and the send) is said as the gate says it, not as a
		// pipeline without a language model.
		const refused: { text: string | null } = { text: null };
		const send = (text: string): Promise<unknown> => session.invoke(TOOL.getQuery, { question: text });
		const answer = await askQuestion(question, (text) => (gate ? gate.send(TOOL.getQuery, () => send(text)) : send(text)).catch((error: unknown) => {
			if (isGateRefusal(error)) refused.text = (error as Error).message;
			throw error;
		}), ASK_UNAVAILABLE);
		const result: AskOutcome = refused.text !== null ? { kind: 'refused', text: refused.text } : answer;
		if (mine !== ticket.current) return;
		setPending(false);
		if (result.kind === 'ignored') return;
		if (result.kind === 'cypher') {
			// A draft that could not get a tab (all are in use) waits here, never dropped.
			setOutcome(onDraft(result.cypher, asked.current) ? null : result);
			return;
		}
		setOutcome(result);
		if (result.kind === 'prose') announcer.announce('The node answered in words.');
		else if (result.kind === 'unavailable') announcer.announce('Asking is unavailable for this pipeline.');
		else if (result.kind === 'refused') announcer.announce(result.text);
		else announcer.announce(`Asking failed. ${result.headline}`);
	}, [env, endpoint, pending, question, onDraft, onAsked, gate]);

	const stop = useCallback(() => {
		ticket.current += 1;
		setPending(false);
		announcer.announce(`${ASK_STOPPED_TEXT} A late answer is ignored.`);
	}, []);

	return (
		<div style={styles.root}>
			<div ref={row} style={styles.row}>
				<InputField
					style={styles.input}
					aria-label="Ask a question about this graph"
					placeholder="Ask in words, for example: which people work at Acme?"
					value={question}
					maxLength={ASK_MAX_CHARS}
					disabled={pending}
					onChange={(e) => setQuestion(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void ask();
						} else if (e.key === 'Escape' && onClose) {
							e.preventDefault();
							onClose();
						}
					}}
				/>
				{pending ? (
					<Button variant="ghost" title={ASK_STOP_NOTE} onClick={stop}>
						Stop waiting
					</Button>
				) : (
					<Button variant="secondary" disabled={!isConnected || question.trim() === ''} onClick={() => void ask()}>
						Ask
					</Button>
				)}
				{onClose && (
					<button type="button" style={styles.close} title="Hide the Ask bar" aria-label="Hide the Ask bar" onClick={onClose}>
						<BxX size={16} />
					</button>
				)}
			</div>
			{pending && <div style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }}>{'Asking the language model\u2026'}</div>}
			{outcome?.kind === 'cypher' && (
				<Banner variant="warning">
					The draft from Ask has no tab yet: every query tab is in use. Close one, then open the draft.{' '}
					<Button variant="ghost" small onClick={() => { if (onDraft(outcome.cypher, asked.current)) setOutcome(null); }}>
						Open the draft
					</Button>
				</Banner>
			)}
			{outcome?.kind === 'prose' && <Banner variant="info">{outcome.text}</Banner>}
			{outcome?.kind === 'unavailable' && <Banner variant="info">{outcome.text}</Banner>}
			{outcome?.kind === 'refused' && <Banner variant="warning">{outcome.text}</Banner>}
			{outcome?.kind === 'failed' && (
				<Banner variant={outcome.variant}>
					<strong>{outcome.headline}</strong>
					{outcome.detail !== '' && <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12 }}>{outcome.detail}</pre>}
					{outcome.hint && <div style={{ marginTop: 4 }}>{outcome.hint}</div>}
				</Banner>
			)}
		</div>
	);
};

export default AskBar;
