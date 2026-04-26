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
 *   PageSidebarProvider (Node.js) ↔ postMessage ↔ SidebarViewWebview (browser)
 *     → SidebarView (shared-ui) + SidebarFooter (shared-ui)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';

import { SidebarView, BxUser, BxCog, BxExport, BxDesktop, BxCloudUpload, BxLock } from 'shared';
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
	name?: string;
	projectId: string;
	source: string;
	tasks?: { id: string; name: string; projectId: string; source: string }[];
}

type OutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'command'; command: string; args?: unknown[] } | { type: 'openFile'; fsPath: string } | { type: 'runPipeline'; fsPath: string; sourceId?: string } | { type: 'stopPipeline'; projectId: string; sourceId: string } | { type: 'refresh' } | { type: 'openUnknownTask'; projectId: string; sourceId: string; displayName: string } | { type: 'setDevelopmentMode'; mode: string } | { type: 'setDevelopmentTeam'; teamId: string } | { type: 'setDeployTargetMode'; mode: string | null } | { type: 'setDeployTargetTeam'; teamId: string } | { type: 'cloudSignIn' };

interface DashboardTaskDTO {
	id: string;
	name: string;
	projectId: string;
	source: string;
	completed: boolean;
	state: number;
}

interface TeamDTO {
	id: string;
	name: string;
	color?: string;
	memberCount?: number;
}

type IncomingMessage =
	| {
			type: 'update';
			data: {
				// Dev connection
				connectionState: string;
				connectionMode: string;
				developmentTeamId?: string;
				// Deploy connection
				deployConnectionState?: string;
				deployConnectionMode?: string | null;
				deployTargetTeamId?: string;
				// Teams (from respective servers)
				teams?: TeamDTO[];
				deployTeams?: TeamDTO[];
				// Shared auth
				cloudSignedIn?: boolean;
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
	const [developmentTeamId, setDevelopmentTeamId] = useState('');
	const [teams, setTeams] = useState<TeamDTO[]>([]);

	// ── Deploy connection state ─────────────────────────────────────────────
	const [deployConnectionState, setDeployConnectionState] = useState('disconnected');
	const [deployTargetMode, setDeployTargetMode] = useState<string | null>(null);
	const [deployTargetTeamId, setDeployTargetTeamId] = useState('');
	const [deployTeams, setDeployTeams] = useState<TeamDTO[]>([]);

	// ── Pipeline data ───────────────────────────────────────────────────────
	const [entries, setEntries] = useState<ProjectEntry[]>([]);
	const [activeTasks, setActiveTasks] = useState<Map<string, ActiveTaskState>>(new Map());
	const [unknownTasks, setUnknownTasks] = useState<UnknownTask[]>([]);

	// ── Shared auth + identity ──────────────────────────────────────────────
	const [userName, setUserName] = useState<string | undefined>();
	const [userEmail, setUserEmail] = useState<string | undefined>();
	const [cloudSignedIn, setCloudSignedIn] = useState(false);

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
						next.delete(key);
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
								displayName: t.name || t.source,
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
					if (msg.data.userName !== undefined) setUserName(msg.data.userName || undefined);
					if (msg.data.userEmail !== undefined) setUserEmail(msg.data.userEmail || undefined);
					// Shared auth
					if (msg.data.cloudSignedIn !== undefined) setCloudSignedIn(msg.data.cloudSignedIn);

					// Dev connection state
					if (msg.data.teams) setTeams(msg.data.teams);
					if (msg.data.connectionMode) setDevelopmentMode(msg.data.connectionMode);
					if (msg.data.developmentTeamId !== undefined) setDevelopmentTeamId(msg.data.developmentTeamId);

					// Deploy connection state
					if (msg.data.deployTeams) setDeployTeams(msg.data.deployTeams);
					if (msg.data.deployConnectionState) setDeployConnectionState(msg.data.deployConnectionState);
					if (msg.data.deployConnectionMode !== undefined) setDeployTargetMode(msg.data.deployConnectionMode ?? null);
					if (msg.data.deployTargetTeamId !== undefined) setDeployTargetTeamId(msg.data.deployTargetTeamId);
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

				case 'dashboardSnapshot': {
					// Seed active tasks + unknown tasks from dashboard (initial load)
					const taskMap = new Map<string, ActiveTaskState>();
					const unknown: UnknownTask[] = [];
					for (const t of msg.tasks) {
						if (t.completed) continue;
						const k = `${t.projectId}.${t.source}`;
						taskMap.set(k, { running: true, errors: [], warnings: [] });
						if (!isKnownTask(t.projectId, t.source)) {
							unknown.push({ projectId: t.projectId, sourceId: t.source, displayName: t.name || t.source, projectLabel: t.projectId.substring(0, 8) });
						}
					}
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
				deploy: 'rocketride.page.deploy.open',
				templates: 'rocketride.page.templates.open',
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

	const onToggleConnection = useCallback(() => {
		sendMessage({ type: connection.state === 'connected' ? 'disconnect' : 'connect' });
	}, [sendMessage, connection.state]);

	const onOpenDocs = useCallback(() => {
		sendMessage({ type: 'command', command: 'rocketride.sidebar.documentation.open' });
	}, [sendMessage]);

	const onOpenUnknownTask = useCallback(
		(projectId: string, sourceId: string, displayName: string) => {
			sendMessage({ type: 'openUnknownTask', projectId, sourceId, displayName });
		},
		[sendMessage]
	);

	// ── Footer menu items (dynamic based on auth + connection state) ────────
	//
	// The menu structure adapts to three states:
	//   1. Anonymous: Development Mode (Local/Docker/Service/On-prem/Cloud sign-in) + Settings
	//   2. Cloud signed in: Development Mode + Deploy Target + Account/Billing/Settings/Log out
	//   3. Both submenus show Cloud → team list when teams are available
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Builds a submenu of cloud team items for either Development Mode or Deploy Target.
	 * Each team item shows a checkmark for the currently selected team.
	 *
	 * @param teamList - The team list to render (dev teams or deploy teams)
	 * @param selectedTeamId - The currently selected team ID (for checkmark display)
	 * @param onSelect - Callback invoked when the user selects a team
	 * @returns Array of SidebarFooterMenuItem for the team submenu
	 */
	const buildCloudTeamSubmenu = useCallback((teamList: TeamDTO[], selectedTeamId: string, onSelect: (teamId: string) => void): SidebarFooterMenuItem[] => {
		return teamList.map((t) => ({
			id: t.id,
			label: t.name,
			checked: selectedTeamId === t.id,
			onClick: () => onSelect(t.id),
		}));
	}, []);

	const footerMenuItems: SidebarFooterMenuItem[] = useMemo(() => {
		const items: SidebarFooterMenuItem[] = [];

		// ── Development Mode submenu ────────────────────────────────────────
		const devModeItems: SidebarFooterMenuItem[] = [{ id: 'dev-local', label: 'Local', icon: BxDesktop, checked: developmentMode === 'local', onClick: () => sendMessage({ type: 'setDevelopmentMode', mode: 'local' }) }];

		// Cloud: submenu of teams when signed in, sign-in action when not
		if (cloudSignedIn && teams.length > 0) {
			devModeItems.push({
				id: 'dev-cloud',
				label: 'Cloud',
				icon: BxCloudUpload,
				submenu: buildCloudTeamSubmenu(teams, developmentTeamId, (teamId: string) => {
					sendMessage({ type: 'setDevelopmentTeam', teamId });
					// Only switch mode if not already cloud — avoids needless reconnect
					if (developmentMode !== 'cloud') {
						sendMessage({ type: 'setDevelopmentMode', mode: 'cloud' });
					}
				}),
			});
		} else {
			devModeItems.push({
				id: 'dev-cloud',
				label: 'Cloud',
				icon: BxLock,
				onClick: () => sendMessage({ type: 'cloudSignIn' }),
			});
		}

		devModeItems.push({ id: 'dev-docker', label: 'Docker', checked: developmentMode === 'docker', onClick: () => sendMessage({ type: 'setDevelopmentMode', mode: 'docker' }) }, { id: 'dev-service', label: 'Service', checked: developmentMode === 'service', onClick: () => sendMessage({ type: 'setDevelopmentMode', mode: 'service' }) }, { id: 'dev-onprem', label: 'On-prem', icon: BxCog, checked: developmentMode === 'onprem', onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open' }) });

		items.push({ id: 'dev-mode', label: 'Development Mode', submenu: devModeItems });

		// ── Deploy Target submenu (always available — you can deploy to
		//    on-prem/docker without cloud, or to cloud teams when signed in) ──
		{
			const deployItems: SidebarFooterMenuItem[] = [];

			// Local deploy target (dev in cloud, deploy locally)
			deployItems.push({
				id: 'deploy-local',
				label: 'Local',
				icon: BxDesktop,
				checked: deployTargetMode === 'local',
				onClick: () => sendMessage({ type: 'setDeployTargetMode', mode: 'local' }),
			});

			// Cloud teams — use dev teams or deploy teams (whichever is available,
			// since teams are account-level and the same on any cloud server)
			const availableDeployTeams = deployTeams.length > 0 ? deployTeams : teams;
			if (cloudSignedIn && availableDeployTeams.length > 0) {
				deployItems.push({
					id: 'deploy-cloud',
					label: 'Cloud',
					icon: BxCloudUpload,
					submenu: buildCloudTeamSubmenu(availableDeployTeams, deployTargetTeamId, (teamId: string) => {
						sendMessage({ type: 'setDeployTargetTeam', teamId });
						// Only switch mode if not already cloud — avoids needless reconnect
						if (deployTargetMode !== 'cloud') {
							sendMessage({ type: 'setDeployTargetMode', mode: 'cloud' });
						}
					}),
				});
			} else if (!cloudSignedIn) {
				// Cloud requires sign-in — show sign-in action
				deployItems.push({
					id: 'deploy-cloud',
					label: 'Cloud',
					icon: BxLock,
					onClick: () => sendMessage({ type: 'cloudSignIn' }),
				});
			}

			deployItems.push({ id: 'deploy-onprem', label: 'On-prem', icon: BxCog, checked: deployTargetMode === 'onprem', onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open' }) }, { id: 'deploy-docker', label: 'Docker', checked: deployTargetMode === 'docker', onClick: () => sendMessage({ type: 'setDeployTargetMode', mode: 'docker' }) }, { id: 'deploy-service', label: 'Service', checked: deployTargetMode === 'service', onClick: () => sendMessage({ type: 'setDeployTargetMode', mode: 'service' }) });

			// Show deploy connection state in the label when connected
			const deployLabel = deployConnectionState === 'connected' ? 'Deploy Target  ●' : 'Deploy Target';
			items.push({ id: 'deploy-target', label: deployLabel, submenu: deployItems });
		}

		// ── Account / Billing / Settings / Log out ──────────────────────────
		if (cloudSignedIn) {
			items.push({ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.account.open' }) }, { id: 'billing', label: 'Billing', icon: BxCog, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.billing.open' }) });
		}

		items.push({ id: 'settings', label: 'Settings', icon: BxCog, dividerBefore: !cloudSignedIn, onClick: () => sendMessage({ type: 'command', command: 'rocketride.page.settings.open' }) });

		if (cloudSignedIn) {
			items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: true, onClick: () => sendMessage({ type: 'command', command: 'rocketride.cloud.logout' }) });
		}

		return items;
	}, [sendMessage, cloudSignedIn, teams, deployTeams, developmentMode, developmentTeamId, deployTargetMode, deployTargetTeamId, deployConnectionState, buildCloudTeamSubmenu]);

	// ── Footer slot ─────────────────────────────────────────────────────────
	const footerSlot = <SidebarFooter collapsed={false} userName={userName} userEmail={userEmail} onOpenDocs={onOpenDocs} connection={{ ...connection, onToggle: onToggleConnection }} menuItems={footerMenuItems} />;

	// ── Render ───────────────────────────────────────────────────────────────

	return <SidebarView connection={connection} entries={entries} activeTasks={activeTasks} unknownTasks={unknownTasks} onNavigate={onNavigate} onOpenFile={onOpenFile} onSourceAction={onSourceAction} onRefresh={onRefresh} footerSlot={footerSlot} onOpenUnknownTask={onOpenUnknownTask} />;
};

export default SidebarViewWebview;
