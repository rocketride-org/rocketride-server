/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { MessageSquare } from 'lucide-react';
import { ProcessedResults } from '../../types/dropper.types';

interface AnswersViewProps {
	answers: ProcessedResults['answers'];
	compareMode: boolean;
	setRef?: (filename: string, element: HTMLDivElement | null) => void;
}

export const AnswersView: React.FC<AnswersViewProps> = ({ answers, compareMode, setRef }) => {
	if (answers.length === 0) {
		return (
			<div className="tab-content">
				<div className="no-content">
					<MessageSquare className="w-12 h-12 text-gray-300" />
					<p>No answers found in the processed files.</p>
				</div>
			</div>
		);
	}

	const renderAnswer = (content: any) => {
		if (!content) {
			return <div className="field-value">Empty response</div>;
		}

		const text = typeof content === 'string' ? content : String(content);

		return (
			<div className="field-value">
				<pre className="text-content">{text}</pre>
			</div>
		);
	};

	return (
		<div className="tab-content">
			<div className="content-list">
				{answers.map((group, groupIndex) => (
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
											<div className="answer-content">
												<MessageSquare className="answer-icon" />
												{renderAnswer(block.content)}
											</div>
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
										<div className="answer-content">
											<MessageSquare className="answer-icon" />
											{renderAnswer(block.content)}
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
