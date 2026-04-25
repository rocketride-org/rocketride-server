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
 *   - Pipelines: File tree with source components, run/stop, errors/warnings
 *   - Footer: Settings, Documentation, connection status
 */

import React, { useState, useCallback, useMemo, CSSProperties } from 'react';
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

interface PipelineSourceDTO {
	id: string;
	name: string;
	provider?: string;
	warnings: string[];
	running: boolean;
	taskErrors: string[];
	taskWarnings: string[];
}

interface PipelineFileDTO {
	fsPath: string;
	label: string;
	dir?: string;
	valid: boolean;
	projectId?: string;
	running: boolean;
	errorCount: number;
	warningCount: number;
	sources: PipelineSourceDTO[];
}

interface UnknownTaskDTO {
	projectId: string;
	sourceId: string;
	displayName: string;
	projectLabel: string;
}

interface SidebarData {
	connectionState: string;
	connectionMode: string;
	cloudUserName: string;
	tasks: DashboardTask[];
	pipelineFiles: PipelineFileDTO[];
	unknownTasks: UnknownTaskDTO[];
}

type OutgoingMessage = { type: 'view:ready' } | { type: 'connect' } | { type: 'disconnect' } | { type: 'command'; command: string; args?: unknown[] } | { type: 'openFile'; fsPath: string } | { type: 'runPipeline'; fsPath: string; sourceId?: string } | { type: 'stopPipeline'; projectId: string; sourceId: string } | { type: 'stopTask'; projectId: string; source: string };

type IncomingMessage = { type: 'update'; data: SidebarData } | { type: 'tasksUpdate'; tasks: DashboardTask[] } | { type: 'pipelineUpdate'; pipelineFiles: PipelineFileDTO[]; unknownTasks: UnknownTaskDTO[]; expandFiles?: string[] };

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
		padding: '8px 16px 4px',
		flexShrink: 0,
	} as CSSProperties,
	navItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '2px 8px',
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
		padding: '6px 16px 4px',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
		color: 'var(--vscode-sideBarSectionHeader-foreground)',
		borderTop: '1px solid var(--vscode-sideBarSectionHeader-border)',
		flexShrink: 0,
	} as CSSProperties,
	treeList: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '0 8px',
	} as CSSProperties,
	treeRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 4,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
	} as CSSProperties,
	chevron: {
		width: 16,
		textAlign: 'center' as const,
		fontSize: 10,
		flexShrink: 0,
		color: 'var(--vscode-foreground)',
		opacity: 0.7,
	} as CSSProperties,
	dot: (color: string) =>
		({
			width: 8,
			height: 8,
			borderRadius: '50%',
			backgroundColor: color,
			flexShrink: 0,
		}) as CSSProperties,
	treeName: {
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,
	dirLabel: {
		fontSize: 10,
		color: 'var(--vscode-descriptionForeground)',
		marginLeft: 4,
		flexShrink: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,
	badge: (color: string) =>
		({
			fontSize: 10,
			color,
			flexShrink: 0,
			marginLeft: 2,
		}) as CSSProperties,
	spacer: {
		flex: 1,
	} as CSSProperties,
	treeAction: (color: string) =>
		({
			background: 'none',
			border: 'none',
			cursor: 'pointer',
			fontSize: 14,
			padding: '2px 4px',
			borderRadius: 3,
			color,
			flexShrink: 0,
		}) as CSSProperties,
	emptyState: {
		padding: '16px',
		fontSize: 12,
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center' as const,
	} as CSSProperties,
	footer: {
		flexShrink: 0,
		borderTop: '1px solid var(--vscode-sideBarSectionHeader-border)',
		padding: '4px 16px 4px',
	} as CSSProperties,
	footerItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '2px 8px',
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
		padding: '4px 8px 2px',
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

const MODE_LABELS: Record<string, string> = {
	cloud: 'Cloud',
	docker: 'Docker',
	service: 'Service',
	onprem: 'On-prem',
	local: 'Local',
};

/** Returns the status dot colour for a source component. */
function sourceDotColor(source: PipelineSourceDTO): string {
	if (source.running) return '#22c55e';
	return 'var(--vscode-descriptionForeground)';
}

/** Builds a rich tooltip string for a source component. */
function sourceTooltip(source: PipelineSourceDTO): string {
	const lines: string[] = [];
	lines.push(source.name);
	lines.push(`Status: ${source.running ? 'Running' : 'Stopped'}`);
	if (source.provider) lines.push(`Node: ${source.provider}`);
	if (source.id) lines.push(`Component ID: ${source.id}`);
	if (source.warnings.length > 0) {
		lines.push('');
		lines.push(`Parse warnings (${source.warnings.length}):`);
		source.warnings.forEach((w) => lines.push(`  - ${w}`));
	}
	if (source.taskErrors.length > 0) {
		lines.push('');
		lines.push(`Errors (${source.taskErrors.length}):`);
		source.taskErrors.forEach((e) => lines.push(`  - ${e}`));
	}
	if (source.taskWarnings.length > 0) {
		lines.push('');
		lines.push(`Warnings (${source.taskWarnings.length}):`);
		source.taskWarnings.forEach((w) => lines.push(`  - ${w}`));
	}
	return lines.join('\n');
}

/** True when any source in a file has errors or warnings. */
function fileHasIssues(file: PipelineFileDTO): boolean {
	return file.errorCount > 0 || file.warningCount > 0;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const SidebarMain: React.FC = () => {
	const [data, setData] = useState<SidebarData | null>(null);
	const [hoveredItem, setHoveredItem] = useState<string | null>(null);
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'update':
					setData(msg.data);
					break;
				case 'tasksUpdate':
					setData((prev) => (prev ? { ...prev, tasks: msg.tasks } : null));
					break;
				case 'pipelineUpdate':
					setData((prev) => (prev ? { ...prev, pipelineFiles: msg.pipelineFiles, unknownTasks: msg.unknownTasks } : null));
					// Auto-expand files whose source just started
					if (msg.expandFiles?.length) {
						setExpandedFiles((prev) => {
							const next = new Set(prev);
							for (const fp of msg.expandFiles!) next.add(fp);
							return next;
						});
						setUserCollapsed((prev) => {
							const next = new Set(prev);
							for (const fp of msg.expandFiles!) next.delete(fp);
							return next;
						});
					}
					break;
			}
		},
	});

	const isConnected = data?.connectionState === 'connected';
	const isConnecting = data?.connectionState === 'connecting' || data?.connectionState === 'downloading-engine' || data?.connectionState === 'starting-engine';
	const mode = data?.connectionMode || 'local';
	const pipelineFiles = data?.pipelineFiles ?? [];
	const unknownTasks = data?.unknownTasks ?? [];

	const cmd = useCallback(
		(command: string) => {
			sendMessage({ type: 'command', command });
		},
		[sendMessage]
	);

	// ── Auto-expand files that have issues (user can still collapse) ─────────
	const effectiveExpanded = useMemo(() => {
		const set = new Set(expandedFiles);
		for (const file of pipelineFiles) {
			if (fileHasIssues(file) && !userCollapsed.has(file.fsPath)) {
				set.add(file.fsPath);
			}
		}
		return set;
	}, [expandedFiles, userCollapsed, pipelineFiles]);

	// ── Toggle helper ────────────────────────────────────────────────────────

	const toggleFile = useCallback((fsPath: string) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(fsPath)) {
				next.delete(fsPath);
				setUserCollapsed((uc) => new Set(uc).add(fsPath));
			} else {
				next.add(fsPath);
				setUserCollapsed((uc) => {
					const n = new Set(uc);
					n.delete(fsPath);
					return n;
				});
			}
			return next;
		});
	}, []);

	// ── Hover style helper ───────────────────────────────────────────────────

	const hoverNav = (id: string) => (hoveredItem === id ? { backgroundColor: 'var(--vscode-list-hoverBackground)' } : {});
	const hoverRow = (id: string) => (hoveredRow === id ? { backgroundColor: 'var(--vscode-list-hoverBackground)' } : {});

	// ── Whether the pipelines section has any content ─────────────────────────
	const hasFiles = pipelineFiles.length > 0;
	const hasUnknown = unknownTasks.length > 0;
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div style={S.container}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				<button style={{ ...S.navItem, ...hoverNav('new') }} onClick={() => cmd('rocketride.sidebar.files.createFile')} onMouseEnter={() => setHoveredItem('new')} onMouseLeave={() => setHoveredItem(null)}>
					<span style={{ fontSize: 16 }}>+</span>
					New pipeline
				</button>
				<button style={{ ...S.navItem, ...hoverNav('monitor'), ...(isConnected ? {} : S.navItemDisabled) }} onClick={() => isConnected && cmd('rocketride.page.monitor.open')} onMouseEnter={() => setHoveredItem('monitor')} onMouseLeave={() => setHoveredItem(null)} disabled={!isConnected}>
					<span style={{ fontSize: 14 }}>&#9776;</span>
					Monitor
				</button>
				<button style={{ ...S.navItem, ...hoverNav('deploy'), ...(isConnected ? {} : S.navItemDisabled) }} onClick={() => isConnected && cmd('rocketride.page.deploy.open')} onMouseEnter={() => setHoveredItem('deploy')} onMouseLeave={() => setHoveredItem(null)} disabled={!isConnected}>
					<span style={{ fontSize: 14 }}>&#9650;</span>
					Deployments
				</button>
			</div>

			{/* ── Pipelines (File Tree) ──────────────────────────────── */}
			<div style={S.sectionHeader}>Pipelines</div>
			<div style={S.treeList}>
				{!hasFiles && !hasUnknown && <div style={S.emptyState}>No pipeline files</div>}

				{/* ── Pipeline files ──────────────────────────────────── */}
				{pipelineFiles.map((file) => {
					const canExpand = file.valid && file.sources.length > 0;
					const isExpanded = effectiveExpanded.has(file.fsPath);
					const fileKey = `file:${file.fsPath}`;

					return (
						<React.Fragment key={file.fsPath}>
							{/* File row */}
							<div
								style={{ ...S.treeRow, ...hoverRow(fileKey) }}
								onMouseEnter={() => setHoveredRow(fileKey)}
								onMouseLeave={() => setHoveredRow(null)}
								onClick={() => {
									sendMessage({ type: 'openFile', fsPath: file.fsPath });
									if (canExpand) toggleFile(file.fsPath);
								}}
								title={file.valid ? file.fsPath : `${file.fsPath} (invalid JSON)`}
							>
								<span style={S.chevron}>{canExpand ? (isExpanded ? '\u25BC' : '\u25B6') : '\u00A0'}</span>
								<span style={S.treeName}>{file.label}</span>
								{!file.valid && <span style={S.badge('var(--vscode-errorForeground)')}>Parse Error</span>}
								<span style={S.spacer} />
								{file.valid && (file.errorCount > 0 ? <div style={S.dot('#e53935')} /> : file.warningCount > 0 ? <div style={S.dot('#eab308')} /> : file.running ? <div style={S.dot('#22c55e')} /> : null)}
							</div>

							{/* Source component children */}
							{canExpand &&
								isExpanded &&
								file.sources.map((source) => {
									const srcKey = `src:${file.fsPath}:${source.id}`;
									const errCount = source.taskErrors.length;
									const warnCount = source.taskWarnings.length + source.warnings.length;

									return (
										<div key={srcKey} style={{ ...S.treeRow, paddingLeft: 28, ...hoverRow(srcKey) }} onMouseEnter={() => setHoveredRow(srcKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => sendMessage({ type: 'openFile', fsPath: file.fsPath })} title={sourceTooltip(source)}>
											<div style={S.dot(sourceDotColor(source))} />
											<span style={S.treeName}>{source.name}</span>
											{errCount > 0 && <span style={S.badge('var(--vscode-errorForeground)')}>&#10006; {errCount}</span>}
											{warnCount > 0 && <span style={S.badge('var(--vscode-editorWarning-foreground)')}>&#9888; {warnCount}</span>}
											<span style={S.spacer} />
											{hoveredRow === srcKey && isConnected && file.projectId && (
												<button
													style={S.treeAction(source.running ? '#e53935' : '#4caf50')}
													title={source.running ? 'Stop' : 'Run'}
													onClick={(e) => {
														e.stopPropagation();
														if (source.running) {
															sendMessage({ type: 'stopPipeline', projectId: file.projectId!, sourceId: source.id });
														} else {
															sendMessage({ type: 'runPipeline', fsPath: file.fsPath, sourceId: source.id });
														}
													}}
												>
													{source.running ? '\u25A0' : '\u25B6'}
												</button>
											)}
										</div>
									);
								})}
						</React.Fragment>
					);
				})}

				{/* ── Unknown Tasks (Other) ────────────────────────────── */}
				{hasUnknown && (
					<>
						<div style={{ ...S.treeRow, marginTop: 4, ...hoverRow('unknown-root') }} onMouseEnter={() => setHoveredRow('unknown-root')} onMouseLeave={() => setHoveredRow(null)} onClick={() => setUnknownExpanded((p) => !p)}>
							<span style={S.chevron}>{unknownExpanded ? '\u25BC' : '\u25B6'}</span>
							<span style={{ ...S.treeName, fontWeight: 600 }}>Other</span>
							<span style={S.spacer} />
							<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{unknownTasks.length} running</span>
						</div>
						{unknownExpanded &&
							unknownTasks.map((ut) => {
								const utKey = `ut:${ut.projectId}:${ut.sourceId}`;
								return (
									<div key={utKey} style={{ ...S.treeRow, paddingLeft: 28, ...hoverRow(utKey) }} onMouseEnter={() => setHoveredRow(utKey)} onMouseLeave={() => setHoveredRow(null)} title={`Project: ${ut.projectId}\nSource: ${ut.sourceId}\nRunning (no local .pipe file)`}>
										<div style={S.dot('#22c55e')} />
										<span style={S.treeName}>{ut.displayName}</span>
										<span style={S.dirLabel}>{ut.projectLabel}</span>
										<span style={S.spacer} />
										{hoveredRow === utKey && isConnected && (
											<button
												style={S.treeAction('#e53935')}
												title="Stop"
												onClick={(e) => {
													e.stopPropagation();
													sendMessage({ type: 'stopPipeline', projectId: ut.projectId, sourceId: ut.sourceId });
												}}
											>
												{'\u25A0'}
											</button>
										)}
									</div>
								);
							})}
					</>
				)}
			</div>

			{/* ── Footer ─────────────────────────────────────────────── */}
			<div style={S.footer}>
				<button style={{ ...S.footerItem, ...hoverNav('settings') }} onClick={() => cmd('rocketride.page.settings.open')} onMouseEnter={() => setHoveredItem('settings')} onMouseLeave={() => setHoveredItem(null)}>
					<span>&#9881;</span>
					Settings
				</button>
				<button style={{ ...S.footerItem, ...hoverNav('docs') }} onClick={() => cmd('rocketride.sidebar.documentation.open')} onMouseEnter={() => setHoveredItem('docs')} onMouseLeave={() => setHoveredItem(null)}>
					<span>&#128214;</span>
					Documentation
				</button>

				{/* ── Connection Status ────────────────────────────────── */}
				<button style={{ ...S.statusBar, ...hoverNav('status') }} onClick={() => sendMessage({ type: isConnected ? 'disconnect' : 'connect' })} onMouseEnter={() => setHoveredItem('status')} onMouseLeave={() => setHoveredItem(null)} title={isConnected ? 'Click to disconnect' : 'Click to connect'}>
					<div style={S.statusDot(isConnected)} />
					<span style={S.statusText}>{isConnecting ? 'Connecting...' : isConnected ? `Connected (${MODE_LABELS[mode] || mode})` : 'Disconnected'}</span>
				</button>
			</div>
		</div>
	);
};
