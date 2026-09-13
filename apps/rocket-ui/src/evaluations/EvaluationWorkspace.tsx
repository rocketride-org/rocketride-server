import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfirmDialog, TabControl } from 'shell';
import AssistantPanel from './AssistantPanel';
import ResultsPanel from './ResultsPanel';
import SpecEditor from './SpecEditor';
import { EvaluationApi, EvaluationApiError, downloadArtifact, retryablePollError } from './api';
import { dateLabel, Notice, SelectField, Status, TextArea } from './controls';
import { clone, newSpec, parseSpec, pretty, same, validateSpec } from './spec';
import { isActiveRun, type Capabilities, type CaseResult, type Evaluation, type EvaluationSpec, type EvaluationWorkspaceProps, type Revision, type Run, type HumanReviewStatus } from './types';
import { mergeRuns, reviewRequest } from './state';
import './evaluations.css';

export type { EvaluationWorkspaceProps, TraceLocator } from './types';

const message = (reason: unknown): string => (reason instanceof Error ? reason.message : 'The evaluation request failed.');

function JsonEditor({ spec, disabled, onApply, onDirty }: { spec: EvaluationSpec; disabled: boolean; onApply: (spec: EvaluationSpec) => void; onDirty: (dirty: boolean) => void }): React.ReactElement {
	const [text, setText] = useState(() => pretty(spec));
	const [error, setError] = useState('');
	const fileInput = useRef<HTMLInputElement>(null);
	const [reading, setReading] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		setText(pretty(spec));
		setError('');
		onDirty(false);
	}, [spec, onDirty]);
	const change = (value: string): void => {
		setText(value);
		onDirty(value !== pretty(spec));
	};
	return (
		<section className="rr-eval-section rr-eval-stack">
			<div className="rr-eval-section-heading">
				<div>
					<h3>Versioned spec JSON</h3>
					<p>Inspect or edit the same spec used by the API, SDK, CLI, and MCP tools. Apply updates the draft; save creates a revision.</p>
				</div>
				<div className="rr-eval-actions">
					<Button small variant="ghost" disabled={disabled || reading} onClick={() => fileInput.current?.click()}>
						Import spec JSON
					</Button>
					<Button small variant="ghost" onClick={() => downloadArtifact('evaluation-editor.json', text)}>
						Export editor text
					</Button>
				</div>
			</div>
			<input
				hidden
				ref={fileInput}
				type="file"
				accept=".json,application/json"
				aria-label="Import evaluation spec"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = '';
					if (!file) return;
					if (file.size > 1024 * 1024) {
						setError('The spec must be one MiB or smaller.');
						return;
					}
					setReading(true);
					void file
						.text()
						.then((value) => {
							if (mounted.current) change(value);
						})
						.catch((reason: unknown) => {
							if (mounted.current) setError(message(reason));
						})
						.finally(() => {
							if (mounted.current) setReading(false);
						});
				}}
			/>
			<TextArea label="Evaluation spec JSON" className="rr-eval-code" rows={24} spellCheck={false} value={text} disabled={disabled || reading} onChange={(event) => change(event.target.value)} />
			{error && <Notice error>{error}</Notice>}
			<div className="rr-eval-actions">
				<Button
					variant="secondary"
					disabled={disabled || reading || text === pretty(spec)}
					onClick={() => {
						try {
							onApply(parseSpec(text, spec));
							setError('');
						} catch (reason) {
							setError(message(reason));
						}
					}}
				>
					Apply JSON to draft
				</Button>
				<Button
					variant="ghost"
					disabled={disabled || text === pretty(spec)}
					onClick={() => {
						change(pretty(spec));
						setError('');
					}}
				>
					Reset editor to draft
				</Button>
			</div>
			<p className="rr-eval-muted">The target snapshot is preserved. Import cases through the editor or change the target with “Use current canvas snapshot”. New or changed references require review.</p>
		</section>
	);
}

function Workspace({ project, projectName, client, onOpenTrace }: EvaluationWorkspaceProps): React.ReactElement {
	const api = useMemo(() => new EvaluationApi(client), [client]);
	const [spec, setSpec] = useState(() => newSpec(project, projectName));
	const initial = useRef(spec);
	const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
	const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
	const [revisions, setRevisions] = useState<Revision[]>([]);
	const [runs, setRuns] = useState<Run[]>([]);
	const [selectedRunId, setSelectedRunId] = useState('');
	const [baselineId, setBaselineId] = useState('');
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [capabilityError, setCapabilityError] = useState('');
	const [listError, setListError] = useState('');
	const [pollError, setPollError] = useState('');
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [conflict, setConflict] = useState(false);
	const [busy, setBusy] = useState('');
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	const [tab, setTab] = useState('definition');
	const [jsonDirty, setJsonDirty] = useState(false);
	const [fieldPending, setFieldPending] = useState(false);
	const [editorEpoch, setEditorEpoch] = useState(0);
	const [pendingNavigation, setPendingNavigation] = useState<{ id: string } | null>(null);
	const action = useRef<AbortController | null>(null);
	const runRequest = useRef<{ signature: string; key: string } | null>(null);
	const dirty = !same(spec, evaluation?.spec ?? initial.current);
	const projectId = spec.projectId;
	const validation = useMemo(() => validateSpec(spec), [spec]);
	const activeIds = runs
		.filter(isActiveRun)
		.map((run) => run.id)
		.sort()
		.join(',');
	const locked = Boolean(busy);

	useEffect(() => () => action.current?.abort(), []);
	useEffect(() => {
		if (!dirty && !jsonDirty && !fieldPending) return;
		const beforeUnload = (event: BeforeUnloadEvent): void => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', beforeUnload);
		return () => window.removeEventListener('beforeunload', beforeUnload);
	}, [dirty, jsonDirty, fieldPending]);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setCapabilityError('');
		setListError('');
		setCapabilities(null);
		void Promise.allSettled([api.capabilities(controller.signal), projectId ? api.list(projectId, controller.signal) : Promise.resolve({ evaluations: [] as Evaluation[] })]).then(([caps, saved]) => {
			if (controller.signal.aborted) return;
			if (caps.status === 'fulfilled') setCapabilities(caps.value);
			else setCapabilityError(message(caps.reason));
			if (saved.status === 'fulfilled') setEvaluations(saved.value.evaluations);
			else setListError(message(saved.reason));
			setLoading(false);
		});
		return () => controller.abort();
	}, [api, projectId, refresh]);

	useEffect(() => {
		setPollError('');
		if (!activeIds) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let delay = 2000;
		const pendingIds = new Set(activeIds.split(','));
		const stopped: string[] = [];
		const poll = async (): Promise<void> => {
			const ids = [...pendingIds];
			const results = await Promise.allSettled(ids.map((id) => api.run(id, controller.signal)));
			if (controller.signal.aborted) return;
			const received: Run[] = [];
			const failures: string[] = [];
			for (const [index, result] of results.entries()) {
				if (result.status === 'fulfilled') {
					received.push(result.value.run);
					if (!isActiveRun(result.value.run)) pendingIds.delete(ids[index]);
				} else if (!retryablePollError(result.reason)) {
					pendingIds.delete(ids[index]);
					stopped.push(message(result.reason));
				} else failures.push(message(result.reason));
			}
			setRuns((current) => mergeRuns(current, received));
			delay = failures.length ? Math.min(delay * 2, 30000) : 2000;
			setPollError([stopped.length ? `Updates stopped for an inaccessible run: ${stopped[0]} Restore access and reload to resume. The last report is unchanged; execution may still be active.` : '', failures.length ? `Live updates failed: ${failures[0]} Retrying in ${delay / 1000}s.` : ''].filter(Boolean).join(' '));
			if (!pendingIds.size) return;
			timer = setTimeout(() => {
				void poll();
			}, delay);
		};
		timer = setTimeout(() => {
			void poll();
		}, delay);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [api, activeIds]);

	const perform = async (label: string, work: (signal: AbortSignal) => Promise<void>, specWrite = false): Promise<boolean> => {
		if (action.current) return false;
		const controller = new AbortController();
		action.current = controller;
		setBusy(label);
		setError('');
		setNotice('');
		try {
			await work(controller.signal);
			return !controller.signal.aborted;
		} catch (reason) {
			if (!controller.signal.aborted) {
				setError(message(reason));
				if (specWrite && reason instanceof EvaluationApiError && reason.status === 409) setConflict(true);
			}
			return false;
		} finally {
			action.current = null;
			if (!controller.signal.aborted) setBusy('');
		}
	};
	const remember = (value: Evaluation): void => setEvaluations((current) => [value, ...current.filter((item) => item.id !== value.id)]);
	const open = (id: string): void => {
		if (!id) {
			const next = newSpec(project, projectName);
			initial.current = next;
			setSpec(next);
			setEvaluation(null);
			setRevisions([]);
			setRuns([]);
			setSelectedRunId('');
			setBaselineId('');
			setJsonDirty(false);
			setConflict(false);
			setError('');
			setNotice('');
			setTab('definition');
			setEditorEpoch((value) => value + 1);
			runRequest.current = null;
			return;
		}
		void perform('Loading evaluation…', async (signal) => {
			const result = await api.detail(id, signal);
			if (signal.aborted) return;
			if (result.evaluation.projectId !== projectId) throw new Error('The selected evaluation belongs to another pipeline.');
			setEvaluation(result.evaluation);
			setSpec(clone(result.evaluation.spec));
			setRevisions(result.revisions);
			remember(result.evaluation);
			setRuns([]);
			setSelectedRunId('');
			setBaselineId('');
			setConflict(false);
			setJsonDirty(false);
			setEditorEpoch((value) => value + 1);
			runRequest.current = null;
			const history = await api.runs(id, signal);
			if (!signal.aborted) {
				const sorted = mergeRuns([], history.runs);
				setRuns(sorted);
				setSelectedRunId(sorted[0]?.id ?? '');
			}
		});
	};
	const navigate = (id: string): void => {
		if (locked) return;
		if (dirty || jsonDirty || fieldPending) setPendingNavigation({ id });
		else open(id);
	};
	const updateDraft = useCallback((next: EvaluationSpec): void => {
		setSpec(next);
		setNotice('');
	}, []);
	const save = (): void => {
		if (validation.length || jsonDirty || fieldPending || conflict || (!dirty && evaluation)) return;
		void perform(
			'Saving revision…',
			async (signal) => {
				const result = await api.save(spec, evaluation, signal);
				if (signal.aborted) return;
				setEvaluation(result.evaluation);
				setSpec(clone(result.evaluation.spec));
				remember(result.evaluation);
				setNotice(`Saved revision ${result.evaluation.revision}. Run this saved revision when you are ready.`);
				// Fetch the actual server revision hash; never synthesize revision evidence.
				try {
					const detail = await api.detail(result.evaluation.id, signal);
					if (!signal.aborted) setRevisions(detail.revisions);
				} catch (reason) {
					if (!signal.aborted) setError(`Revision saved, but revision history could not refresh: ${message(reason)}`);
				}
			},
			true
		);
	};
	const runBlockers = [...validation];
	if (!evaluation) runBlockers.push('Save this evaluation before running.');
	else if (dirty || jsonDirty) runBlockers.push('Save the draft and apply pending JSON edits before running.');
	if (fieldPending) runBlockers.push('Apply or reset the judge pipeline editor and finish any case import before running.');
	if (conflict) runBlockers.push('Reload the latest revision to resolve the save conflict.');
	if (!capabilities) runBlockers.push('Evaluation capabilities must load before a run can start.');
	else {
		if (!capabilities.environments.some((item) => item.id === spec.environment && item.available)) runBlockers.push(`${spec.environment} execution is unavailable on this server.`);
		const unsupported = spec.scorers.filter((item) => !capabilities.scorerKinds.includes(item.kind));
		if (unsupported.length) runBlockers.push(`Unavailable scorers: ${unsupported.map((item) => item.name).join(', ')}.`);
	}
	if (!spec.cases.some((item) => item.approved)) runBlockers.push('Review at least one case before running.');
	if (!spec.scorers.length) runBlockers.push('Add at least one scorer before running.');
	const startRun = (): void => {
		if (!evaluation || runBlockers.length) return;
		const signature = `${evaluation.id}:${evaluation.revision}:${baselineId || evaluation.baselineRunId || ''}`;
		if (runRequest.current?.signature !== signature) runRequest.current = { signature, key: crypto.randomUUID() };
		const idempotencyKey = runRequest.current.key;
		void perform('Starting run…', async (signal) => {
			const result = await api.request<{ run: Run }>(`/evaluations/${encodeURIComponent(evaluation.id)}/runs`, { revision: evaluation.revision, idempotencyKey, ...(baselineId ? { baselineRunId: baselineId } : {}) }, signal);
			if (signal.aborted) return;
			setRuns((current) => mergeRuns(current, [result.run]));
			setSelectedRunId(result.run.id);
			setTab('results');
			setNotice(`Run ${result.run.id} accepted by the server.`);
			runRequest.current = null;
		});
	};
	const refreshRuns = (): void => {
		if (!evaluation) return;
		void perform('Refreshing runs…', async (signal) => {
			const result = await api.runs(evaluation.id, signal);
			if (!signal.aborted) {
				setRuns((current) => mergeRuns(current, result.runs));
				setSelectedRunId((current) => current || mergeRuns([], result.runs)[0]?.id || '');
				setPollError('');
			}
		});
	};
	const review = (run: Run, item: CaseResult, scorerId: string, status: HumanReviewStatus, reason: string): Promise<boolean> =>
		perform('Saving review…', async (signal) => {
			try {
				const body = reviewRequest(run, item, scorerId, status, reason);
				const result = await api.request<{ run: Run }>(`/runs/${encodeURIComponent(run.id)}/review`, body, signal);
				if (!signal.aborted) setRuns((current) => mergeRuns(current, [result.run]));
			} catch (reason) {
				if (reason instanceof EvaluationApiError && reason.status === 409) throw new Error(`${reason.message} Refresh runs and inspect the latest evidence before submitting again. Your review text is retained.`);
				throw reason;
			}
		});

	return (
		<div className="rr-evaluations">
			<TabControl
				menu={{
					entries: [
						{ id: 'definition', label: 'Definition' },
						{ id: 'results', label: 'Results', count: runs.length },
						{ id: 'assistant', label: 'Assistant' },
						{ id: 'json', label: 'Spec JSON' },
					],
				}}
				activeId={tab}
				onSelect={setTab}
			/>
			<div className="rr-eval-scroll">
				<header className="rr-eval-header">
					<div>
						<h2>Evaluations</h2>
						<p>Test {projectName || 'this pipeline'} against reviewed cases and inspect the evidence.</p>
					</div>
					<div className="rr-eval-actions">
						<Status status={dirty || jsonDirty || fieldPending ? 'unsaved' : evaluation ? 'saved' : 'draft'} />
						<Button variant="ghost" onClick={() => downloadArtifact(`${spec.name || 'evaluation'}.json`, pretty(spec))}>
							Export draft
						</Button>
						<Button variant="secondary" disabled={locked || jsonDirty || fieldPending || conflict || validation.length > 0 || Boolean(evaluation && !dirty)} onClick={save}>
							{busy === 'Saving revision…' ? busy : evaluation ? 'Save revision' : 'Save evaluation'}
						</Button>
						<Button disabled={locked || runBlockers.length > 0} title={runBlockers.join('\n')} onClick={startRun}>
							{busy === 'Starting run…' ? busy : 'Run saved revision'}
						</Button>
					</div>
				</header>
				<div className="rr-eval-library">
					<SelectField label="Saved evaluation" value={evaluation?.id ?? ''} disabled={locked || loading} onChange={(event) => navigate(event.target.value)}>
						<option value="">New evaluation draft</option>
						{evaluations.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name} · r{item.revision}
							</option>
						))}
					</SelectField>
					<div className="rr-eval-actions">
						<Button small variant="ghost" disabled={locked} onClick={() => navigate('')}>
							New evaluation
						</Button>
						<Button small variant="ghost" disabled={locked || loading} onClick={() => setRefresh((value) => value + 1)}>
							{loading ? 'Checking server…' : 'Refresh availability & list'}
						</Button>
						{evaluation && (
							<Button small variant="ghost" disabled={locked} onClick={() => navigate(evaluation.id)}>
								Reload latest revision
							</Button>
						)}
					</div>
				</div>
				{busy && (
					<p role="status" className="rr-eval-muted">
						{busy}
					</p>
				)}
				{!projectId && <Notice>Save this pipeline in Design before saving an evaluation.</Notice>}
				{capabilityError && <Notice error>Evaluation availability could not be verified: {capabilityError} Draft editing and export remain available. Use “Refresh availability & list” to retry.</Notice>}
				{listError && <Notice error>Saved evaluations could not be loaded: {listError} Use “Refresh availability & list” to retry.</Notice>}
				{error && <Notice error>{error}</Notice>}
				{conflict && <Notice>A newer revision exists. Your draft is preserved. Export it, then reload the latest revision and reapply your changes before saving.</Notice>}
				{notice && <Notice>{notice}</Notice>}
				{jsonDirty && <Notice>The JSON editor contains unapplied changes. Apply or reset them in Spec JSON before editing the definition, applying an assistant proposal, saving, or running.</Notice>}
				{fieldPending && <Notice>Finish the case import or apply/reset the judge pipeline JSON in Definition before saving, running, or applying another spec.</Notice>}
				{runBlockers.length > 0 && (
					<details className="rr-eval-help">
						<summary>Before you can run ({runBlockers.length})</summary>
						<ul>
							{runBlockers.map((item, index) => (
								<li key={index}>{item}</li>
							))}
						</ul>
					</details>
				)}
				{spec.cases.some((item) => !item.approved) && <p className="rr-eval-muted">{spec.cases.filter((item) => !item.approved).length} unreviewed cases remain in this cohort. Their missing review evidence cannot certify a pass.</p>}
				<div hidden={tab !== 'definition'} role="tabpanel" aria-label="Evaluation definition">
					<SpecEditor key={editorEpoch} spec={spec} project={project} capabilities={capabilities} disabled={locked || jsonDirty} onChange={updateDraft} onPendingChange={setFieldPending} />
					{evaluation && (
						<details className="rr-eval-section">
							<summary>
								Saved revisions ({revisions.length}) · Editing revision {evaluation.revision}
							</summary>
							<div className="rr-eval-table-wrap">
								<table className="rr-eval-table">
									<caption className="rr-eval-sr-only">Saved evaluation revisions</caption>
									<thead>
										<tr>
											<th scope="col">Revision</th>
											<th scope="col">Saved</th>
											<th scope="col">Spec hash</th>
										</tr>
									</thead>
									<tbody>
										{[...revisions]
											.sort((a, b) => b.revision - a.revision)
											.map((item) => (
												<tr key={item.revision}>
													<th scope="row">{item.revision}</th>
													<td>{dateLabel(item.createdAt)}</td>
													<td className="rr-eval-code">{item.specHash}</td>
												</tr>
											))}
									</tbody>
								</table>
							</div>
						</details>
					)}
				</div>
				<div hidden={tab !== 'results'} role="tabpanel" aria-label="Evaluation results">
					{pollError && <Notice error>{pollError}</Notice>}
					<ResultsPanel
						key={editorEpoch}
						evaluation={evaluation}
						runs={runs}
						selectedRunId={selectedRunId}
						onSelectRun={setSelectedRunId}
						baselineId={baselineId}
						onBaselineSelect={setBaselineId}
						onRefresh={refreshRuns}
						onReview={review}
						busy={locked}
						requestError={error}
						onOpenTrace={onOpenTrace}
						onCancel={(id) => {
							void perform('Cancelling run…', async (signal) => {
								const result = await api.request<{ run: Run }>(`/runs/${encodeURIComponent(id)}/cancel`, {}, signal);
								if (!signal.aborted) {
									setRuns((current) => mergeRuns(current, [result.run]));
									setNotice(`Server reports run ${result.run.status}.`);
								}
							});
						}}
						onSetBaseline={(id) => {
							if (!evaluation) return;
							void perform('Setting baseline…', async (signal) => {
								const result = await api.request<{ evaluation: Evaluation }>(`/evaluations/${encodeURIComponent(evaluation.id)}/baseline`, { runId: id }, signal);
								if (!signal.aborted) {
									setEvaluation((current) => (current ? { ...current, baselineRunId: result.evaluation.baselineRunId } : current));
									remember(result.evaluation);
									setBaselineId('');
									setNotice('Baseline saved for future runs.');
								}
							});
						}}
						onExport={(run, format) => {
							void perform('Downloading report…', async (signal) => {
								const report = await api.report(run.id, format, signal);
								if (!signal.aborted) downloadArtifact(`evaluation-run-${run.id}.${format === 'json' ? 'json' : 'xml'}`, report);
							});
						}}
					/>
				</div>
				<div hidden={tab !== 'assistant'} role="tabpanel" aria-label="Evaluation assistant">
					<AssistantPanel key={editorEpoch} api={api} spec={spec} capabilities={capabilities} disabled={locked || jsonDirty || fieldPending} onApply={updateDraft} />
				</div>
				<div hidden={tab !== 'json'} role="tabpanel" aria-label="Evaluation spec JSON">
					<JsonEditor key={editorEpoch} spec={spec} disabled={locked || fieldPending} onApply={updateDraft} onDirty={setJsonDirty} />
				</div>
			</div>
			{pendingNavigation && (
				<ConfirmDialog
					title="Leave this evaluation draft?"
					message="Unsaved draft changes and unapplied JSON text will be discarded. Export any changes you want to retain before continuing."
					confirmLabel="Discard changes and continue"
					cancelLabel="Keep editing"
					destructive
					onCancel={() => setPendingNavigation(null)}
					onConfirm={() => {
						const target = pendingNavigation.id;
						setPendingNavigation(null);
						open(target);
					}}
				/>
			)}
		</div>
	);
}

/** Reset connection/project state at the boundary; canvas edits update the snapshot only on request. */
export default function EvaluationWorkspace(props: EvaluationWorkspaceProps): React.ReactElement {
	return <Workspace key={`${String(props.project.project_id ?? '')}:${props.client.getConnectionInfo().uri}`} {...props} />;
}
