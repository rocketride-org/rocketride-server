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
// PROFILER VIEW — Profiling controls, status, and tabbed visualisations
// =============================================================================
//
// Connects to a server via the shell's RocketRide client. Provides:
// - Target selector (Server Process or running pipeline)
// - Start/Stop profiling controls
// - Status display with owner and runtime
// - Tabbed visualisation area: Flame Graph | Sunburst | Table | Text
// =============================================================================

import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useShellConnection, getClient } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, ProfileTreeResponse, ProfilerTab } from './visualizations/types';
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

/** Tab definitions for the visualisation switcher. */
const TABS: { key: ProfilerTab; label: string }[] = [
	{ key: 'flame', label: 'Flame Graph' },
	{ key: 'sunburst', label: 'Sunburst' },
	{ key: 'table', label: 'Table' },
	{ key: 'text', label: 'Text' },
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
	// TAB BAR
	// =========================================================================

	/** Horizontal tab bar container. */
	tabBar: {
		display: 'flex',
		gap: 0,
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Individual tab button (inactive). */
	tab: {
		padding: '8px 16px',
		border: 'none',
		borderBottom: '2px solid transparent',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontWeight: 500,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
		transition: 'color 0.15s, border-color 0.15s',
	} as CSSProperties,

	/** Active tab button override. */
	tabActive: {
		color: 'var(--rr-brand)',
		borderBottomColor: 'var(--rr-brand)',
	} as CSSProperties,

	/** Content area below the tab bar — fills remaining space. */
	tabContent: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
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
// COMPONENT
// =============================================================================

/**
 * Profiler view for a single server connection.
 *
 * Provides a target selector (Server Process or running pipelines),
 * start/stop controls, status display, and tabbed visualisation area
 * with flame graph, sunburst, sortable table, and raw text views.
 */
const ProfilerView: React.FC<ProfilerViewProps> = ({ host, port, name }) => {
	const { isConnected } = useShellConnection();

	// =========================================================================
	// STATE
	// =========================================================================

	// Current profiling status from the server
	const [status, setStatus] = useState<CProfileStatus | null>(null);

	// Full pstats report text (for the Text tab)
	const [report, setReport] = useState<string>('');

	// Structured call tree data (for Flame Graph, Sunburst, Table tabs)
	const [treeData, setTreeData] = useState<ProfileTreeResponse | null>(null);

	// Available pipeline targets (from rrext_get_tasks)
	const [tasks, setTasks] = useState<TaskEntry[]>([]);

	// Selected target: null = Server Process, string = task token
	const [target, setTarget] = useState<string | null>(null);

	// Optional session name for the profiling session
	const [sessionName, setSessionName] = useState<string>('');

	// Error message to display
	const [error, setError] = useState<string>('');

	// Active visualisation tab
	const [activeTab, setActiveTab] = useState<ProfilerTab>('flame');

	// Selected node for cross-highlighting between visualisations
	const [selectedNode, setSelectedNode] = useState<ProfileTreeNode | null>(null);

	// Refs for polling intervals
	const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const tasksIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// =========================================================================
	// STATUS POLLING
	// =========================================================================

	/** Fetch cProfile status for the selected target. */
	const fetchStatus = useCallback(async () => {
		const client = getClient();
		if (!client || !client.isConnected()) return;
		try {
			// Build arguments — include target if profiling a pipeline
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

		// Initial fetch then poll
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
			// Task list may fail on model servers (no tasks) — that's fine
			setTasks([]);
		}
	}, []);

	/** Start polling task list when connected. */
	useEffect(() => {
		if (!isConnected) {
			if (tasksIntervalRef.current) { clearInterval(tasksIntervalRef.current); tasksIntervalRef.current = null; }
			return;
		}

		// Initial fetch then poll less frequently
		fetchTasks();
		tasksIntervalRef.current = setInterval(fetchTasks, TASKS_POLL_MS);

		return () => {
			if (tasksIntervalRef.current) { clearInterval(tasksIntervalRef.current); tasksIntervalRef.current = null; }
		};
	}, [isConnected, fetchTasks]);

	// =========================================================================
	// REPORT FETCHING
	// =========================================================================

	/** Fetch the text report and the structured tree independently. */
	const fetchReport = useCallback(async () => {
		const client = getClient();
		if (!client) return;

		// Build shared arguments
		const args: Record<string, unknown> = {};
		if (target) args.target = target;

		// Fetch text report — always available
		try {
			const textResult = await client.call<{ report: string }>('rrext_cprofile_report', args);
			setReport(textResult.report || 'No report available.');
		} catch (err) {
			console.log('[ProfilerView] Text report fetch failed:', err);
			// Clear stale report so the UI doesn't show outdated results
			setReport('');
		}

		// Fetch tree data — may not be available on older servers
		try {
			const treeResult = await client.call<ProfileTreeResponse>('rrext_cprofile_report_tree', args);
			setTreeData(treeResult);
		} catch (err) {
			console.log('[ProfilerView] Tree report fetch failed:', err);
			// Clear stale tree data so visualisations don't show outdated results
			setTreeData(null);
		}
	}, [target]);

	// =========================================================================
	// ACTIONS
	// =========================================================================

	/** Start a new profiling session on the selected target. */
	const handleStart = async () => {
		const client = getClient();
		if (!client) return;
		try {
			// Build arguments
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
				setSelectedNode(null);
			}
			// Refresh status immediately
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
			// Build arguments
			const args: Record<string, unknown> = {};
			if (target) args.target = target;

			const result = await client.call<{ status: string; message?: string }>('rrext_cprofile_stop', args);
			if (result.status === 'error') {
				setError(result.message || 'Failed to stop profiling');
			} else {
				setError('');
				// Fetch both report types after stopping
				await fetchReport();
			}
			await fetchStatus();
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Failed to stop profiling');
		}
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	// Show disconnected state
	if (!isConnected) {
		return <div style={styles.disconnected}>Connecting to {name} ({host}:{port})...</div>;
	}

	const isActive = status?.active === true;

	return (
		<div style={styles.container}>
			{/* Header */}
			<h2 style={styles.sectionTitle}>Profiler — {name}</h2>

			{/* Controls row */}
			<div style={styles.controls}>
				{/* Target selector — Server Process + running pipelines */}
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

				{/* View Report button — only when not actively profiling */}
				<button
					style={styles.button}
					onClick={fetchReport}
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

			{/* Visualisation tab bar */}
			<div style={styles.tabBar}>
				{TABS.map((tab) => (
					<button
						key={tab.key}
						style={{ ...styles.tab, ...(activeTab === tab.key ? styles.tabActive : {}) }}
						onClick={() => setActiveTab(tab.key)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Visualisation content area */}
			<div style={styles.tabContent}>
				{activeTab === 'flame' && (
					<FlameGraph
						treeData={treeData}
						selectedNode={selectedNode}
						onNodeSelect={setSelectedNode}
					/>
				)}
				{activeTab === 'sunburst' && (
					<SunburstChart
						treeData={treeData}
						selectedNode={selectedNode}
						onNodeSelect={setSelectedNode}
					/>
				)}
				{activeTab === 'table' && (
					<StatsTable
						treeData={treeData}
						selectedNode={selectedNode}
						onNodeSelect={setSelectedNode}
					/>
				)}
				{activeTab === 'text' && (
					<ReportText report={report} />
				)}
			</div>
		</div>
	);
};

export default ProfilerView;
