// MIT License
//
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
// PROFILER VIEW — SnakeViz-style stacked layout
// =============================================================================
//
// Layout matches snakeviz:
//   Controls → Viz Controls → Sunburst/Icicle → Call Stack → Stats Table
//
// No tabs — viz on top, table always visible below.
// Style dropdown switches between sunburst and icicle.
// Depth + Cutoff dropdowns filter client-side (not server params).
// Table row click and viz arc click both re-root the visualisation.
// =============================================================================

import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection, getClient } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, ProfileTreeResponse, VizStyle } from './visualizations/types';
import ReportText from './visualizations/ReportText';
import FlameGraph from './visualizations/FlameGraph';
import SunburstChart from './visualizations/SunburstChart';
import StatsTable from './visualizations/StatsTable';

// =============================================================================
// TYPES
// =============================================================================

/** Status response from rrext_cprofile_status. */
interface CProfileStatus {
	active: boolean;
	owner: string | null;
	session: string | null;
	runtime: number | null;
	has_report?: boolean;
}

/** A running task entry from rrext_get_tasks. */
interface TaskEntry {
	name: string;
	token: string;
	status: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Status polling interval in milliseconds. */
const STATUS_POLL_MS = 3000;

/** Task list refresh interval in milliseconds. */
const TASKS_POLL_MS = 10000;

/** Available depth options for the viz depth dropdown (matches snakeviz). */
const DEPTH_OPTIONS = [3, 5, 10, 15, 20];

/** Available cutoff options for the viz cutoff dropdown (matches snakeviz). */
const CUTOFF_OPTIONS = [
	{ value: 0.001, label: '1/1000' },
	{ value: 0.01, label: '1/100' },
	{ value: 0, label: 'None' },
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Root container fills entire client area. */
	container: {
		...commonStyles.columnFill,
		padding: 20,
		gap: 12,
		overflow: 'hidden',
	} as CSSProperties,

	/** Controls row — target selector, session name, buttons. */
	controls: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		flexWrap: 'wrap',
	} as CSSProperties,

	/** Target dropdown. */
	select: {
		padding: '6px 10px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
		minWidth: 200,
	} as CSSProperties,

	/** Smaller dropdown for viz controls. */
	smallSelect: {
		padding: '4px 8px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Session name text input. */
	sessionInput: {
		padding: '6px 10px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Generic button base. */
	button: {
		padding: '6px 14px',
		border: 'none',
		borderRadius: 4,
		fontSize: 13,
		cursor: 'pointer',
		fontWeight: 500,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Start profiling button colour. */
	startButton: {
		background: 'var(--rr-brand)',
		color: '#fff',
	} as CSSProperties,

	/** Stop profiling button colour. */
	stopButton: {
		background: 'var(--rr-error, #f44747)',
		color: '#fff',
	} as CSSProperties,

	/** Status bar below controls. */
	statusBar: {
		padding: '8px 12px',
		borderRadius: 4,
		fontSize: 13,
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Active-session status bar variant. */
	statusActive: {
		background: 'rgba(40, 167, 69, 0.15)',
		borderColor: 'rgba(40, 167, 69, 0.4)',
	} as CSSProperties,

	/** Inactive/idle status bar variant. */
	statusInactive: {
		background: 'rgba(108, 117, 125, 0.1)',
		borderColor: 'rgba(108, 117, 125, 0.3)',
	} as CSSProperties,

	/** Error text. */
	error: {
		color: 'var(--rr-error, #f44747)',
		fontSize: 13,
	} as CSSProperties,

	/** Section title. */
	sectionTitle: {
		fontSize: 14,
		fontWeight: 600,
		margin: 0,
	} as CSSProperties,

	/** Disconnected state placeholder. */
	disconnected: {
		...commonStyles.columnFill,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
	} as CSSProperties,

	// =========================================================================
	// VIZ CONTROLS ROW
	// =========================================================================

	/** Viz controls bar — style, depth, cutoff, reset buttons. */
	vizControls: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		flexWrap: 'wrap',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Label within viz controls. */
	vizLabel: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
	} as CSSProperties,

	/** Small button for Reset Zoom / Reset Root. */
	smallButton: {
		padding: '4px 10px',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		fontSize: 12,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// =========================================================================
	// CALL STACK
	// =========================================================================

	/** Call stack breadcrumb bar. */
	callStack: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '6px 8px',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-secondary)',
		borderTop: '1px solid var(--rr-border)',
		borderBottom: '1px solid var(--rr-border)',
		flexWrap: 'wrap',
	} as CSSProperties,

	/** Clickable call stack entry. */
	callStackLink: {
		color: 'var(--rr-text-link)',
		cursor: 'pointer',
		background: 'none',
		border: 'none',
		padding: 0,
		fontFamily: 'inherit',
		fontSize: 12,
	} as CSSProperties,

	/** Call stack separator arrow. */
	callStackSep: {
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,

	// =========================================================================
	// LAYOUT SECTIONS
	// =========================================================================

	/** Visualisation area — takes available space. */
	vizArea: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		minHeight: 200,
		overflow: 'hidden',
	} as CSSProperties,

	/** Table area — takes remaining space. */
	tableArea: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		minHeight: 150,
		overflow: 'hidden',
	} as CSSProperties,

	// =========================================================================
	// REPORT MODAL
	// =========================================================================

	/** Modal backdrop. */
	modalBackdrop: {
		position: 'fixed',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: 'rgba(0, 0, 0, 0.5)',
		zIndex: 9000,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,

	/** Modal dialog. */
	modalDialog: {
		background: 'var(--rr-bg-paper)',
		borderRadius: 8,
		width: '80%',
		maxWidth: 900,
		maxHeight: '80vh',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		border: '1px solid var(--rr-border)',
		boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
	} as CSSProperties,

	/** Modal header. */
	modalHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		padding: '12px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Modal body. */
	modalBody: {
		flex: 1,
		overflow: 'hidden',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

interface ProfilerViewProps {
	/** Server hostname. */
	host: string;
	/** Server port. */
	port: string;
	/** Display name of this connection. */
	name: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Find a node in the tree by identity (file + line + name).
 * Returns the path (ancestor chain) from root to the found node.
 */
function findNodePath(
	root: ProfileTreeNode,
	target: ProfileTreeNode,
): ProfileTreeNode[] | null {
	if (root.name === target.name && root.file === target.file && root.line === target.line) {
		return [root];
	}
	for (const child of root.children) {
		const path = findNodePath(child, target);
		if (path) return [root, ...path];
	}
	return null;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SnakeViz-style profiler view for a single server connection.
 *
 * Stacked layout: controls → viz controls → sunburst/icicle → call stack → table.
 * No tabs — visualisation and table are always visible simultaneously.
 */
const ProfilerView: React.FC<ProfilerViewProps> = ({ host, port, name }) => {
	const { isConnected } = useShellConnection();

	// =========================================================================
	// STATE
	// =========================================================================

	// Server state
	const [status, setStatus] = useState<CProfileStatus | null>(null);
	const [treeData, setTreeData] = useState<ProfileTreeResponse | null>(null);
	const [report, setReport] = useState<string>('');
	const [tasks, setTasks] = useState<TaskEntry[]>([]);
	const [target, setTarget] = useState<string | null>(null);
	const [sessionName, setSessionName] = useState<string>('');
	const [error, setError] = useState<string>('');

	// Viz state — snakeviz controls
	const [vizStyle, setVizStyle] = useState<VizStyle>('sunburst');
	const [vizDepth, setVizDepth] = useState<number>(10);
	const [vizCutoff, setVizCutoff] = useState<number>(0.001);
	const [showSystemCalls, setShowSystemCalls] = useState<boolean>(false);

	// Root tracking — distinct from tree root
	const [vizRoot, setVizRoot] = useState<ProfileTreeNode | null>(null);
	const [originalRoot, setOriginalRoot] = useState<ProfileTreeNode | null>(null);
	const [callStack, setCallStack] = useState<ProfileTreeNode[]>([]);

	// Report modal
	const [showReportModal, setShowReportModal] = useState(false);

	// Polling refs
	const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const tasksIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Guard against stale async responses when target changes mid-flight
	const fetchIdRef = useRef<number>(0);

	// Guard so an existing server-side report is rehydrated at most once per target
	const rehydratedTargetRef = useRef<string | null | undefined>(undefined);

	// =========================================================================
	// STATUS POLLING
	// =========================================================================

	/** Fetch profiling status for the selected target. */
	const fetchStatus = useCallback(async () => {
		const client = getClient();
		if (!client || !client.isConnected()) return;
		try {
			const args: Record<string, unknown> = {};
			if (target) args.target = target;
			const result = await client.call<CProfileStatus>('rrext_cprofile_status', args);
			setStatus(result);
		} catch (err) {
			console.log('[ProfilerView] Status fetch failed:', err);
		}
	}, [target]);

	/** Start polling status when connected. */
	useEffect(() => {
		if (!isConnected) {
			if (statusIntervalRef.current) { clearInterval(statusIntervalRef.current); statusIntervalRef.current = null; }
			return;
		}
		fetchStatus();
		statusIntervalRef.current = setInterval(fetchStatus, STATUS_POLL_MS);
		return () => {
			if (statusIntervalRef.current) { clearInterval(statusIntervalRef.current); statusIntervalRef.current = null; }
		};
	}, [isConnected, fetchStatus]);

	// =========================================================================
	// TASK LIST POLLING
	// =========================================================================

	/** Fetch the list of running tasks/pipelines for the target dropdown. */
	const fetchTasks = useCallback(async () => {
		const client = getClient();
		if (!client || !client.isConnected()) return;
		try {
			const result = await client.call<{ tasks: TaskEntry[] }>('rrext_get_tasks', {});
			setTasks(result.tasks || []);
		} catch {
			setTasks([]);
		}
	}, []);

	/** Start polling task list when connected. */
	useEffect(() => {
		if (!isConnected) {
			if (tasksIntervalRef.current) { clearInterval(tasksIntervalRef.current); tasksIntervalRef.current = null; }
			return;
		}
		fetchTasks();
		tasksIntervalRef.current = setInterval(fetchTasks, TASKS_POLL_MS);
		return () => {
			if (tasksIntervalRef.current) { clearInterval(tasksIntervalRef.current); tasksIntervalRef.current = null; }
		};
	}, [isConnected, fetchTasks]);

	// =========================================================================
	// REPORT FETCHING
	// =========================================================================

	/** Fetch both the text report and structured tree data. */
	const fetchReport = useCallback(async (systemCalls?: boolean) => {
		const client = getClient();
		if (!client) return;

		// Increment fetch ID so stale responses from a previous target are ignored
		const id = ++fetchIdRef.current;

		const args: Record<string, unknown> = {};
		if (target) args.target = target;

		// Fetch text report
		try {
			const textResult = await client.call<{ report: string }>('rrext_cprofile_report', args);
			if (fetchIdRef.current !== id) return; // stale response
			setReport(textResult.report || 'No report available.');
		} catch (err) {
			console.log('[ProfilerView] Text report fetch failed:', err);
			if (fetchIdRef.current !== id) return;
			setReport('');
		}

		// Fetch tree data — pass include_system flag to server
		const treeArgs: Record<string, unknown> = { ...args };
		const includeSystem = systemCalls ?? showSystemCalls;
		treeArgs.include_system = includeSystem;
		try {
			const treeResult = await client.call<ProfileTreeResponse>('rrext_cprofile_report_tree', treeArgs);
			if (fetchIdRef.current !== id) return; // stale response
			setTreeData(treeResult);
			// Set the original root and initial viz root
			if (treeResult.tree) {
				setOriginalRoot(treeResult.tree);
				setVizRoot(treeResult.tree);
				setCallStack([treeResult.tree]);
			} else {
				// Clear stale roots when tree response is empty
				setOriginalRoot(null);
				setVizRoot(null);
				setCallStack([]);
			}
		} catch (err) {
			console.log('[ProfilerView] Tree report fetch failed:', err);
			if (fetchIdRef.current !== id) return;
			setTreeData(null);
			setOriginalRoot(null);
			setVizRoot(null);
			setCallStack([]);
		}
	}, [target, showSystemCalls]);

	// Re-fetch tree when system calls toggle changes (if we have data)
	useEffect(() => {
		if (treeData?.tree) {
			fetchReport();
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showSystemCalls]);

	// Rehydrate an existing report when this view mounts (or re-mounts) without
	// local data — e.g. after the tab is split, which mounts fresh ProfilerView
	// instances. Report DATA lives only in local state and is otherwise populated
	// solely by the live Stop flow, so a fresh instance shows "No profiling data
	// available" even though the server still holds a report (status.has_report
	// stays true because it is server-backed). Fetch it once per target.
	useEffect(() => {
		if (!isConnected) { rehydratedTargetRef.current = undefined; return; }
		if (status?.active === true) return;   // a live session owns the data
		if (!status?.has_report) return;       // nothing on the server to rehydrate
		if (treeData?.tree != null) return;    // already have data locally
		if (rehydratedTargetRef.current === target) return; // already attempted for this target
		rehydratedTargetRef.current = target;
		fetchReport();
	}, [isConnected, status?.active, status?.has_report, target, treeData, fetchReport]);

	// =========================================================================
	// ROOT CHANGE HANDLER
	// =========================================================================

	/**
	 * Handle re-rooting the visualisation (from viz click or table row click).
	 * Builds the call stack by finding the path from the original root.
	 */
	const handleRootChange = useCallback((node: ProfileTreeNode) => {
		// Find the matching node in the ORIGINAL tree (not a pruned/copied node
		// from d3 — those lose their full subtree after limitDepth/pruneTree)
		if (originalRoot) {
			const path = findNodePath(originalRoot, node);
			if (path) {
				// Use the last element of the path — that's the node from the
				// original tree with its full subtree intact
				setVizRoot(path[path.length - 1]);
				setCallStack(path);
				return;
			}
		}
		// Fallback: use the clicked node directly
		setVizRoot(node);
		setCallStack([node]);
	}, [originalRoot]);

	// =========================================================================
	// ACTIONS
	// =========================================================================

	/** Start a new profiling session on the selected target. */
	const handleStart = async () => {
		const client = getClient();
		if (!client) return;
		try {
			const args: Record<string, unknown> = {};
			if (target) args.target = target;
			if (sessionName.trim()) args.session = sessionName.trim();

			const result = await client.call<{ status: string; message?: string }>('rrext_cprofile_start', args);
			if (result.status === 'error') {
				setError(result.message || 'Failed to start profiling');
			} else {
				setError('');
				// Clear stale data
				setReport('');
				setTreeData(null);
				setOriginalRoot(null);
				setVizRoot(null);
				setCallStack([]);
			}
			await fetchStatus();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to start profiling');
		}
	};

	/** Stop the active profiling session and fetch the report. */
	const handleStop = async () => {
		const client = getClient();
		if (!client) return;
		try {
			const args: Record<string, unknown> = {};
			if (target) args.target = target;

			const result = await client.call<{ status: string; message?: string }>('rrext_cprofile_stop', args);
			if (result.status === 'error') {
				setError(result.message || 'Failed to stop profiling');
			} else {
				setError('');
				await fetchReport();
			}
			await fetchStatus();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to stop profiling');
		}
	};

	/** Reset Zoom — go back to original root. */
	const handleResetRoot = useCallback(() => {
		if (originalRoot) {
			setVizRoot(originalRoot);
			setCallStack([originalRoot]);
		}
	}, [originalRoot]);

	// =========================================================================
	// RENDER
	// =========================================================================

	// Disconnected state
	if (!isConnected) {
		return <div style={styles.disconnected}>Connecting to {name} ({host}:{port})...</div>;
	}

	const isActive = status?.active === true;
	const hasData = treeData?.tree != null;
	const totalTime = treeData?.total_time ?? 0;

	return (
		<div style={styles.container}>
			{/* Header */}
			<h2 style={styles.sectionTitle}>Profiler — {name}</h2>

			{/* Controls row */}
			<div style={styles.controls}>
				{/* Target selector */}
				<select
					style={styles.select}
					value={target || ''}
					onChange={(e) => setTarget(e.target.value || null)}
					disabled={isActive}
				>
					<option value="">Server Process</option>
					{tasks.map((t) => (
						<option key={t.token} value={t.token}>
							{t.name} ({t.status})
						</option>
					))}
				</select>

				{/* Session name input */}
				<input
					type="text"
					placeholder="Session name (optional)"
					value={sessionName}
					onChange={(e) => setSessionName(e.target.value)}
					style={styles.sessionInput}
					disabled={isActive}
				/>

				{/* Start or Stop button */}
				{!isActive ? (
					<button style={{ ...styles.button, ...styles.startButton }} onClick={handleStart}>
						Start Profiling
					</button>
				) : (
					<button style={{ ...styles.button, ...styles.stopButton }} onClick={handleStop}>
						Stop Profiling
					</button>
				)}

				{/* View Report button — available whenever not actively profiling */}
				<button
					style={styles.button}
					onClick={() => {
						if (!report) fetchReport();
						setShowReportModal(true);
					}}
					disabled={isActive}
				>
					View Report
				</button>
			</div>

			{/* Error display */}
			{error && <div style={styles.error}>{error}</div>}

			{/* Status bar */}
			{status && (
				<div style={{ ...styles.statusBar, ...(isActive ? styles.statusActive : styles.statusInactive) }}>
					<strong>Status:</strong>{' '}
					{isActive
						? `Profiling "${status.session}" (owned by ${status.owner}, ${status.runtime?.toFixed(1)}s)`
						: 'Idle'
					}
					{!isActive && status.has_report && ' — report available'}
				</div>
			)}

			{/* Viz controls row — only shown when data is available */}
			{hasData && (
				<div style={styles.vizControls}>
					{/* Style dropdown */}
					<span style={styles.vizLabel}>
						Style:
						<select
							style={styles.smallSelect}
							value={vizStyle}
							onChange={(e) => setVizStyle(e.target.value as VizStyle)}
						>
							<option value="sunburst">Sunburst</option>
							<option value="icicle">Icicle</option>
						</select>
					</span>

					{/* Depth dropdown */}
					<span style={styles.vizLabel}>
						Depth:
						<select
							style={styles.smallSelect}
							value={vizDepth}
							onChange={(e) => setVizDepth(Number(e.target.value))}
						>
							{DEPTH_OPTIONS.map((d) => (
								<option key={d} value={d}>{d}</option>
							))}
						</select>
					</span>

					{/* Cutoff dropdown */}
					<span style={styles.vizLabel}>
						Cutoff:
						<select
							style={styles.smallSelect}
							value={vizCutoff}
							onChange={(e) => setVizCutoff(Number(e.target.value))}
						>
							{CUTOFF_OPTIONS.map((opt) => (
								<option key={opt.label} value={opt.value}>{opt.label}</option>
							))}
						</select>
					</span>

					{/* System calls checkbox — off by default, only show project code */}
					<label style={{ ...styles.vizLabel, cursor: 'pointer' }}>
						<input
							type="checkbox"
							checked={showSystemCalls}
							onChange={(e) => setShowSystemCalls(e.target.checked)}
						/>
						System calls
					</label>

					{/* Reset Root button */}
					<button
						style={styles.smallButton}
						onClick={handleResetRoot}
						disabled={vizRoot === originalRoot}
					>
						Reset Root
					</button>
				</div>
			)}

			{/* Visualisation area */}
			<div style={styles.vizArea}>
				{vizStyle === 'sunburst' ? (
					<SunburstChart
						root={vizRoot}
						totalTime={totalTime}
						maxDepth={vizDepth}
						cutoff={vizCutoff}
						onRootChange={handleRootChange}
					/>
				) : (
					<FlameGraph
						root={vizRoot}
						totalTime={totalTime}
						maxDepth={vizDepth}
						cutoff={vizCutoff}
						onRootChange={handleRootChange}
					/>
				)}
			</div>

			{/* Call stack — shows path from root to current viz root */}
			{hasData && callStack.length > 1 && (
				<div style={styles.callStack}>
					<span>Call Stack:</span>
					{callStack.map((node, i) => (
						<React.Fragment key={i}>
							{i > 0 && <span style={styles.callStackSep}>{'\u2192'}</span>}
							<button
								style={styles.callStackLink}
								onClick={() => handleRootChange(node)}
							>
								{node.name === '<root>' ? 'All' : node.name}
							</button>
						</React.Fragment>
					))}
				</div>
			)}

			{/* Stats table — always visible below the viz */}
			<div style={styles.tableArea}>
				<StatsTable
					treeData={treeData}
					vizRoot={vizRoot}
					onRootChange={handleRootChange}
					showSystemCalls={showSystemCalls}
				/>
			</div>

			{/* Report modal */}
			{showReportModal && (
				<div
					style={styles.modalBackdrop}
					onClick={() => setShowReportModal(false)}
				>
					<div
						style={styles.modalDialog}
						onClick={(e) => e.stopPropagation()}
					>
						<div style={styles.modalHeader}>
							<h3 style={{ margin: 0, fontSize: 14 }}>Raw Profile Report</h3>
							<button
								style={styles.button}
								onClick={() => setShowReportModal(false)}
							>
								Close
							</button>
						</div>
						<div style={styles.modalBody}>
							<ReportText report={report} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

export default ProfilerView;
