import type { CaseResult, HumanReviewStatus, ReviewRequest, Run } from './types';

/** A late poll must never replace a newer cancellation or human review report. */
export function mergeRuns(previous: Run[], incoming: Run[]): Run[] {
	const values = new Map(previous.map((run) => [run.id, run]));
	for (const run of incoming) {
		const current = values.get(run.id);
		if (!current || current.reportRevision <= run.reportRevision) values.set(run.id, run);
	}
	return [...values.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function reviewRequest(run: Run, item: CaseResult, scorerId: string, status: HumanReviewStatus, reason: string): ReviewRequest {
	return { caseId: item.caseId, caseResultId: item.id, scorerId, status, reason, expectedReportRevision: run.reportRevision };
}
