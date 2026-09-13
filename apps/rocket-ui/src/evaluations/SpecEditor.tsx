import React, { useEffect, useState } from 'react';
import { Button } from 'shell';
import CasesEditor from './CasesEditor';
import { Notice, SelectField, TextArea, TextField } from './controls';
import { clone, isRecord, pipelineSources, pretty, same } from './spec';
import { SCORER_KINDS, type Capabilities, type EvaluationSpec, type Scorer } from './types';

function JudgePipeline({ value, onChange, disabled, onDirty }: { value?: Record<string, unknown>; onChange: (value: Record<string, unknown> | undefined) => void; disabled: boolean; onDirty: (dirty: boolean) => void }): React.ReactElement {
	const [text, setText] = useState(value ? pretty(value) : '');
	const [error, setError] = useState('');
	return (
		<div>
			<TextArea
				label="Judge pipeline JSON"
				hint="A separate configured judge pipeline with components and source. Apply this field before saving the spec."
				rows={5}
				className="rr-eval-code"
				value={text}
				disabled={disabled}
				onChange={(event) => {
					setText(event.target.value);
					onDirty(event.target.value !== (value ? pretty(value) : ''));
				}}
			/>
			{error && <Notice error>{error}</Notice>}
			<Button
				small
				variant="ghost"
				disabled={disabled || text === (value ? pretty(value) : '')}
				onClick={() => {
					try {
						const parsed: unknown = text.trim() ? JSON.parse(text) : undefined;
						if (parsed !== undefined && !isRecord(parsed)) throw new Error('Judge pipeline must be a JSON object.');
						onChange(parsed);
						onDirty(false);
						setError('');
					} catch (reason) {
						setError(reason instanceof Error ? reason.message : 'Invalid JSON.');
					}
				}}
			>
				Apply judge pipeline
			</Button>
			<Button
				small
				variant="ghost"
				disabled={disabled || text === (value ? pretty(value) : '')}
				onClick={() => {
					setText(value ? pretty(value) : '');
					onDirty(false);
					setError('');
				}}
			>
				Reset judge editor
			</Button>
		</div>
	);
}

export default function SpecEditor({ spec, project, capabilities, disabled, onChange, onPendingChange }: { spec: EvaluationSpec; project: Record<string, unknown>; capabilities: Capabilities | null; disabled: boolean; onChange: (spec: EvaluationSpec) => void; onPendingChange: (pending: boolean) => void }): React.ReactElement {
	const [pendingJudges, setPendingJudges] = useState<Record<string, boolean>>({});
	const [importing, setImporting] = useState(false);
	const hasPending = importing || spec.scorers.some((scorer) => scorer.kind === 'llm_judge' && pendingJudges[scorer.id]);
	useEffect(() => {
		onPendingChange(hasPending);
	}, [hasPending, onPendingChange]);
	useEffect(() => () => onPendingChange(false), [onPendingChange]);
	const sources = pipelineSources(spec.pipeline);
	const patch = (change: Partial<EvaluationSpec>): void => onChange({ ...spec, ...change });
	const patchScorer = (id: string, change: Partial<Scorer>): void => patch({ scorers: spec.scorers.map((item) => (item.id === id ? { ...item, ...change } : item)) });
	return (
		<div className="rr-eval-stack">
			<fieldset className="rr-eval-fields" disabled={disabled}>
				<section className="rr-eval-section">
					<div className="rr-eval-section-heading">
						<div>
							<h3>Evaluation definition</h3>
							<p>A versioned snapshot of this pipeline and its reference tests.</p>
						</div>
					</div>
					<div className="rr-eval-form-grid">
						<TextField label="Evaluation name" value={spec.name} required onChange={(event) => patch({ name: event.target.value })} />
						<TextField label="Dataset name" value={spec.datasetName} required onChange={(event) => patch({ datasetName: event.target.value })} />
						<SelectField label="Pipeline source" value={spec.source} onChange={(event) => patch({ source: event.target.value })}>
							<option value="">Select a source</option>
							{spec.source && !sources.some((item) => item.id === spec.source) && <option value={spec.source}>{spec.source} (not in snapshot sources)</option>}
							{sources.map((item) => (
								<option value={item.id} key={item.id}>
									{item.name} · {item.id}
								</option>
							))}
						</SelectField>
						<SelectField label="Input mode" value={spec.inputMode} onChange={(event) => patch({ inputMode: event.target.value as EvaluationSpec['inputMode'] })}>
							<option value="chat">Chat</option>
							<option value="text">Text</option>
						</SelectField>
						<SelectField label="Environment" value={spec.environment} hint="Availability is configured on the server." onChange={(event) => patch({ environment: event.target.value as EvaluationSpec['environment'] })}>
							{(['development', 'staging'] as const).map((id) => {
								const environment = capabilities?.environments.find((item) => item.id === id);
								return (
									<option key={id} value={id} disabled={!environment?.available}>
										{environment?.label ?? id}
										{!environment?.available ? (capabilities ? ' (unavailable)' : ' (checking availability)') : ''}
									</option>
								);
							})}
						</SelectField>
						<TextField label="Repetitions per case" type="number" min={1} max={10} step={1} value={Number.isFinite(spec.repetitions) ? spec.repetitions : ''} onChange={(event) => patch({ repetitions: event.target.valueAsNumber })} />
					</div>
					<div className="rr-eval-snapshot">
						<div>
							<strong>Target pipeline snapshot</strong>
							<p className="rr-eval-muted">
								{Array.isArray(spec.pipeline.components) ? spec.pipeline.components.length : 0} nodes · {spec.projectId || 'Save the pipeline to assign a project ID'}
							</p>
							<span className="rr-eval-muted">{same(spec.pipeline, project) ? 'Matches the current canvas.' : 'The current canvas differs from this evaluation snapshot.'}</span>
						</div>
						<Button small variant="ghost" disabled={disabled || same(spec.pipeline, project)} onClick={() => patch({ pipeline: clone(project) })}>
							Use current canvas snapshot
						</Button>
					</div>
					{sources.length === 0 && <Notice>Add a source node in Design, then use the current canvas snapshot.</Notice>}
				</section>
				<section className="rr-eval-section">
					<div className="rr-eval-section-heading">
						<div>
							<h3>
								Scorers <span className="rr-eval-count">{spec.scorers.length}</span>
							</h3>
							<p>Missing evidence is incomplete. Human scoring starts as abstain.</p>
						</div>
						<Button small variant="secondary" disabled={disabled} onClick={() => patch({ scorers: [...spec.scorers, { id: crypto.randomUUID(), name: 'Reference match', kind: 'contains' }] })}>
							Add scorer
						</Button>
					</div>
					{spec.scorers.map((scorer, index) => (
						<div className="rr-eval-scorer" key={scorer.id}>
							<div className="rr-eval-section-heading">
								<h4>Scorer {index + 1}</h4>
								<Button small variant="ghost" disabled={disabled} onClick={() => patch({ scorers: spec.scorers.filter((item) => item.id !== scorer.id) })}>
									Remove scorer {index + 1}
								</Button>
							</div>
							<div className="rr-eval-form-grid">
								<TextField label="Scorer name" value={scorer.name} onChange={(event) => patchScorer(scorer.id, { name: event.target.value })} />
								<SelectField label="Scorer kind" value={scorer.kind} onChange={(event) => patchScorer(scorer.id, { kind: event.target.value as Scorer['kind'] })}>
									{SCORER_KINDS.map((kind) => (
										<option key={kind} value={kind} disabled={Boolean(capabilities && !capabilities.scorerKinds.includes(kind))}>
											{kind}
											{capabilities && !capabilities.scorerKinds.includes(kind) ? ' (unavailable)' : ''}
										</option>
									))}
								</SelectField>
								{['equals', 'contains', 'not_contains', 'json'].includes(scorer.kind) && <TextField label="Expected override (optional)" hint="When omitted, uses each case reference." value={scorer.expected ?? ''} onChange={(event) => patchScorer(scorer.id, { expected: event.target.value || undefined })} />}
								{scorer.kind === 'json' && <TextField label="JSON path (optional)" placeholder="answer.category" value={scorer.path ?? ''} onChange={(event) => patchScorer(scorer.id, { path: event.target.value || undefined })} />}
								{['latency', 'llm_judge'].includes(scorer.kind) && <TextField label={scorer.kind === 'latency' ? 'Latency threshold (ms)' : 'Judge score threshold'} type="number" step="any" value={scorer.threshold ?? ''} onChange={(event) => patchScorer(scorer.id, { threshold: event.target.value === '' ? undefined : event.target.valueAsNumber })} />}
							</div>
							{scorer.kind === 'llm_judge' && (
								<>
									<TextArea label="Judge rubric" rows={3} value={scorer.rubric ?? ''} onChange={(event) => patchScorer(scorer.id, { rubric: event.target.value || undefined })} />
									<JudgePipeline key={pretty(scorer.judgePipeline)} value={scorer.judgePipeline} disabled={disabled} onDirty={(pending) => setPendingJudges((current) => ({ ...current, [scorer.id]: pending }))} onChange={(judgePipeline) => patchScorer(scorer.id, { judgePipeline })} />
								</>
							)}
							{scorer.kind === 'human' && <p className="rr-eval-muted">Review real outputs in the Results case panel after a run finishes.</p>}
						</div>
					))}
				</section>
				<section className="rr-eval-section">
					<div className="rr-eval-section-heading">
						<div>
							<h3>Pass criteria</h3>
							<p>Pass rate includes every planned trial. Empty and unreviewed cohorts cannot certify a pass.</p>
						</div>
					</div>
					<div className="rr-eval-form-grid">
						<TextField label="Minimum pass rate (%)" type="number" min={0} max={100} step="any" value={Number.isFinite(spec.passCriteria.minimumPassRate) ? spec.passCriteria.minimumPassRate * 100 : ''} onChange={(event) => patch({ passCriteria: { ...spec.passCriteria, minimumPassRate: event.target.valueAsNumber / 100 } })} />
						<TextField label="Maximum regressions" type="number" min={0} max={1000000} step={1} value={Number.isFinite(spec.passCriteria.maxRegressions) ? spec.passCriteria.maxRegressions : ''} onChange={(event) => patch({ passCriteria: { ...spec.passCriteria, maxRegressions: event.target.valueAsNumber } })} />
					</div>
				</section>
			</fieldset>
			<CasesEditor cases={spec.cases} disabled={disabled} onImporting={setImporting} onChange={(cases) => patch({ cases })} />
		</div>
	);
}
