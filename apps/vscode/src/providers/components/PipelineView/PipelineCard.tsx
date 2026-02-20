// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
import { StageFlow } from './StageFlow';

/**
 * Individual Pipeline Card Component
 * 
 * This component renders a single pipeline in a card format, providing a clean
 * and consistent visual representation of pipeline information. It serves as
 * the presentation layer for individual pipelines within the larger pipeline
 * management interface.
 * 
 * Key Responsibilities:
 * - Display pipeline identification (ID badge)
 * - Render pipeline stages using the StageFlow component
 * - Provide consistent card layout and styling
 * - Maintain visual hierarchy with header and content sections
 * - Integrate seamlessly with other card components in the interface
 * 
 * Design Philosophy:
 * - Clean, minimal presentation focused on essential information
 * - Consistent visual patterns across all card types
 * - Separation of concerns (card handles layout, StageFlow handles stages)
 * - Semantic HTML structure for accessibility and maintainability
 * 
 * Visual Structure:
 * ┌─────────────────────────────────────┐
 * │ Pipeline [pipeline-id-badge]        │ ← Header section
 * ├─────────────────────────────────────┤
 * │ [stage1] → [stage2] → [stage3]      │ ← Content section (StageFlow)
 * └─────────────────────────────────────┘
 * 
 * Use Cases:
 * - Pipeline dashboard displays
 * - Individual pipeline monitoring
 * - Pipeline status visualization
 * - Integration within larger pipeline management interfaces
 * 
 * @component
 * @param props - Component properties
 * @param props.pipeline - The complete pipeline object containing id and stages
 * @returns JSX.Element The rendered pipeline card with header and stage flow
 * 
 * @example
 * ```tsx
 * // Basic pipeline with multiple stages
 * const pipeline = {
 *   id: 'build-pipeline-1',
 *   stages: ['checkout', 'install', 'build', 'test', 'deploy']
 * };
 * <PipelineCard pipeline={pipeline} />
 * 
 * // Pipeline with single stage
 * const singleStagePipeline = {
 *   id: 'simple-task',
 *   stages: ['compile']
 * };
 * <PipelineCard pipeline={singleStagePipeline} />
 * 
 * // Empty pipeline (stages will be handled by StageFlow)
 * const emptyPipeline = {
 *   id: 'inactive-pipeline',
 *   stages: []
 * };
 * <PipelineCard pipeline={emptyPipeline} />
 * ```
 */
interface PipelineCardProps {
	/** 
	 * Complete pipeline object containing all necessary pipeline information
	 * 
	 * Required properties:
	 * - id: Unique identifier for the pipeline (string)
	 * - stages: Array of stage names in execution order (string[])
	 * 
	 * The pipeline object is passed in its entirety to allow for future
	 * extensibility without changing the component interface.
	 */
	pipeline: Pipeline;
}

/**
 * PipelineCard Component Implementation
 * 
 * This is a pure presentation component that renders pipeline information
 * in a structured card format. It uses a concise arrow function pattern
 * since it contains no complex logic or state management.
 * 
 * Architecture Decision:
 * - No local state needed (pure presentation)
 * - No complex logic (delegates stage rendering to StageFlow)
 * - No lifecycle methods needed (functional component)
 * - Concise implementation using arrow function with implicit return
 */
export const PipelineCard: React.FC<PipelineCardProps> = ({ pipeline }) => (
	// ============================================================================
	// MAIN CARD STRUCTURE
	// ============================================================================

	/**
	 * Card Container
	 * 
	 * Uses semantic HTML5 <section> element to represent a distinct section
	 * of content (the pipeline information). The "pipeline" CSS class provides
	 * consistent styling with other card components in the interface.
	 * 
	 * Semantic Benefits:
	 * - Screen readers can identify this as a discrete content section
	 * - Better document structure for SEO and accessibility
	 * - Consistent with modern HTML5 semantic practices
	 */
	<section className="pipeline">

		{/* ================================================================ */}
		{/* HEADER SECTION */}
		{/* ================================================================ */}

		{/*
         * Pipeline Header
         * 
         * The header section contains the pipeline identification information.
         * Uses semantic "header" element to indicate this is the introductory
         * content for this section.
         * 
         * Structure:
         * - "Pipeline" text label for clear identification
         * - Pipeline ID in a styled badge (pipeline-id class)
         * 
         * CSS Classes:
         * - "pipeline-header": Provides consistent header styling across cards
         * - "pipeline-id": Styles the ID badge with appropriate colors/borders
         */}
		<header className="pipeline-header">
			Pipeline <span className="pipeline-id">{pipeline.id}</span>
		</header>

		{/* ================================================================ */}
		{/* CONTENT SECTION */}
		{/* ================================================================ */}

		{/*
         * Pipeline Content Area
         * 
         * This section contains the main pipeline information - the stage flow.
         * It delegates the actual stage rendering to the StageFlow component,
         * following the single responsibility principle.
         * 
         * Design Decisions:
         * - Uses "stages" CSS class for consistent spacing with other components
         * - Wraps StageFlow to provide proper container context
         * - Maintains separation between card layout and stage flow logic
         * 
         * Component Delegation:
         * - PipelineCard handles: Overall layout, header, container styling
         * - StageFlow handles: Stage rendering, flow arrows, running state
         * 
         * This separation allows:
         * - Independent testing of layout vs. stage logic
         * - Reusability of StageFlow in other contexts
         * - Easier maintenance and modification of each concern
         */}
		<div className="stages">
			<StageFlow stages={pipeline.stages} />
		</div>

	</section>
);
