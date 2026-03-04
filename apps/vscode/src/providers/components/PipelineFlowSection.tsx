// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import React from 'react';
import { TaskStatus, Pipeline } from '../../shared/types';

/**
 * Pipeline Flow Section Component
 * 
 * This component displays the pipeline flow visualization with toggleable views
 * between pipeline-centric and component-centric displays. It provides a full-width
 * section for detailed pipeline monitoring.
 * 
 * Key Features:
 * - Toggleable view modes (pipeline vs component)
 * - Pipeline cards with stage flow visualization
 * - Component usage statistics
 * - Responsive layout for different pipeline counts
 * - Handles undefined taskStatus gracefully
 * 
 * @component
 * @param props - Component properties
 * @param props.taskStatus - Complete task status object (can be undefined)
 * @param props.viewMode - Current view mode
 * @param props.onViewModeChange - Handler for view mode changes
 * @returns JSX.Element The rendered pipeline flow section
 */
interface PipelineFlowSectionProps {
	/** Complete task status object containing pipeline flow data (can be undefined) */
	taskStatus: TaskStatus | undefined;

	/** Current pipeline view mode */
	viewMode: 'pipeline' | 'component';

	/** Handler for view mode changes */
	onViewModeChange: (mode: 'pipeline' | 'component') => void;
}

/**
 * PipelineFlowSection Component Implementation
 */
export const PipelineFlowSection: React.FC<PipelineFlowSectionProps> = ({
	taskStatus,
	viewMode,
	onViewModeChange
}) => {
	// ========================================================================
	// DATA PROCESSING
	// ========================================================================

	/**
	 * Extract Pipelines from Task Status
	 */
	const getPipelinesFromTaskStatus = (): Pipeline[] => {
		if (!taskStatus?.pipeflow?.byPipe) {
			return [];
		}

		return Object.entries(taskStatus.pipeflow.byPipe).map(([pipelineId, stages]) => ({
			id: parseInt(pipelineId),
			stages: stages
		}));
	};

	/**
	 * Extract Component Data from Task Status
	 */
	const getComponentData = () => {
		if (!taskStatus?.pipeflow?.byPipe) {
			return {};
		}

		const data: Record<string, { count: number; objectNames: string[] }> = {};

		Object.entries(taskStatus.pipeflow.byPipe).forEach(([_pipelineId, pipeline]) => {
			const filename = pipeline[0];
			const components = pipeline.slice(1);

			components.forEach(component => {
				if (!data[component]) {
					data[component] = { count: 0, objectNames: [] };
				}
				data[component].count += 1;
				data[component].objectNames.push(filename);
			});
		});

		return data;
	};

	// ========================================================================
	// COMPONENT RENDERING
	// ========================================================================

	/**
	 * Render Pipeline Card
	 */
	const renderPipelineCard = (pipeline: Pipeline) => (
		<section key={pipeline.id} className="pipeline">
			<header className="pipeline-header">
				Pipeline <span className="pipeline-id">{pipeline.id}</span>
			</header>
			<div className="stages">
				{pipeline.stages.length > 0 ? (
					pipeline.stages.map((stage, index) => {
						const isLastStage = index === pipeline.stages.length - 1;
						return (
							<React.Fragment key={index}>
								<span className={`stage ${isLastStage ? 'running' : ''}`}>
									{stage}
								</span>
								{!isLastStage && (
									<span className="flow-arrow">→</span>
								)}
							</React.Fragment>
						);
					})
				) : (
					<div className="empty-stages">No active stages</div>
				)}
			</div>
		</section>
	);

	/**
	 * Render Component Card
	 */
	const renderComponentCard = (componentName: string, data: { count: number; objectNames: string[] }) => (
		<section key={componentName} className="pipeline">
			<header className="pipeline-header">
				Component <span className="pipeline-id">{componentName}</span>
				<span className={`component-count ${data.count > 0 ? 'active' : 'inactive'}`}>
					{data.count} active
				</span>
			</header>
			<div className="stages">
				{data.objectNames.length > 0 ? (
					data.objectNames.map((objectName, index) => (
						<span
							key={`${objectName}-${index}`}
							className="stage running"
						>
							{objectName}
						</span>
					))
				) : (
					<div className="empty-stages">
						Not currently active in any pipeline
					</div>
				)}
			</div>
		</section>
	);

	// ========================================================================
	// DATA PREPARATION
	// ========================================================================

	const pipelines = getPipelinesFromTaskStatus();
	const componentData = getComponentData();
	const activePipelines = pipelines.filter(pipeline =>
		pipeline.stages && pipeline.stages.length > 0
	);

	// ========================================================================
	// RENDER LOGIC
	// ========================================================================

	return (
		<section className="status-section">
			<header className="section-header">
				<span>Pipeline Flow</span>
				<div className="pipeline-flow-controls">
					<button
						className={`view-toggle ${viewMode === 'pipeline' ? 'active' : ''}`}
						onClick={() => onViewModeChange('pipeline')}
					>
						Pipeline View
					</button>
					<button
						className={`view-toggle ${viewMode === 'component' ? 'active' : ''}`}
						onClick={() => onViewModeChange('component')}
					>
						Component View
					</button>
				</div>
			</header>
			<div className="section-content">
				{viewMode === 'pipeline' ? (
					// Pipeline View
					<>
						{activePipelines.length > 0 ? (
							activePipelines.map(renderPipelineCard)
						) : (
							<div className="no-data">No active pipelines</div>
						)}
					</>
				) : (
					// Component View
					<>
						{Object.keys(componentData).length > 0 ? (
							Object.entries(componentData).map(([componentName, data]) =>
								renderComponentCard(componentName, data)
							)
						) : (
							<div className="no-data">No active components</div>
						)}
					</>
				)}
			</div>
		</section>
	);
};
