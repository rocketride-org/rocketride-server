/** Managed evaluations v1 over bearer HTTP. No WebSocket, retries, or redirects. */
export type EvaluationVerdict = 'pass' | 'fail' | 'error' | 'incomplete' | 'abstain';
export interface EvaluationSpec {
	schemaVersion: 1;
	name: string;
	projectId: string;
	pipeline: Record<string, unknown>;
	source: string;
	inputMode: 'chat' | 'text';
	environment: 'development' | 'staging';
	datasetName: string;
	cases: Array<{ id: string; name: string; input: string; reference?: string; approved: boolean; tags?: string[]; provenance?: Record<string, unknown> }>;
	scorers: Array<{ id: string; name: string; kind: 'equals' | 'contains' | 'not_contains' | 'json' | 'latency' | 'llm_judge' | 'human'; expected?: string; path?: string; threshold?: number; rubric?: string; judgePipeline?: Record<string, unknown> }>;
	repetitions: number;
	passCriteria: { minimumPassRate: number; maxRegressions: number };
}
export interface ManagedEvaluation {
	id: string;
	name: string;
	projectId: string;
	revision: number;
	spec: EvaluationSpec;
	baselineRunId?: string;
	createdAt: string;
	updatedAt: string;
}
export interface EvaluationComparison {
	compatible: boolean;
	reasons: string[];
	regressions: number;
	improvements: number;
	unchanged: number;
	cases: Array<{ caseId: string; trial: number; baselineStatus: string; candidateStatus: string; change: string }>;
	pipelineChanges: unknown[];
}
export interface EvaluationRun {
	id: string;
	evaluationId: string;
	revision: number;
	name: string;
	status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	spec: EvaluationSpec;
	pipelineHash: string;
	datasetHash: string;
	scorerHash: string;
	baselineRunId?: string;
	baselineReportRevision?: number;
	reportRevision: number;
	summary: { total: number; completed: number; pass: number; fail: number; error: number; incomplete: number; abstain: number; passRate: number; durationMs: number; gate: 'pass' | 'fail' | 'incomplete'; costUsd: number | null };
	cases: Array<{
		id: string;
		caseId: string;
		name: string;
		trial: number;
		input: string;
		reference?: string;
		output?: string;
		status: EvaluationVerdict | 'pending' | 'running';
		durationMs: number;
		executionProjectId?: string;
		scores: Array<{ scorerId: string; name: string; status: EvaluationVerdict; score: number | null; reason: string; executionProjectId?: string; trace?: EvaluationTrace }>;
		trace?: EvaluationTrace;
		error?: string;
	}>;
	comparison?: EvaluationComparison;
	error?: string;
}
export interface EvaluationTrace {
	projectId: string;
	source: string;
	runKind?: 'dev' | 'deploy';
	environment?: 'development' | 'staging';
	traceId?: number;
	chapter?: number;
}
export interface EvaluationRunOptions {
	revision: number;
	idempotencyKey: string;
	baselineRunId?: string;
}
export interface EvaluationReview {
	caseId: string;
	caseResultId?: string;
	scorerId: string;
	status: 'pass' | 'fail' | 'abstain';
	reason: string;
	expectedReportRevision: number;
}
export interface EvaluationWaitOptions {
	timeout?: number;
	pollInterval?: number;
}
export interface EvaluationCapabilities {
	environments: Array<{ id: string; label: string; available: boolean }>;
	scorerKinds: string[];
	assistantAvailable: boolean;
}
export type EvaluationRunResponse = { run: EvaluationRun };

/** Safe failure metadata. Transport errors never include URLs or credentials. */
export class EvalsError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code = 'evals_error'
	) {
		super(message);
		this.name = 'EvalsError';
	}
}

export function redactEvalsText(text: string, credential: string): string {
	return (credential ? text.split(credential).join('[REDACTED]') : text).replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
}

function baseUrl(uri: string): string {
	try {
		if (!uri || /[\s\\]/.test(uri) || [...uri].some((character) => character.charCodeAt(0) < 32) || uri.includes('?') || uri.includes('#')) throw new Error();
		const url = new URL(uri.includes('://') ? uri : `http://${uri}`);
		if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.port === '0' || !['', '/task/service', '/evals/v1'].includes(url.pathname.replace(/\/+$/, ''))) throw new Error();
		url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
		return `${url.origin}/evals/v1`;
	} catch {
		throw new Error('Managed evaluations require an HTTP(S) server origin without credentials, query, or fragment');
	}
}

function id(value: string): string {
	if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..') throw new Error('A non-empty object ID is required');
	return encodeURIComponent(value);
}
function revision(value: number, name = 'revision'): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
function positive(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a positive finite number within the timer limit`);
}

/** ``client.evals``. Request/wait budgets and poll intervals are milliseconds. */
export class EvalsApi {
	constructor(
		private readonly connection: () => { uri: string; auth: string },
		readonly timeout = 30_000
	) {
		positive(timeout, 'timeout');
	}

	private async request<T>(method: string, path: string, body?: unknown, raw = false, timeout = this.timeout): Promise<T> {
		const { uri, auth } = this.connection();
		const url = baseUrl(uri) + path;
		if (!auth || /\s/.test(auth) || [...auth].some((character) => character.charCodeAt(0) < 32)) throw new Error('A bearer credential is required for managed evaluations');
		positive(timeout, 'timeout');
		const headers: Record<string, string> = { Authorization: `Bearer ${auth}`, Accept: raw ? 'application/xml' : 'application/json' };
		let payload: string | undefined;
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			try {
				payload = JSON.stringify(body, (_key, value) => {
					if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
					return value;
				});
			} catch {
				throw new Error('Request body must be strict JSON');
			}
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(timeout, this.timeout));
		let response: Response;
		let text: string;
		try {
			response = await fetch(url, { method, headers, body: payload, redirect: 'error', credentials: 'omit', signal: controller.signal });
			text = await response.text();
		} catch {
			throw new EvalsError(controller.signal.aborted ? 'Managed evaluation request timed out; no request was retried' : 'Managed evaluation request failed; no request was retried', undefined, controller.signal.aborted ? 'timeout' : 'transport_error');
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			let message = `Managed evaluation request failed (HTTP ${response.status})`;
			let code = 'http_error';
			try {
				const error = JSON.parse(text).error;
				if (typeof error?.message === 'string') message = error.message;
				if (typeof error?.code === 'string') code = error.code;
			} catch {
				/* Untrusted non-JSON bodies are never echoed. */
			}
			throw new EvalsError(redactEvalsText(message, auth), response.status, redactEvalsText(code, auth));
		}
		if (raw) return text as T;
		try {
			const result = JSON.parse(text);
			if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
			return result as T;
		} catch {
			throw new EvalsError('Managed evaluation response is invalid', undefined, 'invalid_response');
		}
	}

	capabilities(): Promise<EvaluationCapabilities> {
		return this.request('GET', '/capabilities');
	}
	list(projectId?: string): Promise<{ evaluations: ManagedEvaluation[] }> {
		return this.request('GET', '/evaluations' + (projectId === undefined ? '' : '?' + new URLSearchParams({ projectId })));
	}
	get(evaluationId: string): Promise<{ evaluation: ManagedEvaluation; revisions: Array<{ revision: number; createdAt: string; specHash: string }> }> {
		return this.request('GET', `/evaluations/${id(evaluationId)}`);
	}
	create(spec: EvaluationSpec): Promise<{ evaluation: ManagedEvaluation }> {
		return this.request('POST', '/evaluations', spec);
	}
	revise(evaluationId: string, spec: EvaluationSpec, expectedRevision: number): Promise<{ evaluation: ManagedEvaluation }> {
		revision(expectedRevision, 'expected-revision');
		return this.request('POST', `/evaluations/${id(evaluationId)}/revisions`, { spec, expectedRevision });
	}
	run(evaluationId: string, options: EvaluationRunOptions): Promise<EvaluationRunResponse> {
		revision(options.revision);
		id(options.idempotencyKey);
		if (options.baselineRunId !== undefined) id(options.baselineRunId);
		return this.request('POST', `/evaluations/${id(evaluationId)}/runs`, options);
	}
	runs(evaluationId?: string): Promise<{ runs: EvaluationRun[] }> {
		return this.request('GET', '/runs' + (evaluationId === undefined ? '' : '?' + new URLSearchParams({ evaluationId })));
	}
	status(runId: string): Promise<EvaluationRunResponse> {
		return this.request('GET', `/runs/${id(runId)}`);
	}
	cancel(runId: string): Promise<EvaluationRunResponse> {
		return this.request('POST', `/runs/${id(runId)}/cancel`, {});
	}
	baseline(evaluationId: string, runId: string): Promise<{ evaluation: ManagedEvaluation }> {
		id(runId);
		return this.request('POST', `/evaluations/${id(evaluationId)}/baseline`, { runId });
	}
	report(runId: string, format: 'junit'): Promise<string>;
	report(runId: string, format?: 'json'): Promise<Record<string, unknown>>;
	report(runId: string, format: 'json' | 'junit'): Promise<string | Record<string, unknown>>;
	report(runId: string, format: 'json' | 'junit' = 'json'): Promise<string | Record<string, unknown>> {
		if (!['json', 'junit'].includes(format)) throw new Error('Report format must be json or junit');
		return this.request('GET', `/runs/${id(runId)}/report?format=${format}`, undefined, format === 'junit');
	}
	async compare(runId: string): Promise<EvaluationRunResponse> {
		const result = await this.status(runId);
		if (!result.run?.comparison || typeof result.run.comparison !== 'object') throw new EvalsError('Run has no server comparison; create a run with baselineRunId', undefined, 'comparison_unavailable');
		return result;
	}
	review(runId: string, review: EvaluationReview): Promise<EvaluationRunResponse> {
		revision(review.expectedReportRevision, 'expected-report-revision');
		id(review.caseId);
		id(review.scorerId);
		if (review.caseResultId !== undefined) id(review.caseResultId);
		if (!['pass', 'fail', 'abstain'].includes(review.status) || typeof review.reason !== 'string' || !review.reason.trim()) throw new Error('Review needs a pass, fail, or abstain status and a reason');
		return this.request('POST', `/runs/${id(runId)}/review`, review);
	}
	assist(instruction: string, spec: EvaluationSpec): Promise<{ message: string; spec?: EvaluationSpec }> {
		return this.request('POST', '/assistant', { instruction, spec });
	}
	async wait(runId: string, { timeout = 300_000, pollInterval = 1_000 }: EvaluationWaitOptions = {}): Promise<EvaluationRunResponse> {
		positive(timeout, 'wait-timeout');
		positive(pollInterval, 'poll-interval');
		const path = `/runs/${id(runId)}`;
		const deadline = performance.now() + timeout;
		for (;;) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new EvalsError('Wait timed out; the durable run can be resumed with status', undefined, 'timeout');
			const result = await this.request<EvaluationRunResponse>('GET', path, undefined, false, remaining);
			if (['completed', 'cancelled', 'error'].includes(result.run?.status)) return result;
			if (!['queued', 'running'].includes(result.run?.status)) throw new EvalsError('Managed run response is invalid', undefined, 'invalid_response');
			await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, Math.max(0, deadline - performance.now()))));
		}
	}
}

/** CI gate: 0 pass, 1 fail, 2 incomplete, active, cancelled or error. */
export function evaluationGateExitCode(run: EvaluationRun): number {
	if (run?.status !== 'completed') return 2;
	return run.summary?.gate === 'pass' ? 0 : run.summary?.gate === 'fail' ? 1 : 2;
}
