// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarViewWebview — VS Code webview bridge for the unified sidebar.
 *
 * Receives data from the extension host via useMessaging, manages local
 * state (active tasks, unknown tasks, connection state for both dev and
 * deploy), and renders <SidebarView> with a <SidebarFooter> footerSlot.
 *
 * The footer menu is built dynamically based on auth and connection state:
 *   - Anonymous (no cloud identity): Development Mode + Settings only
 *   - Cloud signed in: Development Mode + Deploy Target + Account/Billing/Settings/Log out
 *
 * Team submenus under Cloud are populated from the respective connection's
 * server (dev teams from ConnectionManager, deploy teams from DeployManager).
 *
 * Architecture:
 *   SidebarProvider (Node.js) ↔ postMessage ↔ SidebarViewWebview (browser)
 *     → SidebarView (shared-ui) + SidebarFooter (shared-ui)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';

import { SidebarView, BxUser, BxCog, BxExport, BxLock, BxRocket, foldTaskEvent } from 'shared';
import { SidebarFooter } from 'shared/components/sidebar-footer/SidebarFooter';
import type { SidebarFooterMenuItem } from 'shared/components/sidebar-footer/SidebarFooter';
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
	/** Run classification stamp — deploy runs never enter the dev lists. */
	runKind?: string;
	name?: string;
	projectId: string;
	source: string;
	/** Bulk snapshot rows — each row carries its OWN runKind stamp. */
	tasks?: { id: string; name: string; projectId: string; source: string; runKind?: string }[];
}

type OutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'command'; command: string; args?: unknown[] } | { type: 'openFile'; fsPath: string } | { type: 'runPipeline'; fsPath: string; sourceId?: string } | { type: 'stopPipeline'; projectId: string; sourceId: string } | { type: 'refresh' } | { type: 'openUnknownTask'; projectId: string; sourceId: string; displayName: string } | { type: 'setDevelopmentMode'; mode: string } | { type: 'setDeployTargetMode'; mode: string | null } | { type: 'cloudSignIn' };

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

type IncomingMessage =
	| {
			type: 'update';
			data: {
				// Dev connection
				connectionState: string;
				connectionMode: string;
				devProgressMessage?: string;
				devProgressLogLine?: string;
				// Deploy connection
				deployConnectionState?: string;
				deployConnectionMode?: string | null;
				deployProgressMessage?: string;
				deployProgressLogLine?: string;
				// Shared auth
				cloudConnected?: boolean;
				userName?: string;
				userEmail?: string;
				// Pipeline data
				entries: HostProjectEntry[];
				unknownTasks: UnknownTask[];
			};
	  }
	| { type: 'entriesUpdate'; entries: HostProjectEntry[] }
	| { type: 'taskEvent'; event: TaskEventBody }
	| { type: 'statusUpdate'; projectId: string; sourceId: string; errors: string[]; warnings: string[] }
	| { type: 'dashboardSnapshot'; tasks: DashboardTaskDTO[] };

// =============================================================================
// COMPONENT
// =============================================================================

const SidebarViewWebview: React.FC = () => {
	// ── Dev connection state ────────────────────────────────────────────────
	const [connection, setConnection] = useState<ConnectionInfo>({ state: 'disconnected' });
	const [developmentMode, setDevelopmentMode] = useState('local');
	const [devProgressMessage, setDevProgressMessage] = useState<string | undefined>();

	// ── Subscription state ─────────────────────────────────────────────────
	const [subscribed, setSubscribed] = useState(true);

	// ── Deploy connection state ─────────────────────────────────────────────
	const [deployConnectionState, setDeployConnectionState] = useState('disconnected');
	const [deployTargetMode, setDeployTargetMode] = useState<string | null>(null);
	const [deployProgressMessage, setDeployProgressMessage] = useState<string | undefined>();

	// ── Pipeline data ───────────────────────────────────────────────────────
	const [entries, setEntries] = useState<ProjectEntry[]>([]);
	const [activeTasks, setActiveTasks] = useState<Map<string, ActiveTaskState>>(new Map());
	const [unknownTasks, setUnknownTasks] = useState<UnknownTask[]>([]);

	// Synchronously-updated mirrors: the shared foldTaskEvent needs BOTH
	// collections atomically, and relayed events can burst faster than a
	// render — refs advance in the handler itself so successive folds never
	// read stale state; the effects re-anchor them after any other mutation.
	const activeTasksRef = useRef(activeTasks);
	const unknownTasksRef = useRef(unknownTasks);
	useEffect(() => {
		activeTasksRef.current = activeTasks;
	}, [activeTasks]);
	useEffect(() => {
		unknownTasksRef.current = unknownTasks;
	}, [unknownTasks]);

	// ── Engine progress log (last N lines for popup display) ───────────────
	const MAX_PROGRESS_LINES = 15;
	const [devProgressLog, setDevProgressLog] = useState<string[]>([]);
	const [deployProgressLog, setDeployProgressLog] = useState<string[]>([]);

	// ── Shared auth + identity ──────────────────────────────────────────────
	const [userName, setUserName] = useState<string | undefined>();
	const [userEmail, setUserEmail] = useState<string | undefined>();
	const [cloudConnected, setCloudSignedIn] = useState(false);

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
			// The dev-view classification and the whole lifecycle fold live in
			// shared code (foldTaskEvent) — one implementation for this webview
			// and the rocket-ui sidebar. Deploy runs never enter the active/
			// ad-hoc lists; the fold filters every path, including each row of
			// a bulk 'running' snapshot.
			const folded = foldTaskEvent(event, activeTasksRef.current, unknownTasksRef.current, isKnownTask);
			if (folded) {
				activeTasksRef.current = folded.activeTasks;
				unknownTasksRef.current = folded.unknownTasks;
				setActiveTasks(folded.activeTasks);
				setUnknownTasks(folded.unknownTasks);
			}
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
					if (msg.data.userName !== undefined) setUserName(msg.data.userName || undefined);
					if (msg.data.userEmail !== undefined) setUserEmail(msg.data.userEmail || undefined);
					// Shared auth
					if (msg.data.cloudConnected !== undefined) setCloudSignedIn(msg.data.cloudConnected);

					// Dev connection state
					if (msg.data.connectionMode) setDevelopmentMode(msg.data.connectionMode);
					setDevProgressMessage(msg.data.devProgressMessage);

					// Accumulate dev engine log lines; clear on connect
					if (msg.data.connectionState === 'connected') {
						setDevProgressLog([]);
					} else if (msg.data.devProgressLogLine && msg.data.devProgressLogLine !== devProgressLog[devProgressLog.length - 1]) {
						setDevProgressLog((prev) => (prev[prev.length - 1] === msg.data.devProgressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), msg.data.devProgressLogLine!]));
					}

					// Deploy connection state
					if (msg.data.deployConnectionState) setDeployConnectionState(msg.data.deployConnectionState);
					if (msg.data.deployConnectionMode !== undefined) setDeployTargetMode(msg.data.deployConnectionMode ?? null);
					setDeployProgressMessage(msg.data.deployProgressMessage);

					// Accumulate deploy engine log lines; clear on connect
					if (msg.data.deployConnectionState === 'connected') {
						setDeployProgressLog([]);
					} else if (msg.data.deployProgressLogLine) {
						setDeployProgressLog((prev) => (prev[prev.length - 1] === msg.data.deployProgressLogLine ? prev : [...prev.slice(-(MAX_PROGRESS_LINES - 1)), msg.data.deployProgressLogLine!]));
					}
					// Subscription status
					if ((msg.data as any).isSubscribed !== undefined) setSubscribed((msg.data as any).isSubscribed);
					break;

				case 'entriesUpdate':
					setEntries(msg.entries);
					break;

				case 'taskEvent':
					handleTaskEvent(msg.event);
					break;

				case 'statusUpdate': {
					// Update errors/warnings for a specific source. Advance the
					// sync refs FIRST (same rule as handleTaskEvent): a task event
					// in the same tick folds from the refs, not from state.
					const statusKey = `${msg.projectId}.${msg.sourceId}`;
					const nextActive = new Map(activeTasksRef.current);
					const existing = nextActive.get(statusKey) ?? { running: false, errors: [], warnings: [] };
					nextActive.set(statusKey, { ...existing, errors: msg.errors, warnings: msg.warnings });
					activeTasksRef.current = nextActive;
					setActiveTasks(nextActive);
					break;
				}

				case 'dashboardSnapshot': {
					// Seed active tasks + unknown tasks from dashboard (initial load)
					const taskMap = new Map<string, ActiveTaskState>();
					const unknown: UnknownTask[] = [];
					for (const t of msg.tasks) {
						if (t.completed) continue;
						// Same classification the shared fold applies on every event
						// path: deploy runs never seed the dev sidebar.
						if (t.runKind === 'deploy') continue;
						const k = `${t.projectId}.${t.source}`;
						// Preserve accumulated diagnostics for a task that was
						// already tracked — the snapshot confirms it is still
						// running, it does not reset its indicators (same rule as
						// the shared fold's bulk 'running' rebuild).
						const prev = activeTasksRef.current.get(k);
						taskMap.set(k, { running: true, errors: prev?.errors ?? [], warnings: prev?.warnings ?? [] });
						if (!isKnownTask(t.projectId, t.source)) {
							unknown.push({ projectId: t.projectId, sourceId: t.source, displayName: t.name || t.source, projectLabel: t.projectId.substring(0, 8) });
						}
					}
					// Advance the sync refs FIRST (same rule as handleTaskEvent)
					// so an event in the same tick folds from the seeded state.
					activeTasksRef.current = taskMap;
					unknownTasksRef.current = unknown;
					setActiveTasks(taskMap);
					setUnknownTasks(unknown);
					break;
				}
			}
		},
	});

	// ── Callbacks for SidebarView ────────────────────────────────────────────

	const onNavigate = useCallback(
		(target: string) => {
			const commands: Record<string, string> = {
				new: 'rocketride.sidebar.files.createFile',
				monitor: 'rocketride.page.monitor.open',
			};
			const cmd = commands[target];
			if (cmd) sendMessage({ type: 'command', command: cmd });
		},
		[sendMessage]
	);

	const onOpenFile = useCallback(
		(path: string) => {
			sendMessage({ type: 'openFile', fsPath: path });
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

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);

	const onOpenUnknownTask = useCallback(
		(projectId: string, sourceId: string, displayName: string) => {
			sendMessage({ type: 'openUnknownTask', projectId, sourceId, displayName });
		},
		[sendMessage]
	);

	// ── Footer popup menu items ─────────────────────────────────────────────
	//
	// Development and Deployment appear in the popup; clicking opens the
	// Settings page (dev or deploy section). Runs use the profile-assigned
	// development team, so no team selection exists here.
	// Account, Billing, Settings, Log out follow below.
	// ─────────────────────────────────────────────────────────────────────────

	/** Builds a mode display label like "Local" or "Cloud". */
	const modeLabel = (mode: string | null): string => {
		if (!mode) return 'Not configured';
		const labels: Record<string, string> = { local: 'Local', cloud: 'Cloud', docker: 'Docker', service: 'Service', onprem: 'Direct' };
		return labels[mode] ?? mode;
	};

	/** Builds a connection status string from state, mode, and optional progress. */
	const connectionStatusText = (state: string, mode: string | null, progressMessage?: string): string => {
		// Progress message takes priority (e.g. "Downloading 1.2.0: 45%", "Unpacking...")
		if (progressMessage) return progressMessage;
		const modeStr = modeLabel(mode);
		switch (state) {
			case 'connected':
				return `Connected (${modeStr})`;
			case 'connecting':
				return 'Connecting...';
			case 'downloading-engine':
				return 'Downloading engine...';
			case 'starting-engine':
				return 'Starting engine...';
			case 'stopping-engine':
				return 'Stopping engine...';
			case 'auth-failed':
				return 'Sign-in required';
			default:
				return 'Disconnected';
		}
	};

	// ── Footer menu items ───────────────────────────────────────────────────
	const anyConnected = connection.state === 'connected' || deployConnectionState === 'connected';

	const footerMenuItems: SidebarFooterMenuItem[] = useMemo(() => {
		const items: SidebarFooterMenuItem[] = [];

		// ── Development section ─────────────────────────────────────────────
		const devStatus = connectionStatusText(connection.state, developmentMode, devProgressMessage);
		const devLines = [devStatus, ...devProgressLog];
		items.push({
			id: 'dev-header',
			label: 'Development',
			header: true,
			statusText: devLines.join('\n'),
			statusState: connection.state === 'connected' ? 'connected' : connection.state === 'connecting' ? 'connecting' : 'disconnected',
			onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open', args: ['development'] }),
		});

		// ── Deployment section ──────────────────────────────────────────────
		if (deployTargetMode) {
			const deployStatus = connectionStatusText(deployConnectionState, deployTargetMode, deployProgressMessage);
			const deployLines = [deployStatus, ...deployProgressLog];
			items.push({
				id: 'deploy-header',
				label: 'Deployment',
				header: true,
				statusText: deployLines.join('\n'),
				statusState: deployConnectionState === 'connected' ? 'connected' : deployConnectionState === 'connecting' ? 'connecting' : 'disconnected',
				onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open', args: ['deployment'] }),
			});
		}

		// ── Account / Subscribe / Environment / Settings / Log out ──────────
		if (cloudConnected) {
			items.push({ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.account.open' }) });
		}

		// Subscribe CTA — only when cloud-signed-in but not subscribed
		if (cloudConnected && !subscribed) {
			items.push({ id: 'subscribe', label: 'Subscribe', icon: BxRocket, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.account.open', args: ['billing'] }) });
		}

		// Environment is visible whenever at least one connection is active,
		// regardless of whether the server is OSS or SaaS.
		if (anyConnected) {
			items.push({ id: 'environment', label: 'Variables', icon: BxLock, dividerBefore: !cloudConnected, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.environment.open' }) });
		}

		// Settings is always shown. Divider only when neither Account nor
		// Environment was shown above (i.e. not connected and not cloud).
		items.push({ id: 'settings', label: 'Settings', icon: BxCog, dividerBefore: !cloudConnected && !anyConnected, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open' }) });

		if (cloudConnected) {
			items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.cloud.logout' }) });
		}

		return items;
	}, [sendMessage, cloudConnected, connection.state, developmentMode, devProgressMessage, devProgressLog, deployConnectionState, deployTargetMode, deployProgressMessage, deployProgressLog, subscribed, anyConnected]);

	// ── Footer slot ─────────────────────────────────────────────────────────
	const footerSlot = <SidebarFooter collapsed={false} userName={userName} userEmail={userEmail} onOpenDocs={onOpenDocs} menuItems={footerMenuItems} />;

	// ── Render ───────────────────────────────────────────────────────────────

	// No headerSlot: the VS Code host has no home-app destination, so it injects no
	// host-specific top nav. The "Home" button is a SaaS-shell concept owned by the
	// web host (rocket-ui), intentionally absent from shared-ui / this extension.
	return <SidebarView connection={connection} isSubscribed={subscribed} entries={entries} activeTasks={activeTasks} unknownTasks={unknownTasks} onNavigate={onNavigate} onOpenFile={onOpenFile} onSourceAction={onSourceAction} onRefresh={onRefresh} footerSlot={footerSlot} onOpenUnknownTask={onOpenUnknownTask} />;
};

export default SidebarViewWebview;
