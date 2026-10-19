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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// PIPELINES TOOL — the builtin pipelines tool's CONTROLLER
// =============================================================================
//
// Owns the whole pipelines sidebar state in-realm: file discovery over the
// host's workspaceFs capability, the live task feed on the realm's OWN
// engine connection (dashboard seed + apaevt_task folding via the shared
// fold), and host-pushed per-source diagnostics. The host contributes only
// generic verbs (openFile / manageFile / pipelineAction / pages).
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DevToolProps } from 'shell';
import { ConnectionManager, useShellConnection } from 'shell';
import { useToolHost } from '../core/ToolContext';
import { PipelinesSidebarPanel } from './sidebar/PipelinesSidebarPanel';
import { startPipelineDiscovery } from './sidebar/discovery';
import type { IPipelineDiscovery } from './sidebar/discovery';
import { foldTaskEvent } from './sidebar/taskFold';
import type { TaskLifecycleEvent } from './sidebar/taskFold';
import type { ActiveTaskState, ProjectEntry, UnknownTask } from './sidebar/types';
import type { ServiceClassInfo } from './utils/parse';
import { onSourceDiagnostics } from './diagnostics';
import type { IntroMode } from '../introCatalog';

/** One dashboard task row (the snapshot seed's shape). */
interface DashboardTaskDTO {
	id: string;
	name: string;
	projectId: string;
	source: string;
	completed: boolean;
	state: number;
	/** Run classification stamp: deploy runs never enter the dev lists. */
	runKind?: string;
}

/** The pipelines tool's sidebar controller. */
export const PipelinesTool: React.FC<DevToolProps> = () => {
	const services = useToolHost();
	const { isConnected } = useShellConnection();

	// ── Discovery ────────────────────────────────────────────────────────────
	// Two sources, host's choice: a workspace-VIEW entry feed when the host
	// provides one (rocket-ui — staged files included), else the shared
	// workspaceFs discovery (VS Code).
	const [entries, setEntries] = useState<ProjectEntry[]>([]);
	const discoveryRef = useRef<IPipelineDiscovery | null>(null);
	useEffect(() => {
		const feed = services.pipelineEntries;
		if (!feed) return;
		return feed.subscribe(setEntries);
	}, [services.pipelineEntries]);
	useEffect(() => {
		const fs = services.workspaceFs;
		if (!fs || services.pipelineEntries) return;
		const cm = ConnectionManager.getInstance();
		const discovery = startPipelineDiscovery(
			fs,
			{ getServices: () => cm.getCachedServices()?.services as Record<string, ServiceClassInfo> | undefined },
			setEntries,
		);
		discoveryRef.current = discovery;
		// A catalog landing/refreshing re-derives source rows without rereads.
		const offServices = cm.on('shell:servicesUpdated', () => discovery.refresh({ reparse: false }));
		return () => {
			offServices();
			discoveryRef.current = null;
			discovery.stop();
		};
	}, [services.workspaceFs, services.pipelineEntries]);

	// ── Task state (shared fold; sync refs — events burst faster than renders)
	const [activeTasks, setActiveTasks] = useState<Map<string, ActiveTaskState>>(new Map());
	const [unknownTasks, setUnknownTasks] = useState<UnknownTask[]>([]);
	const activeTasksRef = useRef(activeTasks);
	const unknownTasksRef = useRef(unknownTasks);
	useEffect(() => { activeTasksRef.current = activeTasks; }, [activeTasks]);
	useEffect(() => { unknownTasksRef.current = unknownTasks; }, [unknownTasks]);
	const entriesRef = useRef(entries);
	useEffect(() => {
		entriesRef.current = entries;
		// Re-evaluate unknown tasks — some may now match newly-parsed entries.
		setUnknownTasks((prev) => prev.filter((ut) => !entries.some((e) => (!e.type || e.type === 'file') && e.projectId === ut.projectId && e.sources?.some((s: { id: string }) => s.id === ut.sourceId))));
	}, [entries]);

	/** Whether a projectId+sourceId matches any discovered local file. */
	const isKnownTask = useCallback((projectId: string, sourceId: string): boolean => {
		return entriesRef.current.some((e) => e.projectId === projectId && e.sources?.some((s) => s.id === sourceId));
	}, []);

	/** Folds one apaevt_task event (the shared fold filters deploy runs). */
	const handleTaskEvent = useCallback((event: TaskLifecycleEvent) => {
		const folded = foldTaskEvent(event, activeTasksRef.current, unknownTasksRef.current, isKnownTask);
		if (folded) {
			activeTasksRef.current = folded.activeTasks;
			unknownTasksRef.current = folded.unknownTasks;
			setActiveTasks(folded.activeTasks);
			setUnknownTasks(folded.unknownTasks);
		}
	}, [isKnownTask]);

	/** Seeds active + unknown tasks from a dashboard snapshot. */
	const seedFromDashboard = useCallback((tasks: DashboardTaskDTO[]): void => {
		const taskMap = new Map<string, ActiveTaskState>();
		const unknown: UnknownTask[] = [];
		for (const t of tasks) {
			if (t.completed) continue;
			// Same classification the shared fold applies on every event path.
			if (t.runKind === 'deploy') continue;
			const k = `${t.projectId}.${t.source}`;
			// The snapshot confirms a tracked task is still running; it does
			// not reset its accumulated diagnostics.
			const prev = activeTasksRef.current.get(k);
			taskMap.set(k, { running: true, errors: prev?.errors ?? [], warnings: prev?.warnings ?? [] });
			if (!isKnownTask(t.projectId, t.source)) {
				unknown.push({ projectId: t.projectId, sourceId: t.source, displayName: t.name || t.source, projectLabel: t.projectId.substring(0, 8) });
			}
		}
		activeTasksRef.current = taskMap;
		unknownTasksRef.current = unknown;
		setActiveTasks(taskMap);
		setUnknownTasks(unknown);
	}, [isKnownTask]);

	// Live feed over the SHELL BUS: monitor + dashboard seed on every
	// (re)connect through the brokered client.* ops (in-process at the
	// framework root, bridged in spoke realms), apaevt_task events folded as
	// they arrive off the local event lane (socket- or mirror-fed).
	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		const seed = (): void => {
			void cm.request('client.addMonitor', { key: { token: '*' }, types: ['task'] }).catch(() => { /* feed degrades to dashboard-only */ });
			cm.request('client.getDashboard', {}).then((dashboard) => {
				const tasks = (dashboard as { tasks?: DashboardTaskDTO[] } | null)?.tasks;
				if (tasks) seedFromDashboard(tasks);
			}).catch(() => { /* no snapshot — events still fold */ });
		};
		const offEvent = cm.on('shell:event', ({ event }) => {
			const e = event as { event?: string; body?: unknown };
			if (e?.event === 'apaevt_task' && e.body) {
				handleTaskEvent(e.body as TaskLifecycleEvent);
				return;
			}
			if (e?.event === 'apaevt_status_update' && e.body) {
				// Incremental per-source status straight off the engine feed.
				// Deploy runs never touch the dev lists (same classification
				// as the fold).
				const body = e.body as { project_id?: string; source?: string; runKind?: string; errors?: string[]; warnings?: string[] };
				if (!body.project_id || !body.source || body.runKind === 'deploy') return;
				const key = `${body.project_id}.${body.source}`;
				const next = new Map(activeTasksRef.current);
				const existing = next.get(key) ?? { running: false, errors: [], warnings: [] };
				next.set(key, { ...existing, errors: body.errors ?? [], warnings: body.warnings ?? [] });
				activeTasksRef.current = next;
				setActiveTasks(next);
			}
		});
		const offDisconnected = cm.on('shell:disconnected', () => {
			activeTasksRef.current = new Map();
			unknownTasksRef.current = [];
			setActiveTasks(new Map());
			setUnknownTasks([]);
		});
		const offConnected = cm.on('shell:connected', seed);
		if (cm.isConnected()) seed();
		return () => {
			offEvent();
			offConnected();
			offDisconnected();
		};
	}, [handleTaskEvent, seedFromDashboard]);

	// Host-pushed per-source diagnostics (the canvas editor's cache).
	useEffect(() => {
		return onSourceDiagnostics(({ projectId, sourceId, errors, warnings }) => {
			const key = `${projectId}.${sourceId}`;
			const next = new Map(activeTasksRef.current);
			const existing = next.get(key) ?? { running: false, errors: [], warnings: [] };
			next.set(key, { ...existing, errors, warnings });
			activeTasksRef.current = next;
			setActiveTasks(next);
		});
	}, []);

	return (
		<PipelinesSidebarPanel
			isConnected={isConnected}
			{...(services.isSubscribed !== undefined ? { isSubscribed: services.isSubscribed } : {})}
			entries={entries}
			activeTasks={activeTasks}
			unknownTasks={unknownTasks}
			{...(services.activeDocKey !== undefined ? { activeFilePath: services.activeDocKey } : {})}
			onNavigate={() => services.newPipeline?.()}
			onOpenFile={(path) => services.openFile?.(path)}
			{...(services.manageFile ? { onFileManage: services.manageFile } : {})}
			{...(services.fileActions ? { fileActions: services.fileActions } : {})}
			onSourceAction={(action, filePath, sourceId, projectId) => services.pipelineAction?.(action, filePath, sourceId, projectId)}
			onRefresh={() => (services.pipelineEntries ? services.pipelineEntries.refresh() : discoveryRef.current?.refresh())}
			{...(services.openUnknownTask ? { onOpenUnknownTask: services.openUnknownTask } : {})}
			onShowIntro={(mode: IntroMode) => services.openPage(`intro:${mode}`)}
		/>
	);
};
