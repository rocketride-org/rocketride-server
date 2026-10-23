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
// Asks the node's language model (`get_query`) and puts what it returns in the
// editor as a PREVIEW. Nothing is run: the user reads the query and presses Run. A
// question may be answered in prose (shown as an answer, not an error). A pipeline
// without a language model gets an "unavailable" note instead of an error banner.
// "Stop waiting" stops this bar from waiting; a late answer is then dropped.
// =============================================================================

import React, { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, InputField } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { TOOL, announcer } from '../adapters/explorer';
import { patternCheck } from '../cypher/classify';
import { useGraphEnv } from '../env';
import { ASK_MAX_CHARS, askQuestion } from '../graph/ask';
import type { AskOutcome } from '../graph/ask';
import { ASK_UNAVAILABLE } from '../graph/wording';

/** Shown under a Cypher preview. */
export const ASK_PREVIEW_NOTE = 'This is a preview written by the language model. It has not been run: read it, edit it if you like, then press Run.';

/** What the bar says while it waits. */
export const ASK_STOP_NOTE = 'Stop waiting stops this bar from waiting; the node may still be working on the question.';

/** Props. */
export interface IAskBarProps {
	endpoint: IExplorerEndpoint;
	/** Put the previewed Cypher in the editor (without running it). */
	onPreview(cypher: string): void;
}

const styles = {
	root: { padding: '12px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	row: { display: 'flex', gap: 8, alignItems: 'center' } as CSSProperties,
	input: { flex: 1, minWidth: 0 } as CSSProperties,
};

/**
 * The Ask bar.
 *
 * @param props - See {@link IAskBarProps}.
 * @returns The bar.
 */
export const AskBar: React.FC<IAskBarProps> = ({ endpoint, onPreview }) => {
	const env = useGraphEnv();
	const isConnected = env.ready;
	const [question, setQuestion] = useState('');
	const [pending, setPending] = useState(false);
	const [outcome, setOutcome] = useState<AskOutcome | null>(null);
	const ticket = useRef(0);

	const ask = useCallback(async () => {
		const session = env.session(endpoint);
		if (!session || pending) return;
		const mine = ++ticket.current;
		setPending(true);
		setOutcome(null);
		announcer.announce('Asking the node. This can take a while.');
		// The same rules as adapters/actions.ts askConnection, over this mount's session (a remote one in a dev-tool frame).
		const result = await askQuestion(question, (text) => session.invoke(TOOL.getQuery, { question: text }), ASK_UNAVAILABLE);
		if (mine !== ticket.current) return;
		setPending(false);
		if (result.kind === 'ignored') return;
		setOutcome(result);
		if (result.kind === 'cypher') {
			onPreview(result.cypher);
			announcer.announce('A query preview is in the editor. It has not been run.');
		} else if (result.kind === 'prose') announcer.announce('The node answered in words.');
		else if (result.kind === 'unavailable') announcer.announce('Asking is unavailable for this pipeline.');
		else if (result.kind === 'refused') announcer.announce(result.text);
		else announcer.announce(`Asking failed. ${result.headline}`);
	}, [env, endpoint, pending, question, onPreview]);

	const stop = useCallback(() => {
		ticket.current += 1;
		setPending(false);
		announcer.announce('Stopped waiting for the answer. If it arrives later it is ignored.');
	}, []);

	const finding = outcome?.kind === 'cypher' ? patternCheck(outcome.cypher) : null;

	return (
		<div style={styles.root}>
			<div style={styles.row}>
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
			</div>
			{pending && <div style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }}>Asking the language model\u2026</div>}
			{outcome?.kind === 'cypher' && (
				<Banner variant="info">
					{ASK_PREVIEW_NOTE}
					{finding && ` The text check found ${finding.kind}; the editor on this page only reads, so it will refuse to run it. This is a text check, not a database safeguard.`}
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
