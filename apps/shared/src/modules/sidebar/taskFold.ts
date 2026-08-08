// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Shared fold of `apaevt_task` lifecycle events into the sidebar's task
 * state — used by BOTH hosts (rocket-ui SidebarProvider and the VS Code
 * SidebarWebview) so the dev-view classification exists exactly once.
 *
 * The classification rule: DEPLOY runs are not dev tasks. They belong to
 * their team's deployment (opened from the pipeline's DEPLOY page) and
 * never enter the active/ad-hoc lists. Every path of the fold applies it —
 * the top-level event, each row of a bulk `running` snapshot, and the
 * unknown-task rebuild — because the connection's event firehose carries
 * deploy events whenever a team-scoped subscription is open.
 */

import type { ActiveTaskState, UnknownTask } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** The subset of an `apaevt_task` body the fold consumes. */
export interface TaskLifecycleEvent {
	/** Lifecycle action: 'begin' | 'restart' | 'running' | 'end'. */
	action?: string;
	/** Project identity of the run (absent on bulk snapshots). */
	projectId?: string;
	/** Source component id of the run (absent on bulk snapshots). */
	source?: string;
	/** Display name of the task, when the server knows one. */
	name?: string;
	/** Run classification stamp: deploy runs never enter the dev lists. */
	runKind?: string;
	/** Owning team of a deploy run (the stamped body carries the OWNER). */
	teamId?: string;
	/** Bulk `running` snapshot rows (each row carries its own stamps). */
	tasks?: Array<{ projectId: string; source: string; name?: string; runKind?: string; teamId?: string }>;
}

/** The fold's output: the next task state, or null when nothing changed. */
export interface TaskFoldResult {
	/** Next active-task map (keyed 'projectId.sourceId'). */
	activeTasks: Map<string, ActiveTaskState>;
	/** Next unknown-task list (server runs with no local pipeline file). */
	unknownTasks: UnknownTask[];
}

// =============================================================================
// FOLD
// =============================================================================

/**
 * Fold one `apaevt_task` event into the sidebar task state.
 *
 * Pure function: returns fresh collections, never mutates the inputs.
 * Returns null when the event is not a dev-view task event (e.g. a deploy
 * run's lifecycle) so callers can skip their state updates entirely.
 *
 * @param event - The apaevt_task body (see {@link TaskLifecycleEvent}).
 * @param activeTasks - Current active-task map (keyed 'projectId.sourceId').
 * @param unknownTasks - Current unknown-task list.
 * @param isKnownTask - Host predicate: does projectId+sourceId match a local pipeline file.
 * @returns The next state, or null when the event does not affect the dev view.
 */
export function foldTaskEvent(
	event: TaskLifecycleEvent,
	activeTasks: Map<string, ActiveTaskState>,
	unknownTasks: UnknownTask[],
	isKnownTask: (projectId: string, sourceId: string) => boolean,
): TaskFoldResult | null {
	const { action, projectId, source: sourceId } = event;

	// Deploy runs are not dev tasks — see the module docstring.
	if (event.runKind === 'deploy') return null;

	const key = `${projectId}.${sourceId}`;
	const nextActive = new Map(activeTasks);
	let nextUnknown = unknownTasks;

	switch (action) {
		case 'begin':
		case 'restart': {
			// A begin/restart is a NEW run: stale diagnostics from the previous
			// run reset here, so a lingering warning chip always describes the
			// run the user is looking at (indicator-semantics decision: dots =
			// liveness, chips = the LAST run's diagnostics).
			nextActive.set(key, { running: true, errors: [], warnings: [] });
			if (projectId && sourceId && !isKnownTask(projectId, sourceId)) {
				if (!unknownTasks.some((ut) => ut.projectId === projectId && ut.sourceId === sourceId)) {
					nextUnknown = [
						...unknownTasks,
						{ projectId, sourceId, displayName: event.name || sourceId, projectLabel: projectId.substring(0, 8) },
					];
				}
			}
			break;
		}

		case 'running': {
			// Bulk snapshot: rebuild both collections from the server state.
			// Each ROW carries its own runKind — the snapshot event itself has
			// none, so the per-row filter is what keeps deploy runs out.
			const rows = (event.tasks ?? []).filter((t) => t.runKind !== 'deploy');
			nextActive.clear();
			for (const t of rows) {
				// Preserve accumulated errors/warnings for a task that was
				// already tracked — the snapshot confirms it is still running,
				// it does not reset its indicators (same rule as begin/restart).
				const prev = activeTasks.get(`${t.projectId}.${t.source}`);
				nextActive.set(`${t.projectId}.${t.source}`, { running: true, errors: prev?.errors ?? [], warnings: prev?.warnings ?? [] });
			}
			nextUnknown = rows
				.filter((t) => !isKnownTask(t.projectId, t.source))
				.map((t) => {
					const existing = unknownTasks.find((ut) => ut.projectId === t.projectId && ut.sourceId === t.source);
					return existing ?? { projectId: t.projectId, sourceId: t.source, displayName: t.name || t.source, projectLabel: t.projectId.substring(0, 8) };
				});
			break;
		}

		case 'end':
			nextActive.delete(key);
			nextUnknown = unknownTasks.filter((ut) => !(ut.projectId === projectId && ut.sourceId === sourceId));
			break;

		default:
			return null;
	}

	return { activeTasks: nextActive, unknownTasks: nextUnknown };
}

// =============================================================================
// DEPLOY RUN-STATE FOLD
// =============================================================================

/**
 * Fold one `apaevt_task` event into a TEAM deployment's running-source map.
 *
 * The event-driven replacement for the deploy surfaces' rrext_get_tasks
 * polling: the server's catch-up `running` snapshot seeds the map on
 * subscribe, and `begin`/`restart`/`end` flip individual sources the moment
 * they happen. Shared by both hosts (rocket-ui DeploymentProvider and the
 * VS Code deployment drawer) so the classification exists exactly once.
 *
 * Pure function: returns a fresh map, never mutates the input. Returns
 * null when the event does not affect THIS team deployment's view (wrong
 * team, wrong project, or a dev run).
 *
 * @param event - The apaevt_task body (see {@link TaskLifecycleEvent}).
 * @param running - Current running-source map (keyed by source id).
 * @param teamId - The deployment's owning team.
 * @param projectId - The deployed project.
 * @returns The next running-source map, or null when nothing changed.
 */
export function foldDeployRunState(
	event: TaskLifecycleEvent,
	running: Record<string, boolean>,
	teamId: string,
	projectId: string,
): Record<string, boolean> | null {
	const { action } = event;

	// Bulk snapshot: rebuild from the rows that belong to THIS deployment —
	// each row carries its own runKind/teamId stamps.
	if (action === 'running') {
		const next: Record<string, boolean> = {};
		for (const row of event.tasks ?? []) {
			if (row.runKind === 'deploy' && row.teamId === teamId && row.projectId === projectId && row.source) {
				next[row.source] = true;
			}
		}
		return next;
	}

	// Lifecycle flips: only THIS deployment's runs apply. The stamped body
	// carries the OWNER team for deploy runs.
	if (event.runKind !== 'deploy' || event.teamId !== teamId || event.projectId !== projectId || !event.source) {
		return null;
	}
	if (action === 'begin' || action === 'restart') {
		return { ...running, [event.source]: true };
	}
	if (action === 'end') {
		const next = { ...running };
		delete next[event.source];
		return next;
	}
	return null;
}

/**
 * Fold one `apaevt_task` event into a PROJECT's deploy-run map across every
 * team — feeds the where-live table's running badges (one project, N team
 * deployments). Same event source as {@link foldDeployRunState}, different
 * grouping: `teamId → sourceId → running`.
 *
 * Pure function: returns fresh maps, never mutates the input. Returns null
 * when the event does not affect this project's deploy runs.
 *
 * @param event - The apaevt_task body (see {@link TaskLifecycleEvent}).
 * @param runsByTeam - Current map (teamId → running-source map).
 * @param projectId - The project whose deployments are displayed.
 * @returns The next map, or null when nothing changed.
 */
export function foldProjectDeployRuns(
	event: TaskLifecycleEvent,
	runsByTeam: Record<string, Record<string, boolean>>,
	projectId: string,
): Record<string, Record<string, boolean>> | null {
	const { action } = event;

	// Bulk snapshot: rebuild the whole map from this project's deploy rows.
	if (action === 'running') {
		const next: Record<string, Record<string, boolean>> = {};
		for (const row of event.tasks ?? []) {
			if (row.runKind === 'deploy' && row.teamId && row.projectId === projectId && row.source) {
				(next[row.teamId] ??= {})[row.source] = true;
			}
		}
		return next;
	}

	// Lifecycle flips: only this project's deploy runs apply.
	if (event.runKind !== 'deploy' || !event.teamId || event.projectId !== projectId || !event.source) {
		return null;
	}
	if (action === 'begin' || action === 'restart') {
		return { ...runsByTeam, [event.teamId]: { ...runsByTeam[event.teamId], [event.source]: true } };
	}
	if (action === 'end') {
		const team = { ...runsByTeam[event.teamId] };
		delete team[event.source];
		return { ...runsByTeam, [event.teamId]: team };
	}
	return null;
}
