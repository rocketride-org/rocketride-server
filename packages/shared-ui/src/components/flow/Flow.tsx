// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { TaskStatus, FlowData, Pipeline } from '../../modules/project/types';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	section: {
		display: 'flex',
		flexDirection: 'column',
		gap: 12,
	} as CSSProperties,
	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		fontSize: 'var(--rr-font-size-subtitle)',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	controls: {
		display: 'flex',
		gap: 4,
	} as CSSProperties,
	viewToggle: (active: boolean): CSSProperties => ({
		padding: '4px 12px',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		cursor: 'pointer',
		backgroundColor: active ? 'var(--rr-brand)' : 'transparent',
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
		transition: 'background-color 0.15s, color 0.15s',
	}),
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
	} as CSSProperties,
	pipeline: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		overflow: 'hidden',
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
	noData: {
		padding: 16,
		textAlign: 'center',
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

// =============================================================================
// Component
// =============================================================================

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
		<div style={styles.section}>
			<div style={styles.header}>
				<span>Pipeline Flow</span>
				<div style={styles.controls}>
					<button style={styles.viewToggle(viewMode === 'pipeline')} onClick={() => onViewModeChange('pipeline')}>
						Pipeline View
					</button>
					<button style={styles.viewToggle(viewMode === 'component')} onClick={() => onViewModeChange('component')}>
						Component View
					</button>
				</div>
			</div>
			<div style={styles.content}>{viewMode === 'pipeline' ? activePipelines.length > 0 ? activePipelines.map(renderPipelineCard) : <div style={styles.noData}>No active pipelines</div> : Object.keys(componentData).length > 0 ? Object.entries(componentData).map(([name, data]) => renderComponentCard(name, data)) : <div style={styles.noData}>No active components</div>}</div>
		</div>
	);
};

export default Flow;
