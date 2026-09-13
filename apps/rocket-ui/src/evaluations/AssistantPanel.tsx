import React, { useEffect, useRef, useState } from 'react';
import { Button } from 'shell';
import { EvaluationApi, EvaluationApiError } from './api';
import { Empty, Notice, TextArea } from './controls';
import { parseSpec, pretty, same, specChanges, validateSpec } from './spec';
import type { Capabilities, EvaluationSpec } from './types';

interface Message {
	role: 'You' | 'Assistant';
	text: string;
}
interface Proposal {
	before: EvaluationSpec;
	spec: EvaluationSpec;
}

export default function AssistantPanel({ api, spec, capabilities, disabled, onApply }: { api: EvaluationApi; spec: EvaluationSpec; capabilities: Capabilities | null; disabled: boolean; onApply: (spec: EvaluationSpec) => void }): React.ReactElement {
	const [instruction, setInstruction] = useState('');
	const [messages, setMessages] = useState<Message[]>([]);
	const [proposal, setProposal] = useState<Proposal | null>(null);
	const [invalidProposal, setInvalidProposal] = useState('');
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => setUnavailable(false), [capabilities]);
	const available = capabilities?.assistantAvailable && !unavailable;
	const stale = Boolean(proposal && !same(proposal.before, spec));
	const send = async (): Promise<void> => {
		if (!instruction.trim() || pending || !available || disabled || controller.current) return;
		const errors = validateSpec(spec);
		if (errors.length) {
			setError(`Complete the definition first: ${errors.join(' ')}`);
			return;
		}
		const request = instruction.trim();
		const before = spec;
		const requestController = new AbortController();
		controller.current = requestController;
		setPending(true);
		setError('');
		setProposal(null);
		setInvalidProposal('');
		setInstruction('');
		setMessages((current) => [...current, { role: 'You', text: request }]);
		try {
			const result = await api.request<{ message: string; spec?: unknown }>('/assistant', { instruction: request, spec: before }, requestController.signal);
			if (requestController.signal.aborted) return;
			if (typeof result.message !== 'string') throw new Error('The assistant returned an invalid response.');
			setMessages((current) => [...current, { role: 'Assistant', text: result.message }]);
			if (result.spec !== undefined) {
				try {
					setProposal({ before, spec: parseSpec(pretty(result.spec), before) });
				} catch (reason) {
					setInvalidProposal(pretty(result.spec));
					setError(`Proposal cannot be applied: ${reason instanceof Error ? reason.message : 'Invalid spec.'}`);
				}
			}
		} catch (reason) {
			if (requestController.signal.aborted) return;
			if (reason instanceof EvaluationApiError && reason.status === 503) setUnavailable(true);
			setError(reason instanceof Error ? reason.message : 'Assistant request failed.');
			setInstruction(request);
		} finally {
			controller.current = null;
			if (!requestController.signal.aborted) setPending(false);
		}
	};
	return (
		<div className="rr-eval-assistant rr-eval-stack">
			{!available && <Notice>{capabilities === null ? 'Assistant availability has not been loaded.' : unavailable ? 'The configured assistant is currently unavailable.' : 'No evaluation assistant is configured for this connection.'} A server administrator can configure an evaluation assistant pipeline and execution environment. You can author the full evaluation manually. Refresh availability to check again.</Notice>}
			<div className="rr-eval-chat" role="log" aria-label="Evaluation assistant conversation" aria-live="polite">
				{messages.length === 0 && <Empty title="Build a test suite together">Describe the cases, scorer rubric, or pass criteria you need. The assistant proposes a spec for your review.</Empty>}
				{messages.map((message, index) => (
					<article className={`rr-eval-message rr-eval-message-${message.role.toLowerCase()}`} key={index}>
						<strong>{message.role}</strong>
						<p>{message.text}</p>
					</article>
				))}
				{pending && (
					<p role="status" className="rr-eval-muted">
						Requesting a proposal from the configured assistant…
					</p>
				)}
			</div>
			{error && <Notice error>{error}</Notice>}
			{invalidProposal && (
				<details>
					<summary>Inspect rejected proposal</summary>
					<pre className="rr-eval-code-block">{invalidProposal}</pre>
				</details>
			)}
			{proposal && (
				<section className="rr-eval-section">
					<div className="rr-eval-section-heading">
						<div>
							<h3>Review proposed changes</h3>
							<p>Checked against the v1 contract. New or changed cases remain unreviewed. Apply updates the draft; save and run are separate actions.</p>
						</div>
						<Button
							variant="secondary"
							disabled={disabled || stale || pending}
							onClick={() => {
								onApply(proposal.spec);
								setProposal(null);
								setMessages((current) => [...current, { role: 'Assistant', text: 'Proposal applied to your draft. Review cases and save a revision before running.' }]);
							}}
						>
							Apply proposal
						</Button>
					</div>
					{stale && <Notice>The draft changed after this proposal was requested. Request a new proposal against the current draft.</Notice>}
					<div className="rr-eval-diff">
						{specChanges(proposal.before, proposal.spec).map((change) => (
							<details key={change.field}>
								<summary>{change.field}</summary>
								<div className="rr-eval-form-grid">
									<div>
										<h4>Before</h4>
										<pre className="rr-eval-code-block">{change.before === undefined ? 'Not present' : pretty(change.before)}</pre>
									</div>
									<div>
										<h4>Proposed</h4>
										<pre className="rr-eval-code-block">{change.after === undefined ? 'Removed' : pretty(change.after)}</pre>
									</div>
								</div>
							</details>
						))}
					</div>
					{specChanges(proposal.before, proposal.spec).length === 0 && <p>No changes proposed.</p>}
					<details>
						<summary>Validated proposed spec</summary>
						<pre className="rr-eval-code-block">{pretty(proposal.spec)}</pre>
					</details>
				</section>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
				className="rr-eval-stack"
			>
				<TextArea
					label="Ask the evaluation assistant"
					rows={3}
					value={instruction}
					disabled={!available || pending || disabled}
					placeholder="Describe the inputs and behavior you want to test…"
					onChange={(event) => setInstruction(event.target.value)}
					onKeyDown={(event) => {
						if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
							event.preventDefault();
							void send();
						}
					}}
				/>
				<div className="rr-eval-actions">
					<span className="rr-eval-muted">Ctrl / ⌘ + Enter to send</span>
					<Button variant="secondary" disabled={!available || pending || disabled || !instruction.trim()} onClick={() => void send()}>
						{pending ? 'Requesting…' : 'Send request'}
					</Button>
				</div>
			</form>
		</div>
	);
}
