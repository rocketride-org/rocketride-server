/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { UPLOAD_RESULT } from 'rocketride';
import { formatBytes } from '../utils/dropperUtils';

/**
 * Props for the UploadProgress component
 */
interface UploadProgressProps {
	/** Array of upload progress objects from RocketRide client */
	uploadProgress: UPLOAD_RESULT[];
}

/**
 * UploadProgress - Real-time upload progress display panel
 * 
 * Displays live upload progress for files currently being uploaded to RocketRide.
 * Each file shows in a single horizontal line:
 * - Filename (25% width, wraps if needed)
 * - Progress bar (50% width)
 * - Upload statistics: size and percentage (25% width, wraps if needed)
 * 
 * Layout:
 * - Compact single-line display per file
 * - Filename takes up to 25% width
 * - Progress bar occupies 50% width
 * - Size/percentage info takes remaining 25%
 * - Text wraps when space is constrained
 * 
 * Behavior:
 * - Files appear when 'open' event is received from RocketRide client
 * - Progress updates in real-time as bytes are sent
 * - Files disappear when 'complete' event is received
 * - Shows "Waiting for uploads..." when no active uploads
 * 
 * The component handles file size formatting automatically, converting
 * bytes to appropriate units (B, KB, MB, GB) for readability.
 * 
 * @component
 * @example
 * ```tsx
 * <UploadProgress uploadProgress={[
 *   { filepath: 'document.pdf', bytes_sent: 50000, file_size: 100000 }
 * ]} />
 * ```
 * 
 * @param props - Component props
 * @param props.uploadProgress - Array of upload progress objects
 */
export const UploadProgress: React.FC<UploadProgressProps> = ({
	uploadProgress
}) => {
	// Show empty state when no uploads are in progress
	if (uploadProgress.length === 0) {
		return (
			<div className="upload-progress-empty">
				<p>Waiting for uploads...</p>
			</div>
		);
	}

	return (
		<div className="upload-progress-panel">
			<h3>Uploading Files</h3>
			<div className="upload-progress-list">
				{uploadProgress.map((progress) => {
					// Calculate upload percentage (0-100)
					// Handle edge case where file_size is 0 to prevent division by zero
					const percentage = progress.file_size > 0
						? (progress.bytes_sent / progress.file_size) * 100
						: 0;

					return (
						<div key={progress.filepath} className="upload-progress-item">
							{/* Filename section - 25% width */}
							<div className="upload-progress-filename">
								{progress.filepath}
							</div>

							{/* Progress bar section - 50% width */}
							<div className="upload-progress-bar-wrapper">
								<div className="upload-progress-bar-container">
									<div
										className="upload-progress-bar"
										style={{ width: `${percentage}%` }}
										role="progressbar"
										aria-label={`Upload progress for ${progress.filepath}: ${percentage.toFixed(0)}%`}
									/>
								</div>
							</div>

							{/* Stats section - 25% width */}
							<div className="upload-progress-stats">
								<span className="upload-progress-size">
									({formatBytes(progress.bytes_sent)}/{formatBytes(progress.file_size)})
								</span>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
};
