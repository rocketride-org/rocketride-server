// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMain — Unified RocketRide sidebar webview.
 *
 * Replaces the old split layout (PageConnection webview + SidebarFilesProvider
 * tree) with a single panel containing:
 *   - Navigation: New pipeline, Monitor, Deployments
 *   - Pipelines: Live active tasks from the server
 *   - Footer: Settings, Documentation, connection status
 */

import React, { useState, useCallback, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// TYPES
// =============================================================================

interface DashboardTask {
	id: string;
	name: string;
	projectId: string;
	source: string;
	state: number;
	completed: boolean;
	exitCode: number | null;
	status: string | null;
}

interface SidebarData {
	connectionState: string;
	connectionMode: string;
	cloudUserName: string;
	tasks: DashboardTask[];
}

type OutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'command'; command: string } | { type: 'runTask'; projectId: string; source: string } | { type: 'stopTask'; projectId: string; source: string };

type IncomingMessage = { type: 'update'; data: SidebarData } | { type: 'tasksUpdate'; tasks: DashboardTask[] };

// =============================================================================
// TASK STATES (from rocketride TASK_STATE enum)
// =============================================================================

const TASK_STATE = {
	NONE: 0,
	STARTING: 1,
	INITIALIZING: 2,
	RUNNING: 3,
	STOPPING: 4,
	COMPLETED: 5,
	CANCELLED: 6,
};

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: 'var(--vscode-font-size)',
		color: 'var(--vscode-foreground)',
		overflow: 'hidden',
	} as CSSProperties,
	navSection: {
		padding: '12px 16px 8px',
		flexShrink: 0,
	} as CSSProperties,
	navItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 8px',
		cursor: 'pointer',
		borderRadius: 4,
		fontSize: 13,
		color: 'var(--vscode-foreground)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
	navItemDisabled: {
		opacity: 0.5,
		cursor: 'default',
	} as CSSProperties,
	sectionHeader: {
		padding: '10px 16px 6px',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
		color: 'var(--vscode-sideBarSectionHeader-foreground)',
		borderTop: '1px solid var(--vscode-sideBarSectionHeader-border)',
		flexShrink: 0,
	} as CSSProperties,
	taskList: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '0 8px',
	} as CSSProperties,
	taskItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '5px 8px',
		borderRadius: 4,
		fontSize: 13,
	} as CSSProperties,
	taskDot: (color: string) =>
		({
			width: 8,
			height: 8,
			borderRadius: '50%',
			backgroundColor: color,
			flexShrink: 0,
		}) as CSSProperties,
	taskName: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,
	taskAction: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		fontSize: 14,
		padding: '2px 4px',
		borderRadius: 3,
		color: 'var(--vscode-foreground)',
		opacity: 0.6,
		flexShrink: 0,
	} as CSSProperties,
	emptyState: {
		padding: '16px',
		fontSize: 12,
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center' as const,
	} as CSSProperties,
	footer: {
		flexShrink: 0,
		borderTop: '1px solid var(--vscode-sideBarSectionHeader-border)',
		padding: '8px 16px 6px',
	} as CSSProperties,
	footerItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '5px 8px',
		cursor: 'pointer',
		borderRadius: 4,
		fontSize: 12,
		color: 'var(--vscode-descriptionForeground)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
	statusBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 8px 4px',
		fontSize: 12,
		cursor: 'pointer',
		borderRadius: 4,
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
	statusDot: (connected: boolean) =>
		({
			width: 8,
			height: 8,
			borderRadius: '50%',
			backgroundColor: connected ? '#22c55e' : 'var(--vscode-descriptionForeground)',
			flexShrink: 0,
		}) as CSSProperties,
	statusText: {
		flex: 1,
		fontSize: 12,
		color: 'var(--vscode-descriptionForeground)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

function getTaskColor(task: DashboardTask): string {
	if (task.completed && task.exitCode === 0) return 'var(--vscode-descriptionForeground)';
	if (task.completed && task.exitCode !== 0) return '#ef4444';
	if (task.state === TASK_STATE.RUNNING) return '#22c55e';
	if (task.state === TASK_STATE.STARTING || task.state === TASK_STATE.INITIALIZING) return '#eab308';
	if (task.state === TASK_STATE.STOPPING) return '#f97316';
	return 'var(--vscode-descriptionForeground)';
}

function getTaskStatusLabel(task: DashboardTask): string {
	if (task.completed && task.exitCode === 0) return 'Completed';
	if (task.completed) return 'Failed';
	if (task.state === TASK_STATE.RUNNING) return 'Running';
	if (task.state === TASK_STATE.STARTING) return 'Starting';
	if (task.state === TASK_STATE.INITIALIZING) return 'Initializing';
	if (task.state === TASK_STATE.STOPPING) return 'Stopping';
	return 'Idle';
}

function isTaskRunning(task: DashboardTask): boolean {
	return !task.completed && task.state >= TASK_STATE.STARTING && task.state <= TASK_STATE.STOPPING;
}

const MODE_LABELS: Record<string, string> = {
	cloud: 'Cloud',
	docker: 'Docker',
	service: 'Service',
	onprem: 'On-prem',
	local: 'Local',
};

// =============================================================================
// COMPONENT
// =============================================================================

export const SidebarMain: React.FC = () => {
	const [data, setData] = useState<SidebarData | null>(null);
	const [hoveredItem, setHoveredItem] = useState<string | null>(null);
	const [hoveredTask, setHoveredTask] = useState<string | null>(null);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'update':
					setData(msg.data);
					break;
				case 'tasksUpdate':
					setData((prev) => (prev ? { ...prev, tasks: msg.tasks } : null));
					break;
			}
		},
	});

	const isConnected = data?.connectionState === 'connected';
	const isConnecting = data?.connectionState === 'connecting' || data?.connectionState === 'downloading-engine' || data?.connectionState === 'starting-engine';
	const mode = data?.connectionMode || 'local';
	const tasks = data?.tasks || [];

	const cmd = useCallback(
		(command: string) => {
			sendMessage({ type: 'command', command });
		},
		[sendMessage]
	);

	const hoverStyle = (id: string) => (hoveredItem === id ? { backgroundColor: 'var(--vscode-list-hoverBackground)' } : {});

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div style={S.container}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				<button style={{ ...S.navItem, ...hoverStyle('new') }} onClick={() => cmd('rocketride.sidebar.files.createFile')} onMouseEnter={() => setHoveredItem('new')} onMouseLeave={() => setHoveredItem(null)}>
					<span style={{ fontSize: 16 }}>+</span>
					New pipeline
				</button>
				<button style={{ ...S.navItem, ...hoverStyle('monitor'), ...(isConnected ? {} : S.navItemDisabled) }} onClick={() => isConnected && cmd('rocketride.page.monitor.open')} onMouseEnter={() => setHoveredItem('monitor')} onMouseLeave={() => setHoveredItem(null)} disabled={!isConnected}>
					<span style={{ fontSize: 14 }}>&#9776;</span>
					Monitor
				</button>
				<button style={{ ...S.navItem, ...hoverStyle('deploy'), ...(isConnected ? {} : S.navItemDisabled) }} onClick={() => isConnected && cmd('rocketride.page.deploy.open')} onMouseEnter={() => setHoveredItem('deploy')} onMouseLeave={() => setHoveredItem(null)} disabled={!isConnected}>
					<span style={{ fontSize: 14 }}>&#9650;</span>
					Deployments
				</button>
			</div>

			{/* ── Pipelines (Active Tasks) ────────────────────────────── */}
			<div style={S.sectionHeader}>Pipelines</div>
			<div style={S.taskList}>
				{!isConnected && !isConnecting && <div style={S.emptyState}>Not connected</div>}
				{isConnecting && <div style={S.emptyState}>Connecting...</div>}
				{isConnected && tasks.length === 0 && <div style={S.emptyState}>No active pipelines</div>}
				{tasks.map((task) => {
					const running = isTaskRunning(task);
					return (
						<div
							key={task.id}
							style={{
								...S.taskItem,
								...(hoveredTask === task.id ? { backgroundColor: 'var(--vscode-list-hoverBackground)' } : {}),
							}}
							onMouseEnter={() => setHoveredTask(task.id)}
							onMouseLeave={() => setHoveredTask(null)}
							title={`${task.name} — ${getTaskStatusLabel(task)}`}
						>
							<div style={S.taskDot(getTaskColor(task))} />
							<span style={S.taskName}>{task.name}</span>
							{hoveredTask === task.id && (
								<>
									{!running && (
										<button style={S.taskAction} title="Run" onClick={() => sendMessage({ type: 'runTask', projectId: task.projectId, source: task.source })}>
											&#9654;
										</button>
									)}
									{running && (
										<button style={S.taskAction} title="Stop" onClick={() => sendMessage({ type: 'stopTask', projectId: task.projectId, source: task.source })}>
											&#9632;
										</button>
									)}
								</>
							)}
						</div>
					);
				})}
			</div>

			{/* ── Footer ─────────────────────────────────────────────── */}
			<div style={S.footer}>
				<button style={{ ...S.footerItem, ...hoverStyle('settings') }} onClick={() => cmd('rocketride.page.settings.open')} onMouseEnter={() => setHoveredItem('settings')} onMouseLeave={() => setHoveredItem(null)}>
					<span>&#9881;</span>
					Settings
				</button>
				<button style={{ ...S.footerItem, ...hoverStyle('docs') }} onClick={() => cmd('rocketride.sidebar.documentation.open')} onMouseEnter={() => setHoveredItem('docs')} onMouseLeave={() => setHoveredItem(null)}>
					<span>&#128214;</span>
					Documentation
				</button>

				{/* ── Connection Status ────────────────────────────────── */}
				<button style={{ ...S.statusBar, ...hoverStyle('status') }} onClick={() => sendMessage({ type: isConnected ? 'disconnect' : 'connect' })} onMouseEnter={() => setHoveredItem('status')} onMouseLeave={() => setHoveredItem(null)} title={isConnected ? 'Click to disconnect' : 'Click to connect'}>
					<div style={S.statusDot(isConnected)} />
					<span style={S.statusText}>{isConnecting ? 'Connecting...' : isConnected ? `Connected (${MODE_LABELS[mode] || mode})` : 'Disconnected'}</span>
				</button>
			</div>
		</div>
	);
};
