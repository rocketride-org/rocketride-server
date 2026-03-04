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

import React, { useState, useEffect, useRef } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';
import { TASK_STATE, TaskStatus, ConnectionState } from '../../../shared/types';
import { PipelineFlowSection } from '../../components/PipelineFlowSection';
import { ErrWarnSection } from '../../components/ErrWarnSection';
import { StatusSection, StatusHeader, StatusElapsed } from '../../components/StatusSection';
import { TokenSection } from '../../components/TokenSection';
import { TabPanel } from '../../components/TabPanel';
import { TraceSection, TraceRow } from '../../components/TraceSection';
import { EndpointInfoModal, EndpointInfo } from '../../components/EndpointInfoModal';
import { WarningIcon } from '../../components/icons/WarningIcon';

// Import the styles
import '../../styles/vscode.css'
import '../../styles/app.css';
import './styles.css';

// ============================================================================
// STATUS PAGE VIEW COMPONENT
// ============================================================================

export type PageStatusIncomingMessage
	= {
		type: 'update';
		taskStatus: TaskStatus | undefined;
		state: ConnectionState;
		host: string;
	}
	| {
		type: 'connectionState';
		state: ConnectionState;
	}
	| {
		type: 'traceEvent';
		pipelineId: number;
		op: 'begin' | 'enter' | 'leave' | 'end';
		pipes: string[];
		trace: {
			lane?: string;
			data?: Record<string, unknown>;
			result?: string;
			error?: string;
		};
	};

export type PageStatusOutgoingMessage
	= {
		type: 'ready';
	}
	| {
		type: 'openExternal';
		url: string;
	}
	| {
		type: 'pipelineAction';
		action: 'stop' | 'run' | 'restart';
		tracing?: boolean;
	};

/**
 * PageStatus - Main Layout Component for Pipeline Status Page
 *
 * Layout Structure:
 * - Fixed header: title + action buttons + status line
 * - Tab bar: Status, Tokens, Pipeline Flow, Errors
 * - Tab content: active tab panel
 */
export const PageStatus: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================
	const [taskStatus, setTaskStatus] = useState<TaskStatus | undefined>();
	const [activeTab, setActiveTab] = useState<string>('status');
	const [viewMode, setViewMode] = useState<'pipeline' | 'component'>('pipeline');
	const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
	const [host, setHost] = useState<string>('<unknown>');
	const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
	const [currentElapsed, setCurrentElapsed] = useState<number>(0);
	const [tracingEnabled, setTracingEnabled] = useState(false);
	const [traceRows, setTraceRows] = useState<TraceRow[]>([]);
	const [scrollToSectionTarget, setScrollToSectionTarget] = useState<'errors' | 'warnings' | null>(null);

	// Refs for elapsed timer
	const intervalRef = useRef<number | null>(null);

	// Document-based trace state: per-pipeline-slot routing with bounded archive
	interface TraceDocument { objectName: string; completed: boolean; rows: TraceRow[] }
	const traceIdRef = useRef<number>(0);
	const nextDocIdRef = useRef<number>(0);
	const MAX_DOCS = 64;
	const documentsRef = useRef<Map<number, TraceDocument>>(new Map());
	const docOrderRef = useRef<number[]>([]);
	const slotBindingsRef = useRef<Map<number, number>>(new Map());
	const pendingStacksRef = useRef<Map<number, TraceRow[]>>(new Map());

	const flushTraceRows = () => {
		const flatRows: TraceRow[] = [];
		for (const docId of docOrderRef.current) {
			const doc = documentsRef.current.get(docId);
			if (doc) {
				for (const row of doc.rows) {
					flatRows.push(row.completed === doc.completed ? row : { ...row, completed: doc.completed });
				}
			}
		}
		setTraceRows(flatRows);
	};

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady } = useMessaging<
		PageStatusOutgoingMessage, PageStatusIncomingMessage>({
			onMessage: (message) => {
				switch (message.type) {
					case 'update': {
						setTaskStatus(message.taskStatus);
						setConnectionState(message.state);
						setHost(message.host);
						break;
					}
					case 'connectionState': {
						setConnectionState(message.state);
						break;
					}
					case 'scrollToSection': {
						setActiveTab('errors');
						setScrollToSectionTarget(message.section);
						break;
					}
					case 'traceEvent': {
						const { pipelineId, op, pipes, trace } = message;
						const lane = trace.lane || op;

						if (op === 'begin') {
							// Create a new document and bind this pipeline slot to it
							const docId = nextDocIdRef.current++;
							const objectName = pipes[0] || '';
							documentsRef.current.set(docId, { objectName, completed: false, rows: [] });
							docOrderRef.current.push(docId);
							slotBindingsRef.current.set(pipelineId, docId);
							pendingStacksRef.current.set(pipelineId, []);

							// Evict oldest completed documents if over cap
							while (docOrderRef.current.length > MAX_DOCS) {
								const oldId = docOrderRef.current[0];
								const oldDoc = documentsRef.current.get(oldId);
								if (oldDoc && !oldDoc.completed) break; // don't evict in-flight docs
								docOrderRef.current.shift();
								documentsRef.current.delete(oldId);
							}

							flushTraceRows();

						} else if (op === 'enter') {
							const docId = slotBindingsRef.current.get(pipelineId);
							if (docId == null) break;
							const doc = documentsRef.current.get(docId);
							if (!doc) break;

							const filterName = pipes[pipes.length - 1] || '';
							const depth = Math.max(0, pipes.length - 2);
							const row: TraceRow = {
								id: traceIdRef.current++,
								docId,
								completed: false,
								lane,
								filterName,
								depth,
								data: trace.data,
								timestamp: Date.now(),
								objectName: doc.objectName
							};
							doc.rows.push(row);
							pendingStacksRef.current.get(pipelineId)?.push(row);
							flushTraceRows();

						} else if (op === 'leave') {
							const docId = slotBindingsRef.current.get(pipelineId);
							if (docId == null) break;
							const doc = documentsRef.current.get(docId);
							if (!doc) break;

							const pending = pendingStacksRef.current.get(pipelineId)?.pop();
							if (pending) {
								const idx = doc.rows.findIndex(r => r.id === pending.id);
								if (idx !== -1) {
									doc.rows[idx] = {
										...doc.rows[idx],
										result: trace.result,
										error: trace.error,
										endTimestamp: Date.now()
									};
								}
							}
							flushTraceRows();

						} else if (op === 'end') {
							const docId = slotBindingsRef.current.get(pipelineId);
							if (docId != null) {
								const doc = documentsRef.current.get(docId);
								if (doc) doc.completed = true;
							}
							slotBindingsRef.current.delete(pipelineId);
							pendingStacksRef.current.delete(pipelineId);
							flushTraceRows();
						}
						break;
					}
				}
			}
		});

	// ========================================================================
	// LIFECYCLE MANAGEMENT
	// ========================================================================
	useEffect(() => {
		if (isReady) {
			sendMessage({ type: 'ready' });
		}
	}, [isReady, sendMessage]);

	// Handle ESC key to close modal
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isEndpointModalOpen) {
				setIsEndpointModalOpen(false);
			}
		};

		document.addEventListener('keydown', handleEscape);
		return () => document.removeEventListener('keydown', handleEscape);
	}, [isEndpointModalOpen]);

	/**
	 * Real-Time Elapsed Time Update Effect
	 * (Lifted from StatusSection so StatusHeader in the fixed header can use it)
	 */
	useEffect(() => {
		if (intervalRef.current !== null) {
			window.clearInterval(intervalRef.current);
			intervalRef.current = null;
		}

		if (taskStatus && !taskStatus.completed && taskStatus.startTime > 0) {
			const updateElapsed = () => {
				const currentTimeSeconds = Math.floor(Date.now() / 1000);
				const elapsed = currentTimeSeconds - taskStatus.startTime;
				setCurrentElapsed(Math.max(0, elapsed));
			};

			updateElapsed();
			intervalRef.current = window.setInterval(updateElapsed, 1000);
		} else if (taskStatus?.completed) {
			setCurrentElapsed(0);
		}

		return () => {
			if (intervalRef.current !== null) {
				window.clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only reset timer on completion state
	}, [taskStatus?.completed, taskStatus?.startTime]);

	/** Scroll to Errors or Warnings section when requested (e.g. from sidebar "Errors"/"Warnings" click) */
	useEffect(() => {
		if (activeTab !== 'errors' || !scrollToSectionTarget) return;
		const id = `${scrollToSectionTarget}-section`;
		const timer = requestAnimationFrame(() => {
			document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			setScrollToSectionTarget(null);
		});
		return () => cancelAnimationFrame(timer);
	}, [activeTab, scrollToSectionTarget]);

	// ========================================================================
	// UTILITY FUNCTIONS
	// ========================================================================

	const isConnected = (): boolean => connectionState === ConnectionState.CONNECTED;

	const isConnecting = (): boolean => {
		return connectionState === ConnectionState.DOWNLOADING_ENGINE ||
			connectionState === ConnectionState.STARTING_ENGINE ||
			connectionState === ConnectionState.CONNECTING ||
			connectionState === ConnectionState.STOPPING_ENGINE;
	};

	/**
	 * Get endpoint info from TaskStatus.notes[0]
	 */
	const getEndpointInfo = (): EndpointInfo | null => {
		if (!taskStatus?.notes || taskStatus.notes.length === 0) {
			return null;
		}

		const firstNote = taskStatus.notes[0];
		if (firstNote &&
			typeof firstNote === 'object' &&
			'url-text' in firstNote &&
			'url-link' in firstNote &&
			'auth-text' in firstNote &&
			'auth-key' in firstNote) {
			return firstNote as EndpointInfo;
		}

		return null;
	};

	/**
	 * Process endpoint info to replace {host} placeholders
	 */
	const getProcessedButtonLink = (endpointInfo: EndpointInfo): string | undefined => {
		try {
			if (!endpointInfo['button-link'] || !host) {
				return endpointInfo['button-link'];
			}
			return endpointInfo['button-link'].replace(/{host}/g, host);
		} catch {
			return endpointInfo['button-link'];
		}
	};

	/**
	 * Determine the run/stop button state and action
	 */
	const getControlButton = () => {
		const state = taskStatus?.state ?? TASK_STATE.NONE;
		const runLabel = tracingEnabled ? 'Run & Trace' : 'Run';

		if (state === TASK_STATE.RUNNING || state === TASK_STATE.INITIALIZING) {
			return { label: 'Stop', action: 'stop' as const, disabled: false, className: 'action-btn stop-btn' };
		}
		if (state === TASK_STATE.NONE || state === TASK_STATE.CANCELLED || state === TASK_STATE.COMPLETED) {
			return { label: runLabel, action: 'run' as const, disabled: false, className: 'action-btn run-btn' };
		}
		return { label: runLabel, action: 'run' as const, disabled: true, className: 'action-btn run-btn disabled' };
	};

	/**
	 * Whether the pipeline is in a runnable state (show tracing toggle)
	 */
	const canRun = () => {
		const state = taskStatus?.state ?? TASK_STATE.NONE;
		return state === TASK_STATE.NONE || state === TASK_STATE.CANCELLED || state === TASK_STATE.COMPLETED;
	};

	const handleViewModeChange = (newViewMode: 'pipeline' | 'component') => setViewMode(newViewMode);

	const handleOpenExternal = (url: string) => sendMessage({ type: 'openExternal', url });

	const handlePipelineAction = (action: 'stop' | 'run') => sendMessage({ type: 'pipelineAction', action, tracing: tracingEnabled });

	// ========================================================================
	// RENDER
	// ========================================================================

	if (!isConnected()) {
		return (
			<div className="status-container">
				<div className="connection-status">
					{isConnecting() ? (
						<div className="connecting-message">
							<div className="spinner"></div>
							<p>Establishing connection to server...</p>
						</div>
					) : (
						<div className="disconnected-message">
							<p>Not connected to server</p>
							<p>Pipeline monitoring requires an active connection</p>
						</div>
					)}
				</div>
			</div>
		);
	}

	const endpointInfo = getEndpointInfo();
	const controlButton = getControlButton();
	const errorCount = (taskStatus?.errors?.length ?? 0) + (taskStatus?.warnings?.length ?? 0);

	// Build tab list (Errors tab always visible, badge shown when count > 0)
	const tabs = [
		{ id: 'status', label: 'Status' },
		{ id: 'tokens', label: 'Tokens' },
		{ id: 'flow', label: 'Flow' },
		{ id: 'trace', label: 'Trace' },
		{ id: 'errors', label: 'Errors', badge: errorCount > 0 ? <WarningIcon size={14} /> : undefined }
	];

	return (
		<div className="status-container">
			{/* Header: two-column grid — status left, actions right */}
			<div className="page-header">
				<div className="page-header-left">
					<StatusHeader taskStatus={taskStatus} currentElapsed={currentElapsed} />
				</div>
				<div className="page-header-right">
					<div className="panel-actions">
						{endpointInfo && typeof endpointInfo === 'object' && (
							<>
								{endpointInfo['button-text'] && endpointInfo['button-link'] && (
									<button
										className="action-btn"
										onClick={() => {
											const link = getProcessedButtonLink(endpointInfo);
											if (link) handleOpenExternal(link);
										}}
									>
										{endpointInfo['button-text']}
									</button>
								)}
								<button
									className="action-btn secondary"
									onClick={() => setIsEndpointModalOpen(true)}
								>
									Endpoint Info
								</button>
							</>
						)}
						<button
							className={controlButton.className}
							onClick={() => {
								if (!controlButton.disabled) handlePipelineAction(controlButton.action);
							}}
							disabled={controlButton.disabled}
						>
							{controlButton.label}
						</button>
					</div>
					{canRun() && (
						<label className="tracing-toggle">
							<input
								type="checkbox"
								checked={tracingEnabled}
								onChange={(e) => setTracingEnabled(e.target.checked)}
							/>
							<span className="tracing-toggle-label">Enable tracing</span>
						</label>
					)}
					<StatusElapsed taskStatus={taskStatus} currentElapsed={currentElapsed} />
				</div>
			</div>

			{/* Tab bar — outside the box, content boxed by .tab-content CSS. All panels always mounted so Performance Metrics state is preserved on tab switch. */}
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab}>
				<div
					className={activeTab === 'status' ? 'tab-panel' : 'tab-panel tab-panel-hidden'}
					role="tabpanel"
					aria-hidden={activeTab !== 'status'}
				>
					<StatusSection taskStatus={taskStatus} currentElapsed={currentElapsed} />
				</div>
				<div
					className={activeTab === 'tokens' ? 'tab-panel' : 'tab-panel tab-panel-hidden'}
					role="tabpanel"
					aria-hidden={activeTab !== 'tokens'}
				>
					<TokenSection taskStatus={taskStatus} />
				</div>
				<div
					className={activeTab === 'flow' ? 'tab-panel' : 'tab-panel tab-panel-hidden'}
					role="tabpanel"
					aria-hidden={activeTab !== 'flow'}
				>
					<PipelineFlowSection
						taskStatus={taskStatus}
						viewMode={viewMode}
						onViewModeChange={handleViewModeChange}
					/>
				</div>
				<div
					className={activeTab === 'trace' ? 'tab-panel' : 'tab-panel tab-panel-hidden'}
					role="tabpanel"
					aria-hidden={activeTab !== 'trace'}
				>
					<TraceSection
						rows={traceRows}
						onClear={() => {
							documentsRef.current.clear();
							docOrderRef.current = [];
							slotBindingsRef.current.clear();
							pendingStacksRef.current.clear();
							nextDocIdRef.current = 0;
							traceIdRef.current = 0;
							setTraceRows([]);
						}}
					/>
				</div>
				<div
					className={activeTab === 'errors' ? 'tab-panel' : 'tab-panel tab-panel-hidden'}
					role="tabpanel"
					aria-hidden={activeTab !== 'errors'}
				>
					{taskStatus && taskStatus.errors.length > 0 && (
						<div id="errors-section">
							<ErrWarnSection title="Errors" items={taskStatus.errors} type="error" />
						</div>
					)}
					{taskStatus && taskStatus.warnings.length > 0 && (
						<div id="warnings-section">
							<ErrWarnSection title="Warnings" items={taskStatus.warnings} type="warning" />
						</div>
					)}
					{(!taskStatus || (taskStatus.errors.length === 0 && taskStatus.warnings.length === 0)) && (
						<section className="status-section">
							<header className="section-header">Errors &amp; Warnings</header>
							<div className="section-content">
								<div className="no-data">No errors or warnings</div>
							</div>
						</section>
					)}
				</div>
			</TabPanel>

			{/* Endpoint Info Modal */}
			<EndpointInfoModal
				endpointInfo={endpointInfo}
				isOpen={isEndpointModalOpen}
				onClose={() => setIsEndpointModalOpen(false)}
				onOpenExternal={handleOpenExternal}
				host={host}
			/>
		</div>
	);
};

export default PageStatus;
