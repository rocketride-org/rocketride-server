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
// TOOLS/PIPELINES — the Pipelines tool's SIDEBAR PANEL
// =============================================================================
//
// Extracted from the fixed-mode SidebarView monolith (Phase 5): the + New
// pipeline nav, the Explorer tree over the discovered entries, and the
// ad-hoc (unknown-task) section. The hosts feed it the discovery output
// (the controller's entries) and the task fold; everything rendered here is
// this tool's business alone.
// =============================================================================

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { BxChevronDown, BxChevronRight, BxNote, BxPlus, BxStop } from 'shell';
import { Explorer, NOOP_VFS, SidebarMenu } from 'shell';
import type { ExplorerConfig, ExplorerEntry, ExplorerStatus, ViewMenu } from 'shell';
import type { ExplorerFileAction } from 'shell';
import { PANEL_HOVER_BG, panelStyles } from '../../core/chrome/panelStyles';
import type { ActiveTaskState, ProjectEntry, UnknownTask } from './types';
import type { IntroMode } from '../../introCatalog';

/** Default configuration for the pipeline Explorer panel. */
const PIPELINE_CONFIG: ExplorerConfig = {
	title: 'My Pipelines',
	extensions: ['.pipe', '.pipe.json'],
	displayName: (name: string) => name.replace(/\.pipe(?:\.json)?$/, '') || name,
	createPlaceholder: 'pipeline name',
	emptyMessage: 'No pipeline files',
};

/** Props for {@link PipelinesSidebarPanel}. */
export interface IPipelinesSidebarPanelProps {
	/** Whether the engine connection is up (gates run/stop affordances). */
	isConnected: boolean;
	/** Subscription gate for child actions (run/stop buttons). */
	isSubscribed?: boolean;
	/** The discovered pipeline entries (the tool controller's state). */
	entries: ProjectEntry[];
	/** Live task state per `projectId.sourceId`. */
	activeTasks: Map<string, ActiveTaskState>;
	/** Running tasks with no matching local file. */
	unknownTasks?: UnknownTask[];
	/** Highlight the entry for this path (active editor), when known. */
	activeFilePath?: string;
	/** Navigation actions ('new' = create pipeline). */
	onNavigate: (target: 'new') => void;
	/** Open a pipeline file. */
	onOpenFile: (path: string) => void;
	/** File management, hosts that support it. */
	onFileManage?: (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => void;
	/** Extra per-file actions (e.g. Export). */
	fileActions?: ExplorerFileAction[];
	/** Run/stop a source component. */
	onSourceAction: (action: 'run' | 'stop', filePath: string, sourceId: string, projectId?: string) => void;
	/** Refresh the discovery. */
	onRefresh: () => void;
	/** Open the status page for an ad-hoc task. */
	onOpenUnknownTask?: (projectId: string, sourceId: string, displayName: string) => void;
	/** Open the embedded Introduction page. */
	onShowIntro?: (mode: IntroMode) => void;
}

/**
 * The Pipelines tool's sidebar body: nav, Explorer tree, ad-hoc tasks.
 */
export const PipelinesSidebarPanel: React.FC<IPipelinesSidebarPanelProps> = ({ isConnected, isSubscribed = true, entries, activeTasks, unknownTasks, activeFilePath, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, onOpenUnknownTask, onShowIntro }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const hasUnknown = (unknownTasks?.length ?? 0) > 0;
	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: PANEL_HOVER_BG } : {});

	// "+ New pipeline" with the embedded Introduction row above it.
	const navMenu: ViewMenu = {
		entries: [...(onShowIntro ? [{ id: 'intro', label: 'Introduction to Pipelines', icon: <BxNote size={16} /> }] : []), { id: 'new', label: 'New pipeline', icon: <BxPlus size={16} /> }],
	};

	const explorerEntries: ExplorerEntry[] = entries.map((e) => ({
		path: e.path,
		type: e.type,
		documentId: e.projectId,
		children: e.sources?.map((s) => ({ id: s.id, name: s.name, provider: s.provider })),
	}));

	const handleChildAction = useCallback(
		(action: 'run' | 'stop', filePath: string, childId: string, documentId?: string) => {
			onSourceAction(action, filePath, childId, documentId);
		},
		[onSourceAction],
	);

	return (
		<div style={panelStyles.panelColumn}>
			{/* ── Navigation ──────────────────────────────────────────────── */}
			<div style={panelStyles.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'new') onNavigate(id);
						if (id === 'intro') onShowIntro?.('pipelines');
					}}
				/>
			</div>

			{/* ── Explorer (file tree) — vfs is the typed no-op (frozen shell
			    contract shape; unused here) ───────────────────────────────── */}
			<Explorer vfs={NOOP_VFS} config={PIPELINE_CONFIG} entries={explorerEntries} statuses={activeTasks as Map<string, ExplorerStatus>} isConnected={isConnected} showChildActions={isSubscribed} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onFileManage={onFileManage} fileActions={fileActions} onChildAction={handleChildAction} onRefresh={onRefresh} />

			{/* ── Ad-hoc — server tasks with no local .pipe file ──────────── */}
			{hasUnknown && (
				<div style={{ padding: '2px 6px', flexShrink: 0 }}>
					<div style={{ ...panelStyles.row, marginTop: 4, ...hoverBg('unknown-root') }} onMouseEnter={() => setHoveredRow('unknown-root')} onMouseLeave={() => setHoveredRow(null)} onClick={() => setUnknownExpanded((p) => !p)}>
						{unknownExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
						<span style={{ ...panelStyles.rowName, ...commonStyles.labelUppercase, color: 'var(--rr-text-secondary)' }}>Ad-hoc</span>
						<span style={panelStyles.spacer} />
						<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{unknownTasks!.length} running</span>
					</div>
					{unknownExpanded &&
						unknownTasks!.map((ut) => {
							const utKey = `ut:${ut.projectId}:${ut.sourceId}`;
							return (
								<div key={utKey} style={{ ...panelStyles.row, paddingLeft: 28, ...hoverBg(utKey) }} onMouseEnter={() => setHoveredRow(utKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onOpenUnknownTask?.(ut.projectId, ut.sourceId, ut.displayName)} title={`Project: ${ut.projectId}\nSource: ${ut.sourceId}\nRunning (no local .pipe file)`}>
									<div style={panelStyles.dot('var(--rr-color-success)')} />
									<span style={panelStyles.rowName}>{ut.displayName}</span>
									<span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginLeft: 4 }}>{ut.projectLabel}</span>
									<span style={panelStyles.spacer} />
									{hoveredRow === utKey && isConnected && (
										<button
											style={panelStyles.actionBtn('var(--rr-color-error)')}
											title="Stop"
											onClick={(e) => {
												e.stopPropagation();
												onSourceAction('stop', '', ut.sourceId, ut.projectId);
											}}
										>
											<BxStop size={16} />
										</button>
									)}
								</div>
							);
						})}
				</div>
			)}
		</div>
	);
};

export default PipelinesSidebarPanel;
