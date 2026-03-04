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
import { Pipeline } from '../../../shared/types';
import { PipelineCard } from './PipelineCard';

/**
 * Pipeline View Component
 * 
 * This is the main container component for rendering a collection of active pipelines.
 * It serves as the primary view for users to see all their running pipelines at a glance.
 * 
 * Key Features:
 * - Filters out inactive pipelines (those without stages)
 * - Provides empty state messaging when no pipelines are active
 * - Maps each active pipeline to its own PipelineCard component
 * - Maintains consistent layout structure across all pipeline cards
 * 
 * Use Cases:
 * - Dashboard view for monitoring active pipelines
 * - Quick overview of current pipeline status
 * - Entry point for pipeline management interface
 * 
 * @component
 * @param props - Component properties
 * @param props.pipelines - Array of pipeline objects to display
 * @returns JSX.Element The rendered pipeline view containing active pipeline cards
 * 
 * @example
 * ```tsx
 * const pipelines = [
 *   { id: 'pipeline-1', stages: ['build', 'test', 'deploy'] },
 *   { id: 'pipeline-2', stages: [] }, // This will be filtered out
 *   { id: 'pipeline-3', stages: ['lint', 'compile'] }
 * ];
 * 
 * return <PipelineView pipelines={pipelines} />;
 * ```
 */
interface PipelineViewProps {
	/** Array of all available pipelines from the system */
	pipelines: Pipeline[];
}

/**
 * PipelineView Component Implementation
 * 
 * This functional component handles the display logic for multiple pipelines,
 * ensuring only meaningful (non-empty) pipelines are shown to the user.
 */
export const PipelineView: React.FC<PipelineViewProps> = ({ pipelines }) => {
	// ============================================================================
	// DATA PROCESSING
	// ============================================================================

	/**
	 * Filter active pipelines from the complete pipeline list
	 * 
	 * Business Logic:
	 * - Only show pipelines that have stages defined (not null/undefined)
	 * - Only show pipelines with at least one stage (length > 0)
	 * - This prevents rendering empty pipeline cards that provide no value
	 * 
	 * Why we filter:
	 * 1. Empty pipelines clutter the UI
	 * 2. Users only care about pipelines that are actually doing work
	 * 3. Reduces cognitive load by showing only actionable information
	 */
	const activePipelines = pipelines.filter(pipeline =>
		pipeline.stages &&           // Null/undefined safety check
		pipeline.stages.length > 0   // Must have at least one stage
	);

	// ============================================================================
	// RENDER LOGIC
	// ============================================================================

	/**
	 * Handle Empty State
	 * 
	 * When no pipelines have stages, we show a helpful message instead of
	 * rendering an empty screen. This improves user experience by:
	 * - Clearly communicating the current state
	 * - Avoiding confusion about whether the component is broken
	 * - Providing context about why nothing is showing
	 */
	if (activePipelines.length === 0) {
		return (
			<div className="no-data">
				No active pipelines
			</div>
		);
	}

	/**
	 * Main Render Path
	 * 
	 * When we have active pipelines, render each one as a PipelineCard.
	 * 
	 * Implementation Details:
	 * - Use React.Fragment (<>) to avoid unnecessary DOM wrapper
	 * - Map over activePipelines to create individual cards
	 * - Use pipeline.id as React key for efficient reconciliation
	 * - Pass entire pipeline object to allow card flexibility
	 */
	return (
		<>
			{/* Render each active pipeline as a separate card */}
			{activePipelines.map((pipeline) => (
				<PipelineCard
					key={pipeline.id}        // Unique identifier for React's virtual DOM
					pipeline={pipeline}      // Pass complete pipeline data to card
				/>
			))}
		</>
	);
};