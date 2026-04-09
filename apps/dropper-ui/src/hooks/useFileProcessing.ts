/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { RocketRideClient, UPLOAD_RESULT, VideoChunkSSEData, VideoCompleteSSEData } from 'rocketride';
import { UploadedFile, ProcessedResults } from '../types/dropper.types';
import { parseDropperResults, generateFileId } from '../utils/dropperUtils';
import { subscribeToClient } from './clientSingleton';

/** Maximum accumulated base64 video data per file before rejecting further chunks (~96 MB raw video). */
const MAX_VIDEO_BASE64_BYTES = 134_217_728; // 128 MB base64

function isVideoChunkSSEData(data: unknown): data is VideoChunkSSEData {
	if (typeof data !== 'object' || data === null) return false;
	const d = data as Record<string, unknown>;
	return typeof d.filename === 'string' && typeof d.chunk_index === 'number' && typeof d.total_chunks === 'number' && typeof d.data === 'string' && typeof d.mime_type === 'string';
}

function isVideoCompleteSSEData(data: unknown): data is VideoCompleteSSEData {
	if (typeof data !== 'object' || data === null) return false;
	return typeof (data as Record<string, unknown>).filename === 'string';
}

/**
 * useFileProcessing - React hook for managing file upload and processing workflow
 *
 * This hook orchestrates the complete file processing lifecycle including:
 * - File upload tracking and status management
 * - Real-time upload progress monitoring
 * - Results parsing and organization
 * - File addition, removal, and clearing
 *
 * Processing Workflow:
 * 1. User adds files → creates UploadedFile entries with 'pending' status
 * 2. Files sent to RocketRide → status changes to 'processing'
 * 3. Upload events received → progress bars update, statuses update in real-time
 * 4. Processing completes → results parsed and organized by type
 * 5. Status updates to 'completed' or 'error' as each file finishes
 *
 * Upload Progress Events:
 * - 'open': File upload started (appears in progress list)
 * - 'write': Bytes being sent (progress bar updates)
 * - 'complete': Upload finished (status updated to 'completed', removed from progress)
 * - 'error': Upload failed (status updated to 'error', removed from progress)
 *
 * State Management:
 * - uploadedFiles: Single source of truth for all file tracking
 * - results: Organized results (text, tables, images)
 * - uploadProgress: Real-time upload progress for active uploads
 * - isProcessing: Overall processing state flag
 *
 * Event Subscription:
 * - Subscribes to RocketRide client upload events
 * - Updates file status in real-time as events occur
 * - Automatically cleans up subscriptions on unmount
 *
 * @param client - RocketRide client instance (from useRocketRideClient)
 * @param authToken - Authentication token (used for file uploads)
 *
 * @returns Object containing file state and control functions
 *
 * @example
 * ```tsx
 * const { uploadedFiles, results, isProcessing, addFiles, removeFile, clearAll } =
 *   useFileProcessing(client, authToken);
 *
 * // Add files for processing
 * const handleDrop = (files: FileList) => {
 *   addFiles(files);
 * };
 *
 * // Remove a specific file
 * const handleRemove = (fileId: string) => {
 *   removeFile(fileId);
 * };
 * ```
 */
export const useFileProcessing = (client: RocketRideClient | null, authToken: string | null) => {
	// ============= STATE =============

	/** List of uploaded files with status tracking - single source of truth */
	const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);

	/** Parsed and organized results from processing */
	const [results, setResults] = useState<ProcessedResults | null>(null);

	/** Flag indicating if files are currently being processed */
	const [isProcessing, setIsProcessing] = useState(false);

	/** Raw upload results from RocketRide API */
	const [uploadResults, setUploadResults] = useState<UPLOAD_RESULT[]>([]);

	/** Active upload progress for files currently being uploaded */
	const [uploadProgress, setUploadProgress] = useState<UPLOAD_RESULT[]>([]);

	/** Count of files remaining to complete (for efficient completion detection) */
	const [remainingFiles, setRemainingFiles] = useState<number>(0);

	/** Accumulates base64 video chunks per filename as they stream in via SSE */
	const videoChunksRef = useRef<Map<string, { chunks: string[]; mimeType: string; totalBytes: number; totalChunks?: number; oversized?: boolean }>>(new Map());

	/** Tracks active Blob URLs created from SSE video chunks so they can be revoked */
	const videoBlobUrlsRef = useRef<Map<string, string>>(new Map());

	// Revoke all Blob URLs on unmount to avoid memory leaks
	useEffect(() => {
		const urlsRef = videoBlobUrlsRef;
		return () => {
			urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
		};
	}, []);

	// ============= UPLOAD PROGRESS TRACKING =============

	/**
	 * Subscribe to RocketRide upload events for real-time progress updates
	 *
	 * Event Handling:
	 * - 'open': Add file to progress list
	 * - 'write': Update progress for existing file
	 * - 'complete': Update file status to 'completed', remove from progress
	 * - 'error': Update file status to 'error', remove from progress
	 *
	 * This effect runs whenever the client changes
	 */
	useEffect(() => {
		if (!client) return;

		/**
		 * Processes upload status events from RocketRide client
		 * Updates both progress state and file status in real-time
		 */
		const handleEvent = (message: any) => {
			// Only handle upload status events
			if (message.event === 'apaevt_status_upload' && message.body) {
				const uploadEvent: UPLOAD_RESULT = message.body;

				if (uploadEvent.action === 'open') {
					// File upload started - add to progress list
					setUploadProgress((prev) => [...prev, uploadEvent]);
				} else if (uploadEvent.action === 'write') {
					// Bytes being sent - update progress
					setUploadProgress((prev) => prev.map((item) => (item.filepath === uploadEvent.filepath ? uploadEvent : item)));
				} else if (uploadEvent.action === 'complete') {
					// Upload finished successfully - update file status (skip if oversized — stays 'error')
					if (!videoChunksRef.current.get(uploadEvent.filepath)?.oversized) {
						setUploadedFiles((prev) => prev.map((file) => (file.file.name === uploadEvent.filepath ? { ...file, status: 'completed' as const } : file)));
					}
					// Remove from progress list
					setUploadProgress((prev) => prev.filter((item) => item.filepath !== uploadEvent.filepath));
					// Accumulate upload results for final parsing
					setUploadResults((prev) => [...prev, uploadEvent]);
					// Decrement remaining files count
					setRemainingFiles((prev) => prev - 1);
				} else if (uploadEvent.action === 'error') {
					// Upload failed - update file status immediately
					setUploadedFiles((prev) =>
						prev.map((file) =>
							file.file.name === uploadEvent.filepath
								? {
										...file,
										status: 'error' as const,
										error: uploadEvent.error || 'Upload failed',
									}
								: file
						)
					);
					// Remove from progress list
					setUploadProgress((prev) => prev.filter((item) => item.filepath !== uploadEvent.filepath));
					// Accumulate error results too
					setUploadResults((prev) => [...prev, uploadEvent]);
					// Decrement remaining files count
					setRemainingFiles((prev) => prev - 1);
				}
			}
		};

		// Subscribe to client events
		const unsubscribe = subscribeToClient({
			onEvent: handleEvent,
		});

		// Clean up subscription on unmount or client change
		return () => {
			unsubscribe();
		};
	}, [client]);

	/**
	 * Monitor remaining files count and finalize when all complete
	 * This is the most efficient way to detect completion - O(1) instead of O(n)
	 */
	useEffect(() => {
		// When remaining files reaches 0 and we're processing, we're done
		if (isProcessing && remainingFiles === 0 && uploadedFiles.length > 0) {
			// Parse results if we have any
			try {
				if (uploadResults.length > 0) {
					// Enrich results with any assembled video Blob URLs from SSE chunks
					const enrichedResults = uploadResults.map((r) => {
						const videoEntry = videoChunksRef.current.get(r.filepath);
						// Skip oversized files (already in 'error' state) and files with no video entry
						if (!videoEntry || videoEntry.oversized) return r;
						// Validate all chunks are present using totalChunks from the SSE data.
						// .every() skips sparse-array holes, so we explicitly iterate 0..totalChunks-1
						// to catch any missing index.
						const { totalChunks } = videoEntry;
						const allPresent = typeof totalChunks === 'number' && totalChunks > 0 && Array.from({ length: totalChunks }).every((_, i) => typeof videoEntry.chunks[i] === 'string' && videoEntry.chunks[i].length > 0);
						if (!allPresent) {
							console.error('[useFileProcessing] Incomplete video chunks for', r.filepath, '— skipping assembly');
							return r;
						}
						const binary = atob(videoEntry.chunks.join(''));
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
						// Revoke any existing URL for this file before creating a new one
						const existingUrl = videoBlobUrlsRef.current.get(r.filepath);
						if (existingUrl) URL.revokeObjectURL(existingUrl);
						const blobUrl = URL.createObjectURL(new Blob([bytes], { type: videoEntry.mimeType }));
						videoBlobUrlsRef.current.set(r.filepath, blobUrl);
						// Free the raw chunk buffer — the Blob URL is now the only reference needed
						videoChunksRef.current.delete(r.filepath);
						const baseResult = r.result ?? { name: r.filepath, path: r.filepath, objectId: r.filepath };
						return {
							...r,
							result: {
								...baseResult,
								result_types: { ...(baseResult.result_types ?? {}), video: 'video' },
								video: blobUrl,
							},
						};
					});
					const parsedResults = parseDropperResults(enrichedResults);
					setResults(parsedResults);
				}
			} catch (err) {
				console.error('[useFileProcessing] Error assembling video chunks:', err);
			} finally {
				setIsProcessing(false);
			}
		}
	}, [remainingFiles, isProcessing, uploadedFiles.length, uploadResults]);

	// ============= FILE PROCESSING =============

	/**
	 * Sends files to RocketRide pipeline for processing
	 *
	 * Preparation:
	 * - Adds mime type to each file
	 * - Creates object info with name and size
	 * - Falls back to generic mime type if not specified
	 *
	 * @param files - Array of File objects to process
	 * @returns Promise that resolves when upload is initiated (not when complete)
	 * @throws Error if client not connected or pipeline token missing
	 */
	const processFilesWithAPI = useCallback(
		async (files: File[]): Promise<void> => {
			if (!client || !authToken) {
				throw new Error('Not connected to RocketRide. Please wait for connection.');
			}

			try {
				// Prepare files with metadata for RocketRide
				const filesWithMimeTypes = files.map((file) => ({
					file,
					objinfo: {
						name: file.name,
						size: file.size,
					},
					mimetype: file.type || 'application/octet-stream',
				}));

				// Send files to pipeline (results will come via events)
				// onSSE receives video chunks streamed during processing and assembles them
				await client.sendFiles(filesWithMimeTypes, authToken, async (type, data) => {
					if (type === 'video_chunk') {
						if (!isVideoChunkSSEData(data)) {
							console.warn('[useFileProcessing] Malformed video_chunk SSE payload:', data);
							return;
						}
						const entry = videoChunksRef.current.get(data.filename) ?? { chunks: [], mimeType: data.mime_type, totalBytes: 0 };
						const incoming = data.data.length;
						if (entry.totalBytes + incoming > MAX_VIDEO_BASE64_BYTES) {
							// Mark as terminally oversized, free the partial buffer, stop accumulating
							videoChunksRef.current.set(data.filename, { chunks: [], mimeType: entry.mimeType, totalBytes: entry.totalBytes, oversized: true });
							setUploadedFiles((prev) => prev.map((f) => (f.file.name === data.filename ? { ...f, status: 'error' as const, error: 'Video too large to display in browser (limit: ~96 MB).' } : f)));
							return;
						}
						entry.chunks[data.chunk_index] = data.data;
						entry.totalBytes += incoming;
						entry.totalChunks = data.total_chunks;
						videoChunksRef.current.set(data.filename, entry);
					} else if (type === 'video_complete') {
						if (!isVideoCompleteSSEData(data)) {
							console.warn('[useFileProcessing] Malformed video_complete SSE payload:', data);
							return;
						}
						// Ensure the entry exists even if chunks arrived out of order
						if (!videoChunksRef.current.has(data.filename)) {
							videoChunksRef.current.set(data.filename, { chunks: [], mimeType: 'video/mp4', totalBytes: 0 });
						}
					}
				});
			} catch (error) {
				console.error('Error sending files to pipeline:', error);
				throw error;
			}
		},
		[client, authToken]
	);

	/**
	 * Orchestrates the complete file processing workflow
	 *
	 * Workflow Steps:
	 * 1. Set processing flag and clear old results
	 * 2. Set remaining files counter
	 * 3. Update all file statuses to 'processing'
	 * 4. Send files to RocketRide pipeline
	 * 5. Results handled via event listeners (real-time updates)
	 *
	 * Error Handling:
	 * - Individual file errors tracked via events
	 * - Batch upload errors mark all files as error
	 * - Error messages stored with each failed file
	 *
	 * @param files - Array of File objects to process
	 */
	const processFiles = useCallback(
		async (files: File[]): Promise<void> => {
			if (files.length === 0) return;

			// Clear old data immediately — revoke prior batch Blob URLs before clearing refs
			videoBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
			videoBlobUrlsRef.current.clear();
			videoChunksRef.current.clear();
			setUploadProgress([]);
			setUploadResults([]);

			// Set remaining files counter
			setRemainingFiles(files.length);

			// Start processing
			setIsProcessing(true);

			// Mark all files as processing (use functional update to avoid stale closure)
			setUploadedFiles((prev) => prev.map((file) => ({ ...file, status: 'processing' as const })));

			try {
				// Send files to RocketRide (results come via events)
				await processFilesWithAPI(files);
			} catch (error) {
				console.error('Error processing files:', error);

				// Extract error message
				const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';

				// Mark all files as error
				setUploadedFiles((prev) =>
					prev.map((file) => ({
						...file,
						status: 'error' as const,
						error: errorMessage,
					}))
				);

				// Clear processing flag and remaining count
				setRemainingFiles(0);
				setIsProcessing(false);
			}
		},
		[processFilesWithAPI]
	);

	// ============= FILE MANAGEMENT =============

	/**
	 * Adds new files to the processing queue
	 *
	 * Behavior:
	 * - Clears all existing files (fresh start)
	 * - Creates UploadedFile entries with unique IDs
	 * - Sets initial status to 'pending'
	 * - Immediately begins processing
	 *
	 * Note: This replaces existing files rather than appending
	 *
	 * @param files - FileList from drag-drop or file picker
	 */
	const addFiles = useCallback(
		(files: FileList): void => {
			const fileArray = Array.from(files);

			// Clear everything and start fresh
			const newFiles: UploadedFile[] = fileArray.map((file) => ({
				id: generateFileId(),
				file,
				status: 'pending',
			}));

			setUploadedFiles(newFiles);
			setResults(null);
			setUploadResults([]);

			// Begin processing immediately
			processFiles(fileArray);
		},
		[processFiles]
	);

	/**
	 * Removes a single file from the uploaded files list
	 *
	 * Behavior:
	 * - Removes file from uploadedFiles array
	 * - Removes corresponding result from uploadResults
	 * - Re-parses remaining results
	 * - Clears results if no files remain
	 *
	 * @param fileId - Unique identifier of file to remove
	 */
	const removeFile = useCallback(
		(fileId: string): void => {
			const fileToRemove = uploadedFiles.find((f) => f.id === fileId);
			if (!fileToRemove) return;

			const filename = fileToRemove.file.name;

			// Remove file from list
			setUploadedFiles((prev) => prev.filter((file) => file.id !== fileId));

			// Revoke any Blob URL created for this file
			const blobUrl = videoBlobUrlsRef.current.get(filename);
			if (blobUrl) {
				URL.revokeObjectURL(blobUrl);
				videoBlobUrlsRef.current.delete(filename);
			}

			// Remove corresponding results
			const updatedUploadResults = uploadResults.filter((result) => result.filepath !== filename);
			setUploadResults(updatedUploadResults);

			// Filter the existing results state directly to preserve video-enriched objects
			if (updatedUploadResults.length === 0) {
				setResults(null);
			} else {
				setResults((prev) => {
					if (!prev) return null;
					const filterGroups = (arr: typeof prev.textContent) => arr.filter((g) => g.filename !== filename);
					return {
						...prev,
						textContent: filterGroups(prev.textContent),
						documents: filterGroups(prev.documents),
						tables: filterGroups(prev.tables),
						images: filterGroups(prev.images),
						videos: filterGroups(prev.videos),
						questions: filterGroups(prev.questions),
						answers: filterGroups(prev.answers),
					};
				});
			}
		},
		[uploadedFiles, uploadResults]
	);

	/**
	 * Clears all uploaded files and resets state
	 *
	 * Resets:
	 * - Uploaded files list
	 * - Parsed results
	 * - Raw upload results
	 * - Upload progress
	 * - Remaining files counter
	 *
	 * Use when user wants to start completely fresh
	 */
	const clearAll = useCallback((): void => {
		videoBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
		videoBlobUrlsRef.current.clear();
		videoChunksRef.current.clear();
		setUploadedFiles([]);
		setResults(null);
		setUploadResults([]);
		setUploadProgress([]);
		setRemainingFiles(0);
	}, []);

	// ============= RETURN API =============

	return {
		/** List of uploaded files with status tracking */
		uploadedFiles,

		/** Parsed and organized results (text, tables, images) */
		results,

		/** Raw upload results from RocketRide API */
		uploadResults,

		/** Active upload progress for real-time display */
		uploadProgress,

		/** Flag indicating if files are currently being processed */
		isProcessing,

		/** Function to add new files for processing */
		addFiles,

		/** Function to remove a specific file */
		removeFile,

		/** Function to clear all files and reset state */
		clearAll,
	};
};
