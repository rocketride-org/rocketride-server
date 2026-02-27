// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import React, { useState, useEffect } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';
import { TASK_STATE, TaskStatus, ConnectionState } from '../../../shared/types';
import { PipelineFlowSection } from '../../components/PipelineFlowSection';
import { ErrWarnSection } from '../../components/ErrWarnSection';
import { StatusSection } from '../../components/StatusSection';
import { TokenSection } from '../../components/TokenSection';
import { EndpointInfoModal, EndpointInfo } from '../../components/EndpointInfoModal';

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
		errorsRead?: boolean;
		warningsRead?: boolean;
	}
	| {
		type: 'connectionState';
		state: ConnectionState;
	}
	| {
		type: 'scrollToSection';
		section: 'errors' | 'warnings';
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
	}
	| {
		type: 'markAsRead';
		section: 'errors' | 'warnings';
	};

/**
 * PageStatus - Main Layout Component for Pipeline Status Page
 * 
 * Renders the unified status page layout with live connection to RocketRide server.
 * Features compact status + rate graph, full-width pipeline flow, and error/warning sections.
 * 
 * Layout Structure:
 * - Row 1: Unified Processing Rate & Status section (compact status + graph + endpoint actions)
 * - Row 2: Full-width Pipeline Flow section with view toggles (always displayed)
 * - Row 3: Metrics section (if metrics exist)
 * - Row 4: Full-width Errors section (if errors exist)
 * - Row 5: Full-width Warnings section (if warnings exist)
 */
export const PageStatus: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================
	const [taskStatus, setTaskStatus] = useState<TaskStatus | undefined>();
	const [viewMode, setViewMode] = useState<'pipeline' | 'component'>('pipeline');
	const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
	const [host, setHost] = useState<string>('<unknown>');
	const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
	const [errorsRead, setErrorsRead] = useState(false);
	const [warningsRead, setWarningsRead] = useState(false);

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
						if (message.errorsRead !== undefined) setErrorsRead(message.errorsRead);
						if (message.warningsRead !== undefined) setWarningsRead(message.warningsRead);
						break;
					}
					case 'connectionState': {
						setConnectionState(message.state);
						break;
					}
					case 'scrollToSection': {
						const el = document.getElementById(message.section === 'errors' ? 'errors-section' : 'warnings-section');
						el?.scrollIntoView({ behavior: 'smooth' });
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

	// ========================================================================
	// UTILITY FUNCTIONS
	// ========================================================================

	/**
	 * Connection state helpers
	 */
	const isConnected = (): boolean => {
		const result = connectionState === ConnectionState.CONNECTED;
		return result;
	};

	const isConnecting = (): boolean => {
		const result = connectionState === ConnectionState.DOWNLOADING_ENGINE ||
			connectionState === ConnectionState.STARTING_ENGINE ||
			connectionState === ConnectionState.CONNECTING ||
			connectionState === ConnectionState.STOPPING_ENGINE;
		return result;
	};

	/**
	 * Pipeline state helpers
	 */
	const _isPipelineRunning = (): boolean => {
		if (!taskStatus) return false;
		return taskStatus.state === TASK_STATE.RUNNING;
	};

	const _isDebuggerAttached = (): boolean => {
		if (!taskStatus) return false;
		return taskStatus.debuggerAttached === true;
	};

	const _isTaskStopping = (): boolean => {
		if (!taskStatus) return false;
		return taskStatus.state === TASK_STATE.STOPPING;
	};

	/**
	 * Data availability checkers
	 */
	const _hasAnyData = (): boolean => {
		return taskStatus !== undefined;
	};

	const _hasPipelineData = (): boolean => {
		return (taskStatus?.pipeflow?.byPipe &&
			Object.keys(taskStatus.pipeflow.byPipe).length > 0) || false;
	};

	/**
	 * Get endpoint info from TaskStatus.notes[0]
	 */
	const getEndpointInfo = (): EndpointInfo | null => {
		if (!taskStatus?.notes || taskStatus.notes.length === 0) {
			return null;
		}

		// Check if first note has endpoint info structure
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

	// Handle view mode changes
	const handleViewModeChange = (newViewMode: 'pipeline' | 'component') => {
		setViewMode(newViewMode);
	};

	// Handle external link opening
	const handleOpenExternal = (url: string) => {
		sendMessage({
			type: 'openExternal',
			url: url
		});
	};

	// Handle pipeline action buttons
	const handlePipelineAction = (action: 'stop' | 'run') => {
		sendMessage({
			type: 'pipelineAction',
			action: action
		});
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	/**
	 * Show connection status when not connected
	 */
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

	/**
	 * Main status dashboard with unified layout
	 * Always displayed when connected, regardless of data availability
	 */
	const endpointInfo = getEndpointInfo();

	return (
		<div className="status-container">
			{/* Row 1: Unified Processing Rate & Status (compact status + graph + endpoint actions) */}
			<StatusSection
				taskStatus={taskStatus}
				endpointInfo={endpointInfo}
				onOpenEndpointInfo={() => {
					setIsEndpointModalOpen(true);
				}}
				onOpenExternal={handleOpenExternal}
				onStop={() => handlePipelineAction('stop')}
				onRun={() => handlePipelineAction('run')}
				host={host}
				errorsRead={errorsRead}
				warningsRead={warningsRead}
			/>

			{/* Row 1.5: Token Usage */}
			<TokenSection taskStatus={taskStatus} />

		{/* Row 2: Pipeline Flow - Always displayed */}
		<PipelineFlowSection
			taskStatus={taskStatus}
			viewMode={viewMode}
			onViewModeChange={handleViewModeChange}
		/>

		{/* Row 3: Full-width Errors */}
		{taskStatus && taskStatus.errors.length > 0 && (
				<div id="errors-section">
					<ErrWarnSection
						title="Errors"
						items={taskStatus.errors}
						type="error"
						onMarkAsRead={() => sendMessage({ type: 'markAsRead', section: 'errors' })}
					/>
				</div>
			)}

		{/* Row 4: Full-width Warnings */}
		{taskStatus && taskStatus.warnings.length > 0 && (
				<div id="warnings-section">
					<ErrWarnSection
						title="Warnings"
						items={taskStatus.warnings}
						type="warning"
						onMarkAsRead={() => sendMessage({ type: 'markAsRead', section: 'warnings' })}
					/>
				</div>
			)}

			{/* Endpoint Info Modal */}
			<EndpointInfoModal
				endpointInfo={endpointInfo}
				isOpen={isEndpointModalOpen}
				onClose={() => {
					setIsEndpointModalOpen(false);
				}}
				onOpenExternal={handleOpenExternal}
				host={host}
			/>
		</div>
	);
};

export default PageStatus;
