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
// CONNECT — DISCOVERY (find database tool nodes in running pipelines)
// =============================================================================
//
// Attach-mechanics live here on purpose (see types.ts). Today discovery means:
// list the caller's tasks, resolve each running task's token, read its
// pipeline, and collect components whose provider is a known database node.
// When the platform grows a first-class way to enumerate tool nodes, this
// file is the only place that changes.
// =============================================================================

import type { RocketRideClient } from 'shell';
import type { ISqlEndpoint } from './types';

// =============================================================================
// PROVIDER SET
// =============================================================================

/**
 * Pipeline component providers that expose the shared SQL tool surface
 * (execute / get_schema / dialect, inherited from DatabaseInstanceBase).
 * Extend this set when new relational nodes ship.
 */
export const DATABASE_PROVIDERS: ReadonlySet<string> = new Set(['db_mysql', 'db_postgres', 'db_clickhouse']);

// =============================================================================
// PIPELINE SHAPES (minimal, local to discovery)
// =============================================================================

/** The subset of a pipeline component discovery needs. */
interface IPipelineComponent {
	/** Component id (tool call target). */
	id?: string;
	/** Component provider name. */
	provider?: string;
	/** Optional display name. */
	name?: string;
}

/** The subset of the pipeline dict discovery needs. */
interface IPipelineDict {
	/** The pipeline's components. */
	components?: IPipelineComponent[];
}

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Discover every database tool node reachable through the caller's current
 * tasks. Tasks that fail token/pipeline resolution are skipped (a task can
 * finish between listing and resolution) — discovery never throws for a
 * single bad task, only for the initial task listing itself.
 *
 * @param client - The shell's RocketRide client.
 * @returns Endpoints sorted by pipeline name, then node id.
 */
export async function discoverSqlEndpoints(client: RocketRideClient): Promise<ISqlEndpoint[]> {
	// One page of 100 covers realistic task counts; discovery re-runs on demand.
	const tasks = await client.listTasks({ page_size: 100 });

	// Deduplicate tasks by project+source: restarts can leave multiple task
	// rows for the same pipeline; the token resolver returns the live one.
	const seen = new Set<string>();
	const candidates = tasks.rows.filter((task) => {
		// TASK_STATE >= 4 (STOPPING/COMPLETED/CANCELLED) is not attachable;
		// `completed` alone misses the stopping window.
		if (task.completed || task.state >= 4) return false;
		const id = `${task.projectId}:${task.source}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});

	// Resolve each candidate's pipeline and collect its database components.
	const endpoints: ISqlEndpoint[] = [];
	for (const task of candidates) {
		try {
			// The token names the running task; the pipeline is read through it.
			const token = await client.getTaskToken({ projectId: task.projectId, source: task.source });
			if (!token) continue;
			const pipeline = (await client.getTaskPipeline(token)) as IPipelineDict | undefined;
			if (!pipeline?.components) continue;

			// Every database-provider component in the pipeline is an endpoint.
			for (const component of pipeline.components) {
				if (!component.id || !component.provider) continue;
				if (!DATABASE_PROVIDERS.has(component.provider)) continue;
				endpoints.push({
					// Source is part of the identity: the same project can run
					// several tasks, each exposing a component with this id.
					key: `${task.projectId}:${task.source}:${component.id}`,
					projectId: task.projectId,
					pipelineName: task.name,
					source: task.source,
					nodeId: component.id,
					nodeName: component.name ?? component.id,
					provider: component.provider,
					running: true,
				});
			}
		} catch (err) {
			// A single unreachable task must not break discovery of the rest.
			console.log('[sql-ui] discovery skipped task', task.projectId, task.source, err);
		}
	}

	// Stable ordering for the landing grid.
	endpoints.sort((a, b) => a.pipelineName.localeCompare(b.pipelineName) || a.nodeId.localeCompare(b.nodeId));
	return endpoints;
}
