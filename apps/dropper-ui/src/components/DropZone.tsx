/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useRef, useCallback } from 'react';
import { Upload, Loader } from 'lucide-react';

/**
 * Props for the DropZone component
 */
interface DropZoneProps {
	/** Callback function invoked when files are selected via picker or dropped */
	onFilesSelected: (files: FileList) => void;
	/** Whether files are currently being processed */
	isProcessing: boolean;
	/** Whether files are being dragged over the drop zone */
	isDragOver: boolean;
	/** Handler for drag over events */
	onDragOver: (e: React.DragEvent) => void;
	/** Handler for drag leave events */
	onDragLeave: (e: React.DragEvent) => void;
	/** Handler for drop events */
	onDrop: (e: React.DragEvent) => void;
	/** Whether the drop zone is disabled (e.g., during connection) */
	disabled?: boolean;
}

/**
 * DropZone - Interactive file upload zone with drag-and-drop support
 * 
 * Provides a user-friendly interface for uploading files through multiple methods:
 * - Drag and drop files directly onto the zone
 * - Click to open native file picker dialog
 * - Supports multiple file selection
 * 
 * Visual States:
 * - Default: Upload icon with instructions
 * - Drag Over: Highlighted zone with "Drop files here" message
 * - Processing: Loading spinner with "Processing..." message
 * - Disabled: Loading spinner with "Connecting..." message
 * 
 * Accessibility:
 * - Hidden but functional file input with aria-label
 * - Keyboard accessible file picker
 * - Clear visual feedback for all states
 * 
 * @component
 * @example
 * ```tsx
 * <DropZone
 *   onFilesSelected={(files) => console.log('Files selected:', files)}
 *   isProcessing={false}
 *   isDragOver={false}
 *   onDragOver={(e) => e.preventDefault()}
 *   onDragLeave={(e) => e.preventDefault()}
 *   onDrop={(e) => handleDrop(e)}
 *   disabled={false}
 * />
 * ```
 * 
 * @param props - Component props
 * @param props.onFilesSelected - Callback when files are selected
 * @param props.isProcessing - Whether files are currently being processed
 * @param props.isDragOver - Whether files are being dragged over the zone
 * @param props.onDragOver - Drag over event handler
 * @param props.onDragLeave - Drag leave event handler
 * @param props.onDrop - Drop event handler
 * @param props.disabled - Whether the drop zone is disabled
 */
export const DropZone: React.FC<DropZoneProps> = ({
	onFilesSelected,
	isProcessing,
	isDragOver,
	onDragOver,
	onDragLeave,
	onDrop,
	disabled = false
}) => {
	// Reference to hidden file input element
	const fileInputRef = useRef<HTMLInputElement>(null);

	/**
	 * Handles file input change event when files are selected via dialog
	 * Validates that files exist before invoking callback
	 * 
	 * @param e - Change event from file input element
	 */
	const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files && files.length > 0) {
			onFilesSelected(files);
		}
	}, [onFilesSelected]);

	/**
	 * Opens the native file picker dialog
	 * Only activates if the drop zone is not disabled
	 */
	const openFilePicker = useCallback(() => {
		if (!disabled) {
			fileInputRef.current?.click();
		}
	}, [disabled]);

	// Build CSS class string based on component state
	const dropZoneClasses = [
		'drop-zone',
		isDragOver && 'drag-over',
		isProcessing && 'processing',
		disabled && 'disabled'
	].filter(Boolean).join(' ');

	return (
		<div
			className={dropZoneClasses}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
			onClick={openFilePicker}
			role="button"
			tabIndex={disabled ? -1 : 0}
			aria-label="Drop files or click to upload"
		>
			{/* Hidden file input for programmatic file selection */}
			<input
				ref={fileInputRef}
				type="file"
				multiple
				onChange={handleFileInputChange}
				className="file-input"
				aria-label="Upload files"
				disabled={disabled}
			/>

			{/* Visual content changes based on state */}
			<div className="drop-zone-content">
				{disabled ? (
					// Disabled state: Show connecting message
					<>
						<Loader className="w-8 h-8 text-gray-400 animate-spin" />
						<h4>Connecting...</h4>
						<p>Please wait</p>
					</>
				) : isProcessing ? (
					// Processing state: Show loading indicator
					<>
						<Loader className="w-8 h-8 text-orange-500 animate-spin" />
						<h4>Processing...</h4>
						<p>Analyzing files</p>
					</>
				) : (
					// Default/drag-over state: Show upload icon and instructions
					<>
						<Upload className="w-8 h-8 text-gray-400" />
						<h4>{isDragOver ? 'Drop files here' : 'Drop files or click'}</h4>
						<p>Documents, images, etc.</p>
					</>
				)}
			</div>
		</div>
	);
};
