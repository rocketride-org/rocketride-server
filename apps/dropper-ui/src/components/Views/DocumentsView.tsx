/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { FileText, Hash, FileCode } from 'lucide-react';
import { ProcessedResults } from '../../types/dropper.types';

interface DocumentsViewProps {
	documents: ProcessedResults['documents'];
	compareMode: boolean;
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * DocumentsView Component
 * 
 * Displays structured document objects (Doc type) from processed files.
 * Shows document content along with metadata like scores, chunks, and object IDs.
 */
export const DocumentsView: React.FC<DocumentsViewProps> = ({ documents, compareMode, setRef }) => {
	if (documents.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<FileText className="w-12 h-12 text-gray-300" />
					<p>No documents found in the processed files.</p>
				</div>
			</div>
		);
	}

	/**
	 * Renders a single document object with its metadata
	 */
	const renderDocument = (doc: any) => {
		return (
			<div className="document-block">
				{/* Document metadata header */}
				{doc.metadata && (
					<div className="document-metadata">
						{doc.metadata.objectId && (
							<div className="metadata-item">
								<Hash className="metadata-icon" />
								<span className="metadata-label">Object ID:</span>
								<span className="metadata-value">{doc.metadata.objectId}</span>
							</div>
						)}
						{doc.metadata.chunkId !== undefined && (
							<div className="metadata-item">
								<FileCode className="metadata-icon" />
								<span className="metadata-label">Chunk:</span>
								<span className="metadata-value">{doc.metadata.chunkId}</span>
							</div>
						)}
						{doc.score !== undefined && (
							<div className="metadata-item">
								<span className="metadata-label">Score:</span>
								<span className="metadata-value">{doc.score.toFixed(4)}</span>
							</div>
						)}
					</div>
				)}

				{/* Document content */}
				{doc.page_content && (
					<div className="document-content">
						<pre className="text-content">
							{doc.page_content}
						</pre>
					</div>
				)}

				{/* Context if available */}
				{doc.context && doc.context.length > 0 && (
					<div className="document-context">
						<div className="context-label">Context:</div>
						{doc.context.map((ctx: string, idx: number) => (
							<div key={idx} className="context-item">
								{ctx}
							</div>
						))}
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="tab-content">
			<div className="content-list">
				{documents.map((group, groupIndex) => (
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
								{group.contents.map((block, contentIndex) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && (
											<div className="content-field-label">{block.fieldName}</div>
										)}
										<div className="content-item">
											{renderDocument(block.content)}
										</div>
									</div>
								))}
							</div>
						) : (
							/* Normal mode: stacked layout */
							group.contents.map((block, contentIndex) => (
								<div key={contentIndex} className="content-item-wrapper">
									{/* Show field name only when multiple content blocks exist */}
									{group.contents.length > 1 && block.fieldName && (
										<div className="content-field-label">{block.fieldName}</div>
									)}
									<div className="content-item">
										{renderDocument(block.content)}
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
