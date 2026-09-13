import type { RocketRideClient } from 'rocketride';

/** Wire types follow the parent SaaS docs/evaluations.md v1 contract. */
export interface TraceLocator {
	projectId: string;
	source: string;
	runKind?: string;
	/** Actual begin-flow logSeq, never a generated run or case ID. */
	traceId?: number;
	chapter?: number;
	environment?: 'development' | 'staging';
}

export interface EvaluationWorkspaceProps {
	project: Record<string, unknown>;
	projectName: string;
	client: RocketRideClient;
	onOpenTrace?: (trace: TraceLocator) => void;
}

export interface EvaluationCase {
	id: string;
	name: string;
	input: string;
	reference?: string;
	approved: boolean;
	tags?: string[];
	provenance?: { kind: string; trace?: TraceLocator };
}

export const SCORER_KINDS = ['equals', 'contains', 'not_contains', 'json', 'latency', 'llm_judge', 'human'] as const;
export type ScorerKind = (typeof SCORER_KINDS)[number];
export interface Scorer {
	id: string;
	name: string;
	kind: ScorerKind;
	expected?: string;
	path?: string;
	threshold?: number;
	rubric?: string;
	judgePipeline?: Record<string, unknown>;
}

export interface EvaluationSpec {
	schemaVersion: 1;
	name: string;
	projectId: string;
	pipeline: Record<string, unknown>;
	source: string;
	inputMode: 'chat' | 'text';
	environment: 'development' | 'staging';
	datasetName: string;
	cases: EvaluationCase[];
	scorers: Scorer[];
	repetitions: number;
	passCriteria: { minimumPassRate: number; maxRegressions: number };
}

export interface Capabilities {
	environments: { id: string; label: string; available: boolean }[];
	scorerKinds: string[];
	assistantAvailable: boolean;
}
export interface Evaluation {
	id: string;
	name: string;
	projectId: string;
	revision: number;
	spec: EvaluationSpec;
	baselineRunId?: string;
	createdAt: string;
	updatedAt: string;
}
export interface Revision {
	revision: number;
	createdAt: string;
	specHash: string;
}
export type ScoreStatus = 'pass' | 'fail' | 'error' | 'incomplete' | 'abstain';
export type HumanReviewStatus = 'pass' | 'fail' | 'abstain';
export interface ReviewRequest {
	caseId: string;
	/** Select the exact result/trial, including when repetitions > 1. */
	caseResultId?: string;
	scorerId: string;
	status: HumanReviewStatus;
	reason: string;
	expectedReportRevision: number;
}
export type CaseStatus = 'pending' | 'running' | ScoreStatus;
export interface CaseResult {
	id: string;
	caseId: string;
	name: string;
	trial: number;
	input: string;
	reference?: string;
	output?: string;
	status: CaseStatus;
	durationMs: number;
	scores: { scorerId: string; name: string; status: ScoreStatus; score: number | null; reason: string; executionProjectId?: string; trace?: TraceLocator }[];
	executionProjectId?: string;
	trace?: TraceLocator;
	error?: string;
}
export interface Run {
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
	summary: {
		total: number;
		completed: number;
		pass: number;
		fail: number;
		error: number;
		incomplete: number;
		abstain: number;
		passRate: number;
		durationMs: number;
		gate: 'pass' | 'fail' | 'incomplete';
		costUsd: number | null;
	};
	cases: CaseResult[];
	comparison?: {
		compatible: boolean;
		reasons: string[];
		regressions: number;
		improvements: number;
		unchanged: number;
		cases: { caseId: string; trial: number; baselineStatus: CaseStatus; candidateStatus: CaseStatus; change: string }[];
		// The contract deliberately does not define entries: render server evidence verbatim.
		pipelineChanges: unknown[];
	};
	error?: string;
}

export const isActiveRun = (run: Run): boolean => run.status === 'queued' || run.status === 'running';
export const canBeBaseline = (run: Run): boolean => run.status === 'completed' && run.cases.length > 0 && run.cases.every((item) => item.status === 'pass' || item.status === 'fail');
export function traceUnavailableReason(trace: TraceLocator, environment: EvaluationSpec['environment'], hostAvailable: boolean): string | undefined {
	if (environment === 'staging' || trace.environment === 'staging') return 'Staging traces cannot be opened through this development connection. A backend trace proxy is required; the recorded locator is shown below.';
	if (!Number.isSafeInteger(trace.traceId) || Number(trace.traceId) <= 0 || !trace.projectId || !trace.source) return 'No permanent numeric trace identity was captured. The recorded locator is shown below.';
	if (trace.runKind && trace.runKind !== 'dev' && trace.runKind !== 'deploy') return 'This trace run kind is not supported by the current inspector. The recorded locator is shown below.';
	if (!hostAvailable) return 'Trace navigation is not connected in this host. Use the recorded locator below.';
	return undefined;
}
