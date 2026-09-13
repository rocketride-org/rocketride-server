import React, { useState } from 'react';
import { Button, DetailPanel } from 'shell';
import { downloadArtifact } from './api';
import { dateLabel, durationLabel, Empty, Notice, SelectField, Status, TextArea, TextField } from './controls';
import { pretty } from './spec';
import { canBeBaseline, isActiveRun, traceUnavailableReason, type CaseResult, type Evaluation, type Run, type HumanReviewStatus } from './types';

interface Props {
	evaluation: Evaluation | null;
	runs: Run[];
	selectedRunId: string;
	onSelectRun: (id: string) => void;
	baselineId: string;
	onBaselineSelect: (id: string) => void;
	onSetBaseline: (id: string) => void;
	onCancel: (id: string) => void;
	onExport: (run: Run, format: 'json' | 'junit') => void;
	onReview: (run: Run, item: CaseResult, scorerId: string, status: HumanReviewStatus, reason: string) => Promise<boolean>;
	onRefresh: () => void;
	onOpenTrace?: (trace: NonNullable<CaseResult['trace']>) => void;
	busy: boolean;
	requestError?: string;
}

function CaseDetail({ item, run, busy, onReview, onOpenTrace, onRefresh, requestError }: { item: CaseResult; run: Run; busy: boolean; onReview: Props['onReview']; onOpenTrace?: Props['onOpenTrace']; onRefresh: () => void; requestError?: string }): React.ReactElement {
	const [review, setReview] = useState<Record<string, { status: HumanReviewStatus; reason: string }>>({});
	const [notice, setNotice] = useState('');
	const [error, setError] = useState('');
	const traceReason = item.trace ? traceUnavailableReason(item.trace, run.spec.environment, Boolean(onOpenTrace)) : undefined;
	const reviewable = run.status === 'completed' && run.spec.cases.some((source) => source.id === item.caseId && source.approved) && item.output !== undefined && !item.error;
	const copyTrace = async (): Promise<void> => {
		try {
			if (!navigator.clipboard) throw new Error('Clipboard unavailable');
			await navigator.clipboard.writeText(pretty(item.trace));
			setNotice('Trace locator copied.');
			setError('');
		} catch {
			setError('Clipboard unavailable. Select and copy the trace locator above.');
		}
	};
	return (
		<div className="rr-eval-stack">
			<div className="rr-eval-actions">
				<Status status={item.status} />
				<span className="rr-eval-muted">
					Trial {item.trial} · {durationLabel(item.durationMs)}
				</span>
				<Button small variant="ghost" disabled={busy} onClick={onRefresh}>
					Refresh evidence
				</Button>
			</div>
			{requestError && <Notice error>{requestError}</Notice>}
			<section>
				<h4>Input</h4>
				<pre className="rr-eval-code-block">{typeof item.input === 'string' ? item.input : pretty(item.input)}</pre>
			</section>
			<div className="rr-eval-form-grid">
				<section>
					<h4>Expected reference</h4>
					<pre className="rr-eval-code-block">{item.reference ?? 'No reference supplied'}</pre>
				</section>
				<section>
					<h4>Actual output</h4>
					<pre className="rr-eval-code-block">{item.output === undefined ? 'No output captured' : typeof item.output === 'string' ? item.output : pretty(item.output)}</pre>
				</section>
			</div>
			{item.error && <Notice error>{item.error}</Notice>}
			<section>
				<h4>Scorer evidence</h4>
				{item.scores.length === 0 && <p className="rr-eval-muted">No scorer evidence yet.</p>}
				{item.scores.map((score) => {
					const manual = run.spec.scorers.find((scorer) => scorer.id === score.scorerId)?.kind === 'human';
					const entry = review[score.scorerId] ?? { status: 'pass' as const, reason: '' };
					const scorer = run.spec.scorers.find((candidate) => candidate.id === score.scorerId);
					return (
						<div key={score.scorerId} className="rr-eval-scorer">
							<div className="rr-eval-section-heading">
								<strong>{score.name}</strong>
								<Status status={score.status} />
							</div>
							<p className="rr-eval-prewrap">{score.reason || 'No reason supplied.'}</p>
							<p className="rr-eval-muted">Score: {score.score ?? 'Unavailable'}</p>
							{scorer && (
								<details>
									<summary>Executed scorer configuration</summary>
									<pre className="rr-eval-code-block">{pretty(scorer)}</pre>
								</details>
							)}
							{(score.trace || score.executionProjectId) && (
								<details>
									<summary>Judge execution evidence</summary>
									<pre className="rr-eval-code-block">{pretty({ executionProjectId: score.executionProjectId, trace: score.trace })}</pre>
								</details>
							)}
							{manual && !reviewable && <p className="rr-eval-muted">Review requires a completed run, an approved case, and captured output without execution errors for this trial.</p>}
							{manual && reviewable && (
								<fieldset disabled={busy} className="rr-eval-fields">
									<SelectField label={`Review outcome for ${score.name}`} value={entry.status} onChange={(event) => setReview({ ...review, [score.scorerId]: { ...entry, status: event.target.value as HumanReviewStatus } })}>
										<option value="pass">Pass</option>
										<option value="fail">Fail</option>
										<option value="abstain">Abstain</option>
									</SelectField>
									<TextArea label={`Review reason for ${score.name}`} value={entry.reason} rows={2} maxLength={4096} onChange={(event) => setReview({ ...review, [score.scorerId]: { ...entry, reason: event.target.value } })} />
									<p className="rr-eval-muted">
										This review applies to trial {item.trial} of case {item.caseId} for this scorer. Result ID: {item.id}.
									</p>
									<Button
										small
										variant="secondary"
										disabled={busy || !entry.reason.trim()}
										onClick={() => {
											setNotice('');
											void onReview(run, item, score.scorerId, entry.status, entry.reason.trim()).then((ok) => {
												if (ok) setNotice(`Review saved for ${score.name}.`);
											});
										}}
									>
										Save review
									</Button>
								</fieldset>
							)}
						</div>
					);
				})}
			</section>
			<section>
				<h4>Captured trace</h4>
				{item.executionProjectId && <p className="rr-eval-muted">Execution project: {item.executionProjectId}</p>}
				{item.trace ? (
					<>
						{traceReason && <p className="rr-eval-muted">{traceReason}</p>}
						<pre className="rr-eval-code-block">{pretty(item.trace)}</pre>
						<div className="rr-eval-actions">
							<Button
								variant="secondary"
								disabled={Boolean(traceReason)}
								title={traceReason}
								onClick={() => {
									if (!traceReason && item.trace) onOpenTrace?.(item.trace);
								}}
							>
								Open trace
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									void copyTrace();
								}}
							>
								Copy trace locator
							</Button>
						</div>
					</>
				) : (
					<p className="rr-eval-muted">No trace was captured for this trial.</p>
				)}
			</section>
			{notice && <Notice>{notice}</Notice>}
			{error && <Notice error>{error}</Notice>}
		</div>
	);
}

export default function ResultsPanel({ evaluation, runs, selectedRunId, onSelectRun, baselineId, onBaselineSelect, onSetBaseline, onCancel, onExport, onReview, onRefresh, onOpenTrace, busy, requestError }: Props): React.ReactElement {
	const [caseId, setCaseId] = useState<string | null>(null);
	const [filter, setFilter] = useState('all');
	const [search, setSearch] = useState('');
	const run = runs.find((item) => item.id === selectedRunId);
	const activeCase = run?.cases.find((item) => item.id === caseId);
	const filtered = run?.cases.filter((item) => (filter === 'all' || item.status === filter) && `${item.name} ${item.caseId}`.toLowerCase().includes(search.toLowerCase())) ?? [];
	const baseline = runs.find((item) => item.id === run?.baselineRunId);
	return (
		<div className="rr-eval-stack">
			<section className="rr-eval-section">
				<div className="rr-eval-section-heading">
					<div>
						<h3>Runs & baselines</h3>
						<p>Only queued and running jobs are polled. Completed reports remain available.</p>
					</div>
					<Button small variant="ghost" disabled={busy || !evaluation} onClick={onRefresh}>
						Refresh runs
					</Button>
				</div>
				<div className="rr-eval-form-grid">
					<SelectField
						label="Inspect run"
						value={selectedRunId}
						onChange={(event) => {
							setCaseId(null);
							onSelectRun(event.target.value);
						}}
					>
						<option value="">Select a run</option>
						{runs.map((item) => (
							<option key={item.id} value={item.id}>
								r{item.revision} · {dateLabel(item.createdAt)} · {item.status} · {item.id.slice(0, 8)}
								{evaluation?.baselineRunId === item.id ? ' · Baseline' : ''}
							</option>
						))}
					</SelectField>
					<SelectField label="Compare next run with" hint="The server uses the saved baseline by default. An incompatible comparison cannot certify a regression gate." value={baselineId} disabled={busy} onChange={(event) => onBaselineSelect(event.target.value)}>
						<option value="">{evaluation?.baselineRunId ? `Saved baseline · ${evaluation.baselineRunId.slice(0, 8)}` : 'No saved baseline'}</option>
						{baselineId && !runs.some((item) => item.id === baselineId) && <option value={baselineId}>{baselineId} (saved baseline)</option>}
						{runs.filter(canBeBaseline).map((item) => (
							<option key={item.id} value={item.id}>
								r{item.revision} · {dateLabel(item.createdAt)} · {item.id.slice(0, 8)}
								{evaluation?.baselineRunId === item.id ? ' · Baseline' : ''}
							</option>
						))}
					</SelectField>
				</div>
			</section>
			{!run ? (
				<Empty title={runs.length ? 'Select a run to inspect' : 'No runs yet'}>Save a revision with reviewed cases, then run it against the configured environment.</Empty>
			) : (
				<>
					<section className="rr-eval-section">
						<div className="rr-eval-section-heading">
							<div>
								<h3>
									Run report <Status status={run.status} />
								</h3>
								<p>
									Revision {run.revision} · {run.spec.environment} · {run.spec.source} · Report revision {run.reportRevision}
								</p>
							</div>
							<div className="rr-eval-actions">
								{isActiveRun(run) && (
									<Button small variant="danger" disabled={busy} onClick={() => onCancel(run.id)}>
										Cancel run
									</Button>
								)}
								<Button small variant="secondary" disabled={busy || !canBeBaseline(run) || evaluation?.baselineRunId === run.id} title="A baseline requires completed execution with every case scored pass or fail." onClick={() => onSetBaseline(run.id)}>
									{evaluation?.baselineRunId === run.id ? 'Current baseline' : 'Set as baseline'}
								</Button>
								<Button small variant="ghost" disabled={busy} onClick={() => onExport(run, 'json')}>
									Export JSON report
								</Button>
								<Button small variant="ghost" disabled={busy} onClick={() => onExport(run, 'junit')}>
									Export JUnit
								</Button>
							</div>
						</div>
						{run.error && <Notice error>{run.error}</Notice>}
						<div className="rr-eval-progress" role="status">
							<span>
								{run.summary.completed} / {run.summary.total} trials completed
							</span>
							<span>{isActiveRun(run) ? 'Updating automatically' : `Gate: ${run.summary.gate}`}</span>
						</div>
						<progress aria-label="Evaluation trial progress" value={run.summary.completed} max={Math.max(1, run.summary.total)} />
						<div className="rr-eval-metrics">
							{(['pass', 'fail', 'error', 'incomplete', 'abstain'] as const).map((status) => (
								<div className={`rr-eval-metric rr-eval-metric-${status}`} key={status}>
									<span>{status}</span>
									<strong>{run.summary[status]}</strong>
								</div>
							))}
							<div className="rr-eval-metric">
								<span>Pass rate</span>
								<strong>{Number.isFinite(run.summary.passRate) && run.summary.total > 0 ? `${(run.summary.passRate * 100).toFixed(1)}%` : 'Unavailable'}</strong>
							</div>
							<div className="rr-eval-metric">
								<span>Duration</span>
								<strong>{durationLabel(run.summary.durationMs)}</strong>
							</div>
							<div className="rr-eval-metric">
								<span>Cost</span>
								<strong>{run.summary.costUsd == null || !Number.isFinite(run.summary.costUsd) ? 'Unavailable' : `$${run.summary.costUsd.toFixed(4)}`}</strong>
							</div>
						</div>
						<p className="rr-eval-muted">Pass rate uses all planned trials, including errors, incomplete results, and abstentions.</p>
						<details>
							<summary>Execution identity & target snapshot</summary>
							<dl className="rr-eval-identities">
								<dt>Run ID</dt>
								<dd>{run.id}</dd>
								<dt>Pipeline hash</dt>
								<dd>{run.pipelineHash}</dd>
								<dt>Dataset hash</dt>
								<dd>{run.datasetHash}</dd>
								<dt>Scorer hash</dt>
								<dd>{run.scorerHash}</dd>
								<dt>Created</dt>
								<dd>{dateLabel(run.createdAt)}</dd>
								{run.startedAt && (
									<>
										<dt>Started</dt>
										<dd>{dateLabel(run.startedAt)}</dd>
									</>
								)}
								{run.finishedAt && (
									<>
										<dt>Finished</dt>
										<dd>{dateLabel(run.finishedAt)}</dd>
									</>
								)}
							</dl>
							<Button small variant="ghost" onClick={() => downloadArtifact(`evaluation-${run.evaluationId}-r${run.revision}.json`, pretty(run.spec))}>
								Export executed spec
							</Button>
							<pre className="rr-eval-code-block">{pretty(run.spec.pipeline)}</pre>
						</details>
					</section>
					<section className="rr-eval-section">
						<div className="rr-eval-section-heading">
							<div>
								<h3>Baseline comparison</h3>
								<p>{run.baselineRunId ? `Recorded baseline: ${run.baselineRunId}` : 'This run did not request a baseline comparison.'}</p>
							</div>
						</div>
						{run.comparison ? (
							<>
								{run.comparison.compatible ? (
									<>
										<div className="rr-eval-actions">
											<Status status="compatible" />
											<span>
												{run.comparison.regressions} regressions · {run.comparison.improvements} improvements · {run.comparison.unchanged} unchanged
											</span>
										</div>
										{run.comparison.cases.length > 0 && (
											<div className="rr-eval-table-wrap">
												<table className="rr-eval-table">
													<caption className="rr-eval-sr-only">Baseline case changes</caption>
													<thead>
														<tr>
															<th scope="col">Case / trial</th>
															<th scope="col">Baseline</th>
															<th scope="col">Candidate</th>
															<th scope="col">Change</th>
														</tr>
													</thead>
													<tbody>
														{run.comparison.cases.map((item) => (
															<tr key={`${item.caseId}:${item.trial}`}>
																<th scope="row">
																	{item.caseId} / {item.trial}
																</th>
																<td>
																	<Status status={item.baselineStatus} />
																</td>
																<td>
																	<Status status={item.candidateStatus} />
																</td>
																<td>{item.change}</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
										)}
									</>
								) : (
									<Notice>
										These runs are incompatible and cannot certify a regression gate.
										<ul>
											{run.comparison.reasons.map((reason, index) => (
												<li key={index}>{reason}</li>
											))}
										</ul>
									</Notice>
								)}
								<details open>
									<summary>Reported pipeline changes ({run.comparison.pipelineChanges.length})</summary>
									{run.comparison.pipelineChanges.length ? (
										run.comparison.pipelineChanges.map((change, index) => (
											<pre key={index} className="rr-eval-code-block">
												{typeof change === 'string' ? change : pretty(change)}
											</pre>
										))
									) : (
										<p className="rr-eval-muted">No pipeline changes reported by the server.</p>
									)}
								</details>
								{baseline && (
									<details>
										<summary>Baseline execution identity</summary>
										<dl className="rr-eval-identities">
											<dt>Pipeline hash</dt>
											<dd>{baseline.pipelineHash}</dd>
											<dt>Dataset hash</dt>
											<dd>{baseline.datasetHash}</dd>
											<dt>Scorer hash</dt>
											<dd>{baseline.scorerHash}</dd>
											<dt>Environment</dt>
											<dd>{baseline.spec.environment}</dd>
											<dt>Source / input mode</dt>
											<dd>
												{baseline.spec.source} / {baseline.spec.inputMode}
											</dd>
										</dl>
									</details>
								)}
							</>
						) : (
							<p className="rr-eval-muted">{run.baselineRunId ? 'The server has not returned comparison evidence.' : 'Choose a baseline above, then start a new run to compare.'}</p>
						)}
					</section>
					<section className="rr-eval-section">
						<div className="rr-eval-section-heading">
							<div>
								<h3>Case results</h3>
								<p>Open a case to inspect expected vs actual output, scorer reasons, and captured traces.</p>
							</div>
						</div>
						<div className="rr-eval-form-grid">
							<TextField label="Find result cases" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
							<SelectField label="Filter by outcome" value={filter} onChange={(event) => setFilter(event.target.value)}>
								<option value="all">All outcomes</option>
								{['pending', 'running', 'pass', 'fail', 'error', 'incomplete', 'abstain'].map((status) => (
									<option key={status}>{status}</option>
								))}
							</SelectField>
						</div>
						<div className="rr-eval-table-wrap">
							<table className="rr-eval-table">
								<caption className="rr-eval-sr-only">Run case results</caption>
								<thead>
									<tr>
										<th scope="col">Case</th>
										<th scope="col">Trial</th>
										<th scope="col">Outcome</th>
										<th scope="col">Duration</th>
										<th scope="col">Output</th>
									</tr>
								</thead>
								<tbody>
									{filtered.map((item) => (
										<tr key={item.id}>
											<th scope="row">
												<button className="rr-eval-link" onClick={() => setCaseId(item.id)}>
													{item.name}
												</button>
												<small>{item.caseId}</small>
											</th>
											<td>{item.trial}</td>
											<td>
												<Status status={item.status} />
											</td>
											<td>{durationLabel(item.durationMs)}</td>
											<td>
												<span className="rr-eval-preview">{item.output === undefined ? 'No output' : typeof item.output === 'string' ? item.output : pretty(item.output)}</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{filtered.length === 0 && <Empty title="No case results to show">{run.cases.length ? 'Try another filter.' : 'Results will appear as the server completes trials.'}</Empty>}
					</section>
				</>
			)}
			<DetailPanel open={Boolean(activeCase)} onClose={() => setCaseId(null)} title={activeCase?.name || 'Case detail'} subtitle={activeCase ? `Case ${activeCase.caseId} · Trial ${activeCase.trial}` : undefined} contained width={660} minWidth={280} busy={busy}>
				{activeCase && run && <CaseDetail key={`${run.id}:${activeCase.id}`} item={activeCase} run={run} busy={busy} onReview={onReview} onOpenTrace={onOpenTrace} onRefresh={onRefresh} requestError={requestError} />}
			</DetailPanel>
		</div>
	);
}
