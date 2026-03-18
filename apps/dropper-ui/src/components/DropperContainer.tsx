/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { RocketRideClient } from 'rocketride';
import { useRocketRideClient } from '../hooks/useRocketRide';
import { useFileProcessing } from '../hooks/useFileProcessing';
import { DropperHeader } from './DropperHeader';
import { DropZone } from './DropZone';
import { FileList } from './FileList';
import { ResultsTabs } from './ResultsTabs';
import { ResultsContent } from './ResultsContent';
import { UploadProgress } from './UploadProgress';
import { TabType } from '../types/dropper.types';

/**
 * DropperContainer - Main container component for the RocketRide Dropper application
 * 
 * This component orchestrates the entire file upload and processing workflow:
 * - Handles file uploads via drag-and-drop or file selection
 * - Tracks upload progress and processing status
 * - Displays results in multiple formats (text, tables, images)
 * - Provides file management (add, remove, clear all)
 * 
 * State Management:
 * - Connection status and status messages
 * - Active tab for results display
 * - Drag-over state for drop zone
 * - File scroll synchronization
 * - Compare mode for side-by-side viewing
 * 
 * Component Layout:
 * - Header: Branding, connection status, and actions
 * - Left Panel: Drop zone and file list (when not processing)
 * - Right Panel: Results tabs and content (when results available)
 * - Processing View: Upload progress and completion status
 * 
 * @component
 * @example
 * ```tsx
 * <DropperContainer authToken={token} />
 * ```
 */
export const DropperContainer: React.FC<{ authToken: string | null }> = ({ authToken }) => {
	// Status message displayed to user (connection, errors, etc.)
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [connectionErrorMessage, setConnectionErrorMessage] = useState<string | null>(null);

	// Currently active results tab (results, text, tables, images)
	const [activeTab, setActiveTab] = useState<TabType>('results');

	// Whether files are being dragged over the drop zone
	const [isDragOver, setIsDragOver] = useState<boolean>(false);
	const isDragOverRef = useRef<boolean>(false);

	// Filename to scroll to in results (for file list click synchronization)
	const [scrollToFilename, setScrollToFilename] = useState<string | null>(null);

	// Whether compare mode is enabled (side-by-side view)
	const [compareMode, setCompareMode] = useState<boolean>(false);

	// Track connection attempts for progressive error messaging
	const connectionAttemptsRef = useRef<number>(0);

	/**
	 * Handler called when RocketRide client successfully connects
	 * Clears any status messages - ready to go!
	 * 
	 * @param _client - Connected RocketRide client instance (unused)
	 */
	const handleConnected = useCallback(async (_client: RocketRideClient) => {
		connectionAttemptsRef.current = 0;
		setStatusMessage(null);
		setConnectionErrorMessage(null);
	}, []);

	/**
	 * Handler called when RocketRide client disconnects or a connection attempt fails.
	 * Stores the last error message and shows the error panel after 5 attempts or when we have an error message.
	 */
	const handleDisconnected = useCallback(async (reason: string, hasError: boolean) => {
		connectionAttemptsRef.current++;
		setConnectionErrorMessage((prev) => (hasError ? (reason || null) : prev));
		if (connectionAttemptsRef.current < 5) {
			setStatusMessage(null);
		} else {
			setStatusMessage('CONNECTION_FAILED');
		}
	}, []);

	// Initialize RocketRide client with connection handlers
	const { isConnected, client } = useRocketRideClient(
		handleConnected,
		handleDisconnected,
		setStatusMessage
	);

	// Initialize file processing hook with client and auth token
	const {
		uploadedFiles,
		results,
		uploadProgress,
		isProcessing,
		addFiles,
		removeFile,
		clearAll
	} = useFileProcessing(client, authToken);

	// macOS fix: Finder drag events don't reach cross-origin iframes in Electron
	// webviews, so the parent intercepts and bridges them here via postMessage.
	useEffect(() => {
		const isFromParent = (event: MessageEvent) => event.source === window.parent;

		const handleBridgedDrop = (event: MessageEvent) => {
			if (!isFromParent(event)) return;
			if (event.data?.type !== 'bridgedFileDrop' || !Array.isArray(event.data.files)) return;
			if (!isConnected) {
				setStatusMessage('Please wait for connection before uploading files');
				return;
			}
			if (isProcessing) return;
			if (!isDragOverRef.current) return;

			const dt = new DataTransfer();
			event.data.files.forEach((f: { buffer: ArrayBuffer; name: string; type: string; lastModified: number }) =>
				dt.items.add(new File([f.buffer], f.name, { type: f.type, lastModified: f.lastModified }))
			);
			addFiles(dt.files);
		};

		const handleDragHover = (event: MessageEvent) => {
			if (!isFromParent(event)) return;
			if (event.data?.type === 'dragLeave') {
				isDragOverRef.current = false;
				setIsDragOver(false);
				return;
			}
			if (event.data?.type !== 'dragHover') return;
			const { x, y } = event.data;
			if (typeof x !== 'number' || typeof y !== 'number') return;
			const el = document.elementFromPoint(x, y);
			const over = el?.closest('.drop-zone') !== null;
			isDragOverRef.current = over;
			setIsDragOver(over);
		};

		window.addEventListener('message', handleBridgedDrop);
		window.addEventListener('message', handleDragHover);
		return () => {
			window.removeEventListener('message', handleBridgedDrop);
			window.removeEventListener('message', handleDragHover);
		};
	}, [addFiles, isConnected, isProcessing]);

	/**
	 * Auto-switch to the most relevant tab when results are available
	 * Priority: text > tables > images > results
	 */
	useEffect(() => {
		if (results) {
			if (results.textContent.length > 0) {
				setActiveTab('text');
			} else if (results.tables.length > 0) {
				setActiveTab('tables');
			} else if (results.images.length > 0) {
				setActiveTab('images');
			} else {
				setActiveTab('results');
			}
		}
	}, [results]);

	/**
	 * Handles drag over event for the drop zone
	 * Shows visual feedback that files can be dropped
	 */
	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	}, []);

	/**
	 * Handles drag leave event for the drop zone
	 * Removes visual feedback when drag leaves the area
	 */
	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	}, []);

	/**
	 * Handles file drop event
	 * Validates connection status and processes dropped files
	 */
	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		// Prevent uploads if not connected to RocketRide
		if (!isConnected) {
			setStatusMessage('Please wait for connection before uploading files');
			return;
		}

		// Extract files from drop event and process them
		const files = e.dataTransfer.files;
		if (files.length > 0) {
			addFiles(files);
		}
	}, [addFiles, isConnected]);

	/**
	 * Handles files selected via file picker dialog
	 * Validates connection status before processing
	 */
	const handleFilesSelected = useCallback((files: FileList) => {
		if (!isConnected) {
			setStatusMessage('Please wait for connection before uploading files');
			return;
		}

		addFiles(files);
	}, [addFiles, isConnected]);

	/**
	 * Clears all uploaded files and resets state
	 * Returns to default results tab and disables compare mode
	 */
	const handleClearAll = useCallback(() => {
		clearAll();
		setActiveTab('results');
		setCompareMode(false);
	}, [clearAll]);

	/**
	 * Handles file click in file list
	 * Scrolls to corresponding content in results view
	 * 
	 * @param filename - Name of file to scroll to
	 */
	const handleFileClick = useCallback((filename: string) => {
		setScrollToFilename(filename);
		// Clear scroll target after animation completes
		setTimeout(() => setScrollToFilename(null), 500);
	}, []);

	/**
	 * Calculate real-time processing progress
	 * Count files that have reached 'completed' or 'error' status
	 * Status is now updated in real-time as each file finishes
	 */
	const completedCount = uploadedFiles.filter(
		f => f.status === 'completed' || f.status === 'error'
	).length;
	const totalCount = uploadedFiles.length;

	return (
		<div className="dropper-container">
			{/* Header with branding and actions */}
			<DropperHeader
				hasFiles={uploadedFiles.length > 0}
				onClearAll={handleClearAll}
				isConnected={isConnected}
			/>

		<div className="dropper-main">
			<div className="top-controls-section">
				{/* Left panel: File upload and management - always visible */}
				<div className="left-panel">
					{!isProcessing ? (
						<>
							{/* Drop zone for file upload - always visible */}
							<DropZone
								onFilesSelected={handleFilesSelected}
								isProcessing={isProcessing}
								isDragOver={isDragOver}
								onDragOver={handleDragOver}
								onDragLeave={handleDragLeave}
								onDrop={handleDrop}
								disabled={!isConnected}
							/>

							{/* List of uploaded files */}
							<FileList
								files={uploadedFiles}
								isProcessing={isProcessing}
								onRemoveFile={removeFile}
								onFileClick={handleFileClick}
							/>
					</>
				) : (
					// Show processing indicator with real-time progress
					<div className="processing-indicator">
						<h3>Processing Files...</h3>
						<p className="processing-progress">
							{completedCount} of {totalCount} completed
						</p>
					</div>
				)}
			</div>

		{/* Right panel: Status banner, Results, or Upload progress */}
		{!isConnected && (statusMessage === 'CONNECTION_FAILED' || connectionErrorMessage) ? (
			// Show detailed connection troubleshooting
			<div className="connection-error-panel">
				<div className="connection-error-icon">⚠️</div>
				<h2 className="connection-error-title">Having Trouble Connecting</h2>
				{connectionErrorMessage && (
					<p className="connection-error-message">{connectionErrorMessage}</p>
				)}
				<p className="connection-error-subtitle">We can't reach your pipeline. Here's what to check:</p>
				<div className="connection-error-checklist">
					<div className="connection-error-item">
						<span className="connection-error-bullet">✓</span>
						<span className="connection-error-text">Make sure your pipeline is running</span>
					</div>
					<div className="connection-error-item">
						<span className="connection-error-bullet">✓</span>
						<span className="connection-error-text">Verify you are authorized to use this pipeline</span>
					</div>
					<div className="connection-error-item">
						<span className="connection-error-bullet">✓</span>
						<span className="connection-error-text">Check that your server is running and reachable</span>
					</div>
				</div>
				<p className="connection-error-footer">We'll keep trying to connect automatically...</p>
			</div>
		) : !isProcessing && results ? (
				// Show results when available
				<div className="right-panel">
					{/* Tabs for different result types */}
					<ResultsTabs
						activeTab={activeTab}
						onTabChange={setActiveTab}
						results={results}
						compareMode={compareMode}
						onCompareModeChange={setCompareMode}
					/>

					{/* Content area for results */}
					<div className="tab-content-wrapper">
						<ResultsContent
							activeTab={activeTab}
							results={results}
							scrollToFilename={scrollToFilename}
							compareMode={compareMode}
						/>
					</div>
				</div>
			) : isProcessing ? (
				// Show upload progress during processing
				<div className="right-panel">
					<UploadProgress uploadProgress={uploadProgress} />
				</div>
			) : null}
		</div>
	</div>
</div>
);
};
