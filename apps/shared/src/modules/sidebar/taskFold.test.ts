// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Unit tests: the shared apaevt_task folds (dev sidebar + deploy run state).
//
// These are the ONE dev/deploy classification both hosts (rocket-ui and the
// VS Code webviews) delegate to — a regression here breaks both UIs at once.
// Pinned: deploy filtering on every foldTaskEvent path (top-level event AND
// each bulk-snapshot row), errors/warnings surviving the bulk rebuild, and
// the team/project scoping of the two deploy-run folds.
//
// Run via `shared:test` (node --import tsx --test), matching the package
// convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldTaskEvent, foldDeployRunState, foldProjectDeployRuns } from './taskFold';
import type { TaskLifecycleEvent } from './taskFold';
import type { ActiveTaskState, UnknownTask } from './types';

// --- Fixtures ---------------------------------------------------------------

/** An active-task map with one tracked entry carrying indicators. */
function tracked(): Map<string, ActiveTaskState> {
	return new Map([['proj-1.src-1', { running: true, errors: ['boom'], warnings: ['careful'] }]]);
}

const NO_UNKNOWN: UnknownTask[] = [];

/** Host predicate: only proj-1.src-1 has a local pipeline file. */
const isKnown = (projectId: string, sourceId: string): boolean => projectId === 'proj-1' && sourceId === 'src-1';

// --- foldTaskEvent: dev-view classification ---------------------------------

test('foldTaskEvent: a deploy run never enters the dev lists', () => {
	const event: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	assert.equal(foldTaskEvent(event, new Map(), NO_UNKNOWN, isKnown), null);
});

test('foldTaskEvent: begin tracks the task and lists unknown pipelines', () => {
	const event: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-2', source: 'src-9', name: 'Mystery' };
	const result = foldTaskEvent(event, new Map(), NO_UNKNOWN, isKnown);
	assert.ok(result);
	assert.deepEqual(result.activeTasks.get('proj-2.src-9'), { running: true, errors: [], warnings: [] });
	assert.equal(result.unknownTasks.length, 1);
	assert.equal(result.unknownTasks[0].displayName, 'Mystery');
});

test('foldTaskEvent: restart preserves accumulated errors and warnings', () => {
	const event: TaskLifecycleEvent = { action: 'restart', projectId: 'proj-1', source: 'src-1' };
	const result = foldTaskEvent(event, tracked(), NO_UNKNOWN, isKnown);
	assert.ok(result);
	assert.deepEqual(result.activeTasks.get('proj-1.src-1'), { running: true, errors: ['boom'], warnings: ['careful'] });
});

test('foldTaskEvent: the bulk running snapshot preserves indicators of still-running tasks', () => {
	const event: TaskLifecycleEvent = {
		action: 'running',
		tasks: [
			{ projectId: 'proj-1', source: 'src-1' },
			{ projectId: 'proj-2', source: 'src-2', runKind: 'deploy', teamId: 'team-1' },
		],
	};
	const result = foldTaskEvent(event, tracked(), NO_UNKNOWN, isKnown);
	assert.ok(result);
	// The snapshot confirms src-1 still runs — its indicators survive.
	assert.deepEqual(result.activeTasks.get('proj-1.src-1'), { running: true, errors: ['boom'], warnings: ['careful'] });
	// The per-ROW filter keeps the deploy run out of the rebuild.
	assert.equal(result.activeTasks.size, 1);
});

test('foldTaskEvent: the bulk running snapshot drops tasks the server no longer reports', () => {
	const event: TaskLifecycleEvent = { action: 'running', tasks: [] };
	const result = foldTaskEvent(event, tracked(), NO_UNKNOWN, isKnown);
	assert.ok(result);
	assert.equal(result.activeTasks.size, 0);
});

test('foldTaskEvent: end removes the task and its unknown entry', () => {
	const unknown: UnknownTask[] = [{ projectId: 'proj-2', sourceId: 'src-9', displayName: 'Mystery', projectLabel: 'proj-2' }];
	const active = new Map([['proj-2.src-9', { running: true, errors: [], warnings: [] }]]);
	const event: TaskLifecycleEvent = { action: 'end', projectId: 'proj-2', source: 'src-9' };
	const result = foldTaskEvent(event, active, unknown, isKnown);
	assert.ok(result);
	assert.equal(result.activeTasks.size, 0);
	assert.equal(result.unknownTasks.length, 0);
});

test('foldTaskEvent: unrelated actions change nothing', () => {
	assert.equal(foldTaskEvent({ action: 'status_update' }, new Map(), NO_UNKNOWN, isKnown), null);
});

// --- foldDeployRunState: one team deployment's running map ------------------

test('foldDeployRunState: the snapshot seeds only THIS deployment rows', () => {
	const event: TaskLifecycleEvent = {
		action: 'running',
		tasks: [
			{ projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' },
			{ projectId: 'proj-1', source: 'src-2', runKind: 'deploy', teamId: 'team-2' },
			{ projectId: 'proj-1', source: 'src-3' },
			{ projectId: 'proj-9', source: 'src-4', runKind: 'deploy', teamId: 'team-1' },
		],
	};
	assert.deepEqual(foldDeployRunState(event, {}, 'team-1', 'proj-1'), { 'src-1': true });
});

test('foldDeployRunState: begin/end flip a source; foreign scopes are ignored', () => {
	const begin: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	const running = foldDeployRunState(begin, {}, 'team-1', 'proj-1');
	assert.deepEqual(running, { 'src-1': true });

	const end: TaskLifecycleEvent = { action: 'end', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	assert.deepEqual(foldDeployRunState(end, running!, 'team-1', 'proj-1'), {});

	// A dev run and a foreign team's run never touch this deployment's map.
	const dev: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-1', source: 'src-1' };
	assert.equal(foldDeployRunState(dev, {}, 'team-1', 'proj-1'), null);
	const foreign: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-2' };
	assert.equal(foldDeployRunState(foreign, {}, 'team-1', 'proj-1'), null);
});

// --- foldProjectDeployRuns: all team deployments of one project -------------

test('foldProjectDeployRuns: the snapshot groups this project runs by team', () => {
	const event: TaskLifecycleEvent = {
		action: 'running',
		tasks: [
			{ projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' },
			{ projectId: 'proj-1', source: 'src-2', runKind: 'deploy', teamId: 'team-2' },
			{ projectId: 'proj-9', source: 'src-3', runKind: 'deploy', teamId: 'team-1' },
		],
	};
	assert.deepEqual(foldProjectDeployRuns(event, {}, 'proj-1'), { 'team-1': { 'src-1': true }, 'team-2': { 'src-2': true } });
});

test('foldProjectDeployRuns: begin/end flip one team source; other projects are ignored', () => {
	const begin: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	const runs = foldProjectDeployRuns(begin, {}, 'proj-1');
	assert.deepEqual(runs, { 'team-1': { 'src-1': true } });

	const end: TaskLifecycleEvent = { action: 'end', projectId: 'proj-1', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	assert.deepEqual(foldProjectDeployRuns(end, runs!, 'proj-1'), { 'team-1': {} });

	const other: TaskLifecycleEvent = { action: 'begin', projectId: 'proj-9', source: 'src-1', runKind: 'deploy', teamId: 'team-1' };
	assert.equal(foldProjectDeployRuns(other, {}, 'proj-1'), null);
});
