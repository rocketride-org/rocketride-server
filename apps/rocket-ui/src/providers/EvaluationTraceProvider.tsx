import { useCallback } from 'react';
import { DetailPanel } from 'shell';
import type { RocketRideClient } from 'rocketride';
import { TraceDetail } from 'shared/components/trace/TraceDetail';
import type { TraceLocator } from '../evaluations/types';

/** Evaluation results open the same call-tree inspector as Development traces. */
export default function EvaluationTraceProvider({ client, trace, onClose }: { client: RocketRideClient; trace: TraceLocator; onClose: () => void }) {
	const fetchTrace = useCallback(
		async (traceId: number) => {
			const stream = client.log.openEventStream({
				projectId: trace.projectId,
				source: trace.source,
				runKind: trace.runKind === 'deploy' ? 'deploy' : 'dev',
			});
			try {
				return await stream.getTrace(traceId);
			} finally {
				stream.closeEventStream();
			}
		},
		[client, trace.projectId, trace.source, trace.runKind]
	);
	const traceId = Number(trace.traceId);
	return (
		<DetailPanel open onClose={onClose} title="Evaluation trace" subtitle={`${trace.projectId} · ${trace.source}`} width={720} persistKey="panelTraceDetailWidth">
			{Number.isSafeInteger(traceId) && traceId > 0 ? <TraceDetail key={`${trace.projectId}:${trace.source}:${traceId}`} traceId={traceId} projectId={trace.projectId} fetchTrace={fetchTrace} /> : <p>No permanent trace identity was captured for this trial. The evaluation report retains its output and scorer evidence.</p>}
		</DetailPanel>
	);
}
