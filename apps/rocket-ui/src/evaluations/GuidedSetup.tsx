import React, { useEffect, useState } from 'react';
import { Button } from 'shell';
import { ArrowRight, Check, FlaskConical, ListChecks, Play, Settings2 } from 'lucide-react';
import CasesEditor from './CasesEditor';
import SpecEditor from './SpecEditor';
import { Notice, SelectField, TextArea, TextField } from './controls';
import { clone, same } from './spec';
import { randomUuid } from '../utils/randomUuid';
import type { Capabilities, EvaluationSpec, Scorer } from './types';

const criteria: { kind: Scorer['kind']; name: string; description: string }[] = [
	{ kind: 'contains', name: 'Includes the expected answer', description: 'Check that the response contains the words you expect. Extra text is allowed.' },
	{ kind: 'equals', name: 'Matches the expected answer', description: 'Compare the response with your expected answer using an exact-match check.' },
	{ kind: 'json', name: 'Returns the expected JSON', description: 'Check valid JSON and compare any expected answer. Configure field comparisons in All settings.' },
	{ kind: 'latency', name: 'Responds within a time limit', description: 'Check how long the pipeline takes to respond.' },
	{ kind: 'human', name: 'Let a person review it', description: 'Collect responses, then mark each one in Results. No automatic quality verdict.' },
];

export default function GuidedSetup({ spec, project, capabilities, disabled, onChange, onPendingChange, onRun, blockers, busy }: { spec: EvaluationSpec; project: Record<string, unknown>; capabilities: Capabilities | null; disabled: boolean; onChange: (spec: EvaluationSpec) => void; onPendingChange: (pending: boolean) => void; onRun: () => void; blockers: string[]; busy: string }): React.ReactElement {
	const [step, setStep] = useState(0);
	const [advanced, setAdvanced] = useState(false);
	const [input, setInput] = useState('');
	const [reference, setReference] = useState('');
	const [exampleError, setExampleError] = useState('');
	const [advancedPending, setAdvancedPending] = useState(false);
	const [importing, setImporting] = useState(false);
	const pending = advancedPending || importing || Boolean(input || reference);
	useEffect(() => {
		onPendingChange(pending);
	}, [pending, onPendingChange]);
	useEffect(() => () => onPendingChange(false), [onPendingChange]);
	const patch = (change: Partial<EvaluationSpec>): void => onChange({ ...spec, ...change });
	const reviewed = spec.cases.filter((item) => item.approved).length;
	const labels = ['Add examples', 'Choose checks', 'Review & run'];
	return (
		<div className="rr-eval-setup">
			<div className="rr-eval-setup-toolbar">
				<p className="rr-eval-muted">{advanced ? 'Full control over this evaluation' : 'A few examples. Clear expectations. A repeatable test.'}</p>
				<Button small variant="ghost" disabled={disabled} onClick={() => setAdvanced(!advanced)}>
					<Settings2 size={14} /> {advanced ? 'Guided setup' : 'All settings'}
				</Button>
			</div>
			<div hidden={!advanced}>
				<SpecEditor spec={spec} project={project} capabilities={capabilities} disabled={disabled} onChange={onChange} onPendingChange={setAdvancedPending} />
			</div>
			<div hidden={advanced}>
				<nav className="rr-eval-steps" aria-label="Evaluation setup steps">
					{labels.map((label, index) => (
						<button key={label} type="button" aria-current={step === index ? 'step' : undefined} disabled={disabled} onClick={() => setStep(index)}>
							<span className="rr-eval-step-number">{(index === 0 && reviewed > 0) || (index === 1 && spec.scorers.length > 0 && step > 1) ? <Check size={16} /> : index + 1}</span>
							<span>{label}</span>
						</button>
					))}
				</nav>
				<div className="rr-eval-guided-body">
					<div hidden={step !== 0}>
						<div className="rr-eval-intro">
							<FlaskConical size={26} aria-hidden="true" />
							<h3>What should your pipeline handle?</h3>
							<p>Give it an input you care about and describe the answer you expect. One example is enough to get started.</p>
						</div>
						{(spec.cases.length === 0 || input || reference) && (
							<section className="rr-eval-section rr-eval-stack">
								<details>
									<summary>Input: {spec.inputMode === 'chat' ? 'chat messages' : 'text documents'}</summary>
									<SelectField label="Send examples as" hint="Selected from your pipeline’s connections. Change this if your source expects a different input." value={spec.inputMode} disabled={disabled} onChange={(event) => patch({ inputMode: event.target.value as EvaluationSpec['inputMode'] })}>
										<option value="chat">Chat messages</option>
										<option value="text">Text documents</option>
									</SelectField>
								</details>
								<div className="rr-eval-form-grid">
									<TextArea
										label="What will you send?"
										placeholder="For example: What is our refund policy?"
										rows={5}
										value={input}
										disabled={disabled}
										onChange={(event) => {
											setInput(event.target.value);
											setExampleError('');
										}}
									/>
									<TextArea label="What answer do you expect?" hint="For example: 30 days. Leave blank for checks that do not need an expected answer." placeholder="The key phrase or answer you want to see" rows={5} value={reference} disabled={disabled} onChange={(event) => setReference(event.target.value)} />
								</div>
								{exampleError && <Notice error>{exampleError}</Notice>}
								<div className="rr-eval-actions">
									<Button
										disabled={disabled}
										onClick={() => {
											if (!input.trim()) {
												setExampleError('Enter an input for your first example.');
												return;
											}
											patch({ cases: [...spec.cases, { id: randomUuid(), name: `Example ${spec.cases.length + 1}`, input, ...(reference ? { reference } : {}), approved: true, tags: [], provenance: { kind: 'manual' } }] });
											setInput('');
											setReference('');
											setStep(1);
										}}
									>
										Add example &amp; continue <ArrowRight size={14} />
									</Button>
									<span className="rr-eval-muted">Confirm that this input and expected answer are correct.</span>
									{Boolean(input || reference) && (
										<Button
											small
											variant="ghost"
											disabled={disabled}
											onClick={() => {
												setInput('');
												setReference('');
											}}
										>
											Clear draft example
										</Button>
									)}
								</div>
							</section>
						)}
						<CasesEditor cases={spec.cases} disabled={disabled} compactEmpty onImporting={setImporting} onChange={(cases) => patch({ cases })} />
						{spec.cases.length > 0 && (
							<div className="rr-eval-step-footer">
								<p>
									{reviewed} of {spec.cases.length} examples reviewed
								</p>
								<Button disabled={disabled || !reviewed} onClick={() => setStep(1)}>
									Choose checks <ArrowRight size={14} />
								</Button>
							</div>
						)}
					</div>
					<div hidden={step !== 1}>
						<div className="rr-eval-intro">
							<ListChecks size={26} aria-hidden="true" />
							<h3>What does a good response look like?</h3>
							<p>Choose the checks that matter. Every selected check will run against your examples.</p>
						</div>
						<div className="rr-eval-preset-grid">
							{criteria.map((criterion) => {
								const selected = spec.scorers.some((item) => item.kind === criterion.kind);
								const unavailable = Boolean(capabilities && !capabilities.scorerKinds.includes(criterion.kind));
								return (
									<button type="button" key={criterion.kind} className="rr-eval-preset" aria-pressed={selected} disabled={disabled || unavailable} onClick={() => patch({ scorers: selected ? spec.scorers.filter((item) => item.kind !== criterion.kind) : [...spec.scorers, { id: randomUuid(), name: criterion.name, kind: criterion.kind, ...(criterion.kind === 'latency' ? { threshold: 3000 } : {}) }] })}>
										<span className="rr-eval-preset-check">{selected && <Check size={16} />}</span>
										<span>
											<strong>{criterion.name}</strong>
											<small>
												{criterion.description}
												{unavailable ? ' Unavailable on this server.' : ''}
											</small>
										</span>
									</button>
								);
							})}
						</div>
						{spec.scorers
							.filter((item) => item.kind === 'latency')
							.map((item) => (
								<div className="rr-eval-section" key={item.id}>
									<TextField label="Maximum response time (milliseconds)" type="number" min={0} max={3600000} value={item.threshold ?? ''} disabled={disabled} onChange={(event) => patch({ scorers: spec.scorers.map((scorer) => (scorer.id === item.id ? { ...scorer, threshold: event.target.valueAsNumber } : scorer)) })} />
								</div>
							))}
						<p className="rr-eval-guidance">
							Need an AI judge, excluded phrases, or custom field comparisons?{' '}
							<button className="rr-eval-link" disabled={disabled} onClick={() => setAdvanced(true)}>
								Open all settings
							</button>
							. Your existing checks and configuration stay with this evaluation.
						</p>
						<div className="rr-eval-step-footer">
							<Button variant="ghost" disabled={disabled} onClick={() => setStep(0)}>
								Back to examples
							</Button>
							<Button disabled={disabled || !spec.scorers.length} onClick={() => setStep(2)}>
								Review evaluation <ArrowRight size={14} />
							</Button>
						</div>
					</div>
					<div hidden={step !== 2}>
						<div className="rr-eval-intro">
							<Play size={26} aria-hidden="true" />
							<h3>See how your pipeline performs</h3>
							<p>We’ll run your examples, check the responses, and show you exactly which ones need attention.</p>
						</div>
						<section className="rr-eval-section rr-eval-stack">
							<TextField label="Evaluation name" value={spec.name} disabled={disabled} onChange={(event) => patch({ name: event.target.value })} />
							<dl className="rr-eval-review-summary">
								<dt>Examples</dt>
								<dd>
									{reviewed} reviewed of {spec.cases.length} · {spec.repetitions} run{spec.repetitions !== 1 ? 's' : ''} per example
								</dd>
								<dt>Checks</dt>
								<dd>{spec.scorers.map((item) => item.name).join(', ') || 'Choose at least one check'}</dd>
								<dt>Run on</dt>
								<dd>
									{capabilities?.environments.find((item) => item.id === spec.environment)?.label ?? spec.environment} · {spec.inputMode} input
								</dd>
								<dt>Pass target</dt>
								<dd>
									{spec.passCriteria.minimumPassRate * 100}% of trials pass · up to {spec.passCriteria.maxRegressions} regressions when comparing
								</dd>
							</dl>
							{!same(spec.pipeline, project) && (
								<Notice>
									The canvas has changed since this evaluation was created.{' '}
									<Button small variant="secondary" disabled={disabled} onClick={() => patch({ pipeline: clone(project) })}>
										Use current canvas
									</Button>
									<p>Otherwise, this run uses the saved pipeline snapshot.</p>
								</Notice>
							)}
							{spec.cases.some((item) => !item.approved) && <Notice>Some examples still need review. They cannot count as passing. Go back to Examples to review them.</Notice>}
							{blockers.length > 0 && (
								<Notice>
									<strong>Finish these before running</strong>
									<ul>
										{blockers.map((item) => (
											<li key={item}>{item}</li>
										))}
									</ul>
									<button className="rr-eval-link" onClick={() => setAdvanced(true)}>
										Review all settings
									</button>
								</Notice>
							)}
							<p className="rr-eval-muted">Run evaluation saves a version of this setup and starts real pipeline execution. Any model or external services used by your pipeline may incur their usual costs.</p>
						</section>
						<div className="rr-eval-step-footer">
							<Button variant="ghost" disabled={disabled} onClick={() => setStep(1)}>
								Back to checks
							</Button>
							<Button disabled={disabled || blockers.length > 0} onClick={onRun}>
								{busy || 'Run evaluation'} <Play size={14} />
							</Button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
