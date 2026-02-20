/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { Table } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ProcessedResults } from '../../types/dropper.types';

/**
 * Props for the TablesView component
 */
interface TablesViewProps {
	/** Array of table content groups to display */
	tables: ProcessedResults['tables'];
	/** Whether to display content in comparison mode (side-by-side) */
	compareMode: boolean;
	/** Callback to set element refs for scrolling functionality */
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * TablesView Component
 * 
 * Displays table content extracted from processed files with markdown rendering.
 * Tables are rendered as markdown tables, supporting both normal stacked layout
 * and comparison mode for side-by-side viewing of multiple tables from the same file.
 * 
 * Features:
 * - Markdown table rendering with proper formatting
 * - Comparison mode for side-by-side table viewing
 * - Field name labels when multiple tables exist
 * - Empty state when no tables are available
 * - Ref management for scroll-to-file functionality
 * 
 * @param props - Component props
 * @returns React component displaying table content
 */
export const TablesView: React.FC<TablesViewProps> = ({ tables, compareMode, setRef }) => {
	// Show empty state if no tables are available
	if (tables.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<Table className="w-12 h-12 text-gray-300" />
					<p>No tables found in the processed files.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="tab-content">
			<div className="content-list">
				{tables.map((group, groupIndex) => (
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
											<div className="markdown-content">
												<MarkdownRenderer content={block.content} />
											</div>
										</div>
									</div>
								))}
							</div>
						) : (
							/* Normal mode: stacked layout */
							group.contents.map((block: any, contentIndex: number) => (
								<div key={contentIndex} className="content-item-wrapper">
									{/* Show field name only when multiple tables exist */}
									{group.contents.length > 1 && block.fieldName && (
										<div className="content-field-label">{block.fieldName}</div>
									)}
									<div className="content-item">
										<div className="markdown-content">
											<MarkdownRenderer content={block.content} />
										</div>
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
