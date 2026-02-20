/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { FileText } from 'lucide-react';
import { ProcessedResults } from '../../types/dropper.types';

/**
 * Props for the TextView component
 */
interface TextViewProps {
	/** Array of text content groups to display */
	textContent: ProcessedResults['textContent'];
	/** Whether to display content in comparison mode (side-by-side) */
	compareMode: boolean;
	/** Callback to set element refs for scrolling functionality */
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * TextView Component
 * 
 * Displays text content extracted from processed files as plain text.
 * Supports both normal stacked layout and comparison mode for side-by-side viewing
 * of multiple content blocks from the same file.
 * 
 * Features:
 * - Plain text display with preserved whitespace and line breaks
 * - Comparison mode for side-by-side content viewing
 * - Field name labels when multiple content blocks exist
 * - Empty state when no text content is available
 * - Ref management for scroll-to-file functionality
 * 
 * @param props - Component props
 * @returns React component displaying text content
 */
export const TextView: React.FC<TextViewProps> = ({ textContent, compareMode, setRef }) => {
	// Show empty state if no text content is available
	if (textContent.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<FileText className="w-12 h-12 text-gray-300" />
					<p>No text content found in the processed files.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="tab-content">
			<div className="content-list">
				{textContent.map((group, groupIndex) => (
					<div
						key={groupIndex}
						ref={(el) => {
							if (el && setRef) setRef(group.filename, el);
						}}
					>
						{/* File header */}
						<div className="content-item-header">{group.filename}</div>

						{/* Comparison mode: side-by-side layout */}
						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block: any, contentIndex: number) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && (
											<div className="content-field-label">{block.fieldName}</div>
										)}
										<div className="content-item">
											<pre className="text-content">
												{block.content}
											</pre>
										</div>
									</div>
								))}
							</div>
						) : (
							/* Normal mode: stacked layout */
							group.contents.map((block: any, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{/* Show field name only when multiple content blocks exist */}
									{group.contents.length > 1 && block.fieldName && (
										<div className="content-field-label">{block.fieldName}</div>
									)}
									<div className="content-item">
										<pre className="text-content">
											{block.content}
										</pre>
									</div>
								</div>
							))
						)}
					</div>
				))}
			</div>
		</div>
	);
};
