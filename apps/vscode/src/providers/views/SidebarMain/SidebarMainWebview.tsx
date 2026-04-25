// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMainWebview — VS Code webview bridge for the unified sidebar.
 *
 * Receives data from the extension host via useMessaging, manages local
 * state (active tasks, unknown tasks), and renders <SidebarMain> with props.
 * User actions from SidebarMain flow back as messages to the extension host.
 *
 * Architecture:
 *   SidebarMainProvider (Node.js) ↔ postMessage ↔ SidebarMainWebview (browser) → SidebarMain (shared-ui)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';

import { SidebarMain } from 'shared';
import type { ProjectEntry, ActiveTaskState, UnknownTask, ConnectionInfo } from 'shared';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// TYPES — messages between extension host and webview
// =============================================================================

interface HostProjectEntry {
	path: string;
	projectId?: string;
	sources?: { id: string; name: string; provider?: string }[];
}

interface TaskEventBody {
	action: 'begin' | 'end' | 'restart' | 'running';
	name?: string;
	projectId: string;
	source: string;
	tasks?: { id: string; projectId: string; source: string }[];
}

type OutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'command'; command: string; args?: unknown[] } | { type: 'openFile'; fsPath: string } | { type: 'runPipeline'; fsPath: string; sourceId?: string } | { type: 'stopPipeline'; projectId: string; sourceId: string } | { type: 'refresh' };

type IncomingMessage = { type: 'update'; data: { connectionState: string; connectionMode: string; entries: HostProjectEntry[]; unknownTasks: UnknownTask[] } } | { type: 'entriesUpdate'; entries: HostProjectEntry[] } | { type: 'taskEvent'; event: TaskEventBody } | { type: 'statusUpdate'; projectId: string; sourceId: string; errors: string[]; warnings: string[] };

// =============================================================================
// COMPONENT
// =============================================================================

const SidebarMainWebview: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────────
	const [connection, setConnection] = useState<ConnectionInfo>({ state: 'disconnected' });
	const [entries, setEntries] = useState<ProjectEntry[]>([]);
	const [activeTasks, setActiveTasks] = useState<Map<string, ActiveTaskState>>(new Map());
	const [unknownTasks, setUnknownTasks] = useState<UnknownTask[]>([]);

	// ── Stable ref for entries (used by task event handler to check known tasks)
	const entriesRef = useRef(entries);
	useEffect(() => {
		entriesRef.current = entries;
	}, [entries]);

	// ── Task state helpers ──────────────────────────────────────────────────

	/** Check if a projectId+sourceId matches any known local file. */
	const isKnownTask = useCallback((projectId: string, sourceId: string): boolean => {
		return entriesRef.current.some((e) => e.projectId === projectId && e.sources?.some((s) => s.id === sourceId));
	}, []);

	/** Process an apaevt_task event to update activeTasks and unknownTasks. */
	const handleTaskEvent = useCallback(
		(event: TaskEventBody) => {
			const { action, projectId, source: sourceId } = event;
			const key = `${projectId}.${sourceId}`;

			setActiveTasks((prev) => {
				const next = new Map(prev);

				switch (action) {
					case 'begin':
					case 'restart':
						if (!next.has(key)) {
							next.set(key, { running: true, errors: [], warnings: [] });
						} else {
							const existing = next.get(key)!;
							next.set(key, { ...existing, running: true });
						}
						break;

					case 'running':
						// Full resync — clear and rebuild from task list
						next.clear();
						for (const task of event.tasks ?? []) {
							const k = `${task.projectId}.${task.source}`;
							next.set(k, { running: true, errors: [], warnings: [] });
						}
						break;

					case 'end':
						if (next.has(key)) {
							const existing = next.get(key)!;
							next.set(key, { ...existing, running: false });
						}
						break;
				}

				return next;
			});

			// Update unknown tasks
			setUnknownTasks((prev) => {
				switch (action) {
					case 'begin':
					case 'restart':
						if (!isKnownTask(projectId, sourceId)) {
							if (!prev.some((ut) => ut.projectId === projectId && ut.sourceId === sourceId)) {
								return [
									...prev,
									{
										projectId,
										sourceId,
										displayName: event.name || sourceId,
										projectLabel: projectId.substring(0, 8),
									},
								];
							}
						}
						return prev;

					case 'running': {
						// Full resync
						const tasks = event.tasks ?? [];
						return tasks
							.filter((t) => !isKnownTask(t.projectId, t.source))
							.map((t) => ({
								projectId: t.projectId,
								sourceId: t.source,
								displayName: t.source,
								projectLabel: t.projectId.substring(0, 8),
							}));
					}

					case 'end':
						return prev.filter((ut) => !(ut.projectId === projectId && ut.sourceId === sourceId));

					default:
						return prev;
				}
			});
		},
		[isKnownTask]
	);

	// ── Messaging ───────────────────────────────────────────────────────────

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'update':
					setConnection({
						state: msg.data.connectionState as ConnectionInfo['state'],
						mode: msg.data.connectionMode,
					});
					setEntries(msg.data.entries);
					if (msg.data.unknownTasks) setUnknownTasks(msg.data.unknownTasks);
					break;

				case 'entriesUpdate':
					setEntries(msg.entries);
					break;

				case 'taskEvent':
					handleTaskEvent(msg.event);
					break;

				case 'statusUpdate': {
					// Update errors/warnings for a specific source
					const statusKey = `${msg.projectId}.${msg.sourceId}`;
					setActiveTasks((prev) => {
						const next = new Map(prev);
						const existing = next.get(statusKey) ?? { running: false, errors: [], warnings: [] };
						next.set(statusKey, { ...existing, errors: msg.errors, warnings: msg.warnings });
						return next;
					});
					break;
				}
			}
		},
	});

	// ── Callbacks for SidebarMain ────────────────────────────────────────────

	const onNavigate = useCallback(
		(target: string) => {
			const commands: Record<string, string> = {
				new: 'rocketride.sidebar.files.createFile',
				monitor: 'rocketride.page.monitor.open',
				deploy: 'rocketride.page.deploy.open',
				templates: 'rocketride.page.templates.open',
			};
			const cmd = commands[target];
			if (cmd) sendMessage({ type: 'command', command: cmd });
		},
		[sendMessage]
	);

	const onFileAction = useCallback(
		(action: string, path: string) => {
			switch (action) {
				case 'open':
					sendMessage({ type: 'openFile', fsPath: path });
					break;
			}
		},
		[sendMessage]
	);

	const onSourceAction = useCallback(
		(action: string, filePath: string, sourceId: string, projectId?: string) => {
			switch (action) {
				case 'run':
					sendMessage({ type: 'runPipeline', fsPath: filePath, sourceId });
					break;
				case 'stop':
					if (projectId) sendMessage({ type: 'stopPipeline', projectId, sourceId });
					break;
			}
		},
		[sendMessage]
	);

	const onRefresh = useCallback(() => {
		sendMessage({ type: 'refresh' });
	}, [sendMessage]);

	const onToggleConnection = useCallback(() => {
		sendMessage({ type: connection.state === 'connected' ? 'disconnect' : 'connect' });
	}, [sendMessage, connection.state]);

	const onOpenSettings = useCallback(() => {
		sendMessage({ type: 'command', command: 'rocketride.page.settings.open' });
	}, [sendMessage]);

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);

	// ── Render ───────────────────────────────────────────────────────────────

	return <SidebarMain connection={connection} entries={entries} activeTasks={activeTasks} unknownTasks={unknownTasks} onNavigate={onNavigate} onFileAction={onFileAction} onSourceAction={onSourceAction} onRefresh={onRefresh} onOpenSettings={onOpenSettings} onOpenDocs={onOpenDocs} onToggleConnection={onToggleConnection} />;
};

export default SidebarMainWebview;
