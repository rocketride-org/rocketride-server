/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useEffect, useRef } from 'react';
import { Upload } from 'lucide-react';
import { TabType, ProcessedResults } from '../types/dropper.types';
import { TextView } from './Views/TextView';
import { TablesView } from './Views/TablesView';
import { ImagesView } from './Views/ImagesView';
import { JsonView } from './Views/JsonView';
import { DocumentsView } from './Views/DocumentsView';
import { QuestionsView } from './Views/QuestionsView';
import { AnswersView } from './Views/AnswersView';

interface ResultsContentProps {
	activeTab: TabType;
	results: ProcessedResults | null;
	scrollToFilename?: string | null;
	compareMode?: boolean;
}

export const ResultsContent: React.FC<ResultsContentProps> = ({
	activeTab,
	results,
	scrollToFilename,
	compareMode = false
}) => {
	const contentRefs = useRef<Map<string, HTMLDivElement>>(new Map());

	useEffect(() => {
		if (scrollToFilename && contentRefs.current.has(scrollToFilename)) {
			const element = contentRefs.current.get(scrollToFilename);
			element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}, [scrollToFilename]);

	const setRef = (filename: string, element: HTMLDivElement | null) => {
		if (element) {
			contentRefs.current.set(filename, element);
		}
	};

	if (!results) {
		return (
			<div className="tab-content-empty">
				<div className="empty-state">
					<Upload className="w-16 h-16 text-gray-300" />
					<h3>No results yet</h3>
					<p>Drop some files above to get started with processing</p>
				</div>
			</div>
		);
	}

	switch (activeTab) {
		case 'results':
			return <JsonView rawJson={results.rawJson} />;

		case 'text':
			return (
				<TextView
					textContent={results.textContent}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		case 'documents':
			return (
				<DocumentsView
					documents={results.documents}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		case 'tables':
			return (
				<TablesView
					tables={results.tables}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		case 'images':
			return (
				<ImagesView
					images={results.images}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		case 'questions':
			return (
				<QuestionsView
					questions={results.questions}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		case 'answers':
			return (
				<AnswersView
					answers={results.answers}
					compareMode={compareMode}
					setRef={setRef}
				/>
			);

		default:
			return null;
	}
};
