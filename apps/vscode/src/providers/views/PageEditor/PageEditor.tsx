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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';
import { TaskStatus } from '../../../shared/types';
import { Canvas } from 'shared';
import type { IDynamicForms, IProject, IValidateResponse } from 'shared';

// Import the styles
import '../../styles/vscode.css'
import '../../styles/app.css';
import './styles.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type PageEditorIncomingMessage
	= {
		type: 'update';
		content: string;
	}
	| {
		type: 'taskStatusUpdate';
		source: string; // Component ID
		taskStatus: TaskStatus; // Single TaskStatus update from backend
	}
	| {
		type: 'servicesUpdate';
		services: IDynamicForms;
	}
	| {
		type: 'oauth2Config';
		oauth2RootUrl: string;
	}
	| {
		type: 'preferences';
		preferences: Record<string, unknown>;
	}
	| {
		type: 'validateResponse';
		result: unknown;
		error?: string;
	};

export type PageEditorOutgoingMessage
	= {
		type: 'ready';
	}
	| {
		type: 'save';
		content: string;
	}
	| {
		type: 'contentChanged';
		content: string;
	}
	| {
		type: 'run';
		pipeline: IProject;
	}
	| {
		type: 'stop';
		componentId: string;
	}
	| {
		type: 'openExternal';
		url: string;
	}
	| {
		type: 'setPreference';
		key: string;
		value: unknown;
	}
	| { type: 'requestUndo' }
	| { type: 'requestRedo' }
	| {
		type: 'validate';
		pipeline: IProject;
	};

// ============================================================================
// MAIN EDITOR VIEW COMPONENT
// ============================================================================

/**
 * PageEditor - Full-screen pipeline editor interface for VS Code webview
 * 
 * Provides a complete pipeline editor experience with visual editing capabilities.
 * Communicates with VS Code extension via useMessaging for file operations.
 * 
 * Features:
 * - Full-screen iframe embedding the pipeline editor
 * - Document content synchronization with VS Code
 * - Save functionality integration
 * - Real-time content updates from extension
 */
export const PageEditor: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const [content, setContent] = useState<object>({});
	// Map of component source ID -> TaskStatus
	const [taskStatuses, setTaskStatuses] = useState<Record<string, TaskStatus>>({});
	// Map of component provider name -> pipe count (how many pipes flow through it)
	const [componentPipeCounts, setComponentPipeCounts] = useState<Record<string, number>>({});
	// Total pipes in the pipeline (for progress calculation)
	const [totalPipes, setTotalPipes] = useState<number>(0);
	// Services list from extension (cached on connect, updated in background when editor opens)
	const [servicesJson, setServicesJson] = useState<IDynamicForms>({});
	// OAuth2 root URL for refresh path (from extension settings, default used until message received)
	const [oauth2RootUrl, setOauth2RootUrl] = useState<string>('https://oauth2.rocketride.ai');
	// Canvas preferences (synced from extension on ready, persisted via setPreference)
	const [preferences, setPreferences] = useState<Record<string, unknown>>({});

	const contentChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingContentRef = useRef<string | null>(null);
	const pendingValidate = useRef<{ resolve: (value: IValidateResponse) => void; reject: (reason: unknown) => void } | null>(null);
	const CONTENT_CHANGED_DEBOUNCE_MS = 350;

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady: _isReady } = useMessaging<
		PageEditorOutgoingMessage, PageEditorIncomingMessage>({
		onMessage: (message) => {
			// Handle all incoming messages from your discriminated union
			switch (message.type) {
			case 'update':
				if (message.content && message.content !== "") {
					setContent(JSON.parse(message.content));
				}
				break;
			case 'taskStatusUpdate': {
				// Drive canvas node state from status_update: merge this source's status
				// so the node with id === source (e.g. chat_2) re-renders with run/Processing/offline.
				const { source, taskStatus } = message;
				setTaskStatuses(prev => ({
					...prev,
					[source]: taskStatus
				}));

				// Process pipeflow data to count pipes per component
				if (taskStatus.pipeflow?.byPipe) {
					const byPipe = taskStatus.pipeflow.byPipe;
					
					// Reset all existing counts to 0, but keep the keys
					setComponentPipeCounts(prevCounts => {
						const counts: Record<string, number> = { ...prevCounts };
						
						// Reset all existing counts to 0
						Object.keys(counts).forEach(key => {
							counts[key] = 0;
						});
						
						// Walk through each pipe and update counts
						Object.entries(byPipe).forEach(([_pipeId, pipeline]: [string, string[]]) => {
							// Skip first element (filename), process rest as component names
							const components = pipeline.slice(1);
							
							components.forEach(componentName => {
								// Add to dict if not there, then increment
								if (!(componentName in counts)) {
									counts[componentName] = 0;
								}
								counts[componentName]++;
							});
						});
						
						return counts;
					});
					
					setTotalPipes(taskStatus.pipeflow.totalPipes || Object.keys(taskStatus.pipeflow.byPipe).length);
				} else {
					// When no byPipe data, reset counts to 0 but keep the dict keys
					setComponentPipeCounts(prevCounts => {
						const counts: Record<string, number> = { ...prevCounts };
						Object.keys(counts).forEach(key => {
							counts[key] = 0;
						});
						return counts;
					});
				}
				break;
			}
			case 'servicesUpdate':
				setServicesJson(message.services ?? {});
				break;
			case 'oauth2Config':
				if (message.oauth2RootUrl) {
					setOauth2RootUrl(message.oauth2RootUrl);
				}
				break;
			case 'preferences':
				if (message.preferences && typeof message.preferences === 'object') {
					setPreferences(message.preferences);
				}
				break;
			case 'validateResponse':
				if (message.error) {
					pendingValidate.current?.reject(new Error(message.error));
				} else {
					pendingValidate.current?.resolve(message.result as IValidateResponse);
				}
				pendingValidate.current = null;
				break;
			}
		}
	});

	// ========================================================================
	// EVENT HANDLERS
	// ========================================================================

	/**
	 * Handles save requests from the pipeline editor iframe
	 * 
	 * @param newContent The updated pipeline content to save
	 */
	const handleSave = (newContent: object): void => {
		sendMessage({
			type: 'save',
			content: JSON.stringify(newContent)
		});
		setContent(newContent);
	};

	/**
	 * Handles running the pipeline
	 *
	 * @param pipeline The pipeline to run
	 */
	const handleRun = (pipeline: IProject): void => {
		sendMessage({
			type: 'run',
			pipeline: pipeline
		});
	};

	/**
	 * Handles stopping a running pipeline
	 *
	 * @param componentId The component ID to stop
	 */
	const handleStop = (componentId: string): void => {
		sendMessage({
			type: 'stop',
			componentId: componentId
		});
	};

	/**
	 * Validates the pipeline before running or saving.
	 * Sends a validate message to the extension host, which forwards it
	 * to the server via the typed client SDK. The response arrives as a
	 * 'validateResponse' message handled in the onMessage switch above.
	 */
	const handleValidatePipeline = (pipeline: IProject): Promise<IValidateResponse> => {
		return new Promise((resolve, reject) => {
			pendingValidate.current = { resolve, reject };
			sendMessage({ type: 'validate', pipeline });
		});
	};

	const onOpenLink = useCallback((url: string) => {
		sendMessage({ type: 'openExternal', url });
	}, [sendMessage]);

	const getPreference = useCallback((key: string) => preferences[key] ?? null, [preferences]);
	const setPreference = useCallback((key: string, value: unknown) => {
		setPreferences(prev => ({ ...prev, [key]: value }));
		sendMessage({ type: 'setPreference', key, value });
	}, [sendMessage]);

	// Forward Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y to host so VSCode undo/redo drives the document
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			if (e.key === 'z' && !e.shiftKey) {
				e.preventDefault();
				sendMessage({ type: 'requestUndo' });
			} else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
				e.preventDefault();
				sendMessage({ type: 'requestRedo' });
			}
		};
		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [sendMessage]);

	const onContentChanged = useCallback(
		(project: object) => {
			pendingContentRef.current = JSON.stringify(project);
			if (contentChangedTimerRef.current) clearTimeout(contentChangedTimerRef.current);
			contentChangedTimerRef.current = setTimeout(() => {
				contentChangedTimerRef.current = null;
				const contentToSend = pendingContentRef.current;
				pendingContentRef.current = null;
				if (contentToSend) {
					sendMessage({ type: 'contentChanged', content: contentToSend });
				}
			}, CONTENT_CHANGED_DEBOUNCE_MS);
		},
		[sendMessage]
	);

	// ========================================================================
	// RENDER
	// ========================================================================

	const hasServices = Object.keys(servicesJson).length > 0;

	if (!hasServices) {
		return (
			<div className="pipeline-editor-container">
				<div className="connection-status">
					<div className="connecting-message">
						<div className="spinner"></div>
						<p>Establishing connection to server...</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="pipeline-editor-container">
			<Canvas
				oauth2RootUrl={oauth2RootUrl}
				project={content}
				servicesJson={servicesJson}
				handleRunPipeline={handleRun}
				handleStopPipeline={handleStop}
				handleSaveProject={handleSave}
				handleValidatePipeline={handleValidatePipeline}
				taskStatuses={taskStatuses}
				componentPipeCounts={componentPipeCounts}
				totalPipes={totalPipes}
				onOpenLink={onOpenLink}
				getPreference={getPreference}
				setPreference={setPreference}
				onContentChanged={onContentChanged}
			/>
		</div>
	);
};
