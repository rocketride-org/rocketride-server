/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { Upload, CheckCircle, AlertCircle, Loader, X } from 'lucide-react';
import { UploadedFile } from '../types/dropper.types';

/**
 * Props for the FileList component
 */
interface FileListProps {
	/** Array of uploaded files with their processing status */
	files: UploadedFile[];
	/** Whether files are currently being processed */
	isProcessing: boolean;
	/** Callback to remove a file by its ID */
	onRemoveFile: (fileId: string) => void;
	/** Optional callback when a file is clicked (for scrolling to results) */
	onFileClick?: (filename: string) => void;
}

/**
 * FileList Component
 * 
 * Displays a list of uploaded files with their processing status and metadata.
 * Shows status icons (pending, processing, completed, error) and allows removal
 * of files when not processing. Clicking a file scrolls to its results.
 * 
 * Features:
 * - Color-coded status icons for each file state
 * - File name and size display
 * - Error message display for failed uploads
 * - Remove button (disabled during processing)
 * - Clickable files to navigate to results
 * 
 * @param props - Component props
 * @returns React component displaying the file list
 */
export const FileList: React.FC<FileListProps> = ({
	files,
	isProcessing,
	onRemoveFile,
	onFileClick
}) => {
	// Don't render if there are no files
	if (files.length === 0) {
		return null;
	}

	/**
	 * Renders the appropriate status icon based on file processing state
	 * 
	 * @param status - Current status of the file
	 * @returns Icon component with appropriate styling
	 */
	const renderStatusIcon = (status: UploadedFile['status']) => {
		switch (status) {
			case 'pending':
				return <Upload className="w-4 h-4 text-gray-500" />;
			case 'processing':
				return <Loader className="w-4 h-4 text-orange-500 animate-spin" />;
			case 'completed':
				return <CheckCircle className="w-4 h-4 text-green-500" />;
			case 'error':
				return <AlertCircle className="w-4 h-4 text-red-500" />;
		}
	};

	return (
		<div className="file-list">
			<h4>Files</h4>
			<div className="file-items">
				{files.map((uploadedFile) => (
					<div key={uploadedFile.id} className="file-item">
						{/* File info section - clickable to scroll to results */}
						<div
							className="file-info"
							onClick={() => onFileClick?.(uploadedFile.file.name)}
							style={{ cursor: onFileClick ? 'pointer' : 'default' }}
						>
							{renderStatusIcon(uploadedFile.status)}
							<div className="file-details">
								<p className="file-name">{uploadedFile.file.name}</p>
								<p className="file-meta">
									{(uploadedFile.file.size / 1024).toFixed(1)} KB
									{uploadedFile.error && (
										<span className="file-error"> • {uploadedFile.error}</span>
									)}
								</p>
							</div>
						</div>
						{/* Remove button - only shown when not processing */}
						{!isProcessing && (
							<button
								onClick={() => onRemoveFile(uploadedFile.id)}
								className="remove-file-btn"
								title="Remove file"
								type="button"
							>
								<X className="w-3 h-3" />
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
};
