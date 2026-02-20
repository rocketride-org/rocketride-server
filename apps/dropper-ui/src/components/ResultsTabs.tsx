/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { Database, FileText, Table, Image, File, HelpCircle, MessageSquare } from 'lucide-react';
import { TabType, ProcessedResults } from '../types/dropper.types';

interface ResultsTabsProps {
	activeTab: TabType;
	onTabChange: (tab: TabType) => void;
	results: ProcessedResults | null;
	compareMode: boolean;
	onCompareModeChange: (enabled: boolean) => void;
}

export const ResultsTabs: React.FC<ResultsTabsProps> = ({
	activeTab,
	onTabChange,
	results,
	compareMode,
	onCompareModeChange
}) => {
	if (!results) {
		return null;
	}

	const hasMultipleBlocks = () => {
		switch (activeTab) {
			case 'text':
				return results.textContent.some(group => group.contents.length > 1);
			case 'tables':
				return results.tables.some(group => group.contents.length > 1);
			case 'images':
				return results.images.some(group => group.contents.length > 1);
			case 'documents':
				return results.documents.some(group => group.contents.length > 1);
			case 'questions':
				return results.questions.some(group => group.contents.length > 1);
			case 'answers':
				return results.answers.some(group => group.contents.length > 1);
			default:
				return false;
		}
	};

	const showCompareCheckbox = hasMultipleBlocks();

	return (
		<div className="tab-nav">
			{/* Text Tab */}
			{results.textContent.length > 0 && (
				<button
					onClick={() => onTabChange('text')}
					className={`tab-btn ${activeTab === 'text' ? 'active' : ''}`}
					type="button"
				>
					<FileText className="w-4 h-4" />
					<span>Text</span>
					<span className="tab-badge">{results.textContent.length}</span>
				</button>
			)}

			{/* Documents Tab */}
			{results.documents.length > 0 && (
				<button
					onClick={() => onTabChange('documents')}
					className={`tab-btn ${activeTab === 'documents' ? 'active' : ''}`}
					type="button"
				>
					<File className="w-4 h-4" />
					<span>Documents</span>
					<span className="tab-badge">{results.documents.length}</span>
				</button>
			)}

			{/* Tables Tab */}
			{results.tables.length > 0 && (
				<button
					onClick={() => onTabChange('tables')}
					className={`tab-btn ${activeTab === 'tables' ? 'active' : ''}`}
					type="button"
				>
					<Table className="w-4 h-4" />
					<span>Tables</span>
					<span className="tab-badge">{results.tables.length}</span>
				</button>
			)}

			{/* Images Tab */}
			{results.images.length > 0 && (
				<button
					onClick={() => onTabChange('images')}
					className={`tab-btn ${activeTab === 'images' ? 'active' : ''}`}
					type="button"
				>
					<Image className="w-4 h-4" />
					<span>Images</span>
					<span className="tab-badge">{results.images.length}</span>
				</button>
			)}

			{/* Questions Tab */}
			{results.questions.length > 0 && (
				<button
					onClick={() => onTabChange('questions')}
					className={`tab-btn ${activeTab === 'questions' ? 'active' : ''}`}
					type="button"
				>
					<HelpCircle className="w-4 h-4" />
					<span>Questions</span>
					<span className="tab-badge">{results.questions.length}</span>
				</button>
			)}

			{/* Answers Tab */}
			{results.answers.length > 0 && (
				<button
					onClick={() => onTabChange('answers')}
					className={`tab-btn ${activeTab === 'answers' ? 'active' : ''}`}
					type="button"
				>
					<MessageSquare className="w-4 h-4" />
					<span>Answers</span>
					<span className="tab-badge">{results.answers.length}</span>
				</button>
			)}

			{/* Results Tab */}
			<button
				onClick={() => onTabChange('results')}
				className={`tab-btn ${activeTab === 'results' ? 'active' : ''}`}
				type="button"
			>
				<Database className="w-4 h-4" />
				<span>JSON</span>
			</button>

			{/* Compare checkbox */}
			{showCompareCheckbox && (
				<div className="compare-checkbox-wrapper">
					<label className="compare-checkbox-label">
						<input
							type="checkbox"
							checked={compareMode}
							onChange={(e) => onCompareModeChange(e.target.checked)}
							className="compare-checkbox"
						/>
						<span>Compare</span>
					</label>
				</div>
			)}
		</div>
	);
};
