/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { HelpCircle } from 'lucide-react';
import { ProcessedResults } from '../../types/dropper.types';

interface QuestionsViewProps {
	questions: ProcessedResults['questions'];
	compareMode: boolean;
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

/**
 * QuestionsView Component
 * 
 * Displays Question objects in a structured, compact format.
 * Long strings are truncated with tooltips showing full content.
 */
export const QuestionsView: React.FC<QuestionsViewProps> = ({ questions, compareMode, setRef }) => {
	if (questions.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<HelpCircle className="w-12 h-12 text-gray-300" />
					<p>No questions found in the processed files.</p>
				</div>
			</div>
		);
	}

	/**
	 * Truncates a string to maxLength and adds ellipsis
	 */
	const truncateString = (str: string, maxLength: number = 256): string => {
		if (!str) return '';
		if (str.length <= maxLength) return str;
		return str.substring(0, maxLength) + '...';
	};

	/**
	 * Renders a truncated string with tooltip showing full content
	 */
	const renderTruncatedText = (text: string, maxLength: number = 256) => {
		const isTruncated = text.length > maxLength;
		const displayText = truncateString(text, maxLength);

		return (
			<span className="truncated-text" title={isTruncated ? text : undefined}>
				{displayText}
			</span>
		);
	};

	const renderQuestion = (questionObj: any) => {
		return (
			<div className="question-structured">
				{/* Header with Type and Role */}
				<div className="question-header-info">
					<div className="question-title">
						<HelpCircle className="question-icon" />
						<span>Question Object</span>
					</div>
					<div className="question-meta-badges">
						{questionObj.type && (
							<span className="meta-badge">Type: {questionObj.type}</span>
						)}
						{questionObj.expectJson !== undefined && (
							<span className="meta-badge">JSON: {questionObj.expectJson ? 'Yes' : 'No'}</span>
						)}
					</div>
				</div>

				{/* Role */}
				{questionObj.role && (
					<div className="question-field">
						<div className="field-label">Role:</div>
						<div className="field-value">{renderTruncatedText(questionObj.role)}</div>
					</div>
				)}

				{/* Questions */}
				{questionObj.questions && questionObj.questions.length > 0 && (
					<div className="question-field">
						<div className="field-label">Questions: ({questionObj.questions.length})</div>
						<div className="field-items">
							{questionObj.questions.map((q: any, idx: number) => {
								const questionText = typeof q === 'string' ? q : q.text || JSON.stringify(q);
								return (
									<div key={idx} className="field-item">
										<span className="item-number">{idx + 1}.</span>
										<span className="item-content">
											{renderTruncatedText(questionText)}
										</span>
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* Instructions */}
				{questionObj.instructions && questionObj.instructions.length > 0 && (
					<div className="question-field">
						<div className="field-label">Instructions: ({questionObj.instructions.length})</div>
						<div className="field-items">
							{questionObj.instructions.map((inst: any, idx: number) => (
								<div key={idx} className="field-item">
									<span className="item-number">{idx + 1}.</span>
									<div className="item-content">
										{inst.subtitle && (
											<div className="item-subtitle">{inst.subtitle}</div>
										)}
										<div className="item-text">
											{renderTruncatedText(inst.instructions)}
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Context */}
				{questionObj.context && questionObj.context.length > 0 && (
					<div className="question-field">
						<div className="field-label">Context: ({questionObj.context.length})</div>
						<div className="field-items">
							{questionObj.context.map((ctx: string, idx: number) => (
								<div key={idx} className="field-item">
									<span className="item-number">{idx + 1}.</span>
									<span className="item-content">
										{renderTruncatedText(ctx)}
									</span>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Examples */}
				{questionObj.examples && questionObj.examples.length > 0 && (
					<div className="question-field">
						<div className="field-label">Examples: ({questionObj.examples.length})</div>
						<div className="field-items">
							{questionObj.examples.map((ex: any, idx: number) => (
								<div key={idx} className="field-item">
									<span className="item-number">{idx + 1}.</span>
									<div className="item-content">
										<div className="example-pair">
											<span className="example-label">Given:</span>
											<span className="example-text">{renderTruncatedText(ex.given)}</span>
										</div>
										<div className="example-pair">
											<span className="example-label">Result:</span>
											<span className="example-text">{renderTruncatedText(ex.result)}</span>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* History */}
				{questionObj.history && questionObj.history.length > 0 && (
					<div className="question-field">
						<div className="field-label">History: ({questionObj.history.length})</div>
						<div className="field-items">
							{questionObj.history.map((hist: any, idx: number) => (
								<div key={idx} className="field-item">
									<span className="item-number">{idx + 1}.</span>
									<div className="item-content">
										<span className="history-role">{hist.role}:</span>
										<span className="history-text">{renderTruncatedText(hist.content)}</span>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Documents */}
				{questionObj.documents && questionObj.documents.length > 0 && (
					<div className="question-field">
						<div className="field-label">Documents: ({questionObj.documents.length})</div>
						<div className="field-items">
							{questionObj.documents.map((doc: any, idx: number) => {
								const docText = doc.page_content || JSON.stringify(doc);
								return (
									<div key={idx} className="field-item">
										<span className="item-number">{idx + 1}.</span>
										<span className="item-content">
											{renderTruncatedText(docText)}
										</span>
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* Filter (collapsed view) */}
				{questionObj.filter && (
					<div className="question-field">
						<div className="field-label">Filter:</div>
						<div className="field-value">
							<code className="filter-preview">
								{renderTruncatedText(JSON.stringify(questionObj.filter, null, 2), 128)}
							</code>
						</div>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="tab-content">
			<div className="content-list">
				{questions.map((group, groupIndex) => (
					<div
						key={groupIndex}
						ref={(el) => {
							if (el && setRef) setRef(group.filename, el);
						}}
					>
						<div className="content-item-header">{group.filename}</div>

						{compareMode && group.contents.length > 1 ? (
							<div className="compare-grid">
								{group.contents.map((block, contentIndex) => (
									<div key={contentIndex} className="compare-column">
										{block.fieldName && (
											<div className="content-field-label">{block.fieldName}</div>
										)}
										<div className="content-item">
											{renderQuestion(block.content)}
										</div>
									</div>
								))}
							</div>
						) : (
							group.contents.map((block, contentIndex) => (
								<div key={contentIndex} className="content-item-wrapper">
									{group.contents.length > 1 && block.fieldName && (
										<div className="content-field-label">{block.fieldName}</div>
									)}
									<div className="content-item">
										{renderQuestion(block.content)}
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
