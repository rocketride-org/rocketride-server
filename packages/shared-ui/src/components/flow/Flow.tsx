// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { TaskStatus, Pipeline } from '../../modules/project/types';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// STYLES (component-specific only)
// =============================================================================

const styles = {
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
	} as CSSProperties,
	pipeline: {
		...commonStyles.card,
		borderRadius: 6,
	} as CSSProperties,
	pipelineHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 12px',
		backgroundColor: 'var(--rr-bg-widget)',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	pipelineId: {
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	componentCount: (active: boolean): CSSProperties => ({
		marginLeft: 'auto',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-disabled)',
	}),
	stages: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: 6,
		padding: '8px 12px',
	} as CSSProperties,
	stage: (running: boolean): CSSProperties => ({
		padding: '3px 10px',
		borderRadius: 4,
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		backgroundColor: running ? 'var(--rr-accent-faded)' : 'var(--rr-bg-widget)',
		color: running ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		border: running ? '1px solid var(--rr-brand)' : '1px solid var(--rr-border)',
	}),
	flowArrow: {
		color: 'var(--rr-text-disabled)',
		fontSize: 'var(--rr-font-size-widget)',
	} as CSSProperties,
	emptyStages: {
		padding: '4px 0',
		color: 'var(--rr-text-disabled)',
		fontSize: 'var(--rr-font-size-widget)',
	} as CSSProperties,
};

// =============================================================================
// Types
// =============================================================================

interface FlowProps {
	taskStatus: TaskStatus | null | undefined;
	viewMode: 'pipeline' | 'component';
	onViewModeChange: (mode: 'pipeline' | 'component') => void;
}

export interface SourceFlowContentProps {
	taskStatus: TaskStatus | null | undefined;
	viewMode: 'pipeline' | 'component';
}

// =============================================================================
// Component
// =============================================================================

/**
 * SourceFlowContent — Renders pipeline/component flow for a single source.
 * Used by SourceFlowPane in ProjectView (mirrors SourceTokensContent pattern).
 */
export const SourceFlowContent: React.FC<SourceFlowContentProps> = ({ taskStatus, viewMode }) => {
	const getPipelines = (): Pipeline[] => {
		if (!taskStatus?.pipeflow?.byPipe) return [];
		return Object.entries(taskStatus.pipeflow.byPipe).map(([id, stages]) => ({
			id: parseInt(id),
			stages,
		}));
	};

	const getComponentData = () => {
		if (!taskStatus?.pipeflow?.byPipe) return {};
		const data: Record<string, { count: number; objectNames: string[] }> = {};
		Object.entries(taskStatus.pipeflow.byPipe).forEach(([_, pipeline]) => {
			const filename = pipeline[0];
			const components = pipeline.slice(1);
			components.forEach((component) => {
				if (!data[component]) data[component] = { count: 0, objectNames: [] };
				data[component].count += 1;
				data[component].objectNames.push(filename);
			});
		});
		return data;
	};

	const pipelines = getPipelines();
	const componentData = getComponentData();
	const activePipelines = pipelines.filter((p) => p.stages && p.stages.length > 0);

	return (
		<div style={styles.content}>
			{viewMode === 'pipeline' ? (
				activePipelines.length > 0 ? (
					activePipelines.map((pipeline) => (
						<div key={pipeline.id} style={styles.pipeline}>
							<div style={styles.pipelineHeader}>
								Pipeline <span style={styles.pipelineId}>{pipeline.id}</span>
							</div>
							<div style={styles.stages}>
								{pipeline.stages.length > 0 ? (
									pipeline.stages.map((stage, i) => {
										const isLast = i === pipeline.stages.length - 1;
										return (
											<React.Fragment key={i}>
												<span style={styles.stage(isLast)}>{stage}</span>
												{!isLast && <span style={styles.flowArrow}>&#8594;</span>}
											</React.Fragment>
										);
									})
								) : (
									<div style={styles.emptyStages}>No active stages</div>
								)}
							</div>
						</div>
					))
				) : (
					<div style={commonStyles.empty}>No active pipelines</div>
				)
			) : Object.keys(componentData).length > 0 ? (
				Object.entries(componentData).map(([name, data]) => (
					<div key={name} style={styles.pipeline}>
						<div style={styles.pipelineHeader}>
							Component <span style={styles.pipelineId}>{name}</span>
							<span style={styles.componentCount(data.count > 0)}>{data.count} active</span>
						</div>
						<div style={styles.stages}>
							{data.objectNames.length > 0 ? (
								data.objectNames.map((obj, i) => (
									<span key={`${obj}-${i}`} style={styles.stage(true)}>
										{obj}
									</span>
								))
							) : (
								<div style={styles.emptyStages}>Not currently active in any pipeline</div>
							)}
						</div>
					</div>
				))
			) : (
				<div style={commonStyles.empty}>No active components</div>
			)}
		</div>
	);
};

const Flow: React.FC<FlowProps> = ({ taskStatus, viewMode, onViewModeChange }) => {
	const getPipelines = (): Pipeline[] => {
		if (!taskStatus?.pipeflow?.byPipe) return [];
		return Object.entries(taskStatus.pipeflow.byPipe).map(([id, stages]) => ({
			id: parseInt(id),
			stages,
		}));
	};

	const getComponentData = () => {
		if (!taskStatus?.pipeflow?.byPipe) return {};
		const data: Record<string, { count: number; objectNames: string[] }> = {};
		Object.entries(taskStatus.pipeflow.byPipe).forEach(([_, pipeline]) => {
			const filename = pipeline[0];
			const components = pipeline.slice(1);
			components.forEach((component) => {
				if (!data[component]) data[component] = { count: 0, objectNames: [] };
				data[component].count += 1;
				data[component].objectNames.push(filename);
			});
		});
		return data;
	};

	const pipelines = getPipelines();
	const componentData = getComponentData();
	const activePipelines = pipelines.filter((p) => p.stages && p.stages.length > 0);

	const renderPipelineCard = (pipeline: Pipeline) => (
		<div key={pipeline.id} style={styles.pipeline}>
			<div style={styles.pipelineHeader}>
				Pipeline <span style={styles.pipelineId}>{pipeline.id}</span>
			</div>
			<div style={styles.stages}>
				{pipeline.stages.length > 0 ? (
					pipeline.stages.map((stage, i) => {
						const isLast = i === pipeline.stages.length - 1;
						return (
							<React.Fragment key={i}>
								<span style={styles.stage(isLast)}>{stage}</span>
								{!isLast && <span style={styles.flowArrow}>&#8594;</span>}
							</React.Fragment>
						);
					})
				) : (
					<div style={styles.emptyStages}>No active stages</div>
				)}
			</div>
		</div>
	);

	const renderComponentCard = (name: string, data: { count: number; objectNames: string[] }) => (
		<div key={name} style={styles.pipeline}>
			<div style={styles.pipelineHeader}>
				Component <span style={styles.pipelineId}>{name}</span>
				<span style={styles.componentCount(data.count > 0)}>{data.count} active</span>
			</div>
			<div style={styles.stages}>
				{data.objectNames.length > 0 ? (
					data.objectNames.map((obj, i) => (
						<span key={`${obj}-${i}`} style={styles.stage(true)}>
							{obj}
						</span>
					))
				) : (
					<div style={styles.emptyStages}>Not currently active in any pipeline</div>
				)}
			</div>
		</div>
	);

	return (
		<div style={commonStyles.section}>
			<div style={commonStyles.sectionHeader}>
				<span style={commonStyles.sectionHeaderLabel}>Pipeline Flow</span>
				<div style={commonStyles.toggleGroup}>
					<button style={commonStyles.toggleButton(viewMode === 'pipeline')} onClick={() => onViewModeChange('pipeline')}>
						Pipeline View
					</button>
					<button style={commonStyles.toggleButton(viewMode === 'component')} onClick={() => onViewModeChange('component')}>
						Component View
					</button>
				</div>
			</div>
			<div style={styles.content}>{viewMode === 'pipeline' ? activePipelines.length > 0 ? activePipelines.map(renderPipelineCard) : <div style={commonStyles.empty}>No active pipelines</div> : Object.keys(componentData).length > 0 ? Object.entries(componentData).map(([name, data]) => renderComponentCard(name, data)) : <div style={commonStyles.empty}>No active components</div>}</div>
		</div>
	);
};

export default Flow;
